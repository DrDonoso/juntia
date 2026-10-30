import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Annotated, AsyncIterator

import bcrypt
from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .contracts import Contract, UserAuthOut, UserLoginIn
from .db import (
    AuthLimit,
    GoogleAuthFlow,
    Session,
    User,
    UserSession,
    UserToken,
    aware,
    utcnow,
)
from .errors import AppError
from .identity import digest

COOKIE = "juntia_admin"
USER_COOKIE = "juntia_user"
GOOGLE_COOKIE = "juntia_google"
router = APIRouter(prefix="/api/admin/auth", tags=["Administrator authentication"])
user_router = APIRouter(prefix="/api/auth", tags=["Resident authentication"])


def settings(request: Request) -> Settings:
    return request.app.state.settings


async def database(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.sessions() as db:
        yield db


DB = Annotated[AsyncSession, Depends(database)]


def credential_version(config: Settings) -> str:
    value = config.admin_username + "\0" + config.admin_password.get_secret_value()
    return hmac.new(
        config.auth_secret.get_secret_value().encode(), value.encode(), hashlib.sha256
    ).hexdigest()


async def administrator(request: Request, db: DB) -> str:
    token = request.cookies.get(COOKIE, "")
    if len(token) != 64:
        raise AppError("authentication_required", 401)
    hashed = digest(token)
    session = await db.get(Session, hashed)
    if (
        session is None
        or aware(session.expires_at) <= utcnow()
        or not secrets.compare_digest(
            session.credential_version, credential_version(settings(request))
        )
    ):
        raise AppError("authentication_required", 401)
    return hashed


Admin = Annotated[str, Depends(administrator)]


def access_hash(config: Settings, purpose: str, token: str) -> str:
    return hmac.new(
        config.auth_secret.get_secret_value().encode(),
        f"{purpose}\0{token}".encode(),
        hashlib.sha256,
    ).hexdigest()


def throttle_keys(
    request: Request, scope: str, identity: str, *, per_client_identity: bool = False,
) -> tuple[str, str]:
    client = request.client.host if request.client else "unknown"
    if per_client_identity:
        identity = f"{client}\0{identity}"
    config = settings(request)
    return (
        access_hash(config, "limit", f"{scope}:ip:{client}"),
        access_hash(config, "limit", f"{scope}:id:{identity}"),
    )


async def throttle(
    db: AsyncSession,
    request: Request,
    scope: str,
    identity: str,
    *,
    limit: int = 10,
    ip_limit: int = 50,
    seconds: int = 300,
    per_client_identity: bool = False,
) -> None:
    now = utcnow()
    await db.execute(delete(AuthLimit).where(AuthLimit.expires_at <= now))
    dialect = db.get_bind().dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        raise RuntimeError("Unsupported authentication database")
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    keys = throttle_keys(request, scope, identity, per_client_identity=per_client_identity)
    for key, maximum in zip(keys, (ip_limit, limit), strict=True):
        stmt = insert(AuthLimit).values(
            key=key,
            hits=1,
            expires_at=now + timedelta(seconds=seconds),
        )
        hits = await db.scalar(
            stmt.on_conflict_do_update(
                index_elements=[AuthLimit.key], set_={"hits": AuthLimit.hits + 1}
            ).returning(AuthLimit.hits)
        )
        if hits is not None and hits > maximum:
            await db.commit()
            code = "login_throttled" if scope in {"login", "admin-login"} else "request_throttled"
            raise AppError(code, 429)
    await db.commit()


async def clean_user_access(db: AsyncSession) -> None:
    now = utcnow()
    for model in (UserSession, UserToken, GoogleAuthFlow, AuthLimit):
        await db.execute(delete(model).where(model.expires_at <= now))
    await db.commit()


async def revoke_user(db: AsyncSession, user: User) -> None:
    user.auth_version += 1
    await revoke_user_access(db, user.id)


async def revoke_user_access(db: AsyncSession, user_id: int) -> None:
    for model in (UserSession, UserToken, GoogleAuthFlow):
        await db.execute(
            delete(model).where(model.user_id == user_id).execution_options(autoflush=False)
        )


async def resident_session(request: Request, db: AsyncSession) -> UserAuthOut | None:
    token = request.cookies.get(USER_COOKIE, "")
    if len(token) != 64:
        return None
    row = (
        await db.execute(
            select(User, UserSession)
            .join(UserSession, UserSession.user_id == User.id)
            .where(
                UserSession.token_hash == access_hash(settings(request), "session", token),
                UserSession.expires_at > utcnow(),
                UserSession.auth_version == User.auth_version,
                User.disabled.is_(False),
                User.activated.is_(True),
            )
        )
    ).one_or_none()
    if row is None:
        return None
    user, session = row
    return UserAuthOut(
        authenticated=True, kind="resident", name=user.name, email=user.email,
        user_id=user.id, dwelling_id=user.dwelling_id, expires_at=aware(session.expires_at),
    )


async def reader_session(request: Request, db: DB) -> UserAuthOut:
    try:
        hashed = await administrator(request, db)
    except AppError as error:
        if error.status != 401:
            raise
    else:
        session = await db.get(Session, hashed)
        assert session is not None
        return UserAuthOut(
            authenticated=True, kind="administrator",
            name=settings(request).admin_username, expires_at=aware(session.expires_at),
        )
    resident = await resident_session(request, db)
    if resident is None:
        raise AppError("authentication_required", 401)
    return resident


async def mutation_session(request: Request, db: AsyncSession) -> UserAuthOut:
    identity = await reader_session(request, db)
    if identity.kind == "resident" and identity.user_id is not None:
        await db.scalar(
            select(User).where(User.id == identity.user_id).with_for_update()
            .execution_options(populate_existing=True)
        )
        await db.scalar(
            select(UserSession).where(UserSession.token_hash == access_hash(
                settings(request), "session", request.cookies.get(USER_COOKIE, ""),
            )).with_for_update().execution_options(populate_existing=True)
        )
    else:
        token = await administrator(request, db)
        await db.scalar(
            select(Session).where(Session.token_hash == token).with_for_update()
            .execution_options(populate_existing=True)
        )
    current = await reader_session(request, db)
    if (current.kind, current.user_id) != (identity.kind, identity.user_id):
        raise AppError("authentication_required", 401)
    return current


async def resident_id(request: Request, db: DB) -> int:
    identity = await reader_session(request, db)
    if identity.kind != "resident" or identity.user_id is None:
        raise AppError("resident_profile_required", 403)
    return identity.user_id


Resident = Annotated[int, Depends(resident_id)]


async def verify_current_password(
    db: AsyncSession, user_id: int, password: str, request: Request
) -> tuple[str, int]:
    await throttle(db, request, "password-change", str(user_id))
    snapshot = (await db.execute(
        select(User.password_hash, User.auth_version).where(
            User.id == user_id, User.activated.is_(True), User.disabled.is_(False),
        )
    )).one_or_none()
    await db.rollback()
    if snapshot is None:
        raise AppError("authentication_required", 401)
    stored_hash, version = snapshot
    if not stored_hash:
        raise AppError("password_not_set", 409)
    encoded = password.encode("utf-8")
    valid_size = 1 <= len(encoded) <= 72
    matches = await run_in_threadpool(
        bcrypt.checkpw, encoded if valid_size else b"invalid-password", stored_hash.encode()
    )
    if not valid_size or not matches:
        raise AppError("current_password_invalid", 400)
    return stored_hash, version


async def issue_resident_session(
    db: AsyncSession, request: Request, response: Response, user: User
) -> UserAuthOut:
    now = utcnow()
    current_id = await db.scalar(
        update(User).where(
            User.id == user.id, User.auth_version == user.auth_version,
            User.disabled.is_(False), User.activated.is_(True),
        ).values(last_login_at=now).returning(User.id)
    )
    if current_id is None:
        raise AppError("authentication_required", 401)
    config = settings(request)
    old = request.cookies.get(USER_COOKIE)
    await db.execute(delete(UserSession).where(UserSession.expires_at <= now))
    if old:
        await db.execute(delete(UserSession).where(
            UserSession.token_hash == access_hash(config, "session", old)
        ))
    token = secrets.token_hex(32)
    expires_at = now + timedelta(hours=config.session_hours)
    db.add(UserSession(
        token_hash=access_hash(config, "session", token), user_id=user.id,
        auth_version=user.auth_version, expires_at=expires_at,
    ))
    await db.commit()
    response.set_cookie(
        USER_COOKIE, token, max_age=config.session_hours * 3600, httponly=True,
        secure=config.auth_cookie_secure, samesite="strict", path="/api",
    )
    return UserAuthOut(
        authenticated=True, kind="resident", name=user.name, email=user.email,
        user_id=user.id, dwelling_id=user.dwelling_id, expires_at=expires_at,
    )


def set_admin_cookie(
    response: Response, config: Settings, token: str, expires_at: datetime
) -> None:
    response.delete_cookie(
        COOKIE, path="/api/admin", httponly=True, secure=config.auth_cookie_secure,
        samesite="strict",
    )
    response.set_cookie(
        COOKIE, token, max_age=max(0, int((aware(expires_at) - utcnow()).total_seconds())),
        httponly=True, secure=config.auth_cookie_secure, samesite="strict", path="/api",
    )


class LoginIn(Contract):
    username: str = Field(max_length=150)
    password: str = Field(max_length=1000)


class AuthOut(Contract):
    authenticated: bool
    username: str | None = None


@router.get("/session", response_model=AuthOut)
async def current_session(request: Request, response: Response, db: DB) -> AuthOut:
    try:
        hashed = await administrator(request, db)
    except AppError as error:
        if error.status == 401:
            return AuthOut(authenticated=False)
        raise
    session = await db.get(Session, hashed)
    assert session is not None
    set_admin_cookie(response, settings(request), request.cookies[COOKIE], session.expires_at)
    return AuthOut(authenticated=True, username=settings(request).admin_username)


@router.post("/login", response_model=AuthOut)
async def login(body: LoginIn, request: Request, response: Response, db: DB) -> AuthOut:
    await throttle(db, request, "admin-login", body.username, per_client_identity=True)
    config = settings(request)
    encoded = body.password.encode("utf-8")
    valid_size = 1 <= len(encoded) <= 72
    candidate = encoded if valid_size else b"invalid-password"
    password_ok = await run_in_threadpool(
        bcrypt.checkpw, candidate, request.app.state.password_hash
    )
    username_ok = secrets.compare_digest(
        body.username.encode("utf-8"), config.admin_username.encode("utf-8")
    )
    if not valid_size or not password_ok or not username_ok:
        raise AppError("invalid_credentials", 401)
    token = secrets.token_hex(32)
    await db.execute(delete(Session).where(Session.expires_at < utcnow()))
    old = request.cookies.get(COOKIE)
    if old:
        await db.execute(delete(Session).where(Session.token_hash == digest(old)))
    expires_at = utcnow() + timedelta(hours=config.session_hours)
    db.add(
        Session(
            token_hash=digest(token),
            credential_version=credential_version(config),
            expires_at=expires_at,
        )
    )
    await db.commit()
    set_admin_cookie(response, config, token, expires_at)
    return AuthOut(authenticated=True, username=config.admin_username)


@router.post("/logout", status_code=204)
async def logout(admin: Admin, db: DB, response: Response) -> None:
    await db.execute(delete(Session).where(Session.token_hash == admin))
    await db.commit()
    response.delete_cookie(COOKIE, path="/api/admin", httponly=True, samesite="strict")
    response.delete_cookie(COOKIE, path="/api", httponly=True, samesite="strict")


@user_router.get("/session", response_model=UserAuthOut)
async def current_reader_session(request: Request, db: DB) -> UserAuthOut:
    try:
        return await reader_session(request, db)
    except AppError as error:
        if error.status == 401:
            return UserAuthOut(authenticated=False)
        raise


@user_router.post("/login", response_model=UserAuthOut)
async def user_login(
    body: UserLoginIn, request: Request, response: Response, db: DB
) -> UserAuthOut:
    await throttle(db, request, "login", body.email)
    user = await db.scalar(select(User).where(User.email == body.email))
    encoded = body.password.encode("utf-8")
    valid_size = 1 <= len(encoded) <= 72
    eligible = (
        user is not None and user.activated and not user.disabled and user.password_hash is not None
    )
    password_hash = (
        user.password_hash.encode() if eligible and user and user.password_hash
        else request.app.state.password_hash
    )
    password_ok = await run_in_threadpool(
        bcrypt.checkpw, encoded if valid_size else b"invalid-password", password_hash
    )
    if not eligible or not password_ok or not valid_size or user is None:
        raise AppError("invalid_credentials", 401)
    return await issue_resident_session(db, request, response, user)


@user_router.post("/logout", status_code=204)
async def user_logout(request: Request, response: Response, db: DB) -> None:
    resident = request.cookies.get(USER_COOKIE)
    admin = request.cookies.get(COOKIE)
    if resident:
        await db.execute(delete(UserSession).where(
            UserSession.token_hash == access_hash(settings(request), "session", resident)
        ))
    if admin:
        await db.execute(delete(Session).where(Session.token_hash == digest(admin)))
    google_browser = request.cookies.get(GOOGLE_COOKIE)
    if google_browser:
        await db.execute(delete(GoogleAuthFlow).where(
            GoogleAuthFlow.browser_hash == access_hash(settings(request), "google-browser", google_browser)
        ))
    await db.commit()
    for name, path in [
        (USER_COOKIE, "/api"), (COOKIE, "/api"), (COOKIE, "/api/admin"),
        (GOOGLE_COOKIE, "/api/auth"),
    ]:
        response.delete_cookie(
            name, path=path, httponly=True, secure=settings(request).auth_cookie_secure,
            samesite="strict",
        )
