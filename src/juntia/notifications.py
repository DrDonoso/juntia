"""Notifications: what each account is told, under the bell at the top of the portal and, on the
devices that turned them on, as push notifications (``push``).

Every kind (``KINDS``) says who receives it, the section of the portal it belongs to (while that
section is turned off, the kind is neither listed nor sent) and how long its push messages wait.
``key`` says what a notification is about: an account has one notification per key, and each one
opens its own page (``link``).

An alert holds while its condition does: it is resolved when the condition no longer holds, and
comes back while it holds again.

- ``statement_missing``, for administrators: from the first day of a month (in ``TZ``), the ledger
  has movements from before the previous month but none booked in it, so that month's bank
  statement is still to be imported. It opens the administration, where statements are imported.

News tells the active accounts what someone else did, never the account that did it:

- ``accounts_ready``: an imported statement brought movements of the month that ended last (in
  ``TZ``). It opens the Overview of that month, and is resolved while the month has no movements.
- ``action_changes``: an action was created, or its status changed. It opens the action.
- ``action_comments``: comments and PDFs on an action the account follows: one it created, edited,
  commented on or attached a PDF to. It opens the action.
- ``event_changes``: an event that has not ended was created or deleted, or its date, time or
  place changed. It opens the event, and is resolved when the event ends.
- ``event_reminder``: an event starts in 24 hours (an all-day event, the next day), for every
  account, unless its start was set less than 24 hours before (its news told everybody then). It
  is resolved when the event starts, moves or is deleted.

News about a subject an account was already told about brings that notification up to date
(``notify``) instead of adding another: its parameters change (the new status, how many
comments), and it is unread again and at the top, even if it had been dismissed; its push message
replaces the earlier one on the devices. Doing something on a subject reads what the account was
told about it. News is forgotten 90 days after it came; alerts, 90 days after they were resolved
or dismissed.

``evaluate``, the notifier's round (``push.Notifier``, every minute), brings the alerts and the
reminders up to date and resolves the news of the events that ended. Actions and events tell their
news as they change, in the same transaction; importing a statement tells the accounts of its
month, and importing or removing one resolves at once the alerts it settles. The push messages of
what is new are queued for the devices of the accounts that want them: those of the news about
actions and events wait 2 minutes, so that several changes in a row are told once, with the
latest.

Each account chooses the kinds it wants (``users.notifications_muted`` keeps those it turned off):
a kind turned off is neither listed nor sent. Reading and dismissing are the account's own."""

import datetime as dt
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path, Request
from sqlalchemy import ColumnElement, and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from . import queries
from .auth import DB, Actor, mutation_session, reader_session, settings
from .config import Language, Settings
from .contracts import (
    ACTION_STATUSES,
    NOTIFICATION_KINDS,
    FeatureFlags,
    NotificationKind,
    NotificationKindOut,
    NotificationOut,
    NotificationPreferenceIn,
    NotificationsOut,
    UserAuthOut,
)
from .db import (
    ActionEvent,
    CommunityAction,
    CommunityEvent,
    CommunityEventHistory,
    ImportRow,
    Notification,
    PushDelivery,
    PushSubscription,
    Transaction,
    User,
    aware,
    utcnow,
)
from .errors import AppError
from .texts import Texts, texts

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])
Reader = Annotated[UserAuthOut, Depends(reader_session)]
ItemId = Annotated[int, Path(ge=1, le=2147483647)]

# News, and alerts resolved or dismissed, are forgotten after this long.
KEEP = dt.timedelta(days=90)
# The most notifications listed at once.
MAX_LISTED = 50
# The push messages of the news about actions and events wait this long: several changes in a row
# are told once, with the latest.
SETTLE = dt.timedelta(minutes=2)
# Reminders come this long before an event starts.
AHEAD = dt.timedelta(hours=24)


@dataclass(frozen=True)
class Kind:
    # Who receives it: every account, or the administrators only.
    audience: Literal["everyone", "administrators"]
    # News rather than an alert: forgotten 90 days after it came.
    news: bool = True
    # The section of the portal it belongs to: while it is turned off, the kind is neither listed
    # nor sent.
    section: Literal["actions", "events"] | None = None
    # How long its push messages wait.
    delay: dt.timedelta = dt.timedelta(0)


KINDS: dict[NotificationKind, Kind] = {
    "statement_missing": Kind(audience="administrators", news=False),
    "accounts_ready": Kind(audience="everyone"),
    "action_changes": Kind(audience="everyone", section="actions", delay=SETTLE),
    "action_comments": Kind(audience="everyone", section="actions", delay=SETTLE),
    "event_changes": Kind(audience="everyone", section="events", delay=SETTLE),
    "event_reminder": Kind(audience="everyone", section="events"),
}
NEWS = [kind for kind, value in KINDS.items() if value.news]


def section_on(kind: NotificationKind, flags: FeatureFlags) -> bool:
    section = KINDS[kind].section
    return section is None or bool(getattr(flags, section))


def available(administrator: bool, flags: FeatureFlags) -> list[NotificationKind]:
    """The kinds an account can receive while the sections ``flags`` turns on, in the order they
    are shown."""
    return [
        kind for kind in NOTIFICATION_KINDS
        if (administrator or KINDS[kind].audience == "everyone") and section_on(kind, flags)
    ]


def muted_kinds(value: object) -> set[str]:
    return {kind for kind in value if isinstance(kind, str)} if isinstance(value, list) else set()


def number(params: dict[str, Any], name: str) -> int:
    """A count among the parameters of a notification (0 without one)."""
    value = params.get(name)
    return int(value) if isinstance(value, str) and value.isascii() and value.isdigit() else 0


# Months and days ----------------------------------------------------------------------------------

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


def parse_day(value: object) -> dt.date | None:
    """A day written ``YYYY-MM-DD``; None if it is not one."""
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def community_today(config: Settings, now: dt.datetime | None = None) -> dt.date:
    """The community's date (``TZ``)."""
    return (now or utcnow()).astimezone(ZoneInfo(config.tz)).date()


# Push texts ---------------------------------------------------------------------------------------

def contributions(text: Texts, comments: int, attachments: int, author: str) -> str | None:
    """What is new on an action: "New comment by Ana", "3 new comments", "2 new comments and 1 new
    PDF"."""
    if comments + attachments == 1:
        if not author:
            return None
        return (text.comment_added if comments else text.attachment_added).format(author=author)
    told_comments = (text.comments_one if comments == 1 else text.comments_many).format(
        count=comments
    )
    told_attachments = (text.attachments_one if attachments == 1 else text.attachments_many).format(
        count=attachments
    )
    if comments and attachments:
        return text.contributions_both.format(comments=told_comments, attachments=told_attachments)
    if comments or attachments:
        return text.contributions.format(items=told_comments if comments else told_attachments)
    return None


def event_when(text: Texts, params: dict[str, Any], today: dt.date) -> str | None:
    """When and where an event is: "Thursday 4 December, 19:00 · Portal", with the year when it is
    not this one."""
    day = parse_day(params.get("day"))
    if day is None:
        return None
    when = (text.event_day if day.year == today.year else text.event_day_year).format(
        weekday=text.weekdays[day.weekday()], day=day.day, month=text.months[day.month - 1],
        year=day.year,
    )
    when = when[:1].upper() + when[1:]
    time = params.get("time")
    if isinstance(time, str) and time:
        when += f", {time}"
    location = params.get("location")
    if isinstance(location, str) and location:
        when += f" · {location}"
    return when


def push_text(
    kind: str, params: dict[str, Any], language: Language, today: dt.date
) -> tuple[str, str] | None:
    """The title and text of a notification's push message in ``language``, ``today`` being the
    community's date; None if its kind or its parameters are unknown."""
    text = texts(language)
    if kind in ("statement_missing", "accounts_ready"):
        month = parse_month(params.get("month"))
        if month is None:
            return None
        name = text.month_year.format(month=text.months[month.month - 1], year=month.year)
        if kind == "statement_missing":
            return text.statement_missing_title.format(month=name), text.statement_missing_body
        return text.accounts_ready_title.format(month=name), text.accounts_ready_body
    title = params.get("title")
    if not isinstance(title, str) or not title:
        return None
    if kind == "action_changes":
        value = params.get("status")
        if value not in ACTION_STATUSES:
            return None
        status = text.action_statuses[ACTION_STATUSES.index(value)]
        if params.get("change") == "created":
            return (
                text.action_created_title.format(title=title),
                text.action_created_body.format(status=status),
            )
        return title, text.action_status_body.format(status=status)
    if kind == "action_comments":
        body = contributions(
            text, number(params, "comments"), number(params, "attachments"),
            str(params.get("author") or ""),
        )
        return None if body is None else (title, body)
    if kind not in ("event_changes", "event_reminder"):
        return None
    when = event_when(text, params, today)
    if when is None:
        return None
    if kind == "event_reminder":
        day = parse_day(params.get("day"))
        heading = (
            text.reminder_today if day == today
            else text.reminder_tomorrow if day == today + dt.timedelta(days=1)
            else text.reminder
        )
    else:
        found = {
            "created": text.event_created, "changed": text.event_changed,
            "cancelled": text.event_cancelled,
        }.get(str(params.get("change")))
        if found is None:
            return None
        heading = found
    return heading.format(title=title), when


# Telling ----------------------------------------------------------------------------------------

def insert_for(db: AsyncSession) -> Any:
    return pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


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
    link: str,
    now: dt.datetime,
) -> int | None:
    """Create the notification ``key`` of an account: its id, or None if the account already has it
    (also when another process created it meanwhile)."""
    return await db.scalar(
        insert_for(db)(Notification)
        .values(
            user_id=user_id, kind=kind, key=key, params=params, link=link, created_at=now,
        )
        .on_conflict_do_nothing(index_elements=[Notification.user_id, Notification.key])
        .returning(Notification.id)
    )


async def queue(
    db: AsyncSession, kind: NotificationKind, told: list[tuple[int, int]], now: dt.datetime
) -> None:
    """Queue the push messages of notifications that are new or have news (id, account) for every
    device of the accounts that did not turn ``kind`` off, to go after the kind's delay. A message
    still waiting for one of them waits again, to tell the latest."""
    accounts = {user_id for _, user_id in told}
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
    waiting = [
        {
            "notification_id": notification_id, "subscription_id": device_id,
            "not_before": now + KINDS[kind].delay, "attempts": 0, "created_at": now,
        }
        for notification_id, user_id in told if kind not in muted.get(user_id, set())
        for device_id, owner in devices if owner == user_id
    ]
    if waiting:
        statement = insert_for(db)(PushDelivery)
        await db.execute(
            statement.on_conflict_do_update(
                index_elements=[PushDelivery.notification_id, PushDelivery.subscription_id],
                set_={
                    name: getattr(statement.excluded, name)
                    for name in ("not_before", "attempts", "created_at")
                },
            ),
            waiting,
        )


async def active_accounts(db: AsyncSession) -> set[int]:
    """The accounts that receive news: activated and not disabled."""
    return set((await db.scalars(select(User.id).where(
        User.activated.is_(True), User.disabled.is_(False),
    ))).all())


async def notify(
    db: AsyncSession,
    kind: NotificationKind,
    key: str,
    link: str,
    recipients: set[int],
    change: Callable[[dict[str, str] | None], dict[str, str]],
    now: dt.datetime,
) -> None:
    """Tell ``recipients`` news about ``key``. An account without a notification about it gets
    one, with the parameters ``change(None)`` gives; one that has it gets it brought up to date:
    ``change`` gets its parameters while it is still unread (None once read, dismissed or
    resolved, so that it starts again) and gives the new ones, and it is unread again, at the top,
    even if it had been dismissed. Then their push messages are queued."""
    if not recipients:
        return
    rows = {
        row.user_id: row for row in (await db.scalars(
            select(Notification)
            .where(Notification.key == key, Notification.user_id.in_(recipients))
            .with_for_update()
            .execution_options(populate_existing=True)
        )).all()
    }
    told: list[tuple[int, int]] = []
    for user_id in sorted(recipients):
        row = rows.get(user_id)
        if row is None:
            notification_id = await create(db, user_id, kind, key, change(None), link, now)
            if notification_id is not None:
                told.append((notification_id, user_id))
            continue
        unread = row.read_at is None and row.dismissed_at is None and row.resolved_at is None
        row.params = change(dict(row.params or {}) if unread else None)
        row.link = link
        row.created_at = now
        row.read_at = row.dismissed_at = row.resolved_at = None
        told.append((row.id, user_id))
    await db.flush()
    await queue(db, kind, told, now)


async def amend(db: AsyncSession, condition: ColumnElement[bool], params: dict[str, str]) -> None:
    """Bring up to date the parameters of the notifications that meet ``condition`` without
    telling anyone: a new title, for instance."""
    for row in (await db.scalars(
        select(Notification).where(condition).with_for_update()
        .execution_options(populate_existing=True)
    )).all():
        merged = {**(row.params or {}), **params}
        if merged != row.params:
            row.params = merged


async def seen(db: AsyncSession, user_id: int, keys: Sequence[str], now: dt.datetime) -> None:
    """``user_id`` did something on a subject: what it was told about it counts as read."""
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user_id, Notification.key.in_(keys),
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
        .execution_options(synchronize_session=False)
    )


# A missing statement, and the accounts of a month ------------------------------------------------

async def booked(db: AsyncSession, month: dt.date) -> int:
    """How many movements are booked in ``month``."""
    return await db.scalar(
        select(func.count()).select_from(Transaction)
        .where(Transaction.booking_date >= month, Transaction.booking_date < next_month(month))
    ) or 0


async def missing_statements(db: AsyncSession, months: set[dt.date]) -> set[dt.date]:
    """Those of ``months`` (first days) whose statement is missing: the ledger has movements from
    before the month, and none booked in it."""
    earliest = await db.scalar(select(func.min(Transaction.booking_date)))
    missing: set[dt.date] = set()
    for month in months:
        if earliest is None or earliest >= month:
            continue
        found = await db.scalar(
            select(Transaction.id)
            .where(Transaction.booking_date >= month, Transaction.booking_date < next_month(month))
            .limit(1)
        )
        if found is None:
            missing.add(month)
    return missing


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


def overview_link(month: dt.date) -> str:
    """The Overview of ``month``."""
    last = next_month(month) - dt.timedelta(days=1)
    return f"/?start={month.isoformat()}&end={last.isoformat()}"


async def update_accounts(db: AsyncSession, now: dt.datetime) -> None:
    """Resolve the accounts of the months left without movements (their statement was removed),
    and bring back the others."""
    rows = (await db.scalars(
        select(Notification).where(Notification.kind == "accounts_ready")
    )).all()
    months = {
        row_month for row in rows
        if (row_month := parse_month((row.params or {}).get("month"))) is not None
    }
    filled = {month for month in months if await booked(db, month)}
    for row in rows:
        if parse_month((row.params or {}).get("month")) in filled:
            if row.resolved_at is not None:
                row.resolved_at = None
        elif row.resolved_at is None:
            row.resolved_at = now


async def refresh(db: AsyncSession) -> None:
    """After removing a statement, resolve at once the alerts it settles and bring back those it
    opens again (the notifier creates new ones in its next round). A failure is only logged: the
    change itself is already saved."""
    try:
        now = utcnow()
        await update_statements(db, await recipients_of_statements(db), now)
        await update_accounts(db, now)
        await db.commit()
    except Exception as error:
        await db.rollback()
        log.error("Notifications not updated (%s)", type(error).__name__)


async def brought(db: AsyncSession, import_id: str, month: dt.date) -> bool:
    """Whether an import brought movements booked in ``month``: some that no other statement has
    (every movement kept belongs to a statement still imported)."""
    other = aliased(ImportRow)
    found = await db.scalar(
        select(ImportRow.transaction_id)
        .join(Transaction, Transaction.id == ImportRow.transaction_id)
        .where(
            ImportRow.import_id == import_id,
            Transaction.booking_date >= month,
            Transaction.booking_date < next_month(month),
            ~select(other.transaction_id).where(
                other.transaction_id == ImportRow.transaction_id, other.import_id != import_id,
            ).exists(),
        )
        .limit(1)
    )
    return found is not None


async def imported(
    db: AsyncSession, config: Settings, importer: int | None, import_id: str
) -> None:
    """After importing a statement: when it brought movements of the month that ended last, tell
    its accounts to every active account but ``importer`` that was not told yet; then resolve at
    once the alerts it settles. A failure is only logged: the import itself is already saved."""
    try:
        now = utcnow()
        month = previous_month(community_today(config, now))
        if await brought(db, import_id, month):
            key = f"accounts_ready:{month:%Y-%m}"
            have = set((await db.scalars(
                select(Notification.user_id).where(Notification.key == key)
            )).all())
            created: list[tuple[int, int]] = []
            for user_id in sorted(await active_accounts(db) - have - {importer}):
                notification_id = await create(
                    db, user_id, "accounts_ready", key, {"month": f"{month:%Y-%m}"},
                    overview_link(month), now,
                )
                if notification_id is not None:
                    created.append((notification_id, user_id))
            await queue(db, "accounts_ready", created, now)
            if created:
                log.info("Accounts ready: %d account(s) notified", len(created))
        await update_statements(db, await recipients_of_statements(db), now)
        await update_accounts(db, now)
        await db.commit()
    except Exception as error:
        await db.rollback()
        log.error("Notifications not updated (%s)", type(error).__name__)


# Actions ----------------------------------------------------------------------------------------

def action_link(item_id: int) -> str:
    return f"/actions/{item_id}"


def action_keys(item_id: int) -> tuple[str, str]:
    """The keys of what is told about an action: its changes, and its comments and PDFs."""
    return f"action:{item_id}", f"action_comments:{item_id}"


# The history of an action that makes its author follow it: creating it, editing its title,
# description or status, commenting on it or attaching a PDF. Labels alone do not, nor their
# renaming in the catalog, which every action with them records.
FOLLOWING = ("created", "updated", "comment_added", "attachment_added")
EDITED = ("title", "description", "status")


def follows(kind: str, changes: object) -> bool:
    if kind != "updated":
        return kind in FOLLOWING
    return isinstance(changes, list) and any(
        isinstance(change, dict) and change.get("field") in EDITED for change in changes
    )


async def tell_action(
    db: AsyncSession, actor: Actor, item: CommunityAction, *,
    created: bool = False, status: bool = False, title: bool = False,
) -> None:
    """News about an action: it was ``created``, or its ``status`` changed, for every active
    account but ``actor``. A new ``title`` alone tells nobody: it renames what they were told."""
    now = utcnow()
    keys = action_keys(item.id)
    await seen(db, actor.user_id, keys, now)
    if title:
        await amend(db, Notification.key.in_(keys), {"title": item.title})
    if not (created or status):
        return

    def change(told: dict[str, str] | None) -> dict[str, str]:
        # A new action that is still unread stays new, with its current status.
        new = created or (told is not None and told.get("change") == "created")
        return {"title": item.title, "status": item.status, "change": "created" if new else "status"}

    await notify(
        db, "action_changes", keys[0], action_link(item.id),
        await active_accounts(db) - {actor.user_id}, change, now,
    )


async def tell_contribution(
    db: AsyncSession, actor: Actor, item: CommunityAction, *, attachment: bool
) -> None:
    """News about an action: a new comment, or PDF (``attachment``), for the active accounts that
    follow it but ``actor`` (``follows``): those that created it, edited it, commented on it or
    attached a PDF to it. How many came since they last read it, and who sent the latest."""
    now = utcnow()
    keys = action_keys(item.id)
    await seen(db, actor.user_id, keys, now)
    followers = {
        user_id for user_id, kind, changes in (await db.execute(
            select(ActionEvent.author_user_id, ActionEvent.kind, ActionEvent.changes).where(
                ActionEvent.action_id == item.id,
                ActionEvent.author_kind == "resident",
                ActionEvent.kind.in_(FOLLOWING),
            )
        )).all()
        if user_id is not None and follows(kind, changes)
    }

    def change(told: dict[str, str] | None) -> dict[str, str]:
        counts = told or {}
        return {
            "title": item.title,
            "comments": str(number(counts, "comments") + (0 if attachment else 1)),
            "attachments": str(number(counts, "attachments") + (1 if attachment else 0)),
            "author": actor.name,
        }

    await notify(
        db, "action_comments", keys[1], action_link(item.id),
        (followers & await active_accounts(db)) - {actor.user_id}, change, now,
    )


# Events -----------------------------------------------------------------------------------------

EventChange = Literal["created", "changed", "cancelled"]


def event_link(event_id: int) -> str:
    return f"/events/{event_id}"


def event_key(event_id: int) -> str:
    return f"event:{event_id}"


def key_event(key: str) -> int | None:
    """The event a key of its news or of its reminders is about."""
    parts = key.split(":")
    if len(parts) > 1 and parts[0] in ("event", "event_reminder") and parts[1].isdigit():
        return int(parts[1])
    return None


def event_start(event: CommunityEvent, zone: ZoneInfo) -> dt.datetime:
    """When an event starts: an all-day event, at midnight of its first day in ``zone``."""
    if event.all_day:
        assert event.starts_on is not None
        return dt.datetime.combine(event.starts_on, dt.time(), zone)
    assert event.starts_at is not None
    return aware(event.starts_at)


def event_ended(event: CommunityEvent, now: dt.datetime, zone: ZoneInfo) -> bool:
    """Whether an event has ended, as in the agenda: an all-day event, at the end of its last
    day."""
    if event.all_day:
        assert event.ends_on is not None
        return event.ends_on <= now.astimezone(zone).date()
    assert event.ends_at is not None
    return aware(event.ends_at) <= now


def event_params(event: CommunityEvent, zone: ZoneInfo) -> dict[str, str]:
    """What the texts about an event need: its title, the day and time it starts in ``zone`` (no
    time all day) and its place."""
    start = event_start(event, zone).astimezone(zone)
    return {
        "title": event.title, "day": start.date().isoformat(),
        "time": "" if event.all_day else f"{start:%H:%M}", "location": event.location,
    }


def reminder_key(event: CommunityEvent, zone: ZoneInfo) -> str:
    """The key of the reminder of an event's current start: another start, another reminder."""
    params = event_params(event, zone)
    return f"event_reminder:{event.id}:{params['day']}" + (
        f"T{params['time']}" if params["time"] else ""
    )


def reminder_time(event: CommunityEvent, zone: ZoneInfo) -> dt.datetime:
    """When the reminder of an event comes: 24 hours before it starts; for an all-day event, at
    midnight of the day before."""
    if event.all_day:
        assert event.starts_on is not None
        return dt.datetime.combine(event.starts_on - dt.timedelta(days=1), dt.time(), zone)
    return event_start(event, zone) - AHEAD


async def tell_event(
    db: AsyncSession, config: Settings, actor: Actor, event: CommunityEvent,
    change: EventChange | None,
) -> None:
    """News about an event that has not ended: ``created``, deleted (``cancelled``), or a new date,
    time or place (``changed``), for every active account but ``actor``. Other changes (None) tell
    nobody: they bring up to date what was told about it. Its reminders follow it: a new start or
    its deletion resolves them."""
    now = utcnow()
    zone = ZoneInfo(config.tz)
    key = event_key(event.id)
    await seen(db, actor.user_id, (key,), now)
    params = event_params(event, zone)
    current = reminder_key(event, zone)
    for row in (await db.scalars(
        select(Notification)
        .where(
            Notification.kind == "event_reminder", Notification.resolved_at.is_(None),
            Notification.key.startswith(f"event_reminder:{event.id}:", autoescape=True),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )).all():
        if event.deleted_at is not None or row.key != current:
            row.resolved_at = now
        elif {**(row.params or {}), **params} != row.params:
            row.params = {**(row.params or {}), **params}
    if change is None or event_ended(event, now, zone):
        await amend(db, Notification.key == key, params)
        return
    told_change: EventChange = change

    def news(told: dict[str, str] | None) -> dict[str, str]:
        # A new event that is still unread stays new, unless it is cancelled.
        new = told_change == "created" or (
            told_change == "changed" and told is not None and told.get("change") == "created"
        )
        return {**params, "change": "created" if new else told_change}

    await notify(
        db, "event_changes", key, event_link(event.id),
        await active_accounts(db) - {actor.user_id}, news, now,
    )


def start_of(snapshot: object) -> tuple[object, ...]:
    """The start an event had in a snapshot of its history."""
    values = snapshot if isinstance(snapshot, dict) else {}
    return tuple(values.get(name) for name in ("all_day", "starts_at", "starts_on"))


async def set_late(
    db: AsyncSession, events: Sequence[CommunityEvent], zone: ZoneInfo
) -> set[int]:
    """Those of ``events`` whose current start was set after their reminder was due: when they
    were created, or when they last moved (their news told everybody then)."""
    if not events:
        return set()
    set_at = {event.id: aware(event.created_at) for event in events}
    for event_id, created_at, before, after in (await db.execute(
        select(
            CommunityEventHistory.event_id, CommunityEventHistory.created_at,
            CommunityEventHistory.before, CommunityEventHistory.after,
        ).where(
            CommunityEventHistory.event_id.in_(list(set_at)),
            CommunityEventHistory.kind == "updated",
        )
    )).all():
        if start_of(before) != start_of(after):
            set_at[event_id] = max(set_at[event_id], aware(created_at))
    return {event.id for event in events if set_at[event.id] > reminder_time(event, zone)}


async def remind(db: AsyncSession, config: Settings, now: dt.datetime) -> int:
    """Remind every active account that does not have it yet of the events that start in the next
    24 hours (all-day events: the next day): the number of reminders created."""
    zone = ZoneInfo(config.tz)
    tomorrow = now.astimezone(zone).date() + dt.timedelta(days=1)
    events = (await db.scalars(
        select(CommunityEvent)
        .where(
            CommunityEvent.deleted_at.is_(None),
            or_(
                and_(
                    CommunityEvent.all_day.is_(False), CommunityEvent.starts_at > now,
                    CommunityEvent.starts_at <= now + AHEAD,
                ),
                and_(CommunityEvent.all_day.is_(True), CommunityEvent.starts_on == tomorrow),
            ),
        )
        .order_by(CommunityEvent.id)
    )).all()
    if not events:
        return 0
    keys = {event.id: reminder_key(event, zone) for event in events}
    have: dict[str, set[int]] = {}
    for key, user_id in (await db.execute(
        select(Notification.key, Notification.user_id)
        .where(Notification.key.in_(list(keys.values())))
    )).all():
        have.setdefault(key, set()).add(user_id)
    recipients = await active_accounts(db)
    due = [event for event in events if recipients - have.get(keys[event.id], set())]
    late = await set_late(db, due, zone)
    created: list[tuple[int, int]] = []
    for event in due:
        if event.id in late:
            continue
        key = keys[event.id]
        for user_id in sorted(recipients - have.get(key, set())):
            notification_id = await create(
                db, user_id, "event_reminder", key, event_params(event, zone),
                event_link(event.id), now,
            )
            if notification_id is not None:
                created.append((notification_id, user_id))
    await queue(db, "event_reminder", created, now)
    return len(created)


async def settle_events(db: AsyncSession, config: Settings, now: dt.datetime) -> None:
    """Resolve the news of the events that ended, and the reminders of those that started, moved
    or were deleted."""
    zone = ZoneInfo(config.tz)
    keys = (await db.scalars(
        select(Notification.key).distinct().where(
            Notification.kind.in_(("event_changes", "event_reminder")),
            Notification.resolved_at.is_(None),
        )
    )).all()
    ids = {event_id for key in keys if (event_id := key_event(key)) is not None}
    if not ids:
        return
    events = {
        event.id: event for event in (await db.scalars(
            select(CommunityEvent).where(CommunityEvent.id.in_(ids))
        )).all()
    }
    settled: list[str] = []
    for key in keys:
        event_id = key_event(key)
        event = events.get(event_id) if event_id is not None else None
        if event is None:
            settled.append(key)
        elif key.startswith("event:"):
            if event_ended(event, now, zone):
                settled.append(key)
        elif (
            event.deleted_at is not None or key != reminder_key(event, zone)
            or event_start(event, zone) <= now
        ):
            settled.append(key)
    if settled:
        await db.execute(
            update(Notification)
            .where(Notification.key.in_(settled), Notification.resolved_at.is_(None))
            .values(resolved_at=now)
            .execution_options(synchronize_session=False)
        )


# The notifier's round ---------------------------------------------------------------------------

async def evaluate(db: AsyncSession, config: Settings, now: dt.datetime | None = None) -> int:
    """Bring every account's notifications up to date at ``now`` (the notifier's round): the
    number created."""
    # In UTC, as every stored time (SQLite keeps them without their offset).
    now = (now or utcnow()).astimezone(dt.timezone.utc)
    await forget(db, or_(
        Notification.resolved_at < now - KEEP, Notification.dismissed_at < now - KEEP,
        and_(Notification.kind.in_(NEWS), Notification.created_at < now - KEEP),
    ))
    recipients = await recipients_of_statements(db)
    month = previous_month(community_today(config, now))
    missing = await update_statements(db, recipients, now, month)
    created: list[tuple[int, int]] = []
    if month in missing:
        key = f"statement_missing:{month:%Y-%m}"
        have = set((await db.scalars(
            select(Notification.user_id).where(Notification.key == key)
        )).all())
        for user_id in sorted(recipients - have):
            notification_id = await create(
                db, user_id, "statement_missing", key, {"month": f"{month:%Y-%m}"}, "/admin", now
            )
            if notification_id is not None:
                created.append((notification_id, user_id))
    await queue(db, "statement_missing", created, now)
    reminded = await remind(db, config, now) if (await queries.feature_flags(db)).events else 0
    await settle_events(db, config, now)
    await db.commit()
    if created:
        log.info("Statement missing: %d administrator(s) notified", len(created))
    if reminded:
        log.info("Event reminders: %d account(s) notified", reminded)
    return len(created) + reminded


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
    return available(identity.administrator, await queries.feature_flags(db)), muted_kinds(muted)


def listed(user_id: int, kinds: list[NotificationKind]) -> tuple[ColumnElement[bool], ...]:
    """The account's notifications under the bell: of the kinds it wants, neither resolved nor
    dismissed."""
    return (
        Notification.user_id == user_id,
        Notification.kind.in_(kinds),
        Notification.resolved_at.is_(None),
        Notification.dismissed_at.is_(None),
    )


async def notifications_out(
    db: AsyncSession, identity: UserAuthOut, config: Settings
) -> NotificationsOut:
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
        today=community_today(config),
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
async def notifications(identity: Reader, request: Request, db: DB) -> NotificationsOut:
    return await notifications_out(db, identity, settings(request))


@router.post("/read-all", response_model=NotificationsOut)
async def read_all(identity: Reader, request: Request, db: DB) -> NotificationsOut:
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
    return await notifications_out(db, identity, settings(request))


@router.post("/{notification_id}/read", response_model=NotificationsOut)
async def read(
    notification_id: ItemId, identity: Reader, request: Request, db: DB
) -> NotificationsOut:
    row = await owned(db, identity, notification_id)
    if row.read_at is None:
        row.read_at = utcnow()
        await db.commit()
    return await notifications_out(db, identity, settings(request))


@router.post("/{notification_id}/dismiss", response_model=NotificationsOut)
async def dismiss(
    notification_id: ItemId, identity: Reader, request: Request, db: DB
) -> NotificationsOut:
    """Hide a notification until it has news; its push messages still waiting are not sent."""
    row = await owned(db, identity, notification_id)
    now = utcnow()
    row.read_at = row.read_at or now
    row.dismissed_at = row.dismissed_at or now
    await db.execute(delete(PushDelivery).where(PushDelivery.notification_id == row.id))
    await db.commit()
    return await notifications_out(db, identity, settings(request))


@router.patch("/preferences", response_model=NotificationsOut)
async def choose(body: NotificationPreferenceIn, request: Request, db: DB) -> NotificationsOut:
    """Turn a kind on or off for the account (the bell and every device)."""
    # The account's row stays locked until the commit, so two devices saving at once keep both.
    identity = await mutation_session(request, db)
    user_id = account_id(identity)
    if body.kind not in available(identity.administrator, await queries.feature_flags(db)):
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
    return await notifications_out(db, identity, settings(request))
