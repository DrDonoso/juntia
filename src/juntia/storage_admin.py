"""Administrator view of stored action PDFs, and purging of withdrawn ones."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import case, func, select
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool

from .auth import DB, administrator, mutation_session, settings
from .community_action_files import delete_pdf, pdf_path
from .community_actions import (
    PAGE_SIZE,
    PageNumber,
    add_event,
    attachment_filename,
    attachment_out,
    check_version,
    lock_action,
    page_info,
    session_actor,
)
from .contracts import (
    ActionAttachmentOut,
    ActionChange,
    CommunityStorageOut,
    DiskSpaceOut,
    ResidentStorageOut,
    StorageOut,
    StorageUsageOut,
    StoredAttachmentOut,
    StoredAttachmentPage,
    VersionIn,
)
from .db import ActionAttachment, CommunityAction, User, utcnow
from .errors import AppError
from .storage import MIB, disk_space
from .texts import ServerLanguage

router = APIRouter(
    prefix="/api/admin/storage", tags=["Storage"], dependencies=[Depends(administrator)],
)
# Stored bytes, active bytes, stored files and active files of one author.
Totals = tuple[int, int, int, int]


def usage(groups: list[Totals]) -> dict[str, int]:
    stored, active, files, active_files = [
        sum(group[index] for group in groups) for index in range(4)
    ]
    return {
        "stored_bytes": stored, "active_bytes": active, "withdrawn_bytes": stored - active,
        "active_files": active_files, "withdrawn_files": files - active_files,
    }


@router.get("", response_model=StorageOut)
async def storage_summary(db: DB, request: Request) -> StorageOut:
    config = settings(request)
    active = ActionAttachment.withdrawn_at.is_(None)
    rows = (await db.execute(
        select(
            ActionAttachment.author_kind, ActionAttachment.author_user_id,
            func.sum(ActionAttachment.size),
            func.sum(case((active, ActionAttachment.size), else_=0)),
            func.count(), func.count(case((active, 1))),
        ).where(ActionAttachment.purged_at.is_(None))
        .group_by(ActionAttachment.author_kind, ActionAttachment.author_user_id)
    )).all()
    administrator_groups: list[Totals] = []
    residents: dict[int, Totals] = {}
    for kind, user_id, stored, active_bytes, files, active_files in rows:
        totals = (int(stored), int(active_bytes), int(files), int(active_files))
        if kind == "resident" and user_id is not None:
            residents[user_id] = totals
        else:
            administrator_groups.append(totals)
    names = dict((await db.execute(
        select(User.id, User.name).where(User.id.in_(list(residents)))
    )).all())
    snapshots: dict[int, str] = {}
    if missing := [user_id for user_id in residents if user_id not in names]:
        # Deleted accounts keep their stored PDFs: name them by their latest snapshot.
        for user_id, name in (await db.execute(
            select(ActionAttachment.author_user_id, ActionAttachment.author_name).where(
                ActionAttachment.author_kind == "resident",
                ActionAttachment.author_user_id.in_(missing),
            ).order_by(ActionAttachment.created_at.desc(), ActionAttachment.id.desc())
        )).all():
            if user_id is not None:
                snapshots.setdefault(user_id, name)
    quota = config.action_storage_user_quota_mb * MIB
    space = await run_in_threadpool(disk_space, config.upload_dir)
    return StorageOut(
        community=CommunityStorageOut(
            quota_bytes=config.action_storage_community_quota_mb * MIB,
            **usage([*administrator_groups, *residents.values()]),
        ),
        administrator=StorageUsageOut(**usage(administrator_groups)),
        residents=sorted((
            ResidentStorageOut(
                user_id=user_id, name=names.get(user_id, snapshots.get(user_id, "")),
                account_deleted=user_id not in names, quota_bytes=quota, **usage([totals]),
            ) for user_id, totals in residents.items()
        ), key=lambda row: (-row.stored_bytes, row.name.casefold(), row.user_id)),
        resident_quota_bytes=quota,
        disk=DiskSpaceOut(
            total_bytes=space.total if space else None,
            free_bytes=space.free if space else None,
            reserve_bytes=config.min_free_disk_mb * MIB,
        ),
    )


# Withdrawn PDFs that still use storage: the candidates for a purge.
@router.get("/withdrawn", response_model=StoredAttachmentPage)
async def withdrawn_attachments(
    db: DB, language: ServerLanguage, page: PageNumber = 1,
    sort: Literal["largest", "oldest"] = "largest",
    user_id: Annotated[int | None, Query(ge=1, le=2147483647)] = None,
) -> StoredAttachmentPage:
    where: list[ColumnElement[bool]] = [
        ActionAttachment.withdrawn_at.is_not(None), ActionAttachment.purged_at.is_(None),
    ]
    if user_id is not None:
        where += [
            ActionAttachment.author_kind == "resident", ActionAttachment.author_user_id == user_id,
        ]
    total = await db.scalar(select(func.count()).select_from(ActionAttachment).where(*where))
    order = (
        (ActionAttachment.withdrawn_at.asc(), ActionAttachment.id.asc()) if sort == "oldest"
        else (
            ActionAttachment.size.desc(), ActionAttachment.withdrawn_at.asc(),
            ActionAttachment.id.asc(),
        )
    )
    rows = (await db.execute(
        select(ActionAttachment, CommunityAction.title)
        .join(CommunityAction, CommunityAction.id == ActionAttachment.action_id)
        .where(*where).order_by(*order).offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return StoredAttachmentPage(items=[
        StoredAttachmentOut(
            **attachment_out(row, language).model_dump(), action_id=row.action_id,
            action_title=title,
        ) for row, title in rows
    ], **page_info(total or 0, page))


# Deletes a withdrawn PDF from disk and frees its bytes; the row, metadata and history remain.
@router.post("/attachments/{attachment_id}/purge", response_model=ActionAttachmentOut)
async def purge_attachment(
    attachment_id: UUID, body: VersionIn, db: DB, request: Request, language: ServerLanguage,
) -> ActionAttachmentOut:
    actor = session_actor(await mutation_session(request, db), language)
    found = await db.get(ActionAttachment, str(attachment_id))
    if found is None:
        raise AppError("action_attachment_not_found", 404)
    item = await lock_action(db, found.action_id)
    attachment = await db.get(ActionAttachment, str(attachment_id), populate_existing=True)
    assert attachment is not None
    path = pdf_path(settings(request).upload_dir, attachment.storage_key)
    if attachment.purged_at is not None:
        # Repeating a purge succeeds unchanged, and removes a copy restored from a backup.
        await run_in_threadpool(delete_pdf, path)
        result = attachment_out(attachment, language)
        await db.rollback()
        return result
    check_version(attachment.version, body.version)
    if attachment.withdrawn_at is None:
        raise AppError("action_attachment_active", 409)
    attachment.purged_at = utcnow()
    attachment.version += 1
    add_event(db, item, actor, "attachment_purged", [
        ActionChange(field="filename", before=attachment_filename(attachment), after=None),
        ActionChange(field="size", before=str(attachment.size), after=None),
        ActionChange(field="sha256", before=attachment.sha256, after=None),
    ], attachment_id=attachment.id)
    await db.flush()
    # Delete inside the transaction: if deletion fails nothing is committed, so the database
    # never reports a purged file that is still on disk. If the commit fails afterwards, the
    # file is gone but still counted (downloads answer action_source_missing) until a retry.
    await run_in_threadpool(delete_pdf, path)
    await db.commit()
    return attachment_out(attachment, language)
