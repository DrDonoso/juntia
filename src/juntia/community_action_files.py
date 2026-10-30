import hashlib
import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

from .errors import AppError
from .parser import MAX_BYTES
from .storage import out_of_space

log = logging.getLogger(__name__)
MAX_ACTIVE_PDFS = 20


def pdf_path(directory: Path, storage_key: str) -> Path:
    return directory / "actions" / f"{UUID(storage_key)}.pdf"


@dataclass(frozen=True)
class StagedPDF:
    temporary: Path
    destination: Path
    storage_key: str
    filename: str
    size: int
    sha256: str


def remove_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.error("An action upload could not be cleaned up")
        raise AppError("action_storage_error", 503) from None


def stage_pdf(stream: BinaryIO, filename: str | None, directory: Path) -> StagedPDF:
    name = re.split(r"[/\\]", filename or "")[-1]
    name = "".join(char for char in name if unicodedata.category(char) not in {"Cc", "Cf"}).strip()
    if not name.lower().endswith(".pdf") or len(name) <= 4:
        raise AppError("action_pdf_required", 415)
    name = name[:-4][:251] + ".pdf"
    key = str(uuid4())
    destination = pdf_path(directory, key)
    temporary = destination.with_suffix(".tmp")
    complete = False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        stream.seek(0)
        size = 0
        checksum = hashlib.sha256()
        tail = b""
        with temporary.open("xb") as output:
            while chunk := stream.read(1024 * 1024):
                if size == 0 and not re.match(rb"%PDF-[12]\.[0-9]", chunk):
                    raise AppError("action_pdf_required", 415)
                size += len(chunk)
                if size > MAX_BYTES:
                    raise AppError("upload_too_large", 413)
                checksum.update(chunk)
                output.write(chunk)
                tail = (tail + chunk)[-65536:]
        if not size or b"%%EOF" not in tail:
            raise AppError("action_pdf_required", 415)
        complete = True
        return StagedPDF(temporary, destination, key, name, size, checksum.hexdigest())
    except OSError as error:
        log.error("An action PDF could not be staged")
        if out_of_space(error):
            raise AppError("storage_low_space", 507) from None
        raise AppError("action_storage_error", 503) from None
    finally:
        if not complete:
            remove_file(temporary)


def publish_pdf(staged: StagedPDF) -> None:
    try:
        staged.temporary.replace(staged.destination)
    except OSError:
        log.error("An action PDF could not be published")
        raise AppError("action_storage_error", 503) from None


def delete_pdf(path: Path) -> None:
    """Delete a purged PDF; an already missing file counts as deleted."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        log.error("A withdrawn action PDF could not be purged")
        raise AppError("action_storage_error", 503) from None
