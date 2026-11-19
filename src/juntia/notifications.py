"""Notifications: the alerts of each account, under the bell at the top of the portal and, on the
devices that turned them on, as push notifications (``push``).

Every kind (``KINDS``) says who receives it and the page it opens. There is one so far:

- ``statement_missing``, for administrators: from the first day of a month (in ``TZ``), the
  ledger has movements from before the previous month but none booked in it, so that month's bank
  statement is still to be imported. It opens the administration, where statements are imported.

``evaluate`` brings the alerts up to date: it creates those that are due, never twice for an
account (``notifications.key``); resolves those whose condition no longer holds, and brings them
back while it holds again; and queues the push notifications of the new ones for the devices of
the accounts that want them. The notifier (``push.Notifier``) runs it every minute; importing or
removing a statement resolves or brings back at once the alerts it settles (``refresh``).

Each account chooses the kinds it wants (``users.notifications_muted`` keeps those it turned off):
a kind turned off is neither listed nor sent. Reading and dismissing are the account's own, and a
dismissed notification never comes back."""

import datetime as dt
import logging
from dataclasses import dataclass
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path, Request
from sqlalchemy import ColumnElement, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import DB, mutation_session, reader_session
from .config import Language, Settings
from .contracts import (
    NOTIFICATION_KINDS,
    NotificationKind,
    NotificationKindOut,
    NotificationOut,
    NotificationPreferenceIn,
    NotificationsOut,
    UserAuthOut,
)
from .db import Notification, PushDelivery, PushSubscription, Transaction, User, aware, utcnow
from .errors import AppError
from .texts import texts

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])
Reader = Annotated[UserAuthOut, Depends(reader_session)]
ItemId = Annotated[int, Path(ge=1, le=2147483647)]

# Resolved and dismissed notifications are forgotten after this long.
KEEP = dt.timedelta(days=90)
# The most notifications listed at once.
MAX_LISTED = 50


@dataclass(frozen=True)
class Kind:
    # Who receives it: every account, or the administrators only.
    audience: Literal["everyone", "administrators"]
    # The page of the portal it opens.
    link: str


KINDS: dict[NotificationKind, Kind] = {
    "statement_missing": Kind(audience="administrators", link="/admin"),
}


def available(administrator: bool) -> list[NotificationKind]:
    """The kinds an account can receive, in the order they are shown."""
    return [
        kind for kind in NOTIFICATION_KINDS
        if administrator or KINDS[kind].audience == "everyone"
    ]


def muted_kinds(value: object) -> set[str]:
    return {kind for kind in value if isinstance(kind, str)} if isinstance(value, list) else set()


# A missing statement -----------------------------------------------------------------------------

def previous_month(today: dt.date) -> dt.date:
    """The first day of the month before ``today``'s."""
    return (today.replace(day=1) - dt.timedelta(days=1)).replace(day=1)


def next_month(month: dt.date) -> dt.date:
    return (month.replace(day=28) + dt.timedelta(days=4)).replace(day=1)


def parse_month(value: object) -> dt.date | None:
    """The first day of a month written ``YYYY-MM``; None if it is not one."""
    if not isinstance(value, str) or len(value) != 7:
        return None
    try:
        return dt.date.fromisoformat(f"{value}-01")
    except ValueError:
        return None


async def missing_statements(db: AsyncSession, months: set[dt.date]) -> set[dt.date]:
    """Those of ``months`` (first days) whose statement is missing: the ledger has movements from
    before the month, and none booked in it."""
    earliest = await db.scalar(select(func.min(Transaction.booking_date)))
    missing: set[dt.date] = set()
    for month in months:
        if earliest is None or earliest >= month:
            continue
        booked = await db.scalar(
            select(Transaction.id)
            .where(Transaction.booking_date >= month, Transaction.booking_date < next_month(month))
            .limit(1)
        )
        if booked is None:
            missing.add(month)
    return missing


def push_text(kind: str, params: dict[str, Any], language: Language) -> tuple[str, str] | None:
    """The title and text of a notification's push message in ``language``; None if its kind or
    its parameters are unknown."""
    text = texts(language)
    if kind == "statement_missing":
        month = parse_month(params.get("month"))
        if month is None:
            return None
        name = text.month_year.format(month=text.months[month.month - 1], year=month.year)
        return text.statement_missing_title.format(month=name), text.statement_missing_body
    return None


# Bringing them up to date ----------------------------------------------------------------------

async def forget(db: AsyncSession, condition: ColumnElement[bool]) -> None:
    """Forget the notifications that meet ``condition``, with their pending push messages (SQLite
    does not cascade). Only reads when there are none, as in most of the notifier's rounds."""
    ids = (await db.scalars(select(Notification.id).where(condition))).all()
    if not ids:
        return
    await db.execute(
        delete(PushDelivery)
        .where(PushDelivery.notification_id.in_(ids))
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(Notification)
        .where(Notification.id.in_(ids))
        .execution_options(synchronize_session=False)
    )


async def create(
    db: AsyncSession,
    user_id: int,
    kind: NotificationKind,
    key: str,
    params: dict[str, str],
    now: dt.datetime,
) -> int | None:
    """Create the notification ``key`` of an account: its id, or None if the account already has it
    (also when another process created it meanwhile)."""
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    return await db.scalar(
        insert(Notification)
        .values(
            user_id=user_id, kind=kind, key=key, params=params, link=KINDS[kind].link,
            created_at=now,
        )
        .on_conflict_do_nothing(index_elements=[Notification.user_id, Notification.key])
        .returning(Notification.id)
    )


async def queue(
    db: AsyncSession, kind: NotificationKind, created: list[tuple[int, int]], now: dt.datetime
) -> None:
    """Queue the push messages of new notifications (id, account) for every device of the accounts
    that did not turn ``kind`` off."""
    accounts = {user_id for _, user_id in created}
    if not accounts:
        return
    muted = {
        user_id: muted_kinds(value)
        for user_id, value in await db.execute(
            select(User.id, User.notifications_muted).where(User.id.in_(accounts))
        )
    }
    devices = (
        await db.execute(
            select(PushSubscription.id, PushSubscription.user_id)
            .where(PushSubscription.user_id.in_(accounts))
            .order_by(PushSubscription.id)
        )
    ).all()
    for notification_id, user_id in created:
        if kind in muted.get(user_id, set()):
            continue
        for device_id, owner in devices:
            if owner == user_id:
                db.add(PushDelivery(
                    notification_id=notification_id, subscription_id=device_id, not_before=now,
                    created_at=now,
                ))


async def recipients_of_statements(db: AsyncSession) -> set[int]:
    """The accounts that receive ``statement_missing``: the active administrators."""
    return set((await db.scalars(select(User.id).where(
        User.administrator.is_(True), User.activated.is_(True), User.disabled.is_(False),
    ))).all())


async def update_statements(
    db: AsyncSession, recipients: set[int], now: dt.datetime, month: dt.date | None = None
) -> set[dt.date]:
    """Resolve the alerts of the months whose statement is no longer missing and bring back the
    others; forget those of accounts that no longer receive them. Returns which of their months,
    and of ``month``, are missing."""
    rows = (await db.scalars(
        select(Notification).where(Notification.kind == "statement_missing")
    )).all()
    gone = [row.id for row in rows if row.user_id not in recipients]
    if gone:
        await forget(db, Notification.id.in_(gone))
    rows = [row for row in rows if row.user_id in recipients]
    months = {
        row_month for row in rows
        if (row_month := parse_month((row.params or {}).get("month"))) is not None
    }
    missing = await missing_statements(db, months | ({month} if month else set()))
    for row in rows:
        if parse_month((row.params or {}).get("month")) in missing:
            if row.resolved_at is not None:
                row.resolved_at = None
        elif row.resolved_at is None:
            row.resolved_at = now
    return missing


async def evaluate(db: AsyncSession, config: Settings, now: dt.datetime | None = None) -> int:
    """Bring every account's notifications up to date at ``now`` (the notifier's round): the
    number created."""
    # In UTC, as every stored time (SQLite keeps them without their offset).
    now = (now or utcnow()).astimezone(dt.timezone.utc)
    await forget(db, or_(
        Notification.resolved_at < now - KEEP, Notification.dismissed_at < now - KEEP,
    ))
    recipients = await recipients_of_statements(db)
    month = previous_month(now.astimezone(ZoneInfo(config.tz)).date())
    missing = await update_statements(db, recipients, now, month)
    created: list[tuple[int, int]] = []
    if month in missing:
        key = f"statement_missing:{month:%Y-%m}"
        have = set((await db.scalars(
            select(Notification.user_id).where(Notification.key == key)
        )).all())
        for user_id in sorted(recipients - have):
            notification_id = await create(
                db, user_id, "statement_missing", key, {"month": f"{month:%Y-%m}"}, now
            )
            if notification_id is not None:
                created.append((notification_id, user_id))
    await queue(db, "statement_missing", created, now)
    await db.commit()
    if created:
        log.info("Statement missing: %d administrator(s) notified", len(created))
    return len(created)


async def refresh(db: AsyncSession) -> None:
    """After importing or removing a statement, resolve at once the alerts it settles and bring
    back those it opens again (the notifier creates new ones in its next round). A failure is only
    logged: the change itself is already saved."""
    try:
        await update_statements(db, await recipients_of_statements(db), utcnow())
        await db.commit()
    except Exception as error:
        await db.rollback()
        log.error("Notifications not updated (%s)", type(error).__name__)


# The account's notifications -------------------------------------------------------------------

def account_id(identity: UserAuthOut) -> int:
    if identity.user_id is None:
        raise AppError("authentication_required", 401)
    return identity.user_id


async def wanted_kinds(
    db: AsyncSession, identity: UserAuthOut
) -> tuple[list[NotificationKind], set[str]]:
    """The kinds the account can receive, and those it turned off."""
    muted = await db.scalar(select(User.notifications_muted).where(User.id == account_id(identity)))
    return available(identity.administrator), muted_kinds(muted)


def listed(user_id: int, kinds: list[NotificationKind]) -> tuple[ColumnElement[bool], ...]:
    """The account's notifications under the bell: of the kinds it wants, neither resolved nor
    dismissed."""
    return (
        Notification.user_id == user_id,
        Notification.kind.in_(kinds),
        Notification.resolved_at.is_(None),
        Notification.dismissed_at.is_(None),
    )


async def notifications_out(db: AsyncSession, identity: UserAuthOut) -> NotificationsOut:
    user_id = account_id(identity)
    kinds, muted = await wanted_kinds(db, identity)
    shown = listed(user_id, [kind for kind in kinds if kind not in muted])
    rows = (await db.scalars(
        select(Notification).where(*shown)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(MAX_LISTED)
    )).all()
    unread = await db.scalar(
        select(func.count()).select_from(Notification).where(*shown, Notification.read_at.is_(None))
    )
    return NotificationsOut(
        kinds=[NotificationKindOut(kind=kind, enabled=kind not in muted) for kind in kinds],
        unread=unread or 0,
        items=[
            NotificationOut(
                id=row.id, kind=row.kind, params=row.params or {}, link=row.link,
                created_at=aware(row.created_at), read=row.read_at is not None,
            )
            for row in rows
        ],
    )


async def owned(db: AsyncSession, identity: UserAuthOut, notification_id: int) -> Notification:
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.user_id == account_id(identity),
    ))
    if row is None:
        raise AppError("notification_not_found", 404)
    return row


@router.get("", response_model=NotificationsOut)
async def notifications(identity: Reader, db: DB) -> NotificationsOut:
    return await notifications_out(db, identity)


@router.post("/read-all", response_model=NotificationsOut)
async def read_all(identity: Reader, db: DB) -> NotificationsOut:
    """Mark every notification under the bell as read."""
    kinds, muted = await wanted_kinds(db, identity)
    await db.execute(
        update(Notification)
        .where(
            *listed(account_id(identity), [kind for kind in kinds if kind not in muted]),
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow())
    )
    await db.commit()
    return await notifications_out(db, identity)


@router.post("/{notification_id}/read", response_model=NotificationsOut)
async def read(notification_id: ItemId, identity: Reader, db: DB) -> NotificationsOut:
    row = await owned(db, identity, notification_id)
    if row.read_at is None:
        row.read_at = utcnow()
        await db.commit()
    return await notifications_out(db, identity)


@router.post("/{notification_id}/dismiss", response_model=NotificationsOut)
async def dismiss(notification_id: ItemId, identity: Reader, db: DB) -> NotificationsOut:
    """Hide a notification for good; its push messages still waiting are not sent."""
    row = await owned(db, identity, notification_id)
    now = utcnow()
    row.read_at = row.read_at or now
    row.dismissed_at = row.dismissed_at or now
    await db.execute(delete(PushDelivery).where(PushDelivery.notification_id == row.id))
    await db.commit()
    return await notifications_out(db, identity)


@router.patch("/preferences", response_model=NotificationsOut)
async def choose(body: NotificationPreferenceIn, request: Request, db: DB) -> NotificationsOut:
    """Turn a kind on or off for the account (the bell and every device)."""
    # The account's row stays locked until the commit, so two devices saving at once keep both.
    identity = await mutation_session(request, db)
    user_id = account_id(identity)
    if body.kind not in available(identity.administrator):
        raise AppError("notification_kind_unavailable", 403)
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE; acquire its write lock before reading the list again.
        await db.execute(
            update(User).where(User.id == user_id)
            .values(notifications_muted=User.notifications_muted)
        )
    user = await db.get(User, user_id, with_for_update=True, populate_existing=True)
    if user is None:
        raise AppError("authentication_required", 401)
    muted = muted_kinds(user.notifications_muted)
    if body.enabled:
        muted.discard(body.kind)
    else:
        muted.add(body.kind)
    user.notifications_muted = sorted(muted) or None
    await db.commit()
    return await notifications_out(db, identity)
