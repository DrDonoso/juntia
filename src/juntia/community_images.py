"""Images pasted into the Markdown of community actions, comments and events.

The browser prepares each image before uploading it (orientation applied, metadata removed, at
most 2560 pixels a side, except GIFs). The server does not decode pictures: it recognizes the
format from the bytes, reads the dimensions from the header and checks the limits, then stores
the bytes it received under a server-generated name. Each image belongs to the section whose API
serves it (actions or events), so that section's session and feature switch apply to it.
"""

import hashlib
import logging
import re
import struct
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, BinaryIO, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Form, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse

from .auth import DB, mutation_session, reader_session, settings
from .community_actions import author, authorship, require_actions_enabled, session_actor
from .community_events import require_events_enabled
from .config import Language
from .contracts import ActionActorOut, CommunityImageOut, StoredImageOut
from .db import CommunityImage, aware
from .errors import AppError
from .storage import (
    check_attachment_quota,
    ensure_free_space,
    lock_attachment_storage,
    out_of_space,
)
from .texts import ServerLanguage

log = logging.getLogger(__name__)
ImageScope = Literal["actions", "events"]
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_SIDE = 16384
MAX_IMAGE_PIXELS = 40_000_000
# The size must be found in this prefix of the file, within this many segments or blocks, so a
# crafted file cannot keep the server scanning: the editors' images have it in their first bytes.
HEADER_BYTES = 1024 * 1024
MAX_HEADER_STEPS = 10_000
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG frame headers (SOFn) carry the size; C4, C8 and CC are other segments.
JPEG_FRAMES = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
JPEG_FILL = re.compile(rb"\xff*")


@dataclass(frozen=True)
class ImageFormat:
    media_type: str
    width: int
    height: int


def invalid() -> AppError:
    return AppError("image_invalid", 415)


def jpeg_size(head: bytes) -> tuple[int, int]:
    """Walk the segments after SOI until a frame header; entropy-coded data never comes first."""
    position = 2
    for _ in range(MAX_HEADER_STEPS):
        if head[position:position + 1] != b"\xff":
            raise invalid()
        # The marker follows its 0xFF and any number of 0xFF fill bytes.
        fill = JPEG_FILL.match(head, position)
        position = fill.end() if fill else position
        if position + 3 > len(head):
            raise invalid()
        marker = head[position]
        position += 1
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            continue
        if marker in (0x00, 0xD9, 0xDA):
            raise invalid()
        (length,) = struct.unpack_from(">H", head, position)
        if length < 2:
            raise invalid()
        if marker in JPEG_FRAMES:
            if position + 7 > len(head):
                raise invalid()
            _, height, width = struct.unpack_from(">BHH", head, position + 2)
            return width, height
        position += length
    raise invalid()


def gif_size(head: bytes) -> tuple[int, int]:
    """The canvas size: browsers enlarge the logical screen so that the first frame fits."""
    if len(head) < 13:
        raise invalid()
    width, height, flags = struct.unpack_from("<HHB", head, 6)
    # A global colour table of 2^(n + 1) RGB entries follows the logical screen descriptor.
    position = 13 + (3 << ((flags & 0x07) + 1) if flags & 0x80 else 0)
    in_extension = False
    for _ in range(MAX_HEADER_STEPS):
        if position >= len(head):
            break
        block = head[position]
        if in_extension:
            # Data sub-blocks: a size byte and that many bytes; size 0 ends the extension.
            position += 1 + block
            in_extension = block != 0
        elif block == 0x21:
            position += 2
            in_extension = True
        elif block == 0x2C and position + 9 <= len(head):
            left, top, frame_width, frame_height = struct.unpack_from("<HHHH", head, position + 1)
            return max(width, left + frame_width), max(height, top + frame_height)
        else:
            break
    raise invalid()


def webp_size(chunk: bytes, data: bytes) -> tuple[int, int]:
    if chunk == b"VP8 ":
        # Lossy: a 3-byte frame tag, the start code, then 14-bit width and height.
        if data[3:6] != b"\x9d\x01\x2a":
            raise invalid()
        width, height = struct.unpack("<HH", data[6:10])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L":
        # Lossless: a signature byte, then width - 1 and height - 1 in 14 bits each.
        if data[0] != 0x2F:
            raise invalid()
        bits = int.from_bytes(data[1:5], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        # Extended: flags and reserved bytes, then the canvas width - 1 and height - 1 in 24 bits.
        return int.from_bytes(data[4:7], "little") + 1, int.from_bytes(data[7:10], "little") + 1
    raise invalid()


def image_format(stream: BinaryIO) -> ImageFormat:
    """The format, from the bytes rather than the name or declared type, and the header size."""
    stream.seek(0)
    head = stream.read(HEADER_BYTES)
    if head.startswith(PNG_SIGNATURE):
        if len(head) < 24 or head[12:16] != b"IHDR":
            raise invalid()
        media_type = "image/png"
        width, height = struct.unpack(">II", head[16:24])
    elif head[:6] in (b"GIF87a", b"GIF89a"):
        media_type = "image/gif"
        width, height = gif_size(head)
    elif head.startswith(b"\xff\xd8\xff"):
        media_type = "image/jpeg"
        width, height = jpeg_size(head)
    elif len(head) >= 30 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        media_type = "image/webp"
        width, height = webp_size(head[12:16], head[20:30])
    else:
        raise invalid()
    if width < 1 or height < 1:
        raise invalid()
    if width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        raise AppError("image_dimensions_too_large", 422)
    return ImageFormat(media_type, width, height)


def image_filename(filename: str | None, media_type: str) -> str:
    """The uploaded name without folders or control characters, with its format's extension."""
    name = re.split(r"[/\\]", filename or "")[-1]
    name = "".join(char for char in name if unicodedata.category(char) not in {"Cc", "Cf"})
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", name.strip()).strip(" .") or "image"
    return f"{stem[:250]}.{EXTENSIONS[media_type]}"


def image_path(directory: Path, storage_key: str, media_type: str) -> Path:
    return directory / "images" / f"{UUID(storage_key)}.{EXTENSIONS[media_type]}"


def image_url(scope: str, image_id: str) -> str:
    return f"/api/{scope}/images/{image_id}"


@dataclass(frozen=True)
class StagedImage:
    temporary: Path
    destination: Path
    storage_key: str
    filename: str
    media_type: str
    size: int
    sha256: str
    width: int
    height: int


def remove_image_file(path: Path) -> None:
    """Delete a staged or purged image; an already missing file counts as deleted."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.error("A community image file could not be deleted")
        raise AppError("image_storage_error", 503) from None


def stage_image(stream: BinaryIO, filename: str | None, directory: Path) -> StagedImage:
    # Checked before anything is written: an unrecognized file never reaches the uploads volume.
    found = image_format(stream)
    key = str(uuid4())
    destination = image_path(directory, key, found.media_type)
    temporary = destination.with_suffix(".tmp")
    complete = False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        stream.seek(0)
        size = 0
        checksum = hashlib.sha256()
        with temporary.open("xb") as output:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise AppError("image_too_large", 413)
                checksum.update(chunk)
                output.write(chunk)
        complete = True
        return StagedImage(
            temporary, destination, key, image_filename(filename, found.media_type),
            found.media_type, size, checksum.hexdigest(), found.width, found.height,
        )
    except OSError as error:
        log.error("A community image could not be staged")
        if out_of_space(error):
            raise AppError("storage_low_space", 507) from None
        raise AppError("image_storage_error", 503) from None
    finally:
        if not complete:
            remove_image_file(temporary)


def publish_image(staged: StagedImage) -> None:
    try:
        staged.temporary.replace(staged.destination)
    except OSError:
        log.error("A community image could not be published")
        raise AppError("image_storage_error", 503) from None


def image_out(value: CommunityImage) -> CommunityImageOut:
    return CommunityImageOut.model_validate({
        "id": value.id, "url": image_url(value.scope, value.id), "filename": value.filename,
        "media_type": value.media_type, "size": value.size, "width": value.width,
        "height": value.height, "created_at": aware(value.created_at),
    })


def stored_image_out(value: CommunityImage, language: Language) -> StoredImageOut:
    return StoredImageOut.model_validate({
        **image_out(value).model_dump(), "scope": value.scope, "sha256": value.sha256,
        "author": author(value, language),
        "purged_at": aware(value.purged_at) if value.purged_at else None,
    })


async def require_scope(scope: ImageScope, db: AsyncSession) -> None:
    if scope == "actions":
        await require_actions_enabled(db)
    else:
        await require_events_enabled(db)


async def upload_actor(
    scope: ImageScope, request: Request, db: AsyncSession, language: Language,
) -> ActionActorOut:
    await require_scope(scope, db)
    return session_actor(await mutation_session(request, db), language)


async def cleanup_upload(request: Request, staged: StagedImage) -> None:
    await run_in_threadpool(remove_image_file, staged.temporary)
    # A failed COMMIT response is ambiguous: never delete a possibly committed original.
    try:
        async with request.app.state.sessions() as check:
            retained = await check.scalar(select(CommunityImage.id).where(
                CommunityImage.storage_key == staged.storage_key,
            ))
    except SQLAlchemyError:
        log.error("An interrupted image upload needs storage reconciliation")
        return
    if retained is None:
        await run_in_threadpool(remove_image_file, staged.destination)


async def upload_image(
    scope: ImageScope, db: AsyncSession, request: Request, language: Language,
    file: UploadFile, upload_id: UUID,
) -> CommunityImageOut:
    config = settings(request)
    if file.size is not None and file.size > MAX_IMAGE_BYTES:
        raise AppError("image_too_large", 413)
    try:
        await run_in_threadpool(
            ensure_free_space, config.upload_dir,
            MAX_IMAGE_BYTES if file.size is None else file.size, config.min_free_disk_mb,
        )
    except AppError:
        # A retry of the requester's own stored upload goes on: it is answered from the
        # database below. Anyone else is refused before anything is written.
        stored = await db.get(CommunityImage, str(upload_id))
        requester = await upload_actor(scope, request, db, language)
        if (
            stored is None or stored.scope != scope or stored.purged_at is not None
            or stored.author_kind != requester.kind
            or stored.author_user_id != requester.user_id
        ):
            raise
    await db.rollback()
    staged = await run_in_threadpool(stage_image, file.file, file.filename, config.upload_dir)
    committed = False
    try:
        actor = await upload_actor(scope, request, db, language)
        # The PDF lock: images and PDFs share the byte budgets, so one check sees both.
        await lock_attachment_storage(db)
        existing = await db.get(CommunityImage, str(upload_id), populate_existing=True)
        if existing is not None:
            if (
                existing.scope != scope or existing.author_kind != actor.kind
                or existing.author_user_id != actor.user_id
                or existing.filename != staged.filename or existing.sha256 != staged.sha256
                or existing.purged_at is not None
            ):
                raise AppError("image_upload_conflict", 409)
            result = image_out(existing)
            await db.rollback()
            return result
        await check_attachment_quota(db, config, actor, staged.size)
        image = CommunityImage(
            id=str(upload_id), scope=scope, storage_key=staged.storage_key,
            filename=staged.filename, media_type=staged.media_type, size=staged.size,
            sha256=staged.sha256, width=staged.width, height=staged.height, **authorship(actor),
        )
        db.add(image)
        await db.flush()
        await run_in_threadpool(publish_image, staged)
        await db.commit()
        committed = True
        return image_out(image)
    finally:
        if not committed:
            await db.rollback()
            await cleanup_upload(request, staged)


def file_response(value: CommunityImage, request: Request) -> FileResponse:
    if value.purged_at is not None:
        raise AppError("image_purged", 410)
    path = image_path(settings(request).upload_dir, value.storage_key, value.media_type)
    if not path.is_file():
        log.error("A stored community image is missing")
        raise AppError("image_source_missing", 503)
    return FileResponse(
        path, media_type=value.media_type, filename=value.filename,
        content_disposition_type="inline",
    )


async def image_response(
    scope: ImageScope, image_id: UUID, db: AsyncSession, request: Request,
) -> FileResponse:
    value = await db.get(CommunityImage, str(image_id))
    if value is None or value.scope != scope:
        raise AppError("image_not_found", 404)
    return file_response(value, request)


UploadId = Annotated[UUID, Form()]
actions_router = APIRouter(
    prefix="/api/actions/images", tags=["Community actions"],
    dependencies=[Depends(reader_session), Depends(require_actions_enabled)],
)
events_router = APIRouter(
    prefix="/api/events/images", tags=["Community events"],
    dependencies=[Depends(reader_session), Depends(require_events_enabled)],
)


@actions_router.post("", response_model=CommunityImageOut, status_code=201)
async def upload_action_image(
    db: DB, request: Request, language: ServerLanguage, file: UploadFile, upload_id: UploadId,
) -> CommunityImageOut:
    return await upload_image("actions", db, request, language, file, upload_id)


@actions_router.get("/{image_id}", response_class=FileResponse)
async def action_image(image_id: UUID, db: DB, request: Request) -> FileResponse:
    return await image_response("actions", image_id, db, request)


@events_router.post("", response_model=CommunityImageOut, status_code=201)
async def upload_event_image(
    db: DB, request: Request, language: ServerLanguage, file: UploadFile, upload_id: UploadId,
) -> CommunityImageOut:
    return await upload_image("events", db, request, language, file, upload_id)


@events_router.get("/{image_id}", response_class=FileResponse)
async def event_image(image_id: UUID, db: DB, request: Request) -> FileResponse:
    return await image_response("events", image_id, db, request)
