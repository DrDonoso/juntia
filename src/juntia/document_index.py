"""The text of shared documents for the search, read in the background.

Every readable current version has a row in `document_texts` (DocumentText): an upload queues its
own in the transaction that stores the file, and each start of the application queues what is
missing, such as the documents stored before the search read their text. A reader in each process
takes the newest waiting file, reads it in a child process (document_text.py) with a time limit,
and stores its text, and the same text without case and accents for the search. Processes share
the queue through claims that they renew while they read: an abandoned claim expires in minutes.
"""

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
from bisect import bisect_right
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from sqlalchemy import CursorResult, Result, and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool

from .config import Language, Settings
from .contracts import DocumentExcerpt, DocumentTextOut, DocumentTextStatus
from .db import Document, DocumentText, DocumentVersion, utcnow
from .document_files import stored_path
from .document_text import ERRORS, MAX_CHARACTERS, OCR_MODELS, READABLE
from .query_sql import contains_text, fold_text

log = logging.getLogger(__name__)
LEASE = timedelta(minutes=3)
RENEW_SECONDS = 60
HARD_TIMEOUT = 15 * 60
POLL_SECONDS = 60
RETRY_SECONDS = 30
BATCH = 500
EXCERPT_BEFORE = 80
EXCERPT_AFTER = 160
FOLD_CHUNK = 2048
# What the child process receives of the environment: never the server's secrets.
CHILD_ENVIRONMENT = (
    "PATH", "SYSTEMROOT", "TESSDATA_PREFIX", "TZ", "LANG", "LC_ALL", "PYTHONPATH",
)


def changed(result: Result[Any]) -> int:
    return cast(CursorResult[Any], result).rowcount


def current() -> ColumnElement[bool]:
    return and_(
        DocumentVersion.document_id == Document.id,
        DocumentVersion.number == Document.current_number,
    )


def status_of(status: str, characters: int) -> DocumentTextStatus:
    if status == "pending":
        return "pending"
    if status == "failed":
        return "failed"
    return "ready" if characters else "empty"


@dataclass(frozen=True)
class Engine:
    """Tesseract, which reads scanned pages and pictures, and its model for APP_LANGUAGE."""

    language: Language
    model: str
    version: str | None = None
    available: bool = False


@cache
def probe_engine(language: Language) -> Engine:
    model = OCR_MODELS[language]
    executable = shutil.which("tesseract")
    if executable is None:
        return Engine(language, model)
    try:
        version = subprocess.run(
            [executable, "--version"], capture_output=True, text=True, timeout=20, check=False,
        )
        models = subprocess.run(
            [executable, "--list-langs"], capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return Engine(language, model)
    first = (version.stdout or version.stderr).strip().splitlines()[:1]
    number = first[0].split()[-1] if first and first[0].lower().startswith("tesseract") else None
    listed = {line.strip() for line in (models.stdout + models.stderr).splitlines()}
    return Engine(language, model, number, model in listed)


async def queue_version(db: AsyncSession, version: DocumentVersion, now: datetime) -> None:
    """Queue a new current version, and forget the text of the document's earlier versions."""
    await db.execute(
        delete(DocumentText).where(DocumentText.version_id.in_(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == version.document_id,
                DocumentVersion.id != version.id,
            )
        )).execution_options(synchronize_session=False)
    )
    if version.extension in READABLE:
        db.add(DocumentText(
            version_id=version.id, status="pending", created_at=now, updated_at=now,
        ))


async def forget(db: AsyncSession, version_ids: Iterable[str]) -> None:
    """The text of purged versions goes with their files."""
    ids = list(version_ids)
    for start in range(0, len(ids), BATCH):
        await db.execute(
            delete(DocumentText).where(DocumentText.version_id.in_(ids[start:start + BATCH]))
            .execution_options(synchronize_session=False)
        )


def wake(app: Any) -> None:
    """Tell the reader of this process that something waits to be read."""
    reader = getattr(app.state, "document_reader", None)
    if reader is not None:
        reader.wake()


async def text_matches(db: AsyncSession, needle: str) -> set[int]:
    """Active documents whose current text contains the folded needle."""
    if not needle:
        return set()
    return set(await db.scalars(
        select(Document.id).join(DocumentVersion, current())
        .join(DocumentText, DocumentText.version_id == DocumentVersion.id)
        .where(
            Document.deleted_at.is_(None), DocumentText.characters > 0,
            contains_text(db, DocumentText.content_key.expression, needle),
        )
    ))


async def unread(db: AsyncSession) -> int:
    """Active documents never read yet, whose text the search cannot find yet."""
    return await db.scalar(
        select(func.count()).select_from(DocumentText)
        .join(DocumentVersion, DocumentVersion.id == DocumentText.version_id)
        .join(Document, current())
        .where(
            Document.deleted_at.is_(None), DocumentText.status == "pending",
            DocumentText.read_at.is_(None),
        )
    ) or 0


def excerpt(content: str, needle: str) -> DocumentExcerpt | None:
    """The first place where the text contains the folded needle, with the words around it.

    Folding works character by character, so the text is folded in chunks, and only the chunks
    where the match starts and ends are walked to find its characters in the original text.
    """
    if not needle or not content:
        return None
    starts: list[int] = []
    parts: list[str] = []
    total = 0
    for offset in range(0, len(content), FOLD_CHUNK):
        starts.append(total)
        part = fold_text(content[offset:offset + FOLD_CHUNK])
        parts.append(part)
        total += len(part)
    position = "".join(parts).find(needle)
    if position < 0:
        return None

    def character(folded: int) -> int:
        chunk = bisect_right(starts, folded) - 1
        consumed = starts[chunk]
        base = chunk * FOLD_CHUNK
        for index, char in enumerate(content[base:base + FOLD_CHUNK]):
            consumed += len(fold_text(char))
            if consumed > folded:
                return base + index
        return min(len(content), base + FOLD_CHUNK) - 1

    start = character(position)
    end = character(position + len(needle) - 1) + 1
    left = max(0, start - EXCERPT_BEFORE)
    if left > 0:
        space = content.find(" ", left, start)
        left = space + 1 if space >= 0 else left
    right = min(len(content), end + EXCERPT_AFTER)
    if right < len(content):
        space = content.rfind(" ", end, right)
        right = space if space > end else right
    return DocumentExcerpt(
        before=("…" if left > 0 else "") + content[left:start], match=content[start:end],
        after=content[end:right] + ("…" if right < len(content) else ""),
    )


async def excerpts(
    db: AsyncSession, document_ids: list[int], needle: str,
) -> dict[int, DocumentExcerpt]:
    if not document_ids:
        return {}
    rows = (await db.execute(
        select(Document.id, DocumentText.content).join(DocumentVersion, current())
        .join(DocumentText, DocumentText.version_id == DocumentVersion.id)
        .where(Document.id.in_(document_ids))
    )).all()

    def found() -> dict[int, DocumentExcerpt]:
        return {
            document_id: value for document_id, content in rows
            if (value := excerpt(content, needle)) is not None
        }

    return await run_in_threadpool(found)


async def text_info(db: AsyncSession, version: DocumentVersion) -> DocumentTextOut | None:
    """What the search knows of a version's text: nothing once it is purged."""
    if version.extension not in READABLE:
        return DocumentTextOut(status="unsupported", ocr_pages=0, partial=False)
    row = (await db.execute(
        select(
            DocumentText.status, DocumentText.characters, DocumentText.ocr_pages,
            DocumentText.partial,
        ).where(DocumentText.version_id == version.id)
    )).one_or_none()
    if row is None:
        return None
    return DocumentTextOut(
        status=status_of(row.status, row.characters), ocr_pages=row.ocr_pages,
        partial=row.partial,
    )


async def reconcile(db: AsyncSession, engine: Engine) -> int:
    """At startup: queue the current versions without text (all of them, the first time), forget
    the text of replaced or purged versions, and read again what OCR can now read better."""
    now = utcnow()
    kept = select(DocumentVersion.id).join(Document, current()).where(
        DocumentVersion.purged_at.is_(None),
    )
    await db.execute(
        delete(DocumentText).where(DocumentText.version_id.not_in(kept))
        .execution_options(synchronize_session=False)
    )
    missing = list(await db.scalars(
        select(DocumentVersion.id).join(Document, current())
        .outerjoin(DocumentText, DocumentText.version_id == DocumentVersion.id)
        .where(
            DocumentVersion.purged_at.is_(None),
            DocumentVersion.extension.in_(sorted(READABLE)), DocumentText.version_id.is_(None),
        )
    ))
    db.add_all(
        DocumentText(version_id=version_id, status="pending", created_at=now, updated_at=now)
        for version_id in missing
    )
    if engine.available:
        await db.execute(
            update(DocumentText).where(DocumentText.status == "ready", or_(
                DocumentText.needs_ocr.is_(True),
                and_(DocumentText.ocr_pages > 0, DocumentText.ocr_language != engine.model),
            )).values(status="pending", updated_at=now)
            .execution_options(synchronize_session=False)
        )
    await db.commit()
    return len(missing)


@dataclass(frozen=True)
class Claim:
    version_id: str
    claim_id: str
    path: Path
    extension: str


def child_environment() -> dict[str, str]:
    environment = {
        name: value for name in CHILD_ENVIRONMENT if (value := os.environ.get(name)) is not None
    }
    return {
        **environment, "OMP_THREAD_LIMIT": "1", "MALLOC_ARENA_MAX": "2",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def stop_process(process: asyncio.subprocess.Process) -> None:
    """Stop the child, and Tesseract with it on POSIX systems, where it leads its own group."""
    if process.returncode is not None:
        return
    with suppress(ProcessLookupError, PermissionError):
        if sys.platform != "win32":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()


class DocumentReader:
    """Reads the queue of one process: one file at a time, newest first."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], config: Settings):
        self.sessions = sessions
        self.upload_dir = config.upload_dir
        model = OCR_MODELS[config.app_language]
        self.engine = Engine(config.app_language, model)
        self.event = asyncio.Event()
        self.task: asyncio.Task[None] | None = None

    async def prepare(self) -> None:
        self.engine = await run_in_threadpool(probe_engine, self.engine.language)
        if not self.engine.available:
            log.warning(
                "OCR is not available: shared documents are read without their scanned pages "
                "and pictures until Tesseract and its %s model are installed", self.engine.model,
            )
        async with self.sessions() as db:
            try:
                queued = await reconcile(db, self.engine)
            except IntegrityError:
                # Another process queued them at the same time.
                await db.rollback()
            else:
                if queued:
                    log.info("Queued %s shared documents to read for the search", queued)

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self.task is None:
            return
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task
        self.task = None

    def wake(self) -> None:
        self.event.set()

    async def run(self) -> None:
        while True:
            self.event.clear()
            try:
                if await self.read_next():
                    continue
            except Exception as error:
                log.error("Reading shared documents failed (%s)", type(error).__name__)
                await asyncio.sleep(RETRY_SECONDS)
                continue
            with suppress(TimeoutError):
                await asyncio.wait_for(self.event.wait(), POLL_SECONDS)

    async def drain(self) -> int:
        """Read everything waiting now (tests)."""
        count = 0
        while await self.read_next():
            count += 1
        return count

    async def read_next(self) -> bool:
        claim = await self.claim()
        if claim is None:
            return False
        try:
            try:
                payload = await self.extract(claim)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.error("Reading a shared document failed (%s)", type(error).__name__)
                payload = {"error": "failed"}
            if payload is not None:
                await self.store(claim, payload)
        except asyncio.CancelledError:
            # Stopping: hand the file back at once instead of letting the claim expire.
            with suppress(Exception):
                await asyncio.wait_for(self.release(claim), 5)
            raise
        return True

    async def claim(self) -> Claim | None:
        async with self.sessions() as db:
            now = utcnow()
            free = or_(DocumentText.claimed_until.is_(None), DocumentText.claimed_until < now)
            candidates = (await db.execute(
                select(DocumentText.version_id, DocumentVersion.storage_key, DocumentVersion.extension)
                .join(DocumentVersion, DocumentVersion.id == DocumentText.version_id)
                .join(Document, current())
                .where(
                    DocumentText.status == "pending", free, Document.deleted_at.is_(None),
                    DocumentVersion.purged_at.is_(None),
                )
                .order_by(DocumentVersion.created_at.desc(), DocumentVersion.id).limit(5)
            )).all()
            for version_id, storage_key, extension in candidates:
                claim_id = str(uuid4())
                result = await db.execute(
                    update(DocumentText).where(
                        DocumentText.version_id == version_id, DocumentText.status == "pending",
                        free,
                    ).values(claim_id=claim_id, claimed_at=now, claimed_until=now + LEASE)
                    .execution_options(synchronize_session=False)
                )
                await db.commit()
                if changed(result) == 1:
                    return Claim(
                        version_id, claim_id, stored_path(self.upload_dir, storage_key, extension),
                        extension,
                    )
        return None

    async def renew(self, claim: Claim) -> bool:
        """False when the claim was lost: a newer version or a purge replaced the file."""
        try:
            async with self.sessions() as db:
                result = await db.execute(
                    update(DocumentText).where(
                        DocumentText.version_id == claim.version_id,
                        DocumentText.claim_id == claim.claim_id,
                    ).values(claimed_until=utcnow() + LEASE)
                    .execution_options(synchronize_session=False)
                )
                await db.commit()
                return changed(result) == 1
        except SQLAlchemyError as error:
            log.warning("A reading claim could not be renewed (%s)", type(error).__name__)
            return True

    async def release(self, claim: Claim) -> None:
        async with self.sessions() as db:
            await db.execute(
                update(DocumentText).where(
                    DocumentText.version_id == claim.version_id,
                    DocumentText.claim_id == claim.claim_id,
                ).values(claim_id=None, claimed_at=None, claimed_until=None)
                .execution_options(synchronize_session=False)
            )
            await db.commit()

    async def extract(self, claim: Claim) -> dict[str, Any] | None:
        """What the child read, or None when the claim was lost."""
        if not await run_in_threadpool(claim.path.is_file):
            return {"error": "missing"}
        model = self.engine.model if self.engine.available else "-"
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-X", "utf8", "-m", "juntia.document_text", str(claim.path),
            claim.extension, model, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=child_environment(), start_new_session=sys.platform != "win32",
        )
        output = asyncio.ensure_future(process.communicate())
        loop = asyncio.get_running_loop()
        deadline = loop.time() + HARD_TIMEOUT
        try:
            while True:
                remaining = deadline - loop.time()
                done, _ = await asyncio.wait({output}, timeout=max(0.0, min(RENEW_SECONDS, remaining)))
                if done:
                    break
                if loop.time() >= deadline:
                    log.warning("Reading a shared document took too long and was stopped")
                    return {"error": "timeout"}
                if not await self.renew(claim):
                    return None
        finally:
            if not output.done():
                stop_process(process)
                with suppress(Exception):
                    await asyncio.wait({output}, timeout=10)
        stdout, _ = output.result()
        if process.returncode != 0:
            log.error("Reading a shared document failed with exit code %s", process.returncode)
            return {"error": "failed"}
        try:
            payload = json.loads(stdout)
        except ValueError:
            return {"error": "failed"}
        return payload if isinstance(payload, dict) else {"error": "failed"}

    async def store(self, claim: Claim, payload: dict[str, Any]) -> None:
        now = utcnow()
        values: dict[str, Any] = {
            "claim_id": None, "claimed_at": None, "claimed_until": None, "read_at": now,
            "updated_at": now,
        }
        content = payload.get("content")
        ocr_pages = payload.get("ocr_pages")
        if "error" in payload or not isinstance(content, str) or not isinstance(ocr_pages, int):
            error = payload.get("error")
            # A failed reading keeps the text read earlier, which stays searchable.
            values |= {"status": "failed", "error": error if error in ERRORS else "failed"}
        else:
            content = content[:MAX_CHARACTERS].replace("\0", " ")
            pages = max(0, ocr_pages)
            values |= {
                "status": "ready", "error": None, "content": content,
                "content_key": await run_in_threadpool(fold_text, content),
                "characters": len(content), "ocr_pages": pages,
                "ocr_language": self.engine.model if pages else None,
                "needs_ocr": payload.get("needs_ocr") is True,
                "partial": payload.get("partial") is True,
            }
        async with self.sessions() as db:
            await db.execute(
                update(DocumentText).where(
                    DocumentText.version_id == claim.version_id,
                    DocumentText.claim_id == claim.claim_id,
                ).values(values).execution_options(synchronize_session=False)
            )
            await db.commit()
