"""Push notifications: the devices that turned them on, and the notifier that sends them.

A browser, or the portal installed on a phone's Home Screen, registers from My profile
(``PUT /api/push/subscription``) with its push service's address and keys (``webpush``) and the
language of its interface; the interface registers it again every time it opens, so its language,
its session and the server's key stay current. A device belongs to the account and the session that
registered it: signing out there forgets it, and so do a new password, closing every session, and
a disabled or deleted account, until it registers again. A session that just expires does not, so
that a phone keeps receiving them between visits.

``Notifier`` does a round every minute: it brings the notifications up to date
(``notifications.evaluate``), then sends the push messages waiting (``push_deliveries``) between
9:00 and 21:00 in ``TZ`` (a server that was down at nine sends them when it is back). A message
that fails is tried again after 2, 5, 15, 30 and 60 minutes. It is dropped once its notification is
read, dismissed or resolved, or its kind turned off, and after three days. A device its push
service no longer knows, or that refused three messages in a row, is forgotten.

The messages use the declarative format (``"web_push": 8030``) that Safari shows by itself since
iOS 18.4; the service worker of the interface (``frontend/public/sw.js``) shows them everywhere
else. The image runs one process; should several run, each message is claimed before it is sent,
so that only one of them sends it."""

import asyncio
import datetime as dt
import logging
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from sqlalchemy import and_, delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from . import notifications, webpush
from .auth import DB, CurrentUser, session_hash, settings
from .config import Language, Settings, normalize_origin
from .contracts import PushConfigOut, PushEndpointIn, PushSubscriptionIn
from .db import (
    Notification,
    PushDelivery,
    PushSubscription,
    User,
    aware,
    forget_devices,
    utcnow,
)
from .errors import AppError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/push", tags=["Notifications"])

# Push messages are sent between these hours of the community's day.
NOTIFY_FROM = dt.time(9, 0)
NOTIFY_UNTIL = dt.time(21, 0)
TICK_SECONDS = 60
# Minutes to wait before trying again after a push service or the network failed (the last one
# repeats).
RETRY_MINUTES = (2, 5, 15, 30, 60)
# Messages in a row a push service may refuse for a device before it is forgotten (it registers
# again the next time the portal opens there).
MAX_FAILURES = 3
# Devices kept per account: registering one more forgets the one unused for longest.
MAX_DEVICES = 20
# A message still waiting this long after its notification appeared is dropped.
EXPIRY = dt.timedelta(days=3)
# How long a round has to send a message it claimed before another round may take it.
CLAIM = dt.timedelta(minutes=2)
# How long stopping the app waits for the round in progress (push services answer within
# webpush.TIMEOUT_SECONDS).
STOP_SECONDS = 5.0


def notifier(request: Request) -> "Notifier":
    return request.app.state.notifier


def request_origin(request: Request) -> str:
    """The address of the portal the device uses: the Origin of its request, one of PUBLIC_ORIGIN
    (the middleware refuses any other)."""
    origins = settings(request).public_origins
    try:
        origin = normalize_origin(request.headers.get("origin", ""))
    except ValueError:
        return origins[0]
    return origin if origin in origins else origins[0]


@router.get("", response_model=PushConfigOut)
async def push_config(request: Request, user_id: CurrentUser) -> PushConfigOut:
    return PushConfigOut(public_key=notifier(request).sender.public_key)


@router.put("/subscription", status_code=204)
async def subscribe(
    body: PushSubscriptionIn, request: Request, user_id: CurrentUser, db: DB
) -> None:
    """Register this device for the account's notifications, or refresh its registration. An
    address another account registered becomes this one's (someone else signed in there), without
    what was waiting for the other. 422 ``push_service_unsupported``: the browser uses a push
    service Juntia does not send to."""
    if webpush.push_service(body.endpoint) is None:
        raise AppError("push_service_unsupported", 422)
    try:
        webpush.browser_key(body.keys.p256dh)
        webpush.auth_secret(body.keys.auth)
    except ValueError:
        raise AppError("invalid_request", 422) from None
    previous = await db.scalar(
        select(PushSubscription.user_id).where(PushSubscription.endpoint == body.endpoint)
    )
    if previous is not None and previous != user_id:
        await db.execute(delete(PushDelivery).where(PushDelivery.subscription_id.in_(
            select(PushSubscription.id).where(PushSubscription.endpoint == body.endpoint)
        )))
    now = utcnow()
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    statement = insert(PushSubscription).values(
        user_id=user_id,
        session_hash=session_hash(request),
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        origin=request_origin(request),
        locale=body.locale,
        failures=0,
        created_at=now,
        updated_at=now,
    )
    await db.execute(statement.on_conflict_do_update(
        index_elements=[PushSubscription.endpoint],
        set_={
            name: getattr(statement.excluded, name)
            for name in (
                "user_id", "session_hash", "p256dh", "auth", "origin", "locale", "failures",
                "updated_at",
            )
        },
    ))
    unused = (await db.scalars(
        select(PushSubscription.id)
        .where(PushSubscription.user_id == user_id)
        .order_by(PushSubscription.updated_at.desc(), PushSubscription.id.desc())
        .offset(MAX_DEVICES)
    )).all()
    if unused:
        await forget_devices(db, PushSubscription.id.in_(unused))
    await db.commit()


@router.post("/unsubscribe", status_code=204)
async def unsubscribe(body: PushEndpointIn, user_id: CurrentUser, db: DB) -> None:
    """Stop the notifications of this device (nothing happens unless the account registered it)."""
    await forget_devices(db, and_(
        PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == user_id,
    ))
    await db.commit()


def message(notification: Notification, origin: str, locale: Language) -> dict[str, Any] | None:
    """The declarative push message of a notification, which opens its page of ``origin``; None
    if it cannot be told. Its title says what it is about, never the portal's name: iOS adds
    "from <the community's name>" under the title of every notification."""
    text = notifications.push_text(notification.kind, notification.params or {}, locale)
    if text is None:
        return None
    title, body = text
    return {
        "web_push": 8030,
        "notification": {
            "title": title,
            "body": body,
            "lang": locale,
            "dir": "ltr",
            "navigate": origin + notification.link,
            "tag": notification.key,
            "silent": False,
            "icon": f"{origin}/icons/icon-192.png",
            # Android's status bar (a white silhouette); Safari ignores it.
            "badge": f"{origin}/icons/badge-96.png",
        },
    }


@dataclass(frozen=True)
class Due:
    """A push message to send now, claimed by this round."""

    delivery_id: int
    subscription_id: int
    subscription: webpush.Subscription
    message: dict[str, Any]
    attempts: int
    # Seconds the push service keeps it for an unreachable device: until the end of the window.
    ttl: int
    topic: str


class Notifier:
    """Brings the notifications up to date and sends their push messages (see the module's
    description): ``tick`` does one round, ``start``/``stop`` run one every minute in the app's
    process."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        config: Settings,
        sender: webpush.WebPush | None = None,
    ) -> None:
        self.sessions = sessions
        self.config = config
        self.sender = sender or webpush.WebPush(config)
        self.zone = ZoneInfo(config.tz)
        self.task: asyncio.Task[None] | None = None
        self.stopping = asyncio.Event()

    async def start(self) -> None:
        self.stopping = asyncio.Event()
        self.task = asyncio.create_task(self.run(), name="juntia-notifications")

    async def stop(self) -> None:
        """Let the round in progress end (a round cancelled in a transaction could leave SQLite
        locked), cancelling it only after ``STOP_SECONDS``."""
        if self.task is not None:
            self.stopping.set()
            try:
                await asyncio.wait_for(self.task, STOP_SECONDS)
            except (TimeoutError, asyncio.CancelledError):
                pass
            self.task = None
        await self.sender.close()

    async def run(self) -> None:
        while not self.stopping.is_set():
            try:
                await self.tick()
            except Exception as error:
                log.error("Notifications not sent (%s)", type(error).__name__)
            # Just after the start of each minute.
            with suppress(TimeoutError):
                await asyncio.wait_for(
                    self.stopping.wait(), TICK_SECONDS - time.time() % TICK_SECONDS + 1
                )

    def window_end(self, now: dt.datetime) -> dt.datetime | None:
        """The end of today's window to send push messages, if ``now`` is inside it."""
        local = now.astimezone(self.zone)
        if not NOTIFY_FROM <= local.time() < NOTIFY_UNTIL:
            return None
        return dt.datetime.combine(local.date(), NOTIFY_UNTIL, self.zone)

    async def tick(self, now: dt.datetime | None = None) -> None:
        """Bring the notifications up to date at ``now`` and send the push messages due."""
        # In UTC, as every stored time (SQLite keeps them without their offset).
        now = (now or utcnow()).astimezone(dt.timezone.utc)
        async with self.sessions() as db:
            await notifications.evaluate(db, self.config, now)
        results: list[tuple[Due, webpush.Outcome]] = []
        gone: set[int] = set()
        for item in await self.due(now):
            # Its push service forgot the device: what else was waiting for it goes with it.
            if item.subscription_id in gone:
                continue
            result = await self.deliver(item)
            if result == "gone":
                gone.add(item.subscription_id)
            results.append((item, result))
        if results:
            await self.record(now, results)

    async def due(self, now: dt.datetime) -> list[Due]:
        """Drop the messages no longer wanted, and claim those to send now."""
        end = self.window_end(now)
        dropped: list[int] = []
        due: list[Due] = []
        async with self.sessions() as db:
            rows = (await db.execute(
                select(PushDelivery, Notification, PushSubscription, User)
                .join(Notification, Notification.id == PushDelivery.notification_id)
                .join(PushSubscription, PushSubscription.id == PushDelivery.subscription_id)
                .join(User, User.id == Notification.user_id)
                .order_by(PushDelivery.id)
            )).all()
            for delivery, notification, device, user in rows:
                if (
                    notification.read_at is not None
                    or notification.dismissed_at is not None
                    or notification.resolved_at is not None
                    or device.user_id != notification.user_id
                    or user.disabled
                    or notification.kind not in notifications.available(user.administrator)
                    or notification.kind in notifications.muted_kinds(user.notifications_muted)
                    or aware(delivery.created_at) + EXPIRY <= now
                ):
                    dropped.append(delivery.id)
                    continue
                if end is None or aware(delivery.not_before) > now:
                    continue
                content = message(notification, device.origin, cast(Language, device.locale))
                if content is None:
                    dropped.append(delivery.id)
                    continue
                claimed = await db.scalar(
                    update(PushDelivery)
                    .where(PushDelivery.id == delivery.id, PushDelivery.not_before <= now)
                    .values(not_before=now + CLAIM)
                    .returning(PushDelivery.id)
                    .execution_options(synchronize_session=False)
                )
                if claimed is None:
                    continue
                due.append(Due(
                    delivery_id=delivery.id,
                    subscription_id=device.id,
                    subscription=webpush.Subscription(device.endpoint, device.p256dh, device.auth),
                    message=content,
                    attempts=delivery.attempts,
                    ttl=max(60, int((end - now).total_seconds())),
                    topic=f"notification-{notification.id}",
                ))
            if dropped:
                await db.execute(delete(PushDelivery).where(PushDelivery.id.in_(dropped)))
            await db.commit()
        return due

    async def deliver(self, item: Due) -> webpush.Outcome:
        """Send one push message; never fails (a device that cannot be told now is tried again
        later, and the others are told all the same)."""
        try:
            return await self.sender.send(
                item.subscription, item.message, ttl=item.ttl, topic=item.topic
            )
        except Exception as error:
            log.error("Notification not sent to a device (%s)", type(error).__name__)
            return "retry"

    async def record(self, now: dt.datetime, results: list[tuple[Due, webpush.Outcome]]) -> None:
        async with self.sessions() as db:
            for item, result in results:
                if result == "retry":
                    attempts = item.attempts + 1
                    wait = RETRY_MINUTES[min(attempts, len(RETRY_MINUTES)) - 1]
                    await db.execute(
                        update(PushDelivery)
                        .where(PushDelivery.id == item.delivery_id)
                        .values(attempts=attempts, not_before=now + dt.timedelta(minutes=wait))
                    )
                    continue
                if result == "gone":
                    await forget_devices(db, PushSubscription.id == item.subscription_id)
                    continue
                await db.execute(delete(PushDelivery).where(PushDelivery.id == item.delivery_id))
                await db.execute(
                    update(PushSubscription)
                    .where(PushSubscription.id == item.subscription_id)
                    .values(
                        failures=0 if result == "delivered" else PushSubscription.failures + 1
                    )
                )
            await forget_devices(db, PushSubscription.failures >= MAX_FAILURES)
            await db.commit()
        told = sum(result == "delivered" for _, result in results)
        if told:
            log.info("Notifications sent to %d device(s)", told)
