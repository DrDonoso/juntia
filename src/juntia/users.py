import logging
import secrets
from datetime import timedelta
from decimal import Decimal

import bcrypt
from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from . import mail, queries
from .auth import (
    DB,
    USER_COOKIE,
    Resident,
    access_hash,
    administrator,
    resident_session,
    revoke_user,
    revoke_user_access,
    settings,
    throttle,
    verify_current_password,
)
from .config import Settings
from .contracts import (
    ChangePasswordIn,
    DwellingEdit,
    DwellingIn,
    DwellingLayoutIn,
    DwellingLayoutOut,
    DwellingOut,
    EmailIn,
    PresidencyIn,
    PresidencyOut,
    ProfileEdit,
    ProfileOut,
    RecoveryOut,
    SetPasswordIn,
    UserDeleteIn,
    UserEdit,
    UserIn,
    UserOut,
    UserStatusIn,
    VersionIn,
)
from .db import Dwelling, State, User, UserToken, aware, utcnow
from .errors import AppError

log = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/admin", tags=["Residents"], dependencies=[Depends(administrator)]
)
public_router = APIRouter(prefix="/api/auth", tags=["Account invitations and recovery"])
profile_router = APIRouter(prefix="/api/auth/profile", tags=["Resident profile"])


async def save(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError("record_conflict", 409) from None


async def dwelling_out(db: AsyncSession, dwelling: Dwelling) -> DwellingOut:
    count = await db.scalar(select(func.count()).select_from(User).where(
        User.dwelling_id == dwelling.id
    ))
    return DwellingOut(
        id=dwelling.id, label=dwelling.label,
        coefficient=dwelling.coefficient if (await queries.feature_flags(db)).coefficient else None,
        version=dwelling.version, user_count=count or 0,
    )


def render_user(user: User, dwelling: Dwelling, coefficient_enabled: bool) -> UserOut:
    status = "disabled" if user.disabled else "active" if user.activated else "pending"
    invitation = user.invitation_delivery
    if (
        invitation in {"sending", "sent"}
        and user.invitation_expires_at
        and aware(user.invitation_expires_at) <= utcnow()
    ):
        invitation = "expired"
    return UserOut(
        id=user.id, name=user.name, email=user.email, phone=user.phone,
        dwelling_id=user.dwelling_id,
        version=user.version, status=status, dwelling_label=dwelling.label,
        coefficient=dwelling.coefficient if coefficient_enabled else None,
        last_login_at=aware(user.last_login_at) if user.last_login_at else None,
        invitation_status=invitation,
        invitation_expires_at=(
            aware(user.invitation_expires_at) if user.invitation_expires_at else None
        ),
        invitation_sent_at=aware(user.invitation_sent_at) if user.invitation_sent_at else None,
        has_password=user.password_hash is not None, google_linked=user.google_subject is not None,
    )


async def user_out(db: AsyncSession, user_id: int) -> UserOut:
    row = (
        await db.execute(
            select(User, Dwelling).join(Dwelling, User.dwelling_id == Dwelling.id)
            .where(User.id == user_id).execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        raise AppError("user_not_found", 404)
    return render_user(*row, (await queries.feature_flags(db)).coefficient)


async def locked_user(db: AsyncSession, user_id: int, version: int | None = None) -> User:
    user = await db.scalar(
        select(User).where(User.id == user_id).with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise AppError("user_not_found", 404)
    if version is not None and user.version != version:
        raise AppError("record_stale", 409)
    return user


async def clear_presidency(db: AsyncSession, user_id: int) -> None:
    await db.execute(
        update(State).where(State.id == 1, State.president_user_id == user_id)
        .values(president_user_id=None, presidency_version=State.presidency_version + 1)
        .execution_options(autoflush=False)
    )


async def current_profile_user(request: Request, db: AsyncSession, user_id: int) -> User:
    user = await locked_user(db, user_id)
    identity = await resident_session(request, db)
    if identity is None or identity.user_id != user_id:
        raise AppError("authentication_required", 401)
    return user


def clear_resident_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(
        USER_COOKIE, path="/api", httponly=True, secure=settings(request).auth_cookie_secure,
        samesite="strict",
    )


@profile_router.get("", response_model=ProfileOut)
async def profile(user_id: Resident, request: Request, db: DB) -> ProfileOut:
    await current_profile_user(request, db, user_id)
    return ProfileOut.model_validate(await user_out(db, user_id))


@profile_router.patch("", response_model=ProfileOut)
async def edit_profile(
    body: ProfileEdit, user_id: Resident, request: Request, db: DB
) -> ProfileOut:
    user = await current_profile_user(request, db, user_id)
    if user.version != body.version:
        raise AppError("profile_stale", 409)
    user.name = body.name
    if "phone" in body.model_fields_set:
        user.phone = body.phone
    user.version += 1
    await save(db)
    return ProfileOut.model_validate(await user_out(db, user_id))


@profile_router.post("/password", status_code=204)
async def change_password(
    body: ChangePasswordIn, user_id: Resident, request: Request, response: Response, db: DB
) -> None:
    stored_hash, version = await verify_current_password(
        db, user_id, body.current_password, request,
    )
    password_hash = await run_in_threadpool(
        bcrypt.hashpw, body.password.encode("utf-8"), bcrypt.gensalt()
    )
    user = await current_profile_user(request, db, user_id)
    if user.auth_version != version or user.password_hash != stored_hash:
        raise AppError("authentication_required", 401)
    user.password_hash = password_hash.decode()
    user.version += 1
    await revoke_user(db, user)
    await db.commit()
    clear_resident_cookie(request, response)


@profile_router.delete("/sessions", status_code=204)
async def close_all_sessions(
    user_id: Resident, request: Request, response: Response, db: DB
) -> None:
    user = await current_profile_user(request, db, user_id)
    await revoke_user(db, user)
    await db.commit()
    clear_resident_cookie(request, response)


async def require_dwelling(db: AsyncSession, dwelling_id: int) -> None:
    if await db.get(Dwelling, dwelling_id) is None:
        raise AppError("dwelling_not_found", 422)


async def prepare_invitation(db: AsyncSession, request: Request, email: str) -> None:
    mail.require_smtp(settings(request))
    await throttle(
        db, request, "invitation", email, limit=10, ip_limit=200, seconds=3600
    )


async def issue_token(
    db: AsyncSession, request: Request, user: User, purpose: mail.Purpose
) -> str:
    raw = secrets.token_hex(32)
    hashed = access_hash(settings(request), purpose, raw)
    expires = utcnow() + timedelta(hours=72 if purpose == "invitation" else 1)
    await db.execute(delete(UserToken).where(
        UserToken.user_id == user.id, UserToken.purpose == purpose
    ).execution_options(autoflush=False))
    db.add(UserToken(
        token_hash=hashed, user_id=user.id, purpose=purpose,
        auth_version=user.auth_version, expires_at=expires,
    ))
    if purpose == "invitation":
        user.invitation_delivery = "sending"
        user.invitation_token_hash = hashed
        user.invitation_expires_at = expires
        user.invitation_sent_at = None
    return raw


async def send_token(
    db: AsyncSession, config: Settings, user: User, raw: str, purpose: mail.Purpose
) -> None:
    hashed = access_hash(config, purpose, raw)
    community_name = (await queries.general_settings(db)).community_name
    await db.commit()
    failure = None
    try:
        await mail.send_link(
            config, user.email, user.name, raw, purpose, community_name=community_name
        )
    except AppError as error:
        failure = error
    if failure:
        await db.execute(delete(UserToken).where(UserToken.token_hash == hashed))
    changed = None
    if purpose == "invitation":
        changed = await db.scalar(
            update(User).where(User.id == user.id, User.invitation_token_hash == hashed)
            .values(
                invitation_delivery="failed" if failure else "sent",
                invitation_sent_at=None if failure else utcnow(),
            ).returning(User.id)
        )
    await db.commit()
    if failure:
        raise failure
    if purpose == "invitation" and changed is None:
        raise AppError("invitation_superseded", 409)


@router.get("/dwellings", response_model=list[DwellingOut])
async def dwellings(db: DB) -> list[DwellingOut]:
    flags = await queries.feature_flags(db)
    rows = (await db.execute(
        select(Dwelling, func.count(User.id))
        .outerjoin(User, User.dwelling_id == Dwelling.id)
        .group_by(Dwelling.id).order_by(Dwelling.label, Dwelling.id)
    )).all()
    return sorted([
        DwellingOut(
            id=value.id, label=value.label,
            coefficient=value.coefficient if flags.coefficient else None,
            version=value.version, user_count=count,
        ) for value, count in rows
    ], key=lambda value: queries.dwelling_sort_key(value.label))


@router.put("/dwellings/layout", response_model=DwellingLayoutOut)
async def update_dwelling_layout(body: DwellingLayoutIn, db: DB) -> DwellingLayoutOut:
    placed = {
        cell for zone in body.layout.zones for row in zone.rows
        for cell in row.cells if cell is not None
    }
    existing = set(await db.scalars(select(Dwelling.id)))
    if placed - existing:
        raise AppError("dwelling_layout_missing", 422)
    version = await db.scalar(
        update(State)
        .where(State.id == 1, State.dwelling_layout_version == body.version)
        .values(
            dwelling_layout=body.layout.model_dump(),
            dwelling_layout_version=State.dwelling_layout_version + 1,
        )
        .returning(State.dwelling_layout_version)
    )
    if version is None:
        if await db.get(State, 1) is None:
            raise RuntimeError("Missing application state")
        raise AppError("dwelling_layout_stale", 409)
    await save(db)
    return DwellingLayoutOut(version=version, layout=body.layout)


@router.post("/dwellings", response_model=DwellingOut, status_code=201)
async def create_dwelling(body: DwellingIn, db: DB) -> DwellingOut:
    flags = await queries.feature_flags(db)
    value = Dwelling(label=body.label, coefficient=coefficient_update(body, flags.coefficient))
    db.add(value)
    await save(db)
    return await dwelling_out(db, value)


def coefficient_update(
    body: DwellingIn, enabled: bool, existing: Decimal | None = None
) -> Decimal | None:
    supplied = "coefficient" in body.model_fields_set
    if not enabled:
        if supplied:
            raise AppError("coefficient_disabled", 409)
        return existing
    value = body.coefficient if supplied else existing
    if value is None:
        raise AppError("coefficient_required", 422)
    return value


@router.patch("/dwellings/{dwelling_id}", response_model=DwellingOut)
async def edit_dwelling(
    dwelling_id: int, body: DwellingEdit, db: DB
) -> DwellingOut:
    value = await db.scalar(
        select(Dwelling).where(Dwelling.id == dwelling_id).with_for_update()
    )
    if value is None:
        raise AppError("dwelling_not_found", 404)
    if value.version != body.version:
        raise AppError("record_stale", 409)
    value.label = body.label
    flags = await queries.feature_flags(db)
    value.coefficient = coefficient_update(body, flags.coefficient, value.coefficient)
    value.version += 1
    await save(db)
    return await dwelling_out(db, value)


@router.get("/users", response_model=list[UserOut])
async def users(db: DB) -> list[UserOut]:
    flags = await queries.feature_flags(db)
    rows = (await db.execute(
        select(User, Dwelling).join(Dwelling, User.dwelling_id == Dwelling.id)
        .order_by(User.name, User.id)
    )).all()
    return [render_user(*row, flags.coefficient) for row in rows]


@router.get("/presidency", response_model=PresidencyOut)
async def read_presidency(db: DB) -> PresidencyOut:
    return await queries.presidency(db)


@router.put("/presidency", response_model=PresidencyOut)
async def update_presidency(body: PresidencyIn, db: DB) -> PresidencyOut:
    statement = update(State).where(State.id == 1, State.presidency_version == body.version)
    if body.user_id is not None:
        user = await locked_user(db, body.user_id)
        if user.disabled or not user.activated:
            raise AppError("presidency_inactive", 409)
        # SQLite has no row locks; also check eligibility in the atomic update.
        statement = statement.where(select(User.id).where(
            User.id == body.user_id, User.disabled.is_(False), User.activated.is_(True),
        ).exists())
    version = await db.scalar(
        statement.values(
            president_user_id=body.user_id, presidency_version=State.presidency_version + 1,
        ).returning(State.presidency_version)
    )
    if version is None:
        if await db.get(State, 1) is None:
            raise RuntimeError("Missing application state")
        raise AppError("presidency_stale", 409)
    await save(db)
    return await queries.presidency(db)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: int, body: UserDeleteIn, db: DB) -> None:
    user = await locked_user(db, user_id, body.version)
    if body.email != user.email:
        raise AppError("user_delete_confirmation_required", 422)
    await clear_presidency(db, user_id)
    await revoke_user_access(db, user_id)
    removed = await db.scalar(
        delete(User).where(
            User.id == user_id, User.version == body.version, User.email == body.email,
        ).returning(User.id)
    )
    if removed is None:
        await db.rollback()
        raise AppError("record_stale", 409)
    await db.commit()


@router.post("/users", response_model=UserOut, status_code=201)
async def invite_user(body: UserIn, request: Request, db: DB) -> UserOut:
    await prepare_invitation(db, request, body.email)
    await require_dwelling(db, body.dwelling_id)
    value = User(**body.model_dump())
    db.add(value)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise AppError("record_conflict", 409) from None
    token = await issue_token(db, request, value, "invitation")
    await save(db)
    await send_token(db, settings(request), value, token, "invitation")
    return await user_out(db, value.id)


@router.post("/users/{user_id}/invite", response_model=UserOut)
async def resend_invitation(
    user_id: int, body: VersionIn, request: Request, db: DB
) -> UserOut:
    email = await db.scalar(select(User.email).where(User.id == user_id))
    if email is None:
        raise AppError("user_not_found", 404)
    await prepare_invitation(db, request, email)
    user = await locked_user(db, user_id, body.version)
    if user.disabled or user.activated:
        raise AppError("invitation_not_pending", 409)
    user.version += 1
    token = await issue_token(db, request, user, "invitation")
    await save(db)
    await send_token(db, settings(request), user, token, "invitation")
    return await user_out(db, user_id)


@router.patch("/users/{user_id}", response_model=UserOut)
async def edit_user(user_id: int, body: UserEdit, request: Request, db: DB) -> UserOut:
    previous = (await db.execute(
        select(User.email, User.disabled).where(User.id == user_id)
    )).one_or_none()
    if previous is None:
        raise AppError("user_not_found", 404)
    if previous.email != body.email and not previous.disabled:
        await prepare_invitation(db, request, body.email)
    user = await locked_user(db, user_id, body.version)
    await require_dwelling(db, body.dwelling_id)
    email_changed = user.email != body.email
    user.name = body.name
    if "phone" in body.model_fields_set:
        user.phone = body.phone
    user.dwelling_id = body.dwelling_id
    user.version += 1
    token = None
    if email_changed:
        user.email = body.email
        await revoke_user(db, user)
        user.password_hash = None
        user.google_subject = None
        user.activated = False
        await clear_presidency(db, user_id)
        user.invitation_token_hash = None
        user.invitation_delivery = "none"
        user.invitation_expires_at = None
        user.invitation_sent_at = None
        if not user.disabled:
            token = await issue_token(db, request, user, "invitation")
    await save(db)
    if token:
        await send_token(db, settings(request), user, token, "invitation")
    return await user_out(db, user_id)


@router.patch("/users/{user_id}/status", response_model=UserOut)
async def change_status(
    user_id: int, body: UserStatusIn, request: Request, db: DB
) -> UserOut:
    previous = (await db.execute(
        select(User.email, User.activated).where(User.id == user_id)
    )).one_or_none()
    if previous is None:
        raise AppError("user_not_found", 404)
    if not body.disabled and not previous.activated:
        await prepare_invitation(db, request, previous.email)
    user = await locked_user(db, user_id, body.version)
    token = None
    if user.disabled != body.disabled:
        user.disabled = body.disabled
        user.version += 1
        if user.disabled:
            await clear_presidency(db, user_id)
        await revoke_user(db, user)
        user.invitation_token_hash = None
        user.invitation_delivery = "none"
        user.invitation_expires_at = None
        user.invitation_sent_at = None
        if not user.disabled and not user.activated:
            token = await issue_token(db, request, user, "invitation")
    await save(db)
    if token:
        await send_token(db, settings(request), user, token, "invitation")
    return await user_out(db, user_id)


@public_router.post("/forgot-password", response_model=RecoveryOut, status_code=202)
async def forgot_password(
    body: EmailIn, request: Request, background: BackgroundTasks, db: DB
) -> RecoveryOut:
    await throttle(db, request, "recovery", body.email, limit=5, ip_limit=20, seconds=3600)
    user = await db.scalar(select(User).where(User.email == body.email).with_for_update())
    if user is None or user.disabled or not user.activated:
        return RecoveryOut()
    try:
        mail.require_smtp(settings(request))
        token = await issue_token(db, request, user, "recovery")
        await db.commit()
        background.add_task(
            deliver_recovery, request.app.state.sessions, settings(request), user.id, token
        )
    except AppError as error:
        log.error("Password recovery delivery unavailable (%s)", error.code)
    return RecoveryOut()


async def deliver_recovery(
    sessions: async_sessionmaker[AsyncSession], config: Settings, user_id: int, raw: str
) -> None:
    # Respond before SMTP: network latency must not disclose a registered address.
    try:
        async with sessions() as db:
            user = await db.get(User, user_id)
            token = await db.get(UserToken, access_hash(config, "recovery", raw))
            if (
                user is None or user.disabled or not user.activated or token is None
                or token.auth_version != user.auth_version or aware(token.expires_at) <= utcnow()
            ):
                log.info("Recovery delivery cancelled after an account or token change")
                return
            await db.commit()
            await send_token(db, config, user, raw, "recovery")
    except AppError as error:
        log.error("Password recovery delivery unavailable (%s)", error.code)
    except SQLAlchemyError as error:
        log.error("Password recovery storage failed (%s)", type(error).__name__)


async def consume_token(
    body: SetPasswordIn, request: Request, db: AsyncSession, purpose: mail.Purpose
) -> None:
    await throttle(db, request, "token", body.token)
    hashed = access_hash(settings(request), purpose, body.token)
    candidate = (await db.execute(
        select(UserToken.user_id, UserToken.auth_version)
        .where(
            UserToken.token_hash == hashed, UserToken.purpose == purpose,
            UserToken.expires_at > utcnow(),
        )
    )).one_or_none()
    if candidate is None:
        raise AppError("invalid_account_link", 400)
    user_id, version = candidate
    await db.rollback()
    password_hash = await run_in_threadpool(
        bcrypt.hashpw, body.password.encode("utf-8"), bcrypt.gensalt()
    )
    user = await locked_user(db, user_id)
    if (
        user.disabled or user.auth_version != version
        or (purpose == "invitation" and user.activated)
        or (purpose == "recovery" and not user.activated)
    ):
        raise AppError("invalid_account_link", 400)
    consumed = await db.scalar(
        delete(UserToken).where(
            UserToken.token_hash == hashed, UserToken.expires_at > utcnow(),
            UserToken.auth_version == user.auth_version,
        ).returning(UserToken.user_id)
    )
    if consumed is None:
        raise AppError("invalid_account_link", 400)
    user.password_hash = password_hash.decode()
    user.activated = True
    user.version += 1
    user.invitation_token_hash = None
    user.invitation_delivery = "none"
    user.invitation_expires_at = None
    user.invitation_sent_at = None
    await revoke_user(db, user)
    await db.commit()


@public_router.post("/activate", status_code=204)
async def activate(body: SetPasswordIn, request: Request, db: DB) -> None:
    await consume_token(body, request, db, "invitation")


@public_router.post("/reset-password", status_code=204)
async def reset_password(body: SetPasswordIn, request: Request, db: DB) -> None:
    await consume_token(body, request, db, "recovery")
