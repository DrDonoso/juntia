import math
import re
import unicodedata
from collections.abc import Sequence
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic_core import ErrorDetails
from sqlalchemy import Text, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from .auth import DB, Admin, administrator, mutation_session, reader_session
from .config import Language
from .contracts import (
    ActorOut,
    ContactEdit,
    ContactEventOut,
    ContactHistoryPage,
    ContactIn,
    ContactOut,
    ContactPage,
    ContactSnapshot,
    ContactTagEdit,
    ContactTagIn,
    ContactTagOut,
    ContactTagPage,
    UserAuthOut,
    VersionIn,
)
from .db import Contact, ContactEvent, ContactTag, ContactTagLink, aware, utcnow
from .errors import AppError
from .query_sql import binary_text, contains_text, fold_sql, fold_text
from .texts import ServerLanguage, author_name, public_actor

router = APIRouter(
    prefix="/api", tags=["Contacts"], dependencies=[Depends(reader_session)],
)
PAGE_SIZE = 50
ItemId = Annotated[int, Path(ge=1, le=2147483647)]
PageNumber = Annotated[int, Query(ge=1, le=1000000)]
ContactSort = Literal[
    "name", "company", "email", "phone", "tags", "notes", "created_at", "updated_at"
]


def validation_fields(errors: Sequence[ErrorDetails], *, tag: bool = False) -> dict[str, str]:
    codes = {
        "name": "contact_tag_name_invalid" if tag else "contact_name_invalid",
        "company": "contact_company_invalid",
        "email": "contact_email_invalid",
        "phone": "contact_phone_invalid",
        "notes": "contact_notes_invalid",
        "tags": "contact_tags_invalid",
        "color": "contact_tag_color_invalid",
    }
    fields: dict[str, str] = {}
    for error in errors:
        location = error["loc"]
        if not location or location[0] != "body":
            continue
        if error["type"] == "contact_channel_required":
            fields.update(email="contact_channel_required", phone="contact_channel_required")
        elif error["type"] == "contact_tags_invalid":
            fields["tags"] = "contact_tags_invalid"
        elif len(location) > 1 and location[1] == "new_tags":
            fields["tags"] = (
                "contact_tag_name_invalid" if location[-1] == "name"
                else "contact_tag_color_invalid" if location[-1] == "color"
                else "contact_tags_invalid"
            )
        elif len(location) > 1 and isinstance(location[1], str) and location[1] in codes:
            fields[location[1]] = codes[location[1]]
    return fields


def page_info(total: int, page: int) -> dict[str, int]:
    return {"total": total, "page": page, "pages": max(1, math.ceil(total / PAGE_SIZE))}


async def render_contacts(db: AsyncSession, values: list[Contact]) -> list[ContactOut]:
    if not values:
        return []
    tags: dict[int, list[ContactTagOut]] = {value.id: [] for value in values}
    for contact_id, tag in (await db.execute(
        select(ContactTagLink.contact_id, ContactTag)
        .join(ContactTag, ContactTag.id == ContactTagLink.tag_id)
        .where(ContactTagLink.contact_id.in_(tags))
        .order_by(ContactTag.normalized_name, ContactTag.id)
    )).all():
        tags[contact_id].append(ContactTagOut.model_validate(tag))
    return [ContactOut(
        id=value.id, name=value.name, company=value.company, email=value.email,
        phone=value.phone, notes=value.notes, tags=tags[value.id], version=value.version,
        created_at=aware(value.created_at), updated_at=aware(value.updated_at),
        deleted_at=aware(value.deleted_at) if value.deleted_at else None,
    ) for value in values]


async def render_contact(db: AsyncSession, value: Contact) -> ContactOut:
    return (await render_contacts(db, [value]))[0]


def snapshot(value: ContactOut) -> ContactSnapshot:
    return ContactSnapshot(**{
        field: getattr(value, field) for field in ContactSnapshot.model_fields
    })


def add_event(
    db: AsyncSession, actor: UserAuthOut, kind: Literal["created", "updated", "deleted"],
    before: ContactSnapshot | ContactTagIn | None,
    after: ContactSnapshot | ContactTagIn | None,
    *, contact_id: int | None = None, tag_id: int | None = None,
) -> None:
    db.add(ContactEvent(
        contact_id=contact_id, tag_id=tag_id, kind=kind,
        author_kind=actor.kind, author_user_id=actor.user_id, author_name=actor.name,
        before=before.model_dump(mode="json") if before else None,
        after=after.model_dump(mode="json") if after else None,
    ))


async def get_contact(db: AsyncSession, contact_id: int, *, lock: bool = False) -> Contact:
    if lock:
        # Serialize on SQLite as well as PostgreSQL without touching the finance revision.
        found = await db.scalar(update(Contact).where(
            Contact.id == contact_id, Contact.deleted_at.is_(None),
        ).values(version=Contact.version).returning(Contact.id))
        if found is None:
            raise AppError("contact_not_found", 404)
    value = await db.get(Contact, contact_id, populate_existing=True)
    if value is None or value.deleted_at is not None:
        raise AppError("contact_not_found", 404)
    return value


async def lock_tags(db: AsyncSession, ids: list[int]) -> None:
    for tag_id in sorted(set(ids)):
        found = await db.scalar(update(ContactTag).where(ContactTag.id == tag_id)
                                .values(version=ContactTag.version).returning(ContactTag.id))
        if found is None:
            raise AppError("contact_tag_not_found", 422, fields={"tags": "contact_tag_not_found"})


async def tag_ids(db: AsyncSession, contact_id: int) -> list[int]:
    return list((await db.scalars(
        select(ContactTagLink.tag_id).where(ContactTagLink.contact_id == contact_id)
    )).all())


async def replace_tags(db: AsyncSession, contact_id: int, ids: list[int]) -> None:
    if len(ids) > 30:
        raise AppError("contact_tags_invalid", 422, fields={"tags": "contact_tags_invalid"})
    await db.execute(delete(ContactTagLink).where(ContactTagLink.contact_id == contact_id))
    db.add_all([ContactTagLink(contact_id=contact_id, tag_id=key) for key in ids])
    await db.flush()


async def resolve_new_tags(
    db: AsyncSession, values: list[ContactTagIn], actor: UserAuthOut,
) -> list[int]:
    dialect = db.get_bind().dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        raise RuntimeError("Unsupported contacts database")
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    ids = []
    for value in sorted(values, key=lambda tag: tag.name.casefold()):
        normalized = value.name.casefold()
        tag_id = await db.scalar(insert(ContactTag).values(
            name=value.name, normalized_name=normalized, color=value.color, version=1,
        ).on_conflict_do_nothing(
            index_elements=[ContactTag.normalized_name],
        ).returning(ContactTag.id))
        if tag_id is None:
            tag_id = await db.scalar(select(ContactTag.id).where(
                ContactTag.normalized_name == normalized,
            ))
            if tag_id is None:
                raise AppError("contact_tag_not_found", 422, fields={"tags": "contact_tag_not_found"})
        else:
            add_event(db, actor, "created", None, value, tag_id=tag_id)
        ids.append(tag_id)
    return ids


def check_version(current: int, expected: int) -> None:
    if current != expected:
        raise AppError("contact_stale", 409)


def joined_tag_names(db: AsyncSession, *, sorting: bool) -> ColumnElement[str]:
    value = fold_sql(db, ContactTag.name) if sorting else ContactTag.name
    order = binary_text(db, value) if sorting else ContactTag.normalized_name
    names = (
        select(value.label("name")).join(ContactTagLink, ContactTagLink.tag_id == ContactTag.id)
        .where(ContactTagLink.contact_id == Contact.id)
        .order_by(order, ContactTag.id).correlate(Contact).subquery()
    )
    # Tag names contain no control characters. This sorts like the former NUL separator.
    return select(func.aggregate_strings(names.c.name, "\x1f" if sorting else "\n")).scalar_subquery()


async def contact_page(
    db: AsyncSession, q: str, page: int, sort: ContactSort, direction: Literal["asc", "desc"],
    *, deleted: bool = False,
) -> ContactPage:
    where: list[ColumnElement[bool]] = [
        Contact.deleted_at.is_not(None) if deleted else Contact.deleted_at.is_(None),
    ]
    needle = fold_text(q.strip())
    if needle:
        text = (
            Contact.name + "\n" + Contact.company + "\n"
            + func.coalesce(Contact.email, "") + "\n" + Contact.phone + "\n" + Contact.notes
            + func.coalesce("\n" + joined_tag_names(db, sorting=False), "")
        )
        search = contains_text(db, fold_sql(db, text), needle)
        phone = re.sub(r"[\s().-]", "", needle)
        if re.fullmatch(r"\+?[0-9]+", phone):
            search = or_(search, Contact.phone.contains(phone, autoescape=True))
        where.append(search)
    query = select(Contact).where(*where)
    if sort in {"created_at", "updated_at"}:
        column = Contact.created_at if sort == "created_at" else Contact.updated_at
        query = query.order_by(column.asc() if direction == "asc" else column.desc(), Contact.id)
    else:
        key = binary_text(db, func.coalesce(
            joined_tag_names(db, sorting=True) if sort == "tags"
            else fold_sql(db, getattr(Contact, sort)), "", type_=Text,
        ))
        query = query.order_by((key == "").asc(), key.asc() if direction == "asc" else key.desc(), Contact.id)
    total = await db.scalar(select(func.count()).select_from(Contact).where(*where))
    values = list((await db.scalars(
        query.offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all())
    return ContactPage(
        items=await render_contacts(db, values), **page_info(total or 0, page),
    )


@router.get("/contacts", response_model=ContactPage)
async def contacts(
    db: DB, q: Annotated[str, Query(max_length=200)] = "", page: PageNumber = 1,
    sort: ContactSort = "name", direction: Literal["asc", "desc"] = "asc",
) -> ContactPage:
    return await contact_page(db, q, page, sort, direction)


@router.get("/admin/contacts/deleted", response_model=ContactPage)
async def deleted_contacts(
    db: DB, admin: Admin, q: Annotated[str, Query(max_length=200)] = "",
    page: PageNumber = 1, sort: ContactSort = "name",
    direction: Literal["asc", "desc"] = "asc",
) -> ContactPage:
    return await contact_page(db, q, page, sort, direction, deleted=True)


@router.get("/contacts/{contact_id}", response_model=ContactOut)
async def contact(contact_id: ItemId, db: DB) -> ContactOut:
    return await render_contact(db, await get_contact(db, contact_id))


@router.post("/contacts", response_model=ContactOut, status_code=201)
async def create_contact(
    body: ContactIn, db: DB, request: Request, language: ServerLanguage,
) -> ContactOut:
    actor = public_actor(await mutation_session(request, db), language)
    value = Contact(**body.model_dump(exclude={"tags", "new_tags"}))
    db.add(value)
    await db.flush()
    selected = sorted(set(body.tags + await resolve_new_tags(db, body.new_tags, actor)))
    await lock_tags(db, selected)
    await replace_tags(db, value.id, selected)
    result = await render_contact(db, value)
    add_event(db, actor, "created", None, snapshot(result), contact_id=value.id)
    await db.commit()
    return result


@router.patch("/contacts/{contact_id}", response_model=ContactOut)
async def edit_contact(
    contact_id: ItemId, body: ContactEdit, db: DB, request: Request, language: ServerLanguage,
) -> ContactOut:
    actor = public_actor(await mutation_session(request, db), language)
    value = await get_contact(db, contact_id, lock=True)
    check_version(value.version, body.version)
    previous_tags = await tag_ids(db, contact_id)
    selected = body.tags if "tags" in body.model_fields_set else previous_tags
    selected = sorted(set(selected + await resolve_new_tags(db, body.new_tags, actor)))
    await lock_tags(db, previous_tags + selected)
    before = snapshot(await render_contact(db, value))
    for field, updated in body.model_dump(
        exclude={"version", "tags", "new_tags"}, exclude_unset=True,
    ).items():
        setattr(value, field, updated)
    if set(previous_tags) != set(selected):
        await replace_tags(db, contact_id, selected)
    after = snapshot(await render_contact(db, value))
    if before != after:
        value.version += 1
        value.updated_at = utcnow()
        add_event(db, actor, "updated", before, after, contact_id=contact_id)
    await db.commit()
    return await render_contact(db, value)


@router.delete("/contacts/{contact_id}", status_code=204)
async def delete_contact(
    contact_id: ItemId, body: VersionIn, db: DB, request: Request, language: ServerLanguage,
) -> None:
    actor = public_actor(await mutation_session(request, db), language)
    value = await get_contact(db, contact_id, lock=True)
    check_version(value.version, body.version)
    await lock_tags(db, await tag_ids(db, contact_id))
    before = snapshot(await render_contact(db, value))
    value.deleted_at = value.updated_at = utcnow()
    value.version += 1
    add_event(db, actor, "deleted", before, None, contact_id=contact_id)
    await db.commit()


@router.get("/contact-tags", response_model=list[ContactTagOut])
async def tags(db: DB) -> list[ContactTagOut]:
    usage = (
        select(ContactTagLink.tag_id, func.count().label("uses"))
        .join(Contact, Contact.id == ContactTagLink.contact_id)
        .where(Contact.deleted_at.is_(None))
        .group_by(ContactTagLink.tag_id).subquery()
    )
    rows = (await db.scalars(
        select(ContactTag).outerjoin(usage, usage.c.tag_id == ContactTag.id)
        .order_by(func.coalesce(usage.c.uses, 0).desc(), ContactTag.normalized_name, ContactTag.id)
    )).all()
    return [ContactTagOut.model_validate(row) for row in rows]


@router.get("/admin/contact-tags", response_model=ContactTagPage)
async def admin_tags(
    db: DB, admin: Admin, q: Annotated[str, Query(max_length=100)] = "",
    page: PageNumber = 1,
) -> ContactTagPage:
    needle = unicodedata.normalize("NFKC", q).strip().casefold()
    where = ContactTag.normalized_name.contains(needle, autoescape=True)
    total = await db.scalar(select(func.count()).select_from(ContactTag).where(where))
    rows = (await db.scalars(
        select(ContactTag).where(where).order_by(ContactTag.normalized_name, ContactTag.id)
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return ContactTagPage(
        items=[ContactTagOut.model_validate(row) for row in rows], **page_info(total or 0, page),
    )


@router.get("/admin/contact-tags/{tag_id}", response_model=ContactTagOut)
async def read_admin_tag(tag_id: ItemId, db: DB, admin: Admin) -> ContactTagOut:
    value = await db.get(ContactTag, tag_id)
    if value is None:
        raise AppError("contact_tag_not_found", 404)
    return ContactTagOut.model_validate(value)


async def save_tag(
    db: AsyncSession, value: ContactTag, actor: UserAuthOut, before: ContactTagIn | None,
) -> ContactTagOut:
    after = ContactTagIn.model_validate(value)
    try:
        await db.flush()
        if before != after:
            add_event(
                db, actor, "updated" if before else "created", before, after, tag_id=value.id,
            )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError("contact_tag_exists", 409, fields={"name": "contact_tag_exists"}) from None
    return ContactTagOut.model_validate(value)


@router.post("/contact-tags", response_model=ContactTagOut, status_code=201)
async def create_tag(
    body: ContactTagIn, db: DB, request: Request, language: ServerLanguage,
) -> ContactTagOut:
    actor = public_actor(await mutation_session(request, db), language)
    value = ContactTag(
        name=body.name, normalized_name=unicodedata.normalize("NFKC", body.name).casefold(),
        color=body.color,
    )
    db.add(value)
    return await save_tag(db, value, actor, None)


@router.patch(
    "/admin/contact-tags/{tag_id}", response_model=ContactTagOut,
    dependencies=[Depends(administrator)],
)
@router.patch("/contact-tags/{tag_id}", response_model=ContactTagOut)
async def edit_tag(
    tag_id: ItemId, body: ContactTagEdit, db: DB, request: Request, language: ServerLanguage,
) -> ContactTagOut:
    actor = public_actor(await mutation_session(request, db), language)
    await lock_tags(db, [tag_id])
    value = await db.get(ContactTag, tag_id, populate_existing=True)
    assert value is not None
    check_version(value.version, body.version)
    before = ContactTagIn.model_validate(value)
    value.name, value.color = body.name, body.color
    value.normalized_name = unicodedata.normalize("NFKC", body.name).casefold()
    if before != ContactTagIn.model_validate(value):
        value.version += 1
    return await save_tag(db, value, actor, before)


def render_event(value: ContactEvent, language: Language) -> ContactEventOut:
    target = "contact" if value.contact_id is not None else "tag"
    snapshot_type = ContactSnapshot if target == "contact" else ContactTagIn
    before = snapshot_type.model_validate(value.before) if value.before is not None else None
    after = snapshot_type.model_validate(value.after) if value.after is not None else None
    content = after or before
    assert content is not None
    return ContactEventOut.model_validate({
        "id": value.id, "target": target,
        "target_id": value.contact_id if target == "contact" else value.tag_id,
        "name": content.name, "kind": value.kind,
        "author": ActorOut.model_validate({
            "kind": value.author_kind, "user_id": value.author_user_id,
            "name": author_name(value.author_kind, value.author_name, language),
        }),
        "created_at": aware(value.created_at), "before": before, "after": after,
    })


@router.get("/contact-history", response_model=ContactHistoryPage)
async def history(
    db: DB, language: ServerLanguage, page: PageNumber = 1,
    contact_id: Annotated[int | None, Query(ge=1, le=2147483647)] = None,
) -> ContactHistoryPage:
    where = []
    if contact_id is not None:
        if await db.get(Contact, contact_id) is None:
            raise AppError("contact_not_found", 404)
        where.append(ContactEvent.contact_id == contact_id)
    total = await db.scalar(select(func.count()).select_from(ContactEvent).where(*where))
    rows = (await db.scalars(select(ContactEvent).where(*where)
                            .order_by(ContactEvent.id.desc())
                            .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE))).all()
    return ContactHistoryPage(
        items=[render_event(row, language) for row in rows], **page_info(total or 0, page),
    )
