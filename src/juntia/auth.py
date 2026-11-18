import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, AsyncIterator, Literal

import bcrypt
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .contracts import SetupIn, SetupOut, UserAuthOut, UserLoginIn
from .db import (
    AuthLimit,
    GoogleAuthFlow,
    State,
    User,
    UserSession,
    UserToken,
    aware,
    utcnow,
)
from .errors import AppError

USER_COOKIE = "juntia_user"
GOOGLE_COOKIE = "juntia_google"
# The technical administrator's session cookie of earlier releases, which signing in and signing
# out clear so that old browsers drop it.
LEGACY_ADMIN_COOKIE = "juntia_admin"
# Compared when an account cannot sign in with a password, so that the response takes as long as
# a real check (bcrypt's default cost). Its password is unknown and never accepted.
UNUSABLE_HASH = b"$2b$12$Sm9C1OTI7qL2ujTgHeYsNuSzlAcsTF9JvafH1MOvsQBepj0b8bdr2"
router = APIRouter(prefix="/api/auth", tags=["Authentication"])


def settings(request: Request) -> Settings:
    return request.app.state.settings


async def database(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.sessions() as db:
        yield db


DB = Annotated[AsyncSession, Depends(database)]


def access_hash(config: Settings, purpose: str, token: str) -> str:
    return hmac.new(
        config.auth_secret.get_secret_value().encode(),
        f"{purpose}\0{token}".encode(),
        hashlib.sha256,
    ).hexdigest()


def session_hash(request: Request) -> str:
    return access_hash(settings(request), "session", request.cookies.get(USER_COOKIE, ""))


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
            code = "login_throttled" if scope == "login" else "request_throttled"
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


def signed_in(user: User, expires_at: datetime) -> UserAuthOut:
    return UserAuthOut(
        authenticated=True, administrator=user.administrator, name=user.name, email=user.email,
        user_id=user.id, dwelling_id=user.dwelling_id, expires_at=aware(expires_at),
    )


async def account_session(request: Request, db: AsyncSession) -> UserAuthOut | None:
    """The signed-in account, read from the database on every request: a revoked role, a disabled
    account or a closed session apply at once."""
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
    return signed_in(user, session.expires_at)


async def reader_session(request: Request, db: DB) -> UserAuthOut:
    identity = await account_session(request, db)
    if identity is None:
        raise AppError("authentication_required", 401)
    return identity


async def administrator_session(request: Request, db: DB) -> UserAuthOut:
    """A signed-in account with the administrator role."""
    identity = await reader_session(request, db)
    if not identity.administrator:
        raise AppError("administrator_required", 403)
    return identity


Administrator = Annotated[UserAuthOut, Depends(administrator_session)]


async def administrator(request: Request, db: DB) -> str:
    """The session of a signed-in administrator, which owns its statement previews."""
    await administrator_session(request, db)
    return session_hash(request)


Admin = Annotated[str, Depends(administrator)]


async def mutation_session(request: Request, db: AsyncSession) -> UserAuthOut:
    """The signed-in account, its row and session locked until the transaction ends, so that a
    concurrent revocation either applies first or waits for the change."""
    identity = await reader_session(request, db)
    await db.scalar(
        select(User).where(User.id == identity.user_id).with_for_update()
        .execution_options(populate_existing=True)
    )
    await db.scalar(
        select(UserSession).where(UserSession.token_hash == session_hash(request))
        .with_for_update().execution_options(populate_existing=True)
    )
    current = await reader_session(request, db)
    if current.user_id != identity.user_id:
        raise AppError("authentication_required", 401)
    return current


async def current_user_id(request: Request, db: DB) -> int:
    identity = await reader_session(request, db)
    if identity.user_id is None:
        raise AppError("authentication_required", 401)
    return identity.user_id


CurrentUser = Annotated[int, Depends(current_user_id)]


@dataclass(frozen=True)
class Actor:
    """The signed-in account that writes something: the author snapshot stored with it, which is
    'resident' with its user ID for every account, administrators included, and whether it
    administers, which lets it manage what others wrote."""

    user_id: int
    name: str
    administrator: bool = False
    kind: Literal["resident"] = "resident"


def actor_of(identity: UserAuthOut) -> Actor:
    if identity.user_id is None or identity.name is None:
        raise AppError("authentication_required", 401)
    return Actor(user_id=identity.user_id, name=identity.name, administrator=identity.administrator)


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


def clear_legacy_admin_cookie(config: Settings, response: Response) -> None:
    for path in ("/api", "/api/admin"):
        response.delete_cookie(
            LEGACY_ADMIN_COOKIE, path=path, httponly=True, secure=config.auth_cookie_secure,
            samesite="strict",
        )


async def issue_session(
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
    clear_legacy_admin_cookie(config, response)
    return signed_in(user, expires_at)


@router.get("/session", response_model=UserAuthOut)
async def current_session(request: Request, db: DB) -> UserAuthOut:
    identity = await account_session(request, db)
    return identity or UserAuthOut(authenticated=False)


@router.post("/login", response_model=UserAuthOut)
async def login(body: UserLoginIn, request: Request, response: Response, db: DB) -> UserAuthOut:
    # Neighbors share one limit from every client. Administrators, whose addresses every neighbor
    # may know, count failures per client, so that nobody can lock them out from elsewhere.
    administrator = await db.scalar(select(User.administrator).where(User.email == body.email))
    await throttle(db, request, "login", body.email, per_client_identity=administrator is True)
    user = await db.scalar(select(User).where(User.email == body.email))
    encoded = body.password.encode("utf-8")
    valid_size = 1 <= len(encoded) <= 72
    eligible = (
        user is not None and user.activated and not user.disabled and user.password_hash is not None
    )
    password_hash = (
        user.password_hash.encode() if eligible and user and user.password_hash else UNUSABLE_HASH
    )
    password_ok = await run_in_threadpool(
        bcrypt.checkpw, encoded if valid_size else b"invalid-password", password_hash
    )
    if not eligible or not password_ok or not valid_size or user is None:
        raise AppError("invalid_credentials", 401)
    return await issue_session(db, request, response, user)


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: DB) -> None:
    config = settings(request)
    if request.cookies.get(USER_COOKIE):
        await db.execute(delete(UserSession).where(UserSession.token_hash == session_hash(request)))
    google_browser = request.cookies.get(GOOGLE_COOKIE)
    if google_browser:
        await db.execute(delete(GoogleAuthFlow).where(
            GoogleAuthFlow.browser_hash == access_hash(config, "google-browser", google_browser)
        ))
    await db.commit()
    for name, path in [(USER_COOKIE, "/api"), (GOOGLE_COOKIE, "/api/auth")]:
        response.delete_cookie(
            name, path=path, httponly=True, secure=config.auth_cookie_secure, samesite="strict",
        )
    clear_legacy_admin_cookie(config, response)


async def setup_available(db: AsyncSession) -> bool:
    if not await db.scalar(select(State.setup_open).where(State.id == 1)):
        return False
    return await db.scalar(select(User.id).limit(1)) is None


@router.get("/setup", response_model=SetupOut)
async def setup_status(db: DB) -> SetupOut:
    return SetupOut(available=await setup_available(db))


@router.post("/setup", response_model=UserAuthOut, status_code=201)
async def setup(body: SetupIn, request: Request, response: Response, db: DB) -> UserAuthOut:
    """First run: the first visitor of a new installation creates the administration account,
    with no dwelling, and is signed in."""
    await throttle(db, request, "setup", body.email, limit=5, ip_limit=20, seconds=3600)
    if not await setup_available(db):
        raise AppError("setup_unavailable", 409)
    await db.rollback()
    password_hash = await run_in_threadpool(
        bcrypt.hashpw, body.password.encode("utf-8"), bcrypt.gensalt()
    )
    # One atomic update closes the setup: a simultaneous request finds it closed.
    closed = await db.scalar(
        update(State).where(
            State.id == 1, State.setup_open.is_(True), ~select(User.id).exists(),
        ).values(setup_open=False).returning(State.id)
    )
    if closed is None:
        await db.rollback()
        raise AppError("setup_unavailable", 409)
    user = User(
        email=body.email, name=body.name, administrator=True, activated=True,
        password_hash=password_hash.decode(),
    )
    db.add(user)
    await db.commit()
    return await issue_session(db, request, response, user)
