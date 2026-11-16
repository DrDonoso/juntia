"""How the text of shared documents is read for the search, for the administrator: whether OCR is
available, how far the reading has come, the file being read, and the files by state, which can be
read again. It keeps working while Documents is turned off."""

import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import Row, and_, case, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool

from . import document_index
from .auth import DB, administrator, mutation_session, settings
from .community_documents import (
    ItemId,
    PageNumber,
    active_document,
    chain,
    current_version,
    refs,
)
from .contracts import (
    DocumentTextCountsOut,
    DocumentTextEngineOut,
    DocumentTextFileOut,
    DocumentTextFilePage,
    DocumentTextFilter,
    DocumentTextQueueOut,
    DocumentTextReadingOut,
    DocumentTextSummaryOut,
)
from .db import Document, DocumentText, DocumentVersion, aware, utcnow
from .document_text import READABLE
from .errors import AppError

router = APIRouter(
    prefix="/api/admin/documents/text", tags=["Shared documents"],
    dependencies=[Depends(administrator)],
)
PAGE_SIZE = 20


def total(condition: ColumnElement[bool]) -> ColumnElement[Any]:
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


def active_texts() -> list[ColumnElement[bool]]:
    return [Document.deleted_at.is_(None)]


def joined(statement: Any) -> Any:
    return statement.select_from(DocumentText).join(
        DocumentVersion, DocumentVersion.id == DocumentText.version_id,
    ).join(Document, document_index.current())


def being_read() -> ColumnElement[bool]:
    return and_(
        DocumentText.status == "pending", DocumentText.claim_id.is_not(None),
        DocumentText.claimed_until > utcnow(),
    )


def selected(status: DocumentTextFilter) -> list[ColumnElement[bool]]:
    ready = DocumentText.status == "ready"
    return {
        "all": [],
        "pending": [DocumentText.status == "pending"],
        "failed": [DocumentText.status == "failed"],
        "empty": [ready, DocumentText.characters == 0],
        "text": [ready, DocumentText.characters > 0],
        "partial": [ready, DocumentText.partial.is_(True)],
        "ocr": [ready, DocumentText.ocr_pages > 0],
    }[status]


def file_columns() -> tuple[Any, ...]:
    return (
        Document.id, Document.name, Document.kind, Document.folder_id, DocumentText.status,
        DocumentText.characters, DocumentText.ocr_pages, DocumentText.partial,
        DocumentText.needs_ocr, DocumentText.error, DocumentText.read_at,
        being_read().label("reading"),
    )


async def file_out(db: AsyncSession, row: Row[Any]) -> DocumentTextFileOut:
    status = document_index.status_of(row.status, row.characters)
    return DocumentTextFileOut.model_validate({
        "document_id": row.id, "name": row.name, "kind": row.kind,
        "location": refs(await chain(db, row.folder_id)), "status": status,
        "reading": bool(row.reading), "error": row.error if status == "failed" else None,
        "characters": row.characters, "ocr_pages": row.ocr_pages, "partial": row.partial,
        "needs_ocr": row.needs_ocr, "read_at": aware(row.read_at) if row.read_at else None,
    })


@router.get("", response_model=DocumentTextSummaryOut)
async def reading_summary(db: DB, request: Request) -> DocumentTextSummaryOut:
    reader = getattr(request.app.state, "document_reader", None)
    engine = reader.engine if reader is not None else await run_in_threadpool(
        document_index.probe_engine, settings(request).app_language,
    )
    files = await db.scalar(
        select(func.count()).select_from(Document).where(Document.deleted_at.is_(None))
    ) or 0
    ready = DocumentText.status == "ready"
    counts = (await db.execute(joined(select(
        func.count(), total(DocumentText.status == "pending"),
        total(and_(ready, DocumentText.characters > 0)),
        total(and_(ready, DocumentText.characters == 0)), total(DocumentText.status == "failed"),
        total(and_(ready, DocumentText.partial.is_(True))),
        total(and_(ready, DocumentText.ocr_pages > 0)),
        total(and_(ready, DocumentText.needs_ocr.is_(True))),
    )).where(*active_texts()))).one()
    reading = (await db.execute(joined(
        select(Document.id, Document.name, DocumentText.claimed_at)
    ).where(*active_texts(), being_read()).order_by(DocumentText.claimed_at).limit(1))).first()
    readable, pending, text, empty, failed, partial, ocr, needs_ocr = (int(value) for value in counts)
    return DocumentTextSummaryOut(
        engine=DocumentTextEngineOut(
            available=engine.available, version=engine.version, language=engine.language,
        ),
        counts=DocumentTextCountsOut(
            files=files, readable=readable, pending=pending, text=text, empty=empty,
            failed=failed, partial=partial, ocr=ocr, needs_ocr=needs_ocr,
        ),
        reading=DocumentTextReadingOut(
            document_id=reading.id, name=reading.name, started_at=aware(reading.claimed_at),
        ) if reading is not None and reading.claimed_at is not None else None,
    )


@router.get("/files", response_model=DocumentTextFilePage)
async def reading_files(
    db: DB, status: Annotated[DocumentTextFilter, Query()] = "all", page: PageNumber = 1,
) -> DocumentTextFilePage:
    """The files whose text is read, by state: those waiting in the order they will be read, the
    others the latest read first."""
    where = [*active_texts(), *selected(status)]
    count = await db.scalar(joined(select(func.count())).where(*where)) or 0
    order = (
        (DocumentVersion.created_at.desc(), DocumentVersion.id) if status == "pending"
        else (DocumentText.updated_at.desc(), DocumentVersion.id)
    )
    rows = (await db.execute(
        joined(select(*file_columns())).where(*where).order_by(*order)
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )).all()
    return DocumentTextFilePage(
        items=[await file_out(db, row) for row in rows],
        total=count, page=page, pages=max(1, math.ceil(count / PAGE_SIZE)),
    )


async def text_file(db: AsyncSession, document_id: int) -> DocumentTextFileOut:
    row = (await db.execute(
        joined(select(*file_columns())).where(Document.id == document_id)
    )).one()
    return await file_out(db, row)


@router.post("/files/{document_id}/read", response_model=DocumentTextFileOut)
async def read_again(document_id: ItemId, request: Request, db: DB) -> DocumentTextFileOut:
    """Read a file again, after a failure or to check it; one waiting already keeps its place."""
    await mutation_session(request, db)
    version = await current_version(db, await active_document(db, document_id))
    if version.extension not in READABLE:
        raise AppError("document_text_unsupported", 409)
    now = utcnow()
    status = await db.scalar(
        select(DocumentText.status).where(DocumentText.version_id == version.id)
    )
    if status is None:
        await db.execute(insert(DocumentText).values(
            version_id=version.id, status="pending", content="", content_key="", characters=0,
            ocr_pages=0, needs_ocr=False, partial=False, created_at=now, updated_at=now,
        ))
    elif status != "pending":
        await db.execute(
            update(DocumentText).where(DocumentText.version_id == version.id)
            .values(status="pending", updated_at=now)
            .execution_options(synchronize_session=False)
        )
    await db.commit()
    document_index.wake(request.app)
    return await text_file(db, document_id)


@router.post("/retry", response_model=DocumentTextQueueOut)
async def retry_failed(request: Request, db: DB) -> DocumentTextQueueOut:
    """Read again every file that could not be read."""
    await mutation_session(request, db)
    active = select(DocumentVersion.id).join(Document, document_index.current()).where(
        Document.deleted_at.is_(None),
    )
    result = await db.execute(
        update(DocumentText).where(
            DocumentText.status == "failed", DocumentText.version_id.in_(active),
        ).values(status="pending", updated_at=utcnow())
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    document_index.wake(request.app)
    return DocumentTextQueueOut(queued=document_index.changed(result))
