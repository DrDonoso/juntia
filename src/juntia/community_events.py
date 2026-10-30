import math
from collections.abc import Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic_core import ErrorDetails
from sqlalchemy import Date, DateTime, Integer, Text, case, cast, func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from starlette.responses import Response

from . import event_calendar, queries
from .auth import DB, mutation_session, reader_session, settings
from .config import Language, Settings
from .contracts import (
    ActorOut,
    EventActionOut,
    EventAgendaPage,
    EventCalendarOut,
    EventConfigOut,
    EventEdit,
    EventHistoryOut,
    EventHistoryPage,
    EventIn,
    EventOccurrenceOut,
    EventOut,
    EventPage,
    EventSnapshot,
    UserAuthOut,
    VersionIn,
)
from .db import CommunityAction, CommunityEvent, CommunityEventHistory, aware, utcnow
from .errors import AppError
from .query_sql import CALENDAR_EPOCH, contains_text, date_number, fold_sql, fold_text
from .texts import ServerLanguage, author_name, public_actor

PAGE_SIZE = 20
ItemId = Annotated[int, Path(ge=1, le=2147483647)]
PageNumber = Annotated[int, Query(ge=1, le=1000000)]
OptionalPageNumber = Annotated[int | None, Query(ge=1, le=1000000)]
EventScope = Literal["upcoming", "past", "all", "deleted"]


async def require_events_enabled(db: DB) -> None:
    if not (await queries.feature_flags(db)).events:
        raise AppError("events_disabled", 404)


router = APIRouter(
    prefix="/api/events", tags=["Community events"],
    dependencies=[Depends(reader_session), Depends(require_events_enabled)],
)


def validation_fields(errors: Sequence[ErrorDetails]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for error in errors:
        location = error["loc"]
        if not location or location[0] != "body":
            continue
        if error["type"] == "event_interval_invalid":
            fields["interval"] = "event_interval_invalid"
        elif len(location) > 1 and location[1] in EventIn.model_fields:
            fields[str(location[1])] = (
                "event_interval_invalid" if location[1] in (
                    "starts_at", "ends_at", "starts_on", "ends_on", "all_day",
                ) else "event_field_invalid"
            )
    return fields


def page_count(total: int) -> int:
    return max(1, math.ceil(total / PAGE_SIZE))


def page_info(total: int, page: int) -> dict[str, int]:
    return {"total": total, "page": page, "pages": page_count(total)}


def event_conditions(
    db: AsyncSession, scope: EventScope, q: str, action_id: int | None,
    now: datetime, today: date,
) -> list[ColumnElement[bool]]:
    where: list[ColumnElement[bool]] = [
        CommunityEvent.deleted_at.is_not(None) if scope == "deleted"
        else CommunityEvent.deleted_at.is_(None),
    ]
    if scope in ("upcoming", "past"):
        pending = or_(CommunityEvent.ends_at > now, CommunityEvent.ends_on > today)
        # NULL dates belong to the other schedule variant; avoid negating a nullable predicate.
        past = or_(CommunityEvent.ends_at <= now, CommunityEvent.ends_on <= today)
        where.append(pending if scope == "upcoming" else past)
    if action_id is not None:
        where.append(CommunityEvent.action_id == action_id)
    if q.strip():
        where.append(contains_text(db, fold_sql(db, CommunityEvent.title), fold_text(q.strip())))
    return where


def has_ended(value: EventOut, now: datetime, today: date) -> bool:
    # Same rule as the "past" scope.
    if value.all_day:
        return value.ends_on is not None and value.ends_on <= today
    return value.ends_at is not None and value.ends_at <= now


def local_to_utc(value: datetime, zone: ZoneInfo, field: str) -> datetime:
    try:
        candidates = {
            value.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
            for fold in (0, 1)
        }
        valid = {
            instant for instant in candidates
            if instant.astimezone(zone).replace(tzinfo=None) == value
        }
    except (OverflowError, ValueError):
        raise AppError("event_interval_invalid", 422, fields={
            field: "event_interval_invalid",
        }) from None
    if len(valid) != 1:
        code = "event_time_ambiguous" if valid else "event_time_nonexistent"
        raise AppError(code, 422, fields={field: code})
    return valid.pop()


def set_fields(value: CommunityEvent, body: EventIn, config: Settings) -> None:
    if body.timezone != config.tz:
        raise AppError("event_timezone_changed", 409)
    value.title, value.description, value.location = body.title, body.description, body.location
    value.all_day = body.all_day
    value.starts_on, value.ends_on = body.starts_on, body.ends_on
    if body.all_day:
        value.starts_at = value.ends_at = None
    else:
        assert body.starts_at is not None and body.ends_at is not None
        zone = ZoneInfo(config.tz)
        value.starts_at = local_to_utc(body.starts_at, zone, "starts_at")
        value.ends_at = local_to_utc(body.ends_at, zone, "ends_at")
        if value.ends_at <= value.starts_at:
            raise AppError("event_interval_invalid", 422, fields={
                "ends_at": "event_interval_invalid",
            })


async def set_action(db: AsyncSession, value: CommunityEvent, body: EventIn) -> None:
    if "action_id" not in body.model_fields_set:
        return
    if not (await queries.feature_flags(db)).actions:
        raise AppError("actions_disabled", 404)
    if body.action_id is not None:
        found = await db.scalar(select(CommunityAction.id).where(
            CommunityAction.id == body.action_id,
        ))
        if found is None:
            raise AppError("event_action_not_found", 422, fields={
                "action_id": "event_action_not_found",
            })
    value.action_id = body.action_id


async def get_event(
    db: AsyncSession, event_id: int, *, lock: bool = False, active: bool = False,
) -> CommunityEvent:
    if lock:
        found = await db.scalar(update(CommunityEvent).where(
            CommunityEvent.id == event_id,
        ).values(version=CommunityEvent.version).returning(CommunityEvent.id))
        if found is None:
            raise AppError("event_not_found", 404)
    value = await db.get(CommunityEvent, event_id, populate_existing=True)
    if value is None:
        raise AppError("event_not_found", 404)
    if active and value.deleted_at is not None:
        raise AppError("event_deleted", 409)
    return value


async def render_events(
    db: AsyncSession, values: list[CommunityEvent], *, links: bool, language: Language,
) -> list[EventOut]:
    actions: dict[int, EventActionOut] = {}
    ids = {value.action_id for value in values if value.action_id is not None}
    if links and ids:
        actions = {
            key: EventActionOut(id=key, title=title)
            for key, title in (await db.execute(select(
                CommunityAction.id, CommunityAction.title,
            ).where(CommunityAction.id.in_(ids)))).all()
        }
    return [EventOut(
        id=value.id, title=value.title, description=value.description, location=value.location,
        all_day=value.all_day, starts_at=aware(value.starts_at) if value.starts_at else None,
        ends_at=aware(value.ends_at) if value.ends_at else None,
        starts_on=value.starts_on, ends_on=value.ends_on,
        action=actions.get(value.action_id) if value.action_id else None,
        version=value.version, author=ActorOut(
            kind=value.author_kind, user_id=value.author_user_id,
            name=author_name(value.author_kind, value.author_name, language),
        ),
        created_at=aware(value.created_at), updated_at=aware(value.updated_at),
        deleted_at=aware(value.deleted_at) if value.deleted_at else None,
    ) for value in values]


async def render_event(
    db: AsyncSession, value: CommunityEvent, *, links: bool, language: Language,
) -> EventOut:
    return (await render_events(db, [value], links=links, language=language))[0]


def snapshot(value: EventOut) -> EventSnapshot:
    return EventSnapshot.model_validate(value.model_dump(include=set(EventSnapshot.model_fields)))


def record_history(
    db: AsyncSession, value: CommunityEvent, actor: UserAuthOut,
    kind: Literal["created", "updated", "deleted"],
    before: EventSnapshot | None, after: EventSnapshot | None,
) -> None:
    db.add(CommunityEventHistory(
        event_id=value.id, kind=kind, author_kind=actor.kind,
        author_user_id=actor.user_id, author_name=actor.name,
        before=before.model_dump(mode="json") if before else None,
        after=after.model_dump(mode="json") if after else None,
    ))


@router.get("/config", response_model=EventConfigOut)
async def configuration(request: Request) -> EventConfigOut:
    return EventConfigOut(timezone=settings(request).tz)


@router.get("", response_model=EventPage)
async def events(
    request: Request, db: DB, language: ServerLanguage, page: PageNumber = 1,
    scope: EventScope = "upcoming",
    q: str = Query(default="", max_length=200),
    action_id: int | None = Query(default=None, ge=1, le=2147483647),
) -> EventPage:
    flags = await queries.feature_flags(db)
    if action_id is not None and not flags.actions:
        raise AppError("actions_disabled", 404)
    zone = settings(request).tz
    now = utcnow()
    today = now.astimezone(ZoneInfo(zone)).date()
    where = event_conditions(db, scope, q, action_id, now, today)
    if db.get_bind().dialect.name == "sqlite":
        local = case(
            (CommunityEvent.all_day, cast(CommunityEvent.starts_on, Text) + " 00:00:00.000000"),
            else_=func.juntia_local_datetime(CommunityEvent.starts_at, zone),
        )
    else:
        local = case(
            (CommunityEvent.all_day, cast(CommunityEvent.starts_on, DateTime)),
            else_=func.timezone(zone, CommunityEvent.starts_at),
        )
    order = (local.asc(), CommunityEvent.id.asc()) if scope in ("upcoming", "all") else (
        local.desc(), CommunityEvent.id.desc(),
    )
    total = await db.scalar(select(func.count()).select_from(CommunityEvent).where(*where))
    values = list((await db.scalars(select(CommunityEvent).where(*where)
                                   .order_by(*order).offset((page - 1) * PAGE_SIZE)
                                   .limit(PAGE_SIZE))).all())
    items = await render_events(db, values, links=flags.actions, language=language)
    return EventPage(items=items, **page_info(total or 0, page))


@router.get("/agenda", response_model=EventAgendaPage)
async def agenda(
    request: Request, db: DB, language: ServerLanguage, page: OptionalPageNumber = None,
    scope: EventScope = "upcoming",
    q: str = Query(default="", max_length=200),
    action_id: int | None = Query(default=None, ge=1, le=2147483647),
) -> EventAgendaPage:
    flags = await queries.feature_flags(db)
    if action_id is not None and not flags.actions:
        raise AppError("actions_disabled", 404)
    zone = settings(request).tz
    now = utcnow()
    today = now.astimezone(ZoneInfo(zone)).date()
    where = event_conditions(db, scope, q, action_id, now, today)
    timed_first: ColumnElement[int]
    timed_last: ColumnElement[int]
    if db.get_bind().dialect.name == "sqlite":
        timed_first = func.juntia_local_day_number(
            CommunityEvent.starts_at, zone, False, type_=Integer,
        )
        timed_last = func.juntia_local_day_number(
            CommunityEvent.ends_at, zone, True, type_=Integer,
        )
    else:
        first_date = cast(func.timezone(zone, CommunityEvent.starts_at), Date)
        last_date = cast(func.timezone(
            zone, CommunityEvent.ends_at - timedelta(microseconds=1),
        ), Date)
        timed_first = date_number(db, first_date)
        timed_last = date_number(db, last_date)
    first_day = case(
        (CommunityEvent.all_day, date_number(db, CommunityEvent.starts_on)), else_=timed_first,
    )
    last_day = case(
        (CommunityEvent.all_day, date_number(db, CommunityEvent.ends_on) - 1), else_=timed_last,
    )
    today_number = (today - CALENDAR_EPOCH).days
    ascending = scope in ("upcoming", "all")
    visible_first = case(
        (first_day < today_number, today_number), else_=first_day,
    ) if scope == "upcoming" else first_day
    intervals = select(
        CommunityEvent.id, first_day.label("first_day"), last_day.label("last_day"),
        visible_first.label("visible_first"),
    ).where(*where).cte("event_intervals")
    span = intervals.c.last_day - intervals.c.visible_first
    earlier = case(
        (intervals.c.visible_first >= today_number, 0),
        (intervals.c.last_day < today_number, span + 1),
        else_=today_number - intervals.c.visible_first,
    )
    total, longest, earlier_total = (await db.execute(select(
        func.coalesce(func.sum(span + 1), 0), func.coalesce(func.max(span), 0),
        func.coalesce(func.sum(earlier), 0),
    ))).one()
    if page is None:
        # The complete timeline opens where its entries reach today, or on its latest page.
        page = min(earlier_total // PAGE_SIZE + 1, page_count(total)) if scope == "all" else 1
    offset = (page - 1) * PAGE_SIZE
    if offset >= total:
        return EventAgendaPage(items=[], **page_info(total, page))

    # The first N global occurrences cannot need more than N days from any single event.
    # This avoids expanding a long event's entire duration just to render one page.
    offsets = select(literal(0).label("day_offset")).cte("event_day_offsets", recursive=True)
    offsets = offsets.union_all(select(offsets.c.day_offset + 1).where(
        offsets.c.day_offset < min(longest, page * PAGE_SIZE - 1),
    ))
    display_day = (
        intervals.c.visible_first + offsets.c.day_offset if ascending
        else intervals.c.last_day - offsets.c.day_offset
    )
    time_order = case(
        (display_day == intervals.c.first_day, CommunityEvent.starts_at), else_=None,
    )
    order = (
        (display_day.asc(), time_order.asc().nulls_first(), CommunityEvent.id.asc())
        if ascending
        else (display_day.desc(), time_order.desc().nulls_last(), CommunityEvent.id.desc())
    )
    rows = (await db.execute(
        select(CommunityEvent, display_day, intervals.c.first_day, intervals.c.last_day)
        .join(intervals, intervals.c.id == CommunityEvent.id)
        .join(offsets, offsets.c.day_offset <= span)
        .order_by(*order).offset(offset).limit(PAGE_SIZE)
    )).all()
    rendered = await render_events(
        db, [row[0] for row in rows], links=flags.actions, language=language,
    )
    return EventAgendaPage(items=[
        EventOccurrenceOut(
            day=CALENDAR_EPOCH + timedelta(days=day_number),
            is_continuation=day_number != start, is_last_day=day_number == end,
            is_past=has_ended(value, now, today), event=value,
        )
        for (_, day_number, start, end), value in zip(rows, rendered, strict=True)
    ], **page_info(total, page))


@router.get("/{event_id}", response_model=EventOut)
async def event(event_id: ItemId, db: DB, language: ServerLanguage) -> EventOut:
    return await render_event(
        db, await get_event(db, event_id), links=(await queries.feature_flags(db)).actions,
        language=language,
    )


@router.post("", response_model=EventOut, status_code=201)
async def create_event(
    body: EventIn, request: Request, db: DB, language: ServerLanguage,
) -> EventOut:
    actor = public_actor(await mutation_session(request, db), language)
    await require_events_enabled(db)
    value = CommunityEvent(
        author_kind=actor.kind, author_user_id=actor.user_id, author_name=actor.name,
    )
    set_fields(value, body, settings(request))
    await set_action(db, value, body)
    db.add(value)
    await db.flush()
    record_history(db, value, actor, "created", None,
                   snapshot(await render_event(db, value, links=True, language=language)))
    await db.commit()
    return await render_event(
        db, value, links=(await queries.feature_flags(db)).actions, language=language,
    )


@router.patch("/{event_id}", response_model=EventOut)
async def edit_event(
    event_id: ItemId, body: EventEdit, request: Request, db: DB, language: ServerLanguage,
) -> EventOut:
    actor = public_actor(await mutation_session(request, db), language)
    await require_events_enabled(db)
    value = await get_event(db, event_id, lock=True, active=True)
    if value.version != body.version:
        raise AppError("event_stale", 409)
    before = snapshot(await render_event(db, value, links=True, language=language))
    set_fields(value, body, settings(request))
    await set_action(db, value, body)
    after = snapshot(await render_event(db, value, links=True, language=language))
    if before != after:
        value.version += 1
        value.updated_at = utcnow()
        record_history(db, value, actor, "updated", before, after)
    await db.commit()
    return await render_event(
        db, value, links=(await queries.feature_flags(db)).actions, language=language,
    )


@router.delete("/{event_id}", status_code=204)
async def delete_event(
    event_id: ItemId, body: VersionIn, request: Request, db: DB, language: ServerLanguage,
) -> None:
    actor = public_actor(await mutation_session(request, db), language)
    await require_events_enabled(db)
    value = await get_event(db, event_id, lock=True, active=True)
    if value.version != body.version:
        raise AppError("event_stale", 409)
    before = snapshot(await render_event(db, value, links=True, language=language))
    value.deleted_at = value.updated_at = utcnow()
    value.version += 1
    record_history(db, value, actor, "deleted", before, None)
    await db.commit()


@router.get("/{event_id}/history", response_model=EventHistoryPage)
async def history(
    event_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> EventHistoryPage:
    await get_event(db, event_id)
    links = (await queries.feature_flags(db)).actions
    where = CommunityEventHistory.event_id == event_id
    total = await db.scalar(select(func.count()).select_from(CommunityEventHistory).where(where))
    values = (await db.scalars(select(CommunityEventHistory).where(where)
                              .order_by(CommunityEventHistory.id.desc())
                              .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE))).all()
    result = []
    for value in values:
        before = EventSnapshot.model_validate(value.before) if value.before else None
        after = EventSnapshot.model_validate(value.after) if value.after else None
        if not links:
            if before:
                before.action = None
            if after:
                after.action = None
        result.append(EventHistoryOut(
            id=value.id, kind=value.kind, created_at=aware(value.created_at),
            author=ActorOut(
                kind=value.author_kind, user_id=value.author_user_id,
                name=author_name(value.author_kind, value.author_name, language),
            ), before=before, after=after,
        ))
    return EventHistoryPage(items=result, **page_info(total or 0, page))


@router.get("/{event_id}/calendar", response_model=EventCalendarOut)
async def calendar_links(event_id: ItemId, request: Request, db: DB) -> EventCalendarOut:
    value = await get_event(db, event_id, active=True)
    config = settings(request)
    return event_calendar.calendar_links(value, config.public_origins[0], config.tz)


@router.get("/{event_id}/calendar.ics", response_class=Response, responses={
    200: {"content": {"text/calendar": {"schema": {"type": "string", "format": "binary"}}}},
})
async def calendar_file(event_id: ItemId, request: Request, db: DB) -> Response:
    value = await get_event(db, event_id, active=True)
    return Response(
        event_calendar.calendar_file(value, settings(request).public_origins[0]),
        media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="event-{value.id}.ics"'},
    )
