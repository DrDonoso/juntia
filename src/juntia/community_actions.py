import logging
import math
import unicodedata
from dataclasses import dataclass
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Form, Path, Query, Request, UploadFile
from sqlalchemy import case, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse

from . import queries
from .auth import (
    DB,
    administrator,
    mutation_session,
    reader_session,
    settings,
)
from .community_action_files import (
    MAX_ACTIVE_PDFS,
    StagedPDF,
    pdf_path,
    publish_pdf,
    remove_file,
    stage_pdf,
)
from .config import Language
from .contracts import (
    ACTION_STATUSES,
    ActionActorOut,
    ActionAttachmentEdit,
    ActionAttachmentOut,
    ActionAttachmentPage,
    ActionBoardOut,
    ActionChange,
    ActionColumnOut,
    ActionCommentEdit,
    ActionCommentIn,
    ActionCommentOut,
    ActionCommentPage,
    ActionEdit,
    ActionEventKind,
    ActionEventOut,
    ActionHistoryPage,
    ActionIn,
    ActionLabelEdit,
    ActionLabelOut,
    ActionLabelPage,
    ActionOut,
    ActionPage,
    ActionStatus,
    ActionSummaryOut,
    UserAuthOut,
    VersionIn,
)
from .db import (
    ActionAttachment,
    ActionComment,
    ActionEvent,
    ActionLabel,
    ActionLabelLink,
    Authorship,
    CommunityAction,
    aware,
    lock_state,
    utcnow,
)
from .errors import AppError
from .parser import MAX_BYTES
from .storage import check_attachment_quota, ensure_free_space, lock_attachment_storage
from .texts import ServerLanguage, author_name

log = logging.getLogger(__name__)


async def require_actions_enabled(db: DB) -> None:
    if not (await queries.feature_flags(db)).actions:
        raise AppError("actions_disabled", 404)


router = APIRouter(
    prefix="/api/actions", tags=["Community actions"],
    dependencies=[Depends(reader_session), Depends(require_actions_enabled)],
)
admin_router = APIRouter(
    prefix="/api/admin/action-labels", tags=["Community action labels"],
    dependencies=[Depends(administrator)],
)
PAGE_SIZE = 20
ItemId = Annotated[int, Path(ge=1, le=2147483647)]
PageNumber = Annotated[int, Query(ge=1, le=1000000)]


def author(value: Authorship, language: Language) -> ActionActorOut:
    return ActionActorOut.model_validate({
        "kind": value.author_kind, "user_id": value.author_user_id,
        "name": author_name(value.author_kind, value.author_name, language),
    })


def authorship(value: ActionActorOut) -> dict[str, str | int | None]:
    return {
        "author_kind": value.kind, "author_user_id": value.user_id, "author_name": value.name,
    }


def session_actor(identity: UserAuthOut, language: Language) -> ActionActorOut:
    return ActionActorOut(
        kind="resident" if identity.kind == "resident" else "administrator",
        user_id=identity.user_id,
        name=author_name(identity.kind, identity.name, language),
    )


async def mutation_actor(
    request: Request, db: AsyncSession, language: Language,
) -> ActionActorOut:
    await require_actions_enabled(db)
    return session_actor(await mutation_session(request, db), language)


def require_owner(value: Authorship, actor: ActionActorOut) -> None:
    if actor.kind != "administrator" and (
        value.author_kind != actor.kind or value.author_user_id != actor.user_id
    ):
        raise AppError("action_owner_required", 403)


async def get_action(db: AsyncSession, item_id: int) -> CommunityAction:
    value = await db.get(CommunityAction, item_id)
    if value is None:
        raise AppError("action_not_found", 404)
    return value


async def lock_action(db: AsyncSession, item_id: int) -> CommunityAction:
    # A no-op UPDATE also serializes item mutations on the SQLite preview/test server.
    found = await db.scalar(
        update(CommunityAction).where(CommunityAction.id == item_id)
        .values(version=CommunityAction.version).returning(CommunityAction.id)
    )
    if found is None:
        raise AppError("action_not_found", 404)
    value = await db.get(CommunityAction, item_id, populate_existing=True)
    assert value is not None
    return value


def check_version(current: int, expected: int) -> None:
    if current != expected:
        raise AppError("action_stale", 409)


def add_event(
    db: AsyncSession,
    item: CommunityAction,
    actor: ActionActorOut,
    kind: ActionEventKind,
    changes: list[ActionChange],
    *,
    comment_id: int | None = None,
    attachment_id: str | None = None,
) -> None:
    now = utcnow()
    item.updated_at = now
    db.add(ActionEvent(
        action_id=item.id, kind=kind, created_at=now, **authorship(actor),
        changes=[change.model_dump(mode="json") for change in changes],
        comment_id=comment_id, attachment_id=attachment_id,
    ))


async def labels_for(db: AsyncSession, item_id: int) -> list[ActionLabel]:
    return list((await db.scalars(
        select(ActionLabel).join(ActionLabelLink, ActionLabelLink.label_id == ActionLabel.id)
        .where(ActionLabelLink.action_id == item_id).order_by(ActionLabel.normalized_name)
    )).all())


async def resolve_labels(db: AsyncSession, names: list[str]) -> list[ActionLabel]:
    if not names:
        return []
    dialect = db.get_bind().dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        raise RuntimeError("Unsupported community actions database")
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    await db.execute(insert(ActionLabel).values([
        {"name": name, "normalized_name": name.casefold()} for name in names
    ]).on_conflict_do_nothing(index_elements=[ActionLabel.normalized_name]))
    return list((await db.scalars(
        select(ActionLabel).where(ActionLabel.normalized_name.in_([n.casefold() for n in names]))
        .order_by(ActionLabel.normalized_name)
    )).all())


async def replace_labels(db: AsyncSession, item_id: int, labels: list[ActionLabel]) -> None:
    await db.execute(delete(ActionLabelLink).where(ActionLabelLink.action_id == item_id))
    db.add_all([ActionLabelLink(action_id=item_id, label_id=label.id) for label in labels])


async def summaries(
    db: AsyncSession, values: list[CommunityAction], language: Language,
) -> list[ActionSummaryOut]:
    if not values:
        return []
    ids = [value.id for value in values]
    labels: dict[int, list[ActionLabelOut]] = {key: [] for key in ids}
    for item_id, label in (await db.execute(
        select(ActionLabelLink.action_id, ActionLabel)
        .join(ActionLabel, ActionLabel.id == ActionLabelLink.label_id)
        .where(ActionLabelLink.action_id.in_(ids)).order_by(ActionLabel.normalized_name)
    )).all():
        labels[item_id].append(ActionLabelOut.model_validate(label))
    comments = {item_id: count for item_id, count in (await db.execute(
        select(ActionComment.action_id, func.count())
        .where(ActionComment.action_id.in_(ids), ActionComment.withdrawn_at.is_(None))
        .group_by(ActionComment.action_id)
    )).all()}
    attachments = {item_id: count for item_id, count in (await db.execute(
        select(ActionAttachment.action_id, func.count())
        .where(ActionAttachment.action_id.in_(ids), ActionAttachment.withdrawn_at.is_(None))
        .group_by(ActionAttachment.action_id)
    )).all()}
    return [
        ActionSummaryOut.model_validate({
            "id": value.id, "title": value.title, "status": value.status,
            "labels": labels[value.id], "author": author(value, language),
            "version": value.version,
            "created_at": aware(value.created_at), "updated_at": aware(value.updated_at),
            "comment_count": comments.get(value.id, 0),
            "attachment_count": attachments.get(value.id, 0),
        })
        for value in values
    ]


async def action_out(db: AsyncSession, value: CommunityAction, language: Language) -> ActionOut:
    summary = (await summaries(db, [value], language))[0]
    return ActionOut(**summary.model_dump(), description=value.description)


@dataclass(frozen=True)
class ActionFilters:
    q: str
    status: ActionStatus | None
    labels: tuple[int, ...]
    scope: Literal["open", "closed", "all"]


def filters(
    q: Annotated[str, Query(max_length=200)] = "",
    status: ActionStatus | None = None,
    label: Annotated[list[int] | None, Query(max_length=20)] = None,
    scope: Literal["open", "closed", "all"] = "open",
) -> ActionFilters:
    if label and any(key < 1 or key > 2147483647 for key in label):
        raise AppError("invalid_request")
    return ActionFilters(q.strip(), status, tuple(sorted(set(label or []))), scope)


Filters = Annotated[ActionFilters, Depends(filters)]


def escaped_search(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def conditions(value: ActionFilters) -> list[ColumnElement[bool]]:
    result: list[ColumnElement[bool]] = []
    if value.q:
        text = escaped_search(value.q)
        result.append(or_(
            CommunityAction.title.ilike(text, escape="\\"),
            CommunityAction.description.ilike(text, escape="\\"),
        ))
    if value.status is not None:
        result.append(CommunityAction.status == value.status)
    if value.scope == "open":
        result.append(CommunityAction.status.not_in(["done", "discarded"]))
    elif value.scope == "closed":
        result.append(CommunityAction.status.in_(["done", "discarded"]))
    for label in value.labels:
        result.append(CommunityAction.id.in_(
            select(ActionLabelLink.action_id).where(ActionLabelLink.label_id == label)
        ))
    return result


def page_info(total: int, page: int) -> dict[str, int]:
    return {"total": total, "page": page, "pages": max(1, math.ceil(total / PAGE_SIZE))}


@router.get("/items", response_model=ActionPage)
async def items(
    db: DB, selected: Filters, language: ServerLanguage, page: PageNumber = 1,
    sort: Literal["title", "status", "activity"] = "activity",
    direction: Literal["asc", "desc"] = "desc",
) -> ActionPage:
    where = conditions(selected)
    total = await db.scalar(select(func.count()).select_from(CommunityAction).where(*where))
    sort_column = (
        func.lower(CommunityAction.title) if sort == "title"
        else case(
            {status: position for position, status in enumerate(ACTION_STATUSES)},
            value=CommunityAction.status,
        ) if sort == "status"
        else CommunityAction.updated_at
    )
    order = (
        (sort_column.asc(), CommunityAction.id.asc())
        if direction == "asc" else (sort_column.desc(), CommunityAction.id.desc())
    )
    values = list((await db.scalars(
        select(CommunityAction).where(*where)
        .order_by(*order)
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all())
    return ActionPage(items=await summaries(db, values, language), **page_info(total or 0, page))


@router.get("/board", response_model=ActionBoardOut)
async def board(db: DB, selected: Filters, language: ServerLanguage) -> ActionBoardOut:
    where = conditions(selected)
    totals = {status: count for status, count in (await db.execute(
        select(CommunityAction.status, func.count()).where(*where).group_by(CommunityAction.status)
    )).all()}
    ranked = select(
        CommunityAction.id,
        func.row_number().over(
            partition_by=CommunityAction.status,
            order_by=(CommunityAction.updated_at.desc(), CommunityAction.id.desc()),
        ).label("position"),
    ).where(*where).subquery()
    values = list((await db.scalars(
        select(CommunityAction).join(ranked, ranked.c.id == CommunityAction.id)
        .where(ranked.c.position <= PAGE_SIZE)
        .order_by(CommunityAction.updated_at.desc(), CommunityAction.id.desc())
    )).all())
    rendered = await summaries(db, values, language)
    return ActionBoardOut(columns=[
        ActionColumnOut(
            status=status, items=[value for value in rendered if value.status == status],
            **page_info(totals.get(status, 0), 1),
        ) for status in ACTION_STATUSES
    ])


@admin_router.get("", response_model=ActionLabelPage)
@router.get("/labels", response_model=ActionLabelPage)
async def label_list(
    db: DB, q: Annotated[str, Query(max_length=100)] = "", page: PageNumber = 1,
    id: Annotated[list[int] | None, Query(max_length=20)] = None,
) -> ActionLabelPage:
    needle = unicodedata.normalize("NFKC", q).strip().casefold()
    where = ActionLabel.normalized_name.contains(needle, autoescape=True)
    if id is not None:
        if any(key < 1 or key > 2147483647 for key in id):
            raise AppError("invalid_request")
        where = where & ActionLabel.id.in_(id)
    total = await db.scalar(select(func.count()).select_from(ActionLabel).where(where))
    rows = (await db.scalars(
        select(ActionLabel).where(where).order_by(ActionLabel.normalized_name)
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return ActionLabelPage(
        items=[ActionLabelOut.model_validate(row) for row in rows], **page_info(total or 0, page),
    )


@admin_router.get("/{label_id}", response_model=ActionLabelOut)
async def read_label(label_id: ItemId, db: DB) -> ActionLabelOut:
    value = await db.get(ActionLabel, label_id)
    if value is None:
        raise AppError("action_label_not_found", 404)
    return ActionLabelOut.model_validate(value)


@admin_router.patch("/{label_id}", response_model=ActionLabelOut)
async def edit_label(
    label_id: ItemId, body: ActionLabelEdit, db: DB, request: Request, language: ServerLanguage,
) -> ActionLabelOut:
    actor = session_actor(await mutation_session(request, db), language)
    # Label assignment and renaming share this lock, always before locking actions.
    await lock_state(db)
    value = await db.get(ActionLabel, label_id, populate_existing=True)
    if value is None:
        raise AppError("action_label_not_found", 404)
    if value.version != body.version:
        raise AppError("action_label_stale", 409)
    if value.name == body.name and value.color == body.color:
        return ActionLabelOut.model_validate(value)
    before_name, before_color = value.name, value.color
    items = list((await db.scalars(
        select(CommunityAction).join(
            ActionLabelLink, ActionLabelLink.action_id == CommunityAction.id,
        ).where(ActionLabelLink.label_id == label_id).order_by(CommunityAction.id)
        .with_for_update()
    )).all())
    previous = {
        item.id: [label.name for label in await labels_for(db, item.id)] for item in items
    }
    value.name, value.color = body.name, body.color
    value.normalized_name = body.name.casefold()
    value.version += 1
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise AppError("action_label_exists", 409, fields={"name": "action_label_exists"}) from None
    for item in items:
        changes = []
        if before_name != value.name:
            changes.append(ActionChange(
                field="labels", before=previous[item.id],
                after=[label.name for label in await labels_for(db, item.id)],
            ))
        if before_color != value.color:
            changes.append(ActionChange(
                field="label_color",
                before=f"{before_name}: {before_color}" if before_color else None,
                after=f"{value.name}: {value.color}",
            ))
        item.version += 1
        add_event(db, item, actor, "updated", changes)
    await db.commit()
    return ActionLabelOut.model_validate(value)


@router.get("/items/{item_id}", response_model=ActionOut)
async def item(item_id: ItemId, db: DB, language: ServerLanguage) -> ActionOut:
    return await action_out(db, await get_action(db, item_id), language)


@router.post("/items", response_model=ActionOut, status_code=201)
async def create_item(
    body: ActionIn, db: DB, request: Request, language: ServerLanguage,
) -> ActionOut:
    actor = await mutation_actor(request, db, language)
    if body.labels:
        await lock_state(db)
    value = CommunityAction(
        title=body.title, description=body.description, status=body.status, **authorship(actor),
    )
    db.add(value)
    await db.flush()
    labels = await resolve_labels(db, body.labels)
    await replace_labels(db, value.id, labels)
    add_event(db, value, actor, "created", [
        ActionChange(field="title", before=None, after=value.title),
        ActionChange(field="description", before=None, after=value.description),
        ActionChange(field="status", before=None, after=value.status),
        ActionChange(field="labels", before=None, after=[label.name for label in labels]),
    ])
    await db.commit()
    return await action_out(db, value, language)


@router.patch("/items/{item_id}", response_model=ActionOut)
async def edit_item(
    item_id: ItemId, body: ActionEdit, db: DB, request: Request, language: ServerLanguage,
) -> ActionOut:
    actor = await mutation_actor(request, db, language)
    if body.labels is not None:
        await lock_state(db)
    value = await lock_action(db, item_id)
    check_version(value.version, body.version)
    changes: list[ActionChange] = []
    for field in ("title", "description", "status"):
        updated = getattr(body, field)
        previous = getattr(value, field)
        if updated is not None and updated != previous:
            changes.append(ActionChange.model_validate({
                "field": field, "before": previous, "after": updated,
            }))
            setattr(value, field, updated)
    if body.labels is not None:
        before = await labels_for(db, item_id)
        after = await resolve_labels(db, body.labels)
        if [label.id for label in before] != [label.id for label in after]:
            await replace_labels(db, item_id, after)
            changes.append(ActionChange(
                field="labels", before=[label.name for label in before],
                after=[label.name for label in after],
            ))
    if changes:
        value.version += 1
        add_event(db, value, actor, "updated", changes)
    await db.commit()
    return await action_out(db, value, language)


def comment_out(value: ActionComment, language: Language) -> ActionCommentOut:
    return ActionCommentOut(
        id=value.id, body=None if value.withdrawn_at else value.body,
        author=author(value, language), version=value.version,
        created_at=aware(value.created_at), updated_at=aware(value.updated_at),
        withdrawn_at=aware(value.withdrawn_at) if value.withdrawn_at else None,
    )


@router.get("/items/{item_id}/comments", response_model=ActionCommentPage)
async def comments(
    item_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> ActionCommentPage:
    await get_action(db, item_id)
    where = ActionComment.action_id == item_id
    total = await db.scalar(select(func.count()).select_from(ActionComment).where(where))
    rows = (await db.scalars(
        select(ActionComment).where(where).order_by(ActionComment.id.desc())
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return ActionCommentPage(
        items=[comment_out(row, language) for row in rows], **page_info(total or 0, page),
    )


@router.post("/items/{item_id}/comments", response_model=ActionCommentOut, status_code=201)
async def add_comment(
    item_id: ItemId, body: ActionCommentIn, db: DB, request: Request, language: ServerLanguage,
) -> ActionCommentOut:
    actor = await mutation_actor(request, db, language)
    value = await lock_action(db, item_id)
    comment = ActionComment(action_id=item_id, body=body.body, **authorship(actor))
    db.add(comment)
    await db.flush()
    add_event(db, value, actor, "comment_added", [
        ActionChange(field="comment", before=None, after=comment.body),
    ], comment_id=comment.id)
    await db.commit()
    return comment_out(comment, language)


async def editable_comment(
    db: AsyncSession, item_id: int, comment_id: int, actor: ActionActorOut, version: int,
) -> ActionComment:
    comment = await db.get(ActionComment, comment_id, populate_existing=True)
    if comment is None or comment.action_id != item_id:
        raise AppError("action_comment_not_found", 404)
    require_owner(comment, actor)
    check_version(comment.version, version)
    if comment.withdrawn_at:
        raise AppError("action_content_withdrawn", 409)
    return comment


@router.get("/items/{item_id}/comments/{comment_id}", response_model=ActionCommentOut)
async def read_comment(
    item_id: ItemId, comment_id: ItemId, db: DB, language: ServerLanguage,
) -> ActionCommentOut:
    await get_action(db, item_id)
    value = await db.get(ActionComment, comment_id)
    if value is None or value.action_id != item_id:
        raise AppError("action_comment_not_found", 404)
    return comment_out(value, language)


@router.patch("/items/{item_id}/comments/{comment_id}", response_model=ActionCommentOut)
async def edit_comment(
    item_id: ItemId, comment_id: ItemId, body: ActionCommentEdit, db: DB, request: Request,
    language: ServerLanguage,
) -> ActionCommentOut:
    actor = await mutation_actor(request, db, language)
    value = await lock_action(db, item_id)
    comment = await editable_comment(db, item_id, comment_id, actor, body.version)
    if comment.body != body.body:
        add_event(db, value, actor, "comment_edited", [
            ActionChange(field="comment", before=comment.body, after=body.body),
        ], comment_id=comment.id)
        comment.body = body.body
        comment.version += 1
        comment.updated_at = utcnow()
    await db.commit()
    return comment_out(comment, language)


@router.delete("/items/{item_id}/comments/{comment_id}", status_code=204)
async def withdraw_comment(
    item_id: ItemId, comment_id: ItemId, body: VersionIn, db: DB, request: Request,
    language: ServerLanguage,
) -> None:
    actor = await mutation_actor(request, db, language)
    value = await lock_action(db, item_id)
    comment = await editable_comment(db, item_id, comment_id, actor, body.version)
    add_event(db, value, actor, "comment_withdrawn", [
        ActionChange(field="comment", before=comment.body, after=None),
    ], comment_id=comment.id)
    comment.withdrawn_at = comment.updated_at = utcnow()
    comment.version += 1
    await db.commit()


def attachment_filename(value: ActionAttachment) -> str:
    return value.display_filename or value.filename


def attachment_out(value: ActionAttachment, language: Language) -> ActionAttachmentOut:
    return ActionAttachmentOut(
        id=value.id, filename=attachment_filename(value), size=value.size, sha256=value.sha256,
        author=author(value, language), version=value.version,
        created_at=aware(value.created_at),
        withdrawn_at=aware(value.withdrawn_at) if value.withdrawn_at else None,
        purged_at=aware(value.purged_at) if value.purged_at else None,
    )


@router.get("/items/{item_id}/attachments", response_model=ActionAttachmentPage)
async def attachments(
    item_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
    include_withdrawn: bool = False,
) -> ActionAttachmentPage:
    await get_action(db, item_id)
    where = [ActionAttachment.action_id == item_id]
    if not include_withdrawn:
        where.append(ActionAttachment.withdrawn_at.is_(None))
    total = await db.scalar(select(func.count()).select_from(ActionAttachment).where(*where))
    rows = (await db.scalars(
        select(ActionAttachment).where(*where)
        .order_by(ActionAttachment.created_at.desc(), ActionAttachment.id.desc())
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return ActionAttachmentPage(
        items=[attachment_out(row, language) for row in rows], **page_info(total or 0, page),
    )


async def cleanup_upload(request: Request, staged: StagedPDF) -> None:
    await run_in_threadpool(remove_file, staged.temporary)
    # A failed COMMIT response is ambiguous: never delete a possibly committed original.
    try:
        async with request.app.state.sessions() as check:
            retained = await check.scalar(select(ActionAttachment.id).where(
                ActionAttachment.storage_key == staged.storage_key,
            ))
    except SQLAlchemyError:
        log.error("An interrupted action upload needs storage reconciliation")
        return
    if retained is None:
        await run_in_threadpool(remove_file, staged.destination)


@router.post(
    "/items/{item_id}/attachments", response_model=ActionAttachmentOut, status_code=201,
)
async def upload_attachment(
    item_id: ItemId, db: DB, request: Request, language: ServerLanguage, file: UploadFile,
    upload_id: Annotated[UUID, Form()],
) -> ActionAttachmentOut:
    config = settings(request)
    await get_action(db, item_id)
    if file.size is not None and file.size > MAX_BYTES:
        raise AppError("upload_too_large", 413)
    try:
        await run_in_threadpool(
            ensure_free_space, config.upload_dir,
            MAX_BYTES if file.size is None else file.size, config.min_free_disk_mb,
        )
    except AppError:
        # A retry of the requester's own stored upload goes on: it is answered from the
        # database below, and its temporary copy is discarded. Anyone else is refused before
        # anything is written.
        stored = await db.get(ActionAttachment, str(upload_id))
        requester = await mutation_actor(request, db, language)
        if (
            stored is None or stored.action_id != item_id or stored.withdrawn_at is not None
            or stored.author_kind != requester.kind
            or stored.author_user_id != requester.user_id
        ):
            raise
    await db.rollback()
    staged = await run_in_threadpool(
        stage_pdf, file.file, file.filename, config.upload_dir,
    )
    committed = False
    try:
        actor = await mutation_actor(request, db, language)
        value = await lock_action(db, item_id)
        # Serializes uploads across all actions: the retry lookup and the byte budgets below
        # see every committed PDF, and two uploads cannot both pass the same budget check.
        await lock_attachment_storage(db)
        existing = await db.get(ActionAttachment, str(upload_id), populate_existing=True)
        if existing is not None:
            if (
                existing.action_id != item_id or existing.author_kind != actor.kind
                or existing.author_user_id != actor.user_id
                or existing.filename != staged.filename or existing.sha256 != staged.sha256
                or existing.withdrawn_at is not None
            ):
                raise AppError("action_upload_conflict", 409)
            result = attachment_out(existing, language)
            await db.rollback()
            return result
        count = await db.scalar(
            select(func.count()).select_from(ActionAttachment).where(
                ActionAttachment.action_id == item_id, ActionAttachment.withdrawn_at.is_(None),
            )
        )
        if count is not None and count >= MAX_ACTIVE_PDFS:
            raise AppError("action_attachment_limit", 409)
        await check_attachment_quota(db, config, actor, staged.size)
        attachment = ActionAttachment(
            id=str(upload_id), action_id=item_id, storage_key=staged.storage_key,
            filename=staged.filename, size=staged.size, sha256=staged.sha256, **authorship(actor),
        )
        db.add(attachment)
        await db.flush()
        add_event(db, value, actor, "attachment_added", [
            ActionChange(field="filename", before=None, after=attachment.filename),
            ActionChange(field="size", before=None, after=str(attachment.size)),
        ], attachment_id=attachment.id)
        await run_in_threadpool(publish_pdf, staged)
        await db.commit()
        committed = True
        return attachment_out(attachment, language)
    finally:
        if not committed:
            await db.rollback()
            await cleanup_upload(request, staged)


async def get_attachment(db: AsyncSession, item_id: int, attachment_id: UUID) -> ActionAttachment:
    value = await db.get(ActionAttachment, str(attachment_id), populate_existing=True)
    if value is None or value.action_id != item_id:
        raise AppError("action_attachment_not_found", 404)
    return value


@router.get("/items/{item_id}/attachments/{attachment_id}", response_model=ActionAttachmentOut)
async def read_attachment(
    item_id: ItemId, attachment_id: UUID, db: DB, language: ServerLanguage,
) -> ActionAttachmentOut:
    await get_action(db, item_id)
    return attachment_out(await get_attachment(db, item_id, attachment_id), language)


@router.patch("/items/{item_id}/attachments/{attachment_id}", response_model=ActionAttachmentOut)
async def rename_attachment(
    item_id: ItemId, attachment_id: UUID, body: ActionAttachmentEdit, db: DB, request: Request,
    language: ServerLanguage,
) -> ActionAttachmentOut:
    actor = await mutation_actor(request, db, language)
    value = await lock_action(db, item_id)
    attachment = await get_attachment(db, item_id, attachment_id)
    require_owner(attachment, actor)
    check_version(attachment.version, body.version)
    if attachment.withdrawn_at:
        raise AppError("action_content_withdrawn", 409)
    previous = attachment_filename(attachment)
    if previous != body.filename:
        add_event(db, value, actor, "attachment_renamed", [
            ActionChange(field="filename", before=previous, after=body.filename),
        ], attachment_id=attachment.id)
        attachment.display_filename = body.filename if body.filename != attachment.filename else None
        attachment.version += 1
    await db.commit()
    return attachment_out(attachment, language)


@router.delete("/items/{item_id}/attachments/{attachment_id}", status_code=204)
async def withdraw_attachment(
    item_id: ItemId, attachment_id: UUID, body: VersionIn, db: DB, request: Request,
    language: ServerLanguage,
) -> None:
    actor = await mutation_actor(request, db, language)
    value = await lock_action(db, item_id)
    attachment = await get_attachment(db, item_id, attachment_id)
    require_owner(attachment, actor)
    check_version(attachment.version, body.version)
    if attachment.withdrawn_at:
        raise AppError("action_content_withdrawn", 409)
    attachment.withdrawn_at = utcnow()
    attachment.version += 1
    add_event(db, value, actor, "attachment_withdrawn", [
        ActionChange(field="filename", before=attachment_filename(attachment), after=None),
    ], attachment_id=attachment.id)
    await db.commit()


async def attachment_response(
    item_id: int, attachment_id: UUID, db: AsyncSession, request: Request,
    disposition: Literal["attachment", "inline"],
) -> FileResponse:
    await get_action(db, item_id)
    value = await get_attachment(db, item_id, attachment_id)
    if value.purged_at is not None:
        raise AppError("action_attachment_purged", 410)
    path = pdf_path(settings(request).upload_dir, value.storage_key)
    if not path.is_file():
        log.error("A retained community action PDF is missing")
        raise AppError("action_source_missing", 503)
    return FileResponse(
        path, media_type="application/pdf", filename=attachment_filename(value),
        content_disposition_type=disposition,
    )


@router.get("/items/{item_id}/attachments/{attachment_id}/download", response_class=FileResponse)
async def download_attachment(
    item_id: ItemId, attachment_id: UUID, db: DB, request: Request,
) -> FileResponse:
    return await attachment_response(item_id, attachment_id, db, request, "attachment")


@router.get("/items/{item_id}/attachments/{attachment_id}/preview", response_class=FileResponse)
async def preview_attachment(
    item_id: ItemId, attachment_id: UUID, db: DB, request: Request,
) -> FileResponse:
    return await attachment_response(item_id, attachment_id, db, request, "inline")


@router.get("/items/{item_id}/history", response_model=ActionHistoryPage)
async def history(
    item_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> ActionHistoryPage:
    await get_action(db, item_id)
    total = await db.scalar(
        select(func.count()).select_from(ActionEvent).where(ActionEvent.action_id == item_id)
    )
    rows = (await db.scalars(
        select(ActionEvent).where(ActionEvent.action_id == item_id).order_by(ActionEvent.id.desc())
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return ActionHistoryPage(items=[
        ActionEventOut.model_validate({
            "id": row.id, "kind": row.kind, "author": author(row, language),
            "created_at": aware(row.created_at), "changes": row.changes,
            "comment_id": row.comment_id, "attachment_id": row.attachment_id,
        }) for row in rows
    ], **page_info(total or 0, page))
