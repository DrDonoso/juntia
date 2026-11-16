"""Shared documents: folders and files that every member reads and downloads.

Every active resident and the technical administrator can create folders and upload files into any
folder. Who may rename, move, replace (upload a new version of) and delete an item follows the
administrator's policy: whoever created it, only the administrator, or everyone; the administrator
always may. Deleting hides an item, and everything inside a folder, from residents: only the
administrator can see, restore or permanently delete (purge) it. Every item keeps a history of
who created, uploaded, renamed, moved, deleted and restored it, never of what changed inside.

Files arrive in chunks of at most 4 MiB, so large phone videos also work behind proxies with
small body limits and on slow connections, and an interrupted upload resumes where it stopped.
"""

import logging
import math
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path as FilePath
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy import BigInteger, SQLColumnExpression, and_, func, literal, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from . import document_index, queries
from .auth import DB, administrator, mutation_session, reader_session, settings
from .config import Language
from .contracts import (
    ActorOut,
    DocumentBrowseOut,
    DocumentDeletionOut,
    DocumentDeletionPage,
    DocumentEventKind,
    DocumentEventOut,
    DocumentFileMatch,
    DocumentFolderIn,
    DocumentFolderInfoOut,
    DocumentFolderMatch,
    DocumentFolderOut,
    DocumentFolderRef,
    DocumentHistoryPage,
    DocumentInfoOut,
    DocumentItemEdit,
    DocumentLimitsOut,
    DocumentOut,
    DocumentPolicy,
    DocumentSearchPage,
    DocumentSettings,
    DocumentSettingsEdit,
    DocumentSort,
    DocumentTreeFolderOut,
    DocumentUploadIn,
    DocumentUploadOut,
    DocumentVersionOut,
    UserAuthOut,
    VersionIn,
)
from .db import (
    Authorship,
    Document,
    DocumentDeletion,
    DocumentEvent,
    DocumentFolder,
    DocumentUpload,
    DocumentVersion,
    State,
    aware,
    utcnow,
)
from .document_files import (
    TYPES,
    VIDEO_EXTENSIONS,
    ArchiveEntry,
    archive_chunks,
    check_content,
    checked_name,
    checksum,
    create_partial,
    document_name,
    move_file,
    name_key,
    numbered,
    partial_path,
    remove_file,
    stored_path,
    upload_name,
    version_filename,
    write_chunk,
)
from .errors import AppError
from .query_sql import fold_text
from .storage import MIB, ensure_free_space
from .texts import ServerLanguage, author_name, texts

log = logging.getLogger(__name__)
CHUNK_BYTES = 4 * MIB
UPLOAD_LIFETIME = timedelta(hours=24)
MAX_OPEN_UPLOADS = 4
MAX_FOLDER_ITEMS = 1000
MAX_DEPTH = 10
ARCHIVE_MAX_ITEMS = 100
ARCHIVE_MAX_FILES = 5000
ARCHIVE_MAX_BYTES = 10 * 1024 * MIB
ARCHIVE_STREAMS = 4
PAGE_SIZE = 20
BATCH = 500
# Application-wide key for pg_advisory_xact_lock ("juntiaDC"); nothing else uses it.
DOCUMENTS_LOCK = 0x6A756E7469614443
POLICIES: tuple[DocumentPolicy, ...] = ("creator", "administrator", "everyone")
DETAILS = ("name", "previous_name", "location", "previous_location", "number", "size", "folder")
ItemId = Annotated[int, Path(ge=1, le=2147483647)]
PageNumber = Annotated[int, Query(ge=1, le=1000000)]
SearchText = Annotated[str, Query(min_length=1, max_length=200)]
Reader = Annotated[UserAuthOut, Depends(reader_session)]


async def require_documents_enabled(db: DB) -> None:
    if not (await queries.feature_flags(db)).documents:
        raise AppError("documents_disabled", 404)


router = APIRouter(
    prefix="/api/documents", tags=["Shared documents"],
    dependencies=[Depends(reader_session), Depends(require_documents_enabled)],
)
# The administrator's pages keep working while Documents is turned off.
admin_router = APIRouter(
    prefix="/api/admin/documents", tags=["Shared documents"],
    dependencies=[Depends(administrator)],
)
settings_router = APIRouter(
    prefix="/api/admin/settings/documents", tags=["Shared documents"],
    dependencies=[Depends(administrator)],
)


def actor_of(identity: UserAuthOut, language: Language) -> ActorOut:
    return ActorOut.model_validate({
        "kind": "administrator" if identity.kind == "administrator" else "resident",
        "user_id": identity.user_id, "name": author_name(identity.kind, identity.name, language),
    })


def administrator_actor(language: Language) -> ActorOut:
    return ActorOut(kind="administrator", user_id=None, name=texts(language).administrator)


def author(value: Authorship, language: Language) -> ActorOut:
    return ActorOut.model_validate({
        "kind": value.author_kind, "user_id": value.author_user_id,
        "name": author_name(value.author_kind, value.author_name, language),
    })


def authorship(actor: ActorOut) -> dict[str, str | int | None]:
    return {"author_kind": actor.kind, "author_user_id": actor.user_id, "author_name": actor.name}


def owns(value: Authorship, actor: ActorOut) -> bool:
    return value.author_kind == actor.kind and value.author_user_id == actor.user_id


async def mutation_actor(request: Request, db: AsyncSession, language: Language) -> ActorOut:
    identity = await mutation_session(request, db)
    await require_documents_enabled(db)
    return actor_of(identity, language)


async def lock_documents(db: AsyncSession) -> None:
    """Serialize changes to the tree and the byte budgets until the transaction ends."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        await db.execute(select(func.pg_advisory_xact_lock(literal(DOCUMENTS_LOCK, BigInteger()))))
    elif dialect == "sqlite":
        # SQLite has a single writer: a no-op write takes its lock.
        await db.execute(update(State).where(State.id == 1).values(revision=State.revision))
    else:
        raise RuntimeError("Unsupported documents database")


async def manage_policy(db: AsyncSession) -> DocumentPolicy:
    value = await db.scalar(select(State.documents_manage_policy).where(State.id == 1))
    return next((policy for policy in POLICIES if policy == value), "creator")


# The column of the state row behind each document setting.
SETTING_COLUMNS = {
    "manage_policy": State.documents_manage_policy,
    "max_file_mb": State.documents_max_file_mb,
    "max_video_mb": State.documents_max_video_mb,
    "user_quota_mb": State.documents_user_quota_mb,
    "community_quota_mb": State.documents_community_quota_mb,
}


async def document_settings(db: AsyncSession) -> DocumentSettings:
    """The policy and limits that the administrator chose."""
    row = (await db.execute(select(*SETTING_COLUMNS.values()).where(State.id == 1))).one()
    values = dict(zip(SETTING_COLUMNS, row, strict=True))
    values["manage_policy"] = next(
        (policy for policy in POLICIES if policy == values["manage_policy"]), "creator",
    )
    return DocumentSettings(**values)


def may_manage(value: Authorship, actor: ActorOut, policy: DocumentPolicy) -> bool:
    if actor.kind == "administrator" or policy == "everyone":
        return True
    return policy == "creator" and owns(value, actor)


def require_manage(value: Authorship, actor: ActorOut, policy: DocumentPolicy) -> None:
    if not may_manage(value, actor, policy):
        raise AppError("document_permission_required", 403)


def parent_is(
    column: SQLColumnExpression[int | None], parent_id: int | None,
) -> ColumnElement[bool]:
    return column.is_(None) if parent_id is None else column == parent_id


def current_join() -> ColumnElement[bool]:
    return and_(
        DocumentVersion.document_id == Document.id,
        DocumentVersion.number == Document.current_number,
    )


def page_info(total: int, page: int) -> dict[str, int]:
    return {"total": total, "page": page, "pages": max(1, math.ceil(total / PAGE_SIZE))}


def batches(values: list[int]) -> Iterator[list[int]]:
    for start in range(0, len(values), BATCH):
        yield values[start:start + BATCH]


@dataclass(frozen=True)
class TreeFile:
    id: int
    folder_id: int | None
    name: str
    author_kind: str
    author_user_id: int | None
    size: int
    storage_key: str
    extension: str
    # When its current version was uploaded, and when the file last changed in any way.
    modified: datetime
    updated: datetime
    name_key: str


@dataclass
class Tree:
    """Every active folder and file, enough to add up sizes and to build archives."""

    folders: dict[int, DocumentFolder]
    children: dict[int | None, list[int]]
    files: dict[int | None, list[TreeFile]]


@dataclass
class Stats:
    files: int = 0
    folders: int = 0
    size: int = 0
    # Everything inside was created by the person browsing.
    owned: bool = True


async def load_tree(db: AsyncSession) -> Tree:
    folders = {
        value.id: value for value in await db.scalars(
            select(DocumentFolder).where(DocumentFolder.deleted_at.is_(None))
        )
    }
    children: dict[int | None, list[int]] = {}
    for value in sorted(folders.values(), key=lambda item: (item.name_key, item.id)):
        children.setdefault(value.parent_id, []).append(value.id)
    files: dict[int | None, list[TreeFile]] = {}
    rows = await db.execute(
        select(
            Document.id, Document.folder_id, Document.name, Document.name_key,
            Document.author_kind, Document.author_user_id, DocumentVersion.size,
            DocumentVersion.storage_key, DocumentVersion.extension, DocumentVersion.created_at,
            Document.updated_at,
        ).join(DocumentVersion, current_join()).where(Document.deleted_at.is_(None))
        .order_by(Document.name_key, Document.id)
    )
    for row in rows:
        files.setdefault(row.folder_id, []).append(TreeFile(
            row.id, row.folder_id, row.name, row.author_kind, row.author_user_id, int(row.size),
            row.storage_key, row.extension, aware(row.created_at), aware(row.updated_at),
            row.name_key,
        ))
    return Tree(folders, children, files)


def folder_stats(tree: Tree, actor: ActorOut) -> dict[int, Stats]:
    stats: dict[int, Stats] = {}
    for start in tree.folders:
        stack: list[tuple[int, bool]] = [(start, False)]
        while stack:
            folder_id, expanded = stack.pop()
            if folder_id in stats:
                continue
            if not expanded:
                stack.append((folder_id, True))
                stack.extend(
                    (child, False) for child in tree.children.get(folder_id, [])
                    if child not in stats
                )
                continue
            total = Stats()
            for item in tree.files.get(folder_id, []):
                total.files += 1
                total.size += item.size
                total.owned &= (item.author_kind, item.author_user_id) == (
                    actor.kind, actor.user_id,
                )
            for child in tree.children.get(folder_id, []):
                inner = stats.get(child, Stats())
                total.files += inner.files
                total.folders += inner.folders + 1
                total.size += inner.size
                total.owned &= inner.owned and owns(tree.folders[child], actor)
            stats[folder_id] = total
    return stats


def tree_path(tree: Tree, folder_id: int | None) -> list[DocumentFolder]:
    """The folder and the folders above it, from the top level down."""
    path: list[DocumentFolder] = []
    while folder_id is not None and folder_id in tree.folders and len(path) <= MAX_DEPTH * 4:
        path.append(tree.folders[folder_id])
        folder_id = tree.folders[folder_id].parent_id
    return path[::-1]


async def chain(db: AsyncSession, folder_id: int | None) -> list[DocumentFolder]:
    """Like tree_path, also through deleted folders."""
    path: list[DocumentFolder] = []
    seen: set[int] = set()
    while folder_id is not None and folder_id not in seen:
        seen.add(folder_id)
        value = await db.get(DocumentFolder, folder_id)
        if value is None:
            break
        path.append(value)
        folder_id = value.parent_id
    return path[::-1]


def refs(folders: list[DocumentFolder]) -> list[DocumentFolderRef]:
    return [DocumentFolderRef(id=value.id, name=value.name) for value in folders]


def names(folders: list[DocumentFolder]) -> list[str]:
    return [value.name for value in folders]


def limits(stored: DocumentSettings) -> DocumentLimitsOut:
    return DocumentLimitsOut(
        extensions=sorted(TYPES), video_extensions=list(VIDEO_EXTENSIONS),
        max_file_bytes=stored.max_file_mb * MIB,
        max_video_bytes=stored.max_video_mb * MIB, chunk_bytes=CHUNK_BYTES,
        max_folder_items=MAX_FOLDER_ITEMS, max_depth=MAX_DEPTH,
        archive_max_items=ARCHIVE_MAX_ITEMS, archive_max_files=ARCHIVE_MAX_FILES,
        archive_max_bytes=ARCHIVE_MAX_BYTES,
    )


def folder_out(
    value: DocumentFolder, stats: Stats, actor: ActorOut, policy: DocumentPolicy,
    language: Language,
) -> DocumentFolderOut:
    manage = may_manage(value, actor, policy)
    return DocumentFolderOut(
        id=value.id, parent_id=value.parent_id, name=value.name, version=value.version,
        author=author(value, language), created_at=aware(value.created_at),
        updated_at=aware(value.updated_at), file_count=stats.files,
        folder_count=stats.folders, size=stats.size, can_manage=manage,
        can_delete=manage and (
            actor.kind == "administrator" or policy != "creator" or stats.owned
        ),
    )


def version_out(value: DocumentVersion, language: Language) -> DocumentVersionOut:
    return DocumentVersionOut(
        id=value.id, number=value.number, extension=value.extension,
        media_type=value.media_type, size=value.size, sha256=value.sha256,
        author=author(value, language), created_at=aware(value.created_at),
        purged_at=aware(value.purged_at) if value.purged_at else None,
    )


def document_out(
    value: Document, current: DocumentVersion, actor: ActorOut, policy: DocumentPolicy,
    language: Language,
) -> DocumentOut:
    return DocumentOut.model_validate({
        "id": value.id, "folder_id": value.folder_id, "name": value.name, "kind": value.kind,
        "previewable": TYPES[current.extension].preview_type is not None,
        "version": value.version, "author": author(value, language),
        "created_at": aware(value.created_at), "updated_at": aware(value.updated_at),
        "current": version_out(current, language),
        # Versions are numbered from 1 and never removed, only purged.
        "version_count": value.current_number,
        "can_manage": may_manage(value, actor, policy),
    })


async def deleted_by(
    db: AsyncSession, value: Document | DocumentFolder, language: Language,
) -> ActorOut | None:
    if value.deletion_id is None:
        return None
    deletion = await db.get(DocumentDeletion, value.deletion_id)
    return author(deletion, language) if deletion else None


async def document_info(
    db: AsyncSession, value: Document, actor: ActorOut, policy: DocumentPolicy,
    language: Language,
) -> DocumentInfoOut:
    versions = list(await db.scalars(
        select(DocumentVersion).where(DocumentVersion.document_id == value.id)
        .order_by(DocumentVersion.number.desc())
    ))
    current = next(version for version in versions if version.number == value.current_number)
    return DocumentInfoOut.model_validate({
        **document_out(value, current, actor, policy, language).model_dump(),
        "location": refs(await chain(db, value.folder_id)),
        "versions": [version_out(version, language) for version in versions],
        "deleted_at": aware(value.deleted_at) if value.deleted_at else None,
        "deleted_by": await deleted_by(db, value, language),
        "purged_at": aware(value.purged_at) if value.purged_at else None,
        "text": await document_index.text_info(db, current),
    })


async def active_folder(db: AsyncSession, folder_id: int) -> DocumentFolder:
    value = await db.get(DocumentFolder, folder_id, populate_existing=True)
    if value is None or value.deleted_at is not None:
        raise AppError("document_folder_not_found", 404)
    return value


async def active_document(db: AsyncSession, document_id: int) -> Document:
    value = await db.get(Document, document_id, populate_existing=True)
    if value is None or value.deleted_at is not None:
        raise AppError("document_not_found", 404)
    return value


async def current_version(db: AsyncSession, value: Document) -> DocumentVersion:
    found = await db.scalar(select(DocumentVersion).where(
        DocumentVersion.document_id == value.id,
        DocumentVersion.number == value.current_number,
    ))
    if found is None:
        raise RuntimeError("A document has no current version")
    return found


async def sibling_keys(
    db: AsyncSession, parent_id: int | None, *, folder_id: int | None = None,
    document_id: int | None = None,
) -> set[str]:
    folders = select(DocumentFolder.name_key).where(
        parent_is(DocumentFolder.parent_id, parent_id), DocumentFolder.deleted_at.is_(None),
    )
    if folder_id is not None:
        folders = folders.where(DocumentFolder.id != folder_id)
    documents = select(Document.name_key).where(
        parent_is(Document.folder_id, parent_id), Document.deleted_at.is_(None),
    )
    if document_id is not None:
        documents = documents.where(Document.id != document_id)
    return set(await db.scalars(folders)) | set(await db.scalars(documents))


async def require_free_name(
    db: AsyncSession, parent_id: int | None, name: str, *, folder_id: int | None = None,
    document_id: int | None = None,
) -> None:
    taken = await sibling_keys(db, parent_id, folder_id=folder_id, document_id=document_id)
    if name_key(name) in taken:
        raise AppError("document_name_taken", 409, fields={"name": "document_name_taken"})


async def free_name(
    db: AsyncSession, parent_id: int | None, name: str, extension: str | None,
) -> str:
    """The name, or the first free `name (2)`, `name (3)`… among the folder's active items."""
    taken = await sibling_keys(db, parent_id)
    candidate, number = name, 2
    while name_key(candidate) in taken:
        candidate = numbered(name, number, extension)
        number += 1
    return candidate


async def require_room(db: AsyncSession, parent_id: int | None) -> None:
    count = sum([
        await db.scalar(select(func.count()).select_from(DocumentFolder).where(
            parent_is(DocumentFolder.parent_id, parent_id), DocumentFolder.deleted_at.is_(None),
        )) or 0,
        await db.scalar(select(func.count()).select_from(Document).where(
            parent_is(Document.folder_id, parent_id), Document.deleted_at.is_(None),
        )) or 0,
    ])
    if count >= MAX_FOLDER_ITEMS:
        raise AppError("document_folder_full", 409)


async def subtree(
    db: AsyncSession, root: DocumentFolder,
) -> tuple[list[DocumentFolder], list[Document], int]:
    """The folder and every active item inside it, and how many levels of folders it spans."""
    folders: list[DocumentFolder] = [root]
    documents: list[Document] = []
    levels = 0
    level = [root.id]
    while level:
        levels += 1
        below: list[DocumentFolder] = []
        for batch in batches(level):
            documents += list(await db.scalars(select(Document).where(
                Document.folder_id.in_(batch), Document.deleted_at.is_(None),
            )))
            below += list(await db.scalars(select(DocumentFolder).where(
                DocumentFolder.parent_id.in_(batch), DocumentFolder.deleted_at.is_(None),
            )))
        folders += below
        level = [value.id for value in below]
    return folders, documents, levels


def target(value: DocumentFolder | Document) -> dict[str, int | None]:
    if isinstance(value, DocumentFolder):
        return {"folder_id": value.id, "document_id": None}
    return {"folder_id": None, "document_id": value.id}


def record(
    db: AsyncSession, actor: ActorOut, kind: DocumentEventKind, item: DocumentFolder | Document,
    now: datetime, **details: str | int | list[str] | None,
) -> None:
    db.add(DocumentEvent(
        **target(item), kind=kind, created_at=now, **authorship(actor),
        details={key: value for key, value in details.items() if value is not None},
    ))


def event_out(value: DocumentEvent, language: Language) -> DocumentEventOut:
    details = value.details or {}
    return DocumentEventOut.model_validate({
        "id": value.id, "kind": value.kind, "author": author(value, language),
        "created_at": aware(value.created_at), **{key: details.get(key) for key in DETAILS},
    })


async def history_page(
    db: AsyncSession, column: SQLColumnExpression[int | None], item_id: int, page: int,
    language: Language,
) -> DocumentHistoryPage:
    where = column == item_id
    total = await db.scalar(select(func.count()).select_from(DocumentEvent).where(where)) or 0
    rows = await db.scalars(
        select(DocumentEvent).where(where).order_by(DocumentEvent.id.desc())
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )
    return DocumentHistoryPage(
        items=[event_out(row, language) for row in rows], **page_info(total, page),
    )


async def stored_document_bytes(db: AsyncSession, user_id: int | None = None) -> int:
    """Bytes of every stored version, of one resident's uploads when `user_id` is set."""
    where: list[ColumnElement[bool]] = [DocumentVersion.purged_at.is_(None)]
    if user_id is not None:
        where += [
            DocumentVersion.author_kind == "resident", DocumentVersion.author_user_id == user_id,
        ]
    return int(await db.scalar(
        select(func.coalesce(func.sum(DocumentVersion.size), 0)).where(*where)
    ) or 0)


async def check_quota(
    db: AsyncSession, stored: DocumentSettings, actor: ActorOut, size: int,
) -> None:
    """Both byte budgets of the documents; callers hold lock_documents()."""
    if actor.kind == "resident" and actor.user_id is not None:
        used = await stored_document_bytes(db, actor.user_id)
        if used + size > stored.user_quota_mb * MIB:
            raise AppError("document_storage_user_quota", 409)
    if await stored_document_bytes(db) + size > stored.community_quota_mb * MIB:
        log.warning("A document upload was refused by the community storage quota")
        raise AppError("document_storage_community_quota", 409)


@router.get("/browse", response_model=DocumentBrowseOut)
async def browse(
    db: DB, language: ServerLanguage, identity: Reader,
    folder: Annotated[int | None, Query(ge=1, le=2147483647)] = None,
) -> DocumentBrowseOut:
    actor = actor_of(identity, language)
    stored = await document_settings(db)
    policy = stored.manage_policy
    tree = await load_tree(db)
    if folder is not None and folder not in tree.folders:
        raise AppError("document_folder_not_found", 404)
    stats = folder_stats(tree, actor)
    rows = (await db.execute(
        select(Document, DocumentVersion).join(DocumentVersion, current_join())
        .where(parent_is(Document.folder_id, folder), Document.deleted_at.is_(None))
        .order_by(Document.name_key, Document.id)
    )).all()
    return DocumentBrowseOut(
        folder=folder_out(tree.folders[folder], stats[folder], actor, policy, language)
        if folder is not None else None,
        path=refs(tree_path(tree, folder)),
        folders=[
            folder_out(tree.folders[child], stats[child], actor, policy, language)
            for child in tree.children.get(folder, [])
        ],
        files=[document_out(value, current, actor, policy, language) for value, current in rows],
        policy=policy, limits=limits(stored),
    )


def search_order(
    sort: DocumentSort, name_key: str, item_id: int, updated: datetime, size: int,
) -> tuple[float | str | int, ...]:
    """The order of the folder views: the latest change or the largest first, then by name."""
    if sort == "modified":
        return (-updated.timestamp(), name_key, item_id)
    if sort == "size":
        return (-size, name_key, item_id)
    return (name_key, item_id)


@router.get("/search", response_model=DocumentSearchPage)
async def search(
    q: SearchText, db: DB, language: ServerLanguage, identity: Reader,
    page: PageNumber = 1, sort: DocumentSort = "name",
) -> DocumentSearchPage:
    """Folders and files anywhere in Documents whose name contains the text, ignoring case and
    accents, and then the files whose text contains it, with the words around the first place."""
    actor = actor_of(identity, language)
    needle = fold_text(q.strip())
    # The text is kept on one line with single spaces.
    words = fold_text(" ".join(q.split()))
    tree = await load_tree(db)
    stats = folder_stats(tree, actor)
    folders = sorted(
        (value for value in tree.folders.values() if needle and needle in fold_text(value.name)),
        key=lambda value: search_order(
            sort, value.name_key, value.id, aware(value.updated_at), stats[value.id].size,
        ),
    )
    every = [item for items in tree.files.values() for item in items]
    named = [item for item in every if needle and needle in fold_text(item.name)]
    texts = await document_index.text_matches(db, words)
    by_text = {item.id for item in every if item.id in texts} - {item.id for item in named}

    def ordered(items: Iterable[TreeFile]) -> list[TreeFile]:
        return sorted(items, key=lambda item: search_order(
            sort, item.name_key, item.id, item.updated, item.size,
        ))

    matches: list[DocumentFolder | TreeFile] = [
        *folders, *ordered(named), *ordered(item for item in every if item.id in by_text),
    ]
    shown = matches[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]
    shown_files = [item.id for item in shown if isinstance(item, TreeFile)]
    rows = {
        value.id: (value, current) for value, current in (await db.execute(
            select(Document, DocumentVersion).join(DocumentVersion, current_join())
            .where(Document.id.in_(shown_files))
        )).all()
    } if shown_files else {}
    found = await document_index.excerpts(
        db, [item for item in shown_files if item in by_text], words,
    )
    policy = await manage_policy(db)
    return DocumentSearchPage(
        **page_info(len(matches), page),
        folders=[DocumentFolderMatch.model_validate({
            **folder_out(item, stats[item.id], actor, policy, language).model_dump(),
            "location": refs(tree_path(tree, item.parent_id)),
        }) for item in shown if isinstance(item, DocumentFolder)],
        # A file deleted while searching is left out of this page.
        files=[DocumentFileMatch.model_validate({
            **document_out(*rows[item.id], actor, policy, language).model_dump(),
            "location": refs(tree_path(tree, item.folder_id)), "excerpt": found.get(item.id),
        }) for item in shown if isinstance(item, TreeFile) and item.id in rows],
        pending=await document_index.unread(db),
    )


@router.get("/folders", response_model=list[DocumentTreeFolderOut])
async def folder_tree(db: DB) -> list[DocumentTreeFolderOut]:
    rows = await db.execute(
        select(DocumentFolder.id, DocumentFolder.parent_id, DocumentFolder.name)
        .where(DocumentFolder.deleted_at.is_(None))
        .order_by(DocumentFolder.name_key, DocumentFolder.id)
    )
    return [
        DocumentTreeFolderOut(id=row.id, parent_id=row.parent_id, name=row.name) for row in rows
    ]


@router.post("/folders", response_model=DocumentFolderOut, status_code=201)
async def create_folder(
    body: DocumentFolderIn, request: Request, db: DB, language: ServerLanguage,
) -> DocumentFolderOut:
    actor = await mutation_actor(request, db, language)
    name = checked_name(body.name)
    await lock_documents(db)
    above: list[DocumentFolder] = []
    if body.parent_id is not None:
        await active_folder(db, body.parent_id)
        above = await chain(db, body.parent_id)
        if len(above) >= MAX_DEPTH:
            raise AppError("document_depth_limit", 409)
    await require_room(db, body.parent_id)
    await require_free_name(db, body.parent_id, name)
    now = utcnow()
    value = DocumentFolder(
        parent_id=body.parent_id, name=name, name_key=name_key(name), version=1,
        created_at=now, updated_at=now, **authorship(actor),
    )
    db.add(value)
    await db.flush()
    record(db, actor, "created", value, now, name=name, location=names(above))
    policy = await manage_policy(db)
    await db.commit()
    return folder_out(value, Stats(), actor, policy, language)


@router.get("/folders/{folder_id}", response_model=DocumentFolderInfoOut)
async def folder_details(
    folder_id: ItemId, db: DB, language: ServerLanguage, identity: Reader,
) -> DocumentFolderInfoOut:
    actor = actor_of(identity, language)
    tree = await load_tree(db)
    if folder_id not in tree.folders:
        raise AppError("document_folder_not_found", 404)
    value = tree.folders[folder_id]
    stats = folder_stats(tree, actor)
    policy = await manage_policy(db)
    return DocumentFolderInfoOut.model_validate({
        **folder_out(value, stats[folder_id], actor, policy, language).model_dump(),
        "location": refs(tree_path(tree, value.parent_id)),
        "deleted_at": None, "deleted_by": None, "purged_at": None,
    })


@router.patch("/folders/{folder_id}", response_model=DocumentFolderOut)
async def edit_folder(
    folder_id: ItemId, body: DocumentItemEdit, request: Request, db: DB,
    language: ServerLanguage,
) -> DocumentFolderOut:
    actor = await mutation_actor(request, db, language)
    await lock_documents(db)
    value = await active_folder(db, folder_id)
    if value.version != body.version:
        raise AppError("document_stale", 409)
    policy = await manage_policy(db)
    require_manage(value, actor, policy)
    name = checked_name(body.name) if body.name is not None else value.name
    moving = "folder_id" in body.model_fields_set and body.folder_id != value.parent_id
    destination = body.folder_id if moving else value.parent_id
    before = after = await chain(db, value.parent_id)
    if moving:
        after = []
        if destination is not None:
            await active_folder(db, destination)
            after = await chain(db, destination)
            if value.id in {folder.id for folder in after}:
                raise AppError("document_move_into_itself", 409)
        _, _, levels = await subtree(db, value)
        if len(after) + levels > MAX_DEPTH:
            raise AppError("document_depth_limit", 409)
        await require_room(db, destination)
    if moving or name_key(name) != value.name_key:
        await require_free_name(db, destination, name, folder_id=value.id)
    if moving or name != value.name:
        now = utcnow()
        if name != value.name:
            record(db, actor, "renamed", value, now, previous_name=value.name, name=name)
        if moving:
            record(
                db, actor, "moved", value, now, name=name, previous_location=names(before),
                location=names(after),
            )
        value.name, value.name_key, value.parent_id = name, name_key(name), destination
        value.version += 1
        value.updated_at = now
    await db.commit()
    stats = folder_stats(await load_tree(db), actor)
    return folder_out(value, stats.get(value.id, Stats()), actor, policy, language)


async def delete_items(
    db: AsyncSession, actor: ActorOut, root: DocumentFolder | Document,
    folders: list[DocumentFolder], documents: list[Document],
) -> None:
    """Hide the item and everything in it as one deletion, which the administrator can undo."""
    now = utcnow()
    parent = root.parent_id if isinstance(root, DocumentFolder) else root.folder_id
    location = names(await chain(db, parent))
    deletion = DocumentDeletion(
        id=str(uuid4()), name=root.name, location=location, created_at=now, **target(root),
        **authorship(actor),
    )
    db.add(deletion)
    items: list[DocumentFolder | Document] = [*folders, *documents]
    for item in items:
        item.deleted_at = now
        item.deletion_id = deletion.id
        item.version += 1
        if item is root:
            record(db, actor, "deleted", item, now, name=item.name, location=location)
        else:
            record(db, actor, "deleted", item, now, name=item.name, folder=root.name)
    await db.flush()


@router.delete("/folders/{folder_id}", status_code=204)
async def delete_folder(
    folder_id: ItemId, body: VersionIn, request: Request, db: DB, language: ServerLanguage,
) -> None:
    actor = await mutation_actor(request, db, language)
    await lock_documents(db)
    value = await active_folder(db, folder_id)
    if value.version != body.version:
        raise AppError("document_stale", 409)
    policy = await manage_policy(db)
    require_manage(value, actor, policy)
    folders, documents, _ = await subtree(db, value)
    items: list[DocumentFolder | Document] = [*folders, *documents]
    if actor.kind != "administrator" and policy == "creator" and not all(
        owns(item, actor) for item in items
    ):
        raise AppError("document_folder_not_owned", 403)
    await delete_items(db, actor, value, folders, documents)
    await db.commit()


@router.get("/folders/{folder_id}/history", response_model=DocumentHistoryPage)
async def folder_history(
    folder_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> DocumentHistoryPage:
    await active_folder(db, folder_id)
    return await history_page(db, DocumentEvent.folder_id, folder_id, page, language)


@router.get("/files/{document_id}", response_model=DocumentInfoOut)
async def file_details(
    document_id: ItemId, db: DB, language: ServerLanguage, identity: Reader,
) -> DocumentInfoOut:
    value = await active_document(db, document_id)
    return await document_info(
        db, value, actor_of(identity, language), await manage_policy(db), language,
    )


@router.patch("/files/{document_id}", response_model=DocumentOut)
async def edit_file(
    document_id: ItemId, body: DocumentItemEdit, request: Request, db: DB,
    language: ServerLanguage,
) -> DocumentOut:
    actor = await mutation_actor(request, db, language)
    await lock_documents(db)
    value = await active_document(db, document_id)
    if value.version != body.version:
        raise AppError("document_stale", 409)
    policy = await manage_policy(db)
    require_manage(value, actor, policy)
    current = await current_version(db, value)
    name = document_name(body.name, current.extension) if body.name is not None else value.name
    moving = "folder_id" in body.model_fields_set and body.folder_id != value.folder_id
    destination = body.folder_id if moving else value.folder_id
    before = after = await chain(db, value.folder_id)
    if moving:
        after = []
        if destination is not None:
            await active_folder(db, destination)
            after = await chain(db, destination)
        await require_room(db, destination)
    if moving or name_key(name) != value.name_key:
        await require_free_name(db, destination, name, document_id=value.id)
    if moving or name != value.name:
        now = utcnow()
        if name != value.name:
            record(db, actor, "renamed", value, now, previous_name=value.name, name=name)
        if moving:
            record(
                db, actor, "moved", value, now, name=name, previous_location=names(before),
                location=names(after),
            )
        value.name, value.name_key, value.folder_id = name, name_key(name), destination
        value.version += 1
        value.updated_at = now
    await db.commit()
    return document_out(value, current, actor, policy, language)


@router.delete("/files/{document_id}", status_code=204)
async def delete_file(
    document_id: ItemId, body: VersionIn, request: Request, db: DB, language: ServerLanguage,
) -> None:
    actor = await mutation_actor(request, db, language)
    await lock_documents(db)
    value = await active_document(db, document_id)
    if value.version != body.version:
        raise AppError("document_stale", 409)
    require_manage(value, actor, await manage_policy(db))
    await delete_items(db, actor, value, [], [value])
    await db.commit()


@router.get("/files/{document_id}/history", response_model=DocumentHistoryPage)
async def file_history(
    document_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> DocumentHistoryPage:
    await active_document(db, document_id)
    return await history_page(db, DocumentEvent.document_id, document_id, page, language)


async def version_response(
    version_id: UUID, db: AsyncSession, request: Request,
    disposition: Literal["attachment", "inline"], language: Language, *, deleted: bool = False,
) -> FileResponse:
    version = await db.get(DocumentVersion, str(version_id))
    if version is None:
        raise AppError("document_version_not_found", 404)
    document = await db.get(Document, version.document_id)
    if document is None or (document.deleted_at is not None and not deleted):
        raise AppError("document_not_found", 404)
    if version.purged_at is not None:
        raise AppError("document_version_purged", 410)
    file_type = TYPES[version.extension]
    if disposition == "inline" and file_type.preview_type is None:
        raise AppError("document_preview_unavailable", 415)
    path = stored_path(settings(request).upload_dir, version.storage_key, version.extension)
    if not path.is_file():
        log.error("A stored document is missing")
        raise AppError("document_source_missing", 503)
    return FileResponse(
        path,
        media_type=file_type.preview_type if disposition == "inline" else file_type.media_type,
        filename=version_filename(
            document.name, version.number, document.current_number, version.extension,
            texts(language).document_version,
        ),
        content_disposition_type=disposition,
    )


@router.get("/versions/{version_id}/download", response_class=FileResponse)
async def download_version(
    version_id: UUID, db: DB, request: Request, language: ServerLanguage,
) -> FileResponse:
    return await version_response(version_id, db, request, "attachment", language)


# PDFs, pictures, videos, and text and CSV files, which the portal's viewer shows from its own
# address: videos can be sought, and text files read in part. Phones and tablets open PDFs in a tab.
@router.get("/versions/{version_id}/preview", response_class=FileResponse)
async def preview_version(
    version_id: UUID, db: DB, request: Request, language: ServerLanguage,
) -> FileResponse:
    return await version_response(version_id, db, request, "inline", language)


def attachment_disposition(filename: str) -> str:
    quoted = quote(filename)
    if quoted != filename:
        return f"attachment; filename*=utf-8''{quoted}"
    return f'attachment; filename="{filename}"'


class ArchiveResponse(StreamingResponse):
    """Frees its slot and closes its files however the download ends."""

    def __init__(self, chunks: Iterator[bytes], release: Callable[[], None], filename: str):
        super().__init__(chunks, media_type="application/zip", headers={
            "Content-Disposition": attachment_disposition(filename),
        })
        self.chunks = chunks
        self.release = release

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.release()
            close = getattr(self.chunks, "close", None)
            if close is not None:
                close()


def archive_slot(request: Request) -> Callable[[], None]:
    state = request.app.state
    if getattr(state, "document_archives", 0) >= ARCHIVE_STREAMS:
        raise AppError("document_archive_busy", 503)
    state.document_archives = getattr(state, "document_archives", 0) + 1
    released = False

    def release() -> None:
        nonlocal released
        if not released:
            released = True
            state.document_archives -= 1

    return release


@dataclass
class Archive:
    entries: list[ArchiveEntry] = field(default_factory=list)
    used: set[str] = field(default_factory=set)
    files: int = 0
    size: int = 0


@router.get("/archive", response_class=StreamingResponse, responses={
    200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}},
})
async def archive(
    request: Request, db: DB, language: ServerLanguage,
    folder: Annotated[list[int], Query()] = [],
    file: Annotated[list[int], Query()] = [],
) -> StreamingResponse:
    """A folder, several folders or a selection, as one ZIP that keeps the folder structure."""
    if not 1 <= len(folder) + len(file) <= ARCHIVE_MAX_ITEMS or not all(
        1 <= value <= 2147483647 for value in [*folder, *file]
    ):
        raise AppError("document_archive_items", 422)
    config = settings(request)
    zone = ZoneInfo(config.tz)
    tree = await load_tree(db)
    by_id = {item.id: item for items in tree.files.values() for item in items}
    if any(value not in tree.folders for value in folder):
        raise AppError("document_folder_not_found", 404)
    if any(value not in by_id for value in file):
        raise AppError("document_not_found", 404)
    chosen = set(folder)

    def inside(folder_id: int | None) -> bool:
        return any(value.id in chosen for value in tree_path(tree, folder_id))

    roots = sorted(
        (tree.folders[value] for value in chosen if not inside(tree.folders[value].parent_id)),
        key=lambda value: (value.name_key, value.id),
    )
    loose = sorted(
        (by_id[value] for value in set(file) if not inside(by_id[value].folder_id)),
        key=lambda value: (name_key(value.name), value.id),
    )
    result = Archive()

    def top(name: str, extension: str | None) -> str:
        candidate, number = name, 2
        while name_key(candidate) in result.used:
            candidate = numbered(name, number, extension)
            number += 1
        result.used.add(name_key(candidate))
        return candidate

    def add_file(path: str, item: TreeFile) -> None:
        result.files += 1
        result.size += item.size
        if result.files > ARCHIVE_MAX_FILES or result.size > ARCHIVE_MAX_BYTES:
            raise AppError("document_archive_too_large", 422)
        result.entries.append(ArchiveEntry(
            path, stored_path(config.upload_dir, item.storage_key, item.extension), item.size,
            item.modified.astimezone(zone),
        ))

    def add_folder(prefix: str, value: DocumentFolder) -> None:
        result.entries.append(ArchiveEntry(
            prefix, None, 0, aware(value.updated_at).astimezone(zone),
        ))
        for item in tree.files.get(value.id, []):
            add_file(prefix + item.name, item)
        for child in tree.children.get(value.id, []):
            add_folder(prefix + tree.folders[child].name + "/", tree.folders[child])

    for value in roots:
        add_folder(top(value.name, None) + "/", value)
    for item in loose:
        add_file(top(item.name, item.extension), item)

    def missing() -> bool:
        return any(entry.source is not None and not entry.source.is_file()
                   for entry in result.entries)

    if await run_in_threadpool(missing):
        log.error("A stored document is missing")
        raise AppError("document_source_missing", 503)
    parents = {value.parent_id for value in roots} | {item.folder_id for item in loose}
    if len(roots) == 1 and not loose:
        title = roots[0].name
    elif len(parents) == 1 and (parent := next(iter(parents))) is not None:
        title = tree.folders[parent].name
    else:
        title = texts(language).documents
    return ArchiveResponse(archive_chunks(result.entries), archive_slot(request), title + ".zip")


def upload_out(value: DocumentUpload) -> DocumentUploadOut:
    return DocumentUploadOut(
        id=value.id, name=value.name, size=value.size, received=value.received,
        folder_id=value.folder_id, document_id=value.document_id,
        expires_at=aware(value.expires_at),
    )


def authored_by(actor: ActorOut) -> list[ColumnElement[bool]]:
    return [
        DocumentUpload.author_kind == actor.kind,
        DocumentUpload.author_user_id.is_(None) if actor.user_id is None
        else DocumentUpload.author_user_id == actor.user_id,
    ]


async def lock_upload(db: AsyncSession, upload_id: str) -> DocumentUpload | None:
    found = await db.scalar(
        update(DocumentUpload).where(DocumentUpload.id == upload_id)
        .values(received=DocumentUpload.received).returning(DocumentUpload.id)
    )
    if found is None:
        return None
    return await db.get(DocumentUpload, upload_id, populate_existing=True)


async def remove_partials(directory: FilePath, values: list[DocumentUpload]) -> None:
    for value in values:
        try:
            await run_in_threadpool(remove_file, partial_path(directory, value.storage_key))
        except AppError:
            log.error("A discarded document upload left a partial file")


async def discard_upload(db: AsyncSession, directory: FilePath, value: DocumentUpload) -> None:
    """Give up an upload that can never complete, and free its disk space."""
    await db.delete(value)
    await db.commit()
    await remove_partials(directory, [value])


async def clean_uploads(db: AsyncSession, directory: FilePath) -> None:
    """At startup: discard expired uploads and partial files that no upload refers to."""
    expired = list(await db.scalars(
        select(DocumentUpload).where(DocumentUpload.expires_at <= utcnow())
    ))
    for value in expired:
        await db.delete(value)
    await db.commit()
    keys = set(await db.scalars(select(DocumentUpload.storage_key)))

    def sweep() -> None:
        folder = directory / "documents"
        if folder.is_dir():
            for path in folder.glob("*.part"):
                if path.stem not in keys:
                    path.unlink(missing_ok=True)

    try:
        await run_in_threadpool(sweep)
    except OSError:
        log.error("Abandoned document uploads could not be removed")


@router.post("/uploads", response_model=DocumentUploadOut, status_code=201)
async def create_upload(
    body: DocumentUploadIn, request: Request, db: DB, language: ServerLanguage,
) -> DocumentUploadOut:
    """Start an upload (or find the one already started with this ID); chunks follow."""
    config = settings(request)
    actor = await mutation_actor(request, db, language)
    name, extension = upload_name(body.name)
    file_type = TYPES[extension]
    if body.size == 0:
        raise AppError("document_file_empty", 422)
    stored = await document_settings(db)
    limit = stored.max_video_mb if file_type.kind == "video" else stored.max_file_mb
    if body.size > limit * MIB:
        raise AppError("document_too_large", 413)
    upload_id = str(body.upload_id)
    await lock_documents(db)
    existing = await db.get(DocumentUpload, upload_id, populate_existing=True)
    if existing is not None:
        if not owns(existing, actor) or (
            existing.name, existing.size, existing.folder_id, existing.document_id,
        ) != (name, body.size, body.folder_id, body.document_id):
            raise AppError("document_upload_conflict", 409)
        result = upload_out(existing)
        await db.rollback()
        return result
    if await db.get(DocumentVersion, upload_id) is not None:
        raise AppError("document_upload_conflict", 409)
    if body.document_id is not None:
        document = await active_document(db, body.document_id)
        require_manage(document, actor, await manage_policy(db))
        if (await current_version(db, document)).extension != extension:
            raise AppError("document_version_extension", 422)
    else:
        if body.folder_id is not None:
            await active_folder(db, body.folder_id)
        await require_room(db, body.folder_id)
    await check_quota(db, stored, actor, body.size)
    await run_in_threadpool(
        ensure_free_space, config.upload_dir, body.size, config.min_free_disk_mb,
    )
    now = utcnow()
    # Expired uploads, and this person's least recently active ones beyond the limit.
    discarded = list(await db.scalars(
        select(DocumentUpload).where(DocumentUpload.expires_at <= now)
    )) + list(await db.scalars(
        select(DocumentUpload).where(*authored_by(actor), DocumentUpload.expires_at > now)
        .order_by(DocumentUpload.updated_at.desc(), DocumentUpload.id)
        .offset(MAX_OPEN_UPLOADS - 1)
    ))
    for value in discarded:
        await db.delete(value)
    value = DocumentUpload(
        id=upload_id, folder_id=body.folder_id, document_id=body.document_id, name=name,
        extension=extension, size=body.size, received=0, storage_key=str(uuid4()),
        created_at=now, updated_at=now, expires_at=now + UPLOAD_LIFETIME, **authorship(actor),
    )
    db.add(value)
    partial = partial_path(config.upload_dir, value.storage_key)
    await run_in_threadpool(create_partial, partial)
    try:
        await db.commit()
    except BaseException:
        await remove_partials(config.upload_dir, [value])
        raise
    await remove_partials(config.upload_dir, discarded)
    return upload_out(value)


async def own_upload(db: AsyncSession, upload_id: UUID, actor: ActorOut) -> DocumentUpload:
    value = await lock_upload(db, str(upload_id))
    if value is None or not owns(value, actor) or aware(value.expires_at) <= utcnow():
        raise AppError("document_upload_not_found", 404)
    return value


@router.get("/uploads/{upload_id}", response_model=DocumentUploadOut)
async def upload_status(
    upload_id: UUID, db: DB, language: ServerLanguage, identity: Reader,
) -> DocumentUploadOut:
    """How much of an upload arrived, to resume it after an interruption."""
    value = await db.get(DocumentUpload, str(upload_id))
    if (
        value is None or not owns(value, actor_of(identity, language))
        or aware(value.expires_at) <= utcnow()
    ):
        raise AppError("document_upload_not_found", 404)
    return upload_out(value)


@router.put(
    "/uploads/{upload_id}/content", response_model=DocumentUploadOut,
    openapi_extra={"requestBody": {"required": True, "content": {
        "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
    }}},
)
async def upload_chunk(
    upload_id: UUID, request: Request, db: DB, language: ServerLanguage,
    offset: Annotated[int, Query(ge=0, le=9007199254740991)],
) -> DocumentUploadOut:
    """The next bytes of an upload, at most 4 MiB, starting where the received ones end."""
    config = settings(request)
    data = await request.body()
    if not data or len(data) > CHUNK_BYTES:
        raise AppError("document_upload_size", 422)
    actor = await mutation_actor(request, db, language)
    value = await own_upload(db, upload_id, actor)
    if offset != value.received:
        raise AppError("document_upload_offset", 409)
    if value.received + len(data) > value.size:
        raise AppError("document_upload_size", 422)
    await run_in_threadpool(
        ensure_free_space, config.upload_dir, len(data), config.min_free_disk_mb,
    )
    await run_in_threadpool(
        write_chunk, partial_path(config.upload_dir, value.storage_key), offset, data,
    )
    now = utcnow()
    value.received += len(data)
    value.updated_at = now
    value.expires_at = now + UPLOAD_LIFETIME
    await db.commit()
    return upload_out(value)


@router.delete("/uploads/{upload_id}", status_code=204)
async def cancel_upload(
    upload_id: UUID, request: Request, db: DB, language: ServerLanguage,
) -> None:
    actor = await mutation_actor(request, db, language)
    value = await lock_upload(db, str(upload_id))
    if value is None:
        return
    if not owns(value, actor):
        raise AppError("document_upload_not_found", 404)
    await discard_upload(db, settings(request).upload_dir, value)


async def completed(
    db: AsyncSession, upload_id: str, actor: ActorOut, language: Language,
) -> DocumentOut:
    """A completion retried after it succeeded is answered from the stored version."""
    version = await db.get(DocumentVersion, upload_id)
    if version is None or not owns(version, actor):
        raise AppError("document_upload_not_found", 404)
    document = await db.get(Document, version.document_id)
    if document is None or document.deleted_at is not None:
        raise AppError("document_not_found", 404)
    return document_out(
        document, await current_version(db, document), actor, await manage_policy(db), language,
    )


def inspect_upload(path: FilePath, extension: str) -> str:
    check_content(path, extension)
    try:
        return checksum(path)
    except FileNotFoundError:
        raise AppError("document_upload_not_found", 404) from None
    except OSError:
        log.error("An uploaded document could not be read")
        raise AppError("document_storage_error", 503) from None


async def unpublish(
    request: Request, storage_key: str, destination: FilePath, partial: FilePath,
) -> None:
    # A failed COMMIT response is ambiguous: keep a file the database may already reference.
    try:
        async with request.app.state.sessions() as check:
            retained = await check.scalar(select(DocumentVersion.id).where(
                DocumentVersion.storage_key == storage_key,
            ))
    except SQLAlchemyError:
        log.error("An interrupted document upload needs storage reconciliation")
        return
    if retained is None:
        try:
            await run_in_threadpool(move_file, destination, partial)
        except AppError:
            log.error("An interrupted document upload could not be returned to its upload")


@router.post("/uploads/{upload_id}/complete", response_model=DocumentOut)
async def complete_upload(
    upload_id: UUID, request: Request, db: DB, language: ServerLanguage,
) -> DocumentOut:
    """Check the received file and add it as a new document or a new version."""
    config = settings(request)
    key = str(upload_id)
    actor = await mutation_actor(request, db, language)
    value = await db.get(DocumentUpload, key)
    if value is None or not owns(value, actor):
        return await completed(db, key, actor, language)
    if value.received != value.size:
        raise AppError("document_upload_incomplete", 409)
    storage_key, extension, size = value.storage_key, value.extension, value.size
    await db.rollback()
    partial = partial_path(config.upload_dir, storage_key)
    try:
        digest = await run_in_threadpool(inspect_upload, partial, extension)
    except AppError as error:
        if error.status == 415:
            refused = await lock_upload(db, key)
            if refused is not None and refused.storage_key == storage_key:
                await discard_upload(db, config.upload_dir, refused)
        raise
    destination = stored_path(config.upload_dir, storage_key, extension)
    published = committed = False
    try:
        actor = await mutation_actor(request, db, language)
        await lock_documents(db)
        upload = await db.get(DocumentUpload, key, populate_existing=True)
        if upload is None or not owns(upload, actor) or upload.storage_key != storage_key:
            await db.rollback()
            return await completed(db, key, actor, language)
        # The administrator may have changed the policy or the quotas since the upload began.
        stored = await document_settings(db)
        policy = stored.manage_policy
        now = utcnow()
        file_type = TYPES[extension]
        if upload.document_id is not None:
            document = await db.get(Document, upload.document_id, populate_existing=True)
            if document is None or document.deleted_at is not None:
                await discard_upload(db, config.upload_dir, upload)
                raise AppError("document_deleted", 409)
            if not may_manage(document, actor, policy):
                await discard_upload(db, config.upload_dir, upload)
                raise AppError("document_permission_required", 403)
            await check_quota(db, stored, actor, size)
            number = document.current_number + 1
            document.current_number = number
            document.version += 1
            document.updated_at = now
            record(
                db, actor, "version_added", document, now, name=document.name, number=number,
                size=size,
            )
        else:
            if upload.folder_id is not None:
                folder = await db.get(DocumentFolder, upload.folder_id)
                if folder is None or folder.deleted_at is not None:
                    await discard_upload(db, config.upload_dir, upload)
                    raise AppError("document_folder_deleted", 409)
            await require_room(db, upload.folder_id)
            await check_quota(db, stored, actor, size)
            name = await free_name(db, upload.folder_id, upload.name, extension)
            number = 1
            document = Document(
                folder_id=upload.folder_id, name=name, name_key=name_key(name),
                kind=file_type.kind, current_number=1, version=1, created_at=now,
                updated_at=now, **authorship(actor),
            )
            db.add(document)
            await db.flush()
            record(
                db, actor, "created", document, now, name=name,
                location=names(await chain(db, upload.folder_id)), number=1, size=size,
            )
        version = DocumentVersion(
            id=key, document_id=document.id, number=number, storage_key=storage_key,
            extension=extension, media_type=file_type.media_type, size=size, sha256=digest,
            created_at=now, **authorship(actor),
        )
        db.add(version)
        await db.delete(upload)
        await db.flush()
        await document_index.queue_version(db, version, now)
        await run_in_threadpool(move_file, partial, destination)
        published = True
        await db.commit()
        committed = True
        document_index.wake(request.app)
        return document_out(document, version, actor, policy, language)
    finally:
        if not committed:
            await db.rollback()
            if published:
                await unpublish(request, storage_key, destination, partial)


@settings_router.get("", response_model=DocumentSettings)
async def read_document_settings(db: DB) -> DocumentSettings:
    return await document_settings(db)


@settings_router.patch("", response_model=DocumentSettings)
async def update_document_settings(
    body: DocumentSettingsEdit, request: Request, db: DB,
) -> DocumentSettings:
    """Change only the settings sent; the limits apply to the next uploads and checks."""
    await mutation_session(request, db)
    await db.execute(update(State).where(State.id == 1).values({
        SETTING_COLUMNS[field]: getattr(body, field) for field in body.model_fields_set
    }))
    await db.commit()
    return await document_settings(db)


async def deletion_items(
    db: AsyncSession, deletion: DocumentDeletion,
) -> tuple[list[DocumentFolder], list[Document]]:
    folders = list(await db.scalars(
        select(DocumentFolder).where(DocumentFolder.deletion_id == deletion.id)
        .order_by(DocumentFolder.id)
    ))
    documents = list(await db.scalars(
        select(Document).where(Document.deletion_id == deletion.id).order_by(Document.id)
    ))
    return folders, documents


@admin_router.get("/deleted", response_model=DocumentDeletionPage)
async def deleted_documents(
    db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> DocumentDeletionPage:
    """What residents deleted and the administrator can still restore or purge, newest first."""
    where = [DocumentDeletion.restored_at.is_(None), DocumentDeletion.purged_at.is_(None)]
    total = await db.scalar(select(func.count()).select_from(DocumentDeletion).where(*where)) or 0
    rows = list(await db.scalars(
        select(DocumentDeletion).where(*where)
        .order_by(DocumentDeletion.created_at.desc(), DocumentDeletion.id)
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    ))
    ids = [row.id for row in rows]
    files: dict[str | None, int] = dict((await db.execute(
        select(Document.deletion_id, func.count()).where(Document.deletion_id.in_(ids))
        .group_by(Document.deletion_id)
    )).all())
    folders: dict[str | None, int] = dict((await db.execute(
        select(DocumentFolder.deletion_id, func.count())
        .where(DocumentFolder.deletion_id.in_(ids)).group_by(DocumentFolder.deletion_id)
    )).all())
    sizes = dict((await db.execute(
        select(Document.deletion_id, func.sum(DocumentVersion.size))
        .join(DocumentVersion, DocumentVersion.document_id == Document.id)
        .where(Document.deletion_id.in_(ids), DocumentVersion.purged_at.is_(None))
        .group_by(Document.deletion_id)
    )).all())
    kinds = dict((await db.execute(select(Document.id, Document.kind).where(
        Document.id.in_([row.document_id for row in rows if row.document_id is not None]),
    ))).all())
    return DocumentDeletionPage(items=[DocumentDeletionOut.model_validate({
        "id": row.id, "folder_id": row.folder_id, "document_id": row.document_id,
        "name": row.name, "location": row.location,
        "file_kind": kinds.get(row.document_id) if row.document_id is not None else None,
        "file_count": files.get(row.id, 0),
        "folder_count": max(0, folders.get(row.id, 0) - (1 if row.folder_id is not None else 0)),
        "stored_bytes": int(sizes.get(row.id) or 0), "author": author(row, language),
        "created_at": aware(row.created_at),
    }) for row in rows], **page_info(total, page))


@admin_router.get("/files/{document_id}", response_model=DocumentInfoOut)
async def admin_file_details(
    document_id: ItemId, db: DB, language: ServerLanguage,
) -> DocumentInfoOut:
    value = await db.get(Document, document_id)
    if value is None:
        raise AppError("document_not_found", 404)
    return await document_info(
        db, value, administrator_actor(language), await manage_policy(db), language,
    )


@admin_router.get("/files/{document_id}/history", response_model=DocumentHistoryPage)
async def admin_file_history(
    document_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> DocumentHistoryPage:
    if await db.get(Document, document_id) is None:
        raise AppError("document_not_found", 404)
    return await history_page(db, DocumentEvent.document_id, document_id, page, language)


@admin_router.get("/folders/{folder_id}/history", response_model=DocumentHistoryPage)
async def admin_folder_history(
    folder_id: ItemId, db: DB, language: ServerLanguage, page: PageNumber = 1,
) -> DocumentHistoryPage:
    if await db.get(DocumentFolder, folder_id) is None:
        raise AppError("document_folder_not_found", 404)
    return await history_page(db, DocumentEvent.folder_id, folder_id, page, language)


# The administrator's copy of any stored version, deleted documents' included.
@admin_router.get("/versions/{version_id}/download", response_class=FileResponse)
async def admin_download_version(
    version_id: UUID, db: DB, request: Request, language: ServerLanguage,
) -> FileResponse:
    return await version_response(
        version_id, db, request, "attachment", language, deleted=True,
    )


@admin_router.get("/versions/{version_id}/preview", response_class=FileResponse)
async def admin_preview_version(
    version_id: UUID, db: DB, request: Request, language: ServerLanguage,
) -> FileResponse:
    return await version_response(version_id, db, request, "inline", language, deleted=True)


async def open_deletion(db: AsyncSession, deletion_id: UUID) -> DocumentDeletion:
    value = await db.get(DocumentDeletion, str(deletion_id), populate_existing=True)
    if value is None:
        raise AppError("document_deletion_not_found", 404)
    return value


@admin_router.post("/deletions/{deletion_id}/restore", status_code=204)
async def restore_deletion(
    deletion_id: UUID, request: Request, db: DB, language: ServerLanguage,
) -> None:
    """Bring back everything deleted together, where it was, or at the top level if that folder
    is gone; a name already in use gets a number."""
    actor = actor_of(await mutation_session(request, db), language)
    await lock_documents(db)
    deletion = await open_deletion(db, deletion_id)
    if deletion.restored_at is not None or deletion.purged_at is not None:
        raise AppError("document_deletion_closed", 409)
    folders, documents = await deletion_items(db, deletion)
    root: DocumentFolder | Document | None = next(
        (item for item in [*folders, *documents] if (
            isinstance(item, DocumentFolder) and item.id == deletion.folder_id
            or isinstance(item, Document) and item.id == deletion.document_id
        )), None,
    )
    if root is None:
        raise RuntimeError("A document deletion lost its item")
    parent = root.parent_id if isinstance(root, DocumentFolder) else root.folder_id
    if parent is not None:
        container = await db.get(DocumentFolder, parent)
        if container is None or container.deleted_at is not None:
            parent = None
    extension = None
    if isinstance(root, Document):
        extension = (await current_version(db, root)).extension
    name = await free_name(db, parent, root.name, extension)
    location = names(await chain(db, parent))
    now = utcnow()
    items: list[DocumentFolder | Document] = [*folders, *documents]
    for item in items:
        item.deleted_at = None
        item.deletion_id = None
        item.version += 1
        if item is root:
            record(
                db, actor, "restored", item, now, name=name, location=location,
                previous_name=root.name if name != root.name else None,
            )
        else:
            record(db, actor, "restored", item, now, name=item.name, folder=name)
    root.name, root.name_key = name, name_key(name)
    if isinstance(root, DocumentFolder):
        root.parent_id = parent
    else:
        root.folder_id = parent
    root.updated_at = now
    deletion.restored_at = now
    await db.commit()
    # Restored files whose text was waiting can be read now.
    document_index.wake(request.app)


@admin_router.post("/deletions/{deletion_id}/purge", status_code=204)
async def purge_deletion(
    deletion_id: UUID, request: Request, db: DB, language: ServerLanguage,
) -> None:
    """Delete the files of everything deleted together, for good; records and history remain."""
    actor = actor_of(await mutation_session(request, db), language)
    await lock_documents(db)
    deletion = await open_deletion(db, deletion_id)
    if deletion.restored_at is not None:
        raise AppError("document_deletion_closed", 409)
    folders, documents = await deletion_items(db, deletion)
    versions = list(await db.scalars(select(DocumentVersion).where(
        DocumentVersion.document_id.in_([value.id for value in documents]),
    ))) if documents else []
    directory = settings(request).upload_dir
    paths = [
        stored_path(directory, version.storage_key, version.extension) for version in versions
    ]

    def delete_all() -> None:
        for path in paths:
            remove_file(path)

    if deletion.purged_at is not None:
        # Repeating a purge succeeds unchanged, and removes copies restored from a backup.
        await run_in_threadpool(delete_all)
        await db.rollback()
        return
    now = utcnow()
    for version in versions:
        if version.purged_at is None:
            version.purged_at = now
    items: list[DocumentFolder | Document] = [*folders, *documents]
    root_name = deletion.name
    for item in items:
        item.purged_at = now
        is_root = deletion.folder_id == item.id if isinstance(item, DocumentFolder) else (
            deletion.document_id == item.id
        )
        record(
            db, actor, "purged", item, now, name=item.name,
            folder=None if is_root else root_name,
        )
    deletion.purged_at = now
    await document_index.forget(db, [version.id for version in versions])
    await db.flush()
    # As for action PDFs: the files are deleted before the commit, so the database never
    # reports a purged file that is still on disk.
    await run_in_threadpool(delete_all)
    await db.commit()
