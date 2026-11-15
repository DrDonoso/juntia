"""Shared documents on disk: names, accepted types, the checks of uploaded files and ZIP archives.

Residents share files with every neighbor, so only common formats are accepted, recognized from
their bytes as well as from their extension: PDF; JPEG, PNG, GIF, WebP and HEIC/HEIF pictures;
Word, Excel and PowerPoint (OOXML) and OpenDocument files without macros, ActiveX controls or
embedded binaries; plain text and CSV; and the MP4 and QuickTime videos phones record. Programs,
scripts, web pages, SVG, archives and older Office formats are refused. These checks are not
antivirus scanning.
"""

import hashlib
import io
import logging
import re
import struct
import unicodedata
import zipfile
from collections.abc import Buffer, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, Literal
from uuid import UUID

from .contracts import tag_name_key
from .errors import AppError
from .storage import out_of_space

log = logging.getLogger(__name__)
DocumentKind = Literal["pdf", "image", "video", "document", "spreadsheet", "presentation", "text"]
MAX_NAME = 200
MAX_NAME_KEY = 600
READ_BYTES = 1024 * 1024
# Bounds that keep a crafted file from making the checks scan or allocate without limit.
MAX_ZIP_ENTRIES = 10_000
MAX_ZIP_MEMBER_BYTES = 1024 * 1024
MAX_BOXES = 10_000
FORBIDDEN = re.compile(r'[/\\:*?"<>|]')
# Device names Windows refuses as file names, also with an extension.
RESERVED = re.compile(r"(?i)(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?")
OOXML = "application/vnd.openxmlformats-officedocument."
ODF = "application/vnd.oasis.opendocument."
HEIF_BRANDS = frozenset({
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1",
})
# The first box of an MP4 or QuickTime file; old QuickTime files have no ftyp box.
VIDEO_FIRST_BOXES = frozenset({b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"})
# The content type that [Content_Types].xml declares for the main part of each format.
OOXML_MAIN = {
    "docx": b"wordprocessingml.document.main+xml",
    "xlsx": b"spreadsheetml.sheet.main+xml",
    "pptx": b"presentationml.presentation.main+xml",
}


@dataclass(frozen=True)
class FileType:
    kind: DocumentKind
    media_type: str
    # Shown by the eye icon with this type: PDFs, pictures and videos in a new tab, where phones'
    # QuickTime videos only play when browsers are told they are MP4, the format they derive from;
    # text and CSV files in the portal's viewer, which reads their encoding itself.
    preview_type: str | None = None


TYPES: dict[str, FileType] = {
    "pdf": FileType("pdf", "application/pdf", "application/pdf"),
    "jpg": FileType("image", "image/jpeg", "image/jpeg"),
    "jpeg": FileType("image", "image/jpeg", "image/jpeg"),
    "png": FileType("image", "image/png", "image/png"),
    "gif": FileType("image", "image/gif", "image/gif"),
    "webp": FileType("image", "image/webp", "image/webp"),
    "heic": FileType("image", "image/heic", "image/heic"),
    "heif": FileType("image", "image/heif", "image/heif"),
    "docx": FileType("document", OOXML + "wordprocessingml.document"),
    "xlsx": FileType("spreadsheet", OOXML + "spreadsheetml.sheet"),
    "pptx": FileType("presentation", OOXML + "presentationml.presentation"),
    "odt": FileType("document", ODF + "text"),
    "ods": FileType("spreadsheet", ODF + "spreadsheet"),
    "odp": FileType("presentation", ODF + "presentation"),
    "txt": FileType("text", "text/plain", "text/plain"),
    "csv": FileType("text", "text/csv", "text/plain"),
    "mp4": FileType("video", "video/mp4", "video/mp4"),
    "m4v": FileType("video", "video/x-m4v", "video/mp4"),
    "mov": FileType("video", "video/quicktime", "video/mp4"),
}
VIDEO_EXTENSIONS = tuple(key for key, value in TYPES.items() if value.kind == "video")


def mismatch() -> AppError:
    return AppError("document_type_mismatch", 415)


def macros() -> AppError:
    return AppError("document_macros_unsupported", 415)


def invalid_name() -> AppError:
    return AppError("document_name_invalid", 422, fields={"name": "document_name_invalid"})


def clean_name(value: str) -> str:
    """NFC, without control or invisible format characters (such as right-to-left overrides that
    disguise an extension), single spaces, and no trailing dots or spaces, which Windows drops."""
    characters = []
    for character in unicodedata.normalize("NFC", value):
        if character.isspace():
            characters.append(" ")
        elif unicodedata.category(character) not in {"Cc", "Cf", "Cs"}:
            characters.append(character)
    return " ".join("".join(characters).split()).rstrip(" .")


def name_key(value: str) -> str:
    return tag_name_key(value)


def checked_name(value: str) -> str:
    """A folder or file name typed by someone: it must work on every system it is downloaded to."""
    name = clean_name(value)
    if (
        not name or len(name) > MAX_NAME or FORBIDDEN.search(name) or RESERVED.fullmatch(name)
        or len(name_key(name)) > MAX_NAME_KEY
    ):
        raise invalid_name()
    return name


def extension_of(name: str) -> str:
    return name.rpartition(".")[2].lower() if "." in name else ""


def document_name(value: str, extension: str) -> str:
    """A new name for a file: its extension, and so its type, never changes."""
    name = clean_name(value)
    suffix = "." + extension
    if not name.lower().endswith(suffix):
        name += suffix
    if not name[: -len(suffix)].strip(" ."):
        raise invalid_name()
    return checked_name(name)


def upload_name(filename: str) -> tuple[str, str]:
    """The name of an uploaded file, made valid instead of refused, and its extension."""
    name = clean_name(re.split(r"[/\\]", filename)[-1])
    stem, dot, original = name.rpartition(".")
    extension = original.lower()
    if not dot or extension not in TYPES:
        raise AppError("document_type_unsupported", 415)
    stem = FORBIDDEN.sub("_", stem).strip(" .")
    if not stem:
        stem = "document"
    elif RESERVED.fullmatch(stem):
        stem = "_" + stem
    stem = stem[: MAX_NAME - len(original) - 1].rstrip(" .") or "document"
    name = f"{stem}.{original}"
    if len(name_key(name)) > MAX_NAME_KEY:
        name = f"document.{original}"
    return name, extension


def numbered(name: str, number: int, extension: str | None) -> str:
    """`Report (2).pdf` for the second item called `Report.pdf` in a folder."""
    tail = "." + extension if extension and name.lower().endswith("." + extension) else ""
    stem = name[: len(name) - len(tail)]
    suffix = f" ({number})"
    stem = stem[: MAX_NAME - len(suffix) - len(tail)].rstrip(" .")
    return stem + suffix + name[len(name) - len(tail):]


def version_filename(name: str, number: int, current: int, extension: str, label: str) -> str:
    """Earlier versions download as `Report (version 2).pdf`; `label` is ` (version {number})`
    in the server's language."""
    if number == current:
        return name
    tail = "." + extension if name.lower().endswith("." + extension) else ""
    stem, ending = name[: len(name) - len(tail)], name[len(name) - len(tail):]
    return stem + label.format(number=number) + ending


def stored_path(directory: Path, storage_key: str, extension: str) -> Path:
    if extension not in TYPES:
        raise ValueError("Unknown document extension")
    return directory / "documents" / f"{UUID(storage_key)}.{extension}"


def partial_path(directory: Path, storage_key: str) -> Path:
    return directory / "documents" / f"{UUID(storage_key)}.part"


def storage_error(error: OSError, message: str) -> AppError:
    log.error(message)
    if out_of_space(error):
        return AppError("storage_low_space", 507)
    return AppError("document_storage_error", 503)


def create_partial(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.open("xb").close()
    except OSError as error:
        raise storage_error(error, "A document upload could not be started") from None


def write_chunk(path: Path, offset: int, data: bytes) -> None:
    """Write a chunk at `offset`, discarding anything a failed earlier attempt left after it."""
    try:
        with path.open("r+b") as output:
            output.truncate(offset)
            output.seek(offset)
            output.write(data)
    except FileNotFoundError:
        log.error("A partial document upload is missing")
        raise AppError("document_upload_not_found", 404) from None
    except OSError as error:
        raise storage_error(error, "A document chunk could not be written") from None


def remove_file(path: Path) -> None:
    """Delete a stored or partial file; an already missing file counts as deleted."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.error("A document file could not be deleted")
        raise AppError("document_storage_error", 503) from None


def move_file(source: Path, destination: Path) -> None:
    try:
        source.replace(destination)
    except OSError:
        log.error("A document file could not be moved")
        raise AppError("document_storage_error", 503) from None


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(READ_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def check_pdf(stream: BinaryIO, head: bytes, size: int) -> None:
    if not re.match(rb"%PDF-[12]\.[0-9]", head):
        raise mismatch()
    stream.seek(max(0, size - 65536))
    if b"%%EOF" not in stream.read(65536):
        raise mismatch()


def check_image(extension: str, stream: BinaryIO, head: bytes, size: int) -> None:
    if extension in ("jpg", "jpeg"):
        valid = head.startswith(b"\xff\xd8\xff")
    elif extension == "png":
        valid = head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR"
    elif extension == "gif":
        valid = head[:6] in (b"GIF87a", b"GIF89a")
    elif extension == "webp":
        valid = head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    else:
        valid = bool(brands(stream, size) & HEIF_BRANDS)
    if not valid:
        raise mismatch()


def boxes(stream: BinaryIO, size: int) -> list[tuple[bytes, int, int]]:
    """The top-level boxes of an ISO base media file (MP4, QuickTime, HEIF): type, offset, size.
    They must cover the file exactly, so a truncated upload is refused."""
    found: list[tuple[bytes, int, int]] = []
    position = 0
    for _ in range(MAX_BOXES):
        if position == size:
            return found
        stream.seek(position)
        header = stream.read(16)
        if len(header) < 8:
            raise mismatch()
        length, kind = struct.unpack(">I4s", header[:8])
        minimum = 8
        if length == 1:
            if len(header) < 16:
                raise mismatch()
            (length,) = struct.unpack(">Q", header[8:16])
            minimum = 16
        elif length == 0:
            length = size - position
        if length < minimum or position + length > size or any(
            byte < 0x20 or byte > 0x7E for byte in kind
        ):
            raise mismatch()
        found.append((kind, position, length))
        position += length
    raise mismatch()


def brands(stream: BinaryIO, size: int) -> set[bytes]:
    """The major and compatible brands of the leading ftyp box."""
    stream.seek(0)
    header = stream.read(8)
    if len(header) < 8 or header[4:8] != b"ftyp":
        return set()
    (length,) = struct.unpack(">I", header[:4])
    if length < 16 or length > min(size, 4096):
        return set()
    body = stream.read(length - 8)
    found = {body[0:4]}
    found.update(body[offset:offset + 4] for offset in range(8, len(body) - 3, 4))
    return found


def check_video(stream: BinaryIO, size: int) -> None:
    found = boxes(stream, size)
    kinds = [kind for kind, _, _ in found]
    if not found or kinds[0] not in VIDEO_FIRST_BOXES or b"moov" not in kinds:
        raise mismatch()
    if kinds[0] == b"ftyp":
        stream.seek(8)
        if stream.read(4) in HEIF_BRANDS:
            raise mismatch()


def zip_archive(stream: BinaryIO, size: int) -> zipfile.ZipFile:
    """Open an OOXML or OpenDocument file after bounding its number of entries, which Python reads
    into memory all at once."""
    tail_size = min(size, 65536 + 22)
    stream.seek(size - tail_size)
    tail = stream.read(tail_size)
    end = tail.rfind(b"PK\x05\x06")
    if end < 0 or end + 22 > len(tail):
        raise mismatch()
    (entries,) = struct.unpack("<H", tail[end + 10:end + 12])
    if entries == 0 or entries > MAX_ZIP_ENTRIES:
        raise mismatch()
    try:
        archive = zipfile.ZipFile(stream)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, EOFError):
        raise mismatch() from None
    if len(archive.infolist()) > MAX_ZIP_ENTRIES:
        raise mismatch()
    return archive


def member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    try:
        with archive.open(info) as source:
            data = source.read(MAX_ZIP_MEMBER_BYTES + 1)
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, ValueError, EOFError):
        raise mismatch() from None
    if len(data) > MAX_ZIP_MEMBER_BYTES:
        raise mismatch()
    return data


def check_ooxml(extension: str, stream: BinaryIO, size: int) -> None:
    with zip_archive(stream, size) as archive:
        infos = {info.filename.lower(): info for info in archive.infolist()}
        types = infos.get("[content_types].xml")
        if types is None:
            raise mismatch()
        declared = member(archive, types).lower()
        if b"macroenabled" in declared or b"vbaproject" in declared:
            raise macros()
        if OOXML_MAIN[extension] not in declared:
            raise mismatch()
        for name in infos:
            path = "/" + name
            if (
                name.endswith(("vbaproject.bin", "vbadata.xml")) or "/activex/" in path
                or "/macrosheets/" in path or ("/embeddings/" in path and name.endswith(".bin"))
            ):
                raise macros()


def check_odf(extension: str, stream: BinaryIO, size: int) -> None:
    with zip_archive(stream, size) as archive:
        infos = archive.infolist()
        if not infos or infos[0].filename != "mimetype" or member(archive, infos[0]).strip() != (
            TYPES[extension].media_type.encode()
        ):
            raise mismatch()
        for info in infos:
            folders = info.filename.lower().split("/")[:-1]
            if "basic" in folders or "scripts" in folders:
                raise macros()


def check_text(stream: BinaryIO, head: bytes) -> None:
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return
    stream.seek(0)
    while chunk := stream.read(READ_BYTES):
        if b"\0" in chunk:
            raise mismatch()


def check_content(path: Path, extension: str) -> None:
    """Refuse a file whose bytes are not of the type its extension promises."""
    file_type = TYPES[extension]
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, io.SEEK_END)
            stream.seek(0)
            head = stream.read(65536)
            if file_type.kind == "pdf":
                check_pdf(stream, head, size)
            elif file_type.kind == "image":
                check_image(extension, stream, head, size)
            elif file_type.kind == "video":
                check_video(stream, size)
            elif extension in OOXML_MAIN:
                check_ooxml(extension, stream, size)
            elif file_type.media_type.startswith(ODF):
                check_odf(extension, stream, size)
            else:
                check_text(stream, head)
    except FileNotFoundError:
        raise AppError("document_upload_not_found", 404) from None
    except OSError:
        log.error("An uploaded document could not be read")
        raise AppError("document_storage_error", 503) from None


@dataclass(frozen=True)
class ArchiveEntry:
    # The path inside the archive; folders end with "/" and have no source.
    path: str
    source: Path | None
    size: int
    modified: datetime


class ArchiveSink(io.RawIOBase):
    """An unseekable output: the ZIP writer adds data descriptors, so nothing is held back."""

    def __init__(self) -> None:
        self.pending = bytearray()

    def writable(self) -> bool:
        return True

    def write(self, data: Buffer, /) -> int:
        view = memoryview(data)
        self.pending += view
        return view.nbytes

    def take(self) -> bytes:
        data = bytes(self.pending)
        self.pending.clear()
        return data


def zip_time(value: datetime) -> tuple[int, int, int, int, int, int]:
    return (max(value.year, 1980), value.month, value.day, value.hour, value.minute, value.second)


def archive_chunks(entries: list[ArchiveEntry]) -> Iterator[bytes]:
    """A ZIP of the entries, produced while it is sent: files are stored without compression
    (pictures, videos and office files already are compressed) and read 1 MiB at a time."""
    sink = ArchiveSink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for entry in entries:
            info = zipfile.ZipInfo(entry.path, date_time=zip_time(entry.modified))
            if entry.source is None:
                info.CRC = info.compress_size = info.file_size = 0
                # A directory, readable by everyone, in Unix and MS-DOS terms.
                info.external_attr = (0o40755 << 16) | 0x10
                # Names in UTF-8, as for the files: unzip tools then agree on accents.
                info.flag_bits |= 0x800
                archive.mkdir(info)
            else:
                info.compress_type = zipfile.ZIP_STORED
                info.file_size = entry.size
                info.external_attr = 0o644 << 16
                with entry.source.open("rb") as source, archive.open(info, "w") as target:
                    while chunk := source.read(READ_BYTES):
                        target.write(chunk)
                        if len(sink.pending) >= READ_BYTES:
                            yield sink.take()
            if sink.pending:
                yield sink.take()
    if sink.pending:
        yield sink.take()
