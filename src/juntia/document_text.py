"""What the search reads of shared documents: their text, with OCR for scanned pages and pictures.

The reading queue (document_index.py) runs this module in a child process for one file at a time,
`python -m juntia.document_text FILE EXTENSION MODEL`, which prints the result as JSON, and stops
it after a time limit. Files come from residents and go through large parsers (pdfminer, PDFium,
Pillow and Tesseract), so the child lowers its priority, bounds its memory and CPU time, reads
bounded amounts, refuses XML with DTDs or entities, and writes nothing to disk.

- Text and CSV files, in the encoding the portal's viewer recognizes (text-preview.tsx).
- Word, Excel and PowerPoint (OOXML) and OpenDocument files: the text of their XML parts.
- PDFs: the text of each page; pages with little or no text are rendered and read with OCR.
- JPEG, PNG, GIF and WebP pictures, with OCR.

HEIC pictures and videos are only found by their names.
"""

import io
import json
import logging
import math
import os
import re
import subprocess
import sys
import time
import unicodedata
import warnings
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

import regex

READABLE = frozenset({
    "pdf", "txt", "csv", "docx", "xlsx", "pptx", "odt", "ods", "odp", "jpg", "jpeg", "png", "gif",
    "webp",
})
PICTURES = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
OPEN_DOCUMENTS = frozenset({"odt", "ods", "odp"})
# Tesseract's model for the language of the server (APP_LANGUAGE).
OCR_MODELS = {"en": "eng", "es": "spa"}
ERRORS = ("encrypted", "damaged", "too_large", "timeout", "missing", "failed")
MAX_CHARACTERS = 500_000
MAX_TEXT_BYTES = 2 * 1024 * 1024
# Decompressed XML read from one office file, markup included.
MAX_XML_BYTES = 64 * 1024 * 1024
MAX_ZIP_ENTRIES = 10_000
MAX_PAGES = 500
MAX_PAGE_CHARACTERS = 200_000
MAX_OCR_PAGES = 100
# A PDF page is read with OCR when its text has fewer letters and digits than MIN_TEXT, or fewer
# than SCANNED_TEXT while one picture covers most of it: a scan with a stamp or signature added.
MIN_TEXT = 25
SCANNED_TEXT = 250
SCANNED_COVER = 0.75
RENDER_DPI = 300
MAX_OCR_PIXELS = 25_000_000
MAX_IMAGE_PIXELS = 150_000_000
# What Tesseract "reads" in photos without text comes in lines it is unsure of: their words are
# left out unless it is sure of them, while a short word it doubts in a good line stays.
MIN_LINE_CONFIDENCE = 50
MIN_WORD_CONFIDENCE = 80
# Seconds: the child stops reading and keeps what it read; the queue kills it at 15 minutes.
TIME_BUDGET = 600
OCR_TIMEOUT = 180
MEMORY_LIMIT = 2 * 1024 * 1024 * 1024
CPU_LIMIT = 20 * 60
READ_BYTES = 65536
CHECK_TEXT = "Juntia reads scanned documents 2026"

CID = re.compile(r"\(cid:\d+\)")
# A word split at the end of a line, "comu-\nnidad", is joined when it goes on in lower case.
HYPHENATED = re.compile(r"([^\W\d_])-[ \t]*\r?\n\s*([^\W\d_])")
FORMAT = regex.compile(r"\p{Cf}+")
INVISIBLE = regex.compile(r"[\p{Cc}\p{Cs}\p{Co}\p{Cn}\uFFFD]+")


class Unreadable(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def clean(text: str) -> str:
    """NFC text on one line, without control, invisible or private characters."""
    text = FORMAT.sub("", CID.sub(" ", text))
    text = HYPHENATED.sub(
        lambda match: match[1] + match[2] if match[2].islower() else match[0], text,
    )
    return " ".join(unicodedata.normalize("NFC", INVISIBLE.sub(" ", text)).split())


@dataclass
class Reading:
    deadline: float
    parts: list[str] = field(default_factory=list)
    length: int = 0
    ocr_pages: int = 0
    needs_ocr: bool = False
    # Something was left out: a limit was reached, or a page could not be read.
    partial: bool = False
    # MAX_CHARACTERS were kept: nothing more is read.
    full: bool = False

    @property
    def late(self) -> bool:
        return time.monotonic() >= self.deadline

    @property
    def content(self) -> str:
        return " ".join(self.parts)

    def add(self, text: str) -> bool:
        """Keep the text; False once it is full."""
        text = clean(text)
        if not text:
            return not self.full
        room = MAX_CHARACTERS - self.length - (1 if self.parts else 0)
        if len(text) > room:
            self.partial = self.full = True
            text = text[:max(room, 0)]
            cut = text.rfind(" ")
            text = text[:cut] if cut > 0 else text
        if text:
            self.length += len(text) + (1 if self.parts else 0)
            self.parts.append(text)
        return not self.full


def decode(data: bytes, partial: bool) -> str:
    """Like the viewer: UTF-8 or UTF-16 with a byte order mark, UTF-8, or else Windows-1252. A
    file read in part may end in the middle of a character."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le", "replace")
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", "replace")
    for cut in range(4 if partial else 1):
        try:
            return data[:len(data) - cut].decode("utf-8")
        except UnicodeDecodeError:
            continue
    return data.decode("cp1252", "replace")


def read_text(path: Path, reading: Reading) -> None:
    with path.open("rb") as stream:
        data = stream.read(MAX_TEXT_BYTES + 1)
    partial = len(data) > MAX_TEXT_BYTES
    reading.partial |= partial
    reading.add(decode(data[:MAX_TEXT_BYTES], partial))


def local(name: str) -> str:
    return name.rpartition(" ")[2]


def refuse(*_: object) -> None:
    raise Unreadable("damaged")


class XmlText:
    """Collects the text of an XML part while expat streams it."""

    def __init__(self, reading: Reading):
        self.reading = reading
        self.buffer: list[str] = []
        self.size = 0
        self.stopped = False

    def start(self, name: str, attributes: dict[str, str]) -> None:
        pass

    def end(self, name: str) -> None:
        pass

    def data(self, text: str) -> None:
        pass

    def write(self, text: str) -> None:
        self.buffer.append(text)
        self.size += len(text)

    def line(self) -> None:
        """The end of a paragraph or row: a safe place to hand the text over."""
        self.write("\n")
        if self.size >= READ_BYTES:
            self.flush()

    def flush(self) -> None:
        if self.buffer and not self.stopped and not self.reading.add("".join(self.buffer)):
            self.stopped = True
        self.buffer.clear()
        self.size = 0


class RunText(XmlText):
    """Word documents and PowerPoint slides: the text runs of their paragraphs."""

    def __init__(self, reading: Reading):
        super().__init__(reading)
        self.depth = 0

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if name == "t":
            self.depth += 1
        elif name in ("tab", "ptab"):
            self.write(" ")
        elif name in ("br", "cr"):
            self.write("\n")

    def end(self, name: str) -> None:
        if name == "t":
            self.depth -= 1
        elif name == "p":
            self.line()

    def data(self, text: str) -> None:
        if self.depth > 0:
            self.write(text)


class SharedStrings(XmlText):
    """The strings of an Excel workbook, which its cells refer to by number."""

    def __init__(self, reading: Reading):
        super().__init__(reading)
        self.strings: list[str] = []
        self.current: list[str] = []
        self.kept = 0
        self.depth = 0
        self.phonetic = 0

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if name == "si":
            self.current = []
        elif name == "t":
            self.depth += 1
        elif name == "rPh":
            self.phonetic += 1

    def end(self, name: str) -> None:
        if name == "si":
            value = "".join(self.current) if self.kept < MAX_CHARACTERS else ""
            self.kept += len(value)
            self.strings.append(value)
        elif name == "t":
            self.depth -= 1
        elif name == "rPh":
            self.phonetic -= 1

    def data(self, text: str) -> None:
        if self.depth > 0 and not self.phonetic:
            self.current.append(text)


class SheetText(XmlText):
    """The values of an Excel worksheet's cells, row by row: texts and numbers, not formulas."""

    def __init__(self, reading: Reading, strings: list[str]):
        super().__init__(reading)
        self.strings = strings
        self.kind = ""
        self.value: list[str] = []
        self.inside = False

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if name == "c":
            self.kind = next((value for key, value in attributes.items() if local(key) == "t"), "")
            self.value = []
        elif name in ("v", "t"):
            self.inside = True

    def end(self, name: str) -> None:
        if name in ("v", "t"):
            self.inside = False
        elif name == "c":
            value = "".join(self.value).strip()
            if self.kind == "s":
                index = int(value) if value.isdigit() else -1
                value = self.strings[index] if 0 <= index < len(self.strings) else ""
            elif self.kind in ("b", "e"):
                value = ""
            if value:
                self.write(value + " ")
        elif name == "row":
            self.line()

    def data(self, text: str) -> None:
        if self.inside:
            self.value.append(text)


class OpenDocumentText(XmlText):
    """The paragraphs and headings of an OpenDocument text, spreadsheet or presentation."""

    def __init__(self, reading: Reading):
        super().__init__(reading)
        self.depth = 0

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if name in ("p", "h"):
            self.depth += 1
        elif self.depth and name in ("s", "tab"):
            self.write(" ")
        elif self.depth and name == "line-break":
            self.write("\n")

    def end(self, name: str) -> None:
        if name in ("p", "h"):
            self.depth -= 1
            self.line()

    def data(self, text: str) -> None:
        if self.depth > 0:
            self.write(text)


def parse_xml(stream: IO[bytes], handler: XmlText, budget: list[int]) -> None:
    from xml.parsers import expat

    parser = expat.ParserCreate(namespace_separator=" ")
    parser.buffer_text = True
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.StartElementHandler = lambda name, attributes: handler.start(local(name), attributes)
    parser.EndElementHandler = lambda name: handler.end(local(name))
    parser.CharacterDataHandler = handler.data
    while not handler.stopped:
        chunk = stream.read(READ_BYTES)
        if not chunk:
            parser.Parse(b"", True)
            break
        if len(chunk) > budget[0]:
            # What fits is still read.
            parser.Parse(chunk[:max(budget[0], 0)], False)
            budget[0] = -1
            handler.reading.partial = True
            break
        budget[0] -= len(chunk)
        parser.Parse(chunk, False)
    handler.flush()


def natural(name: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


def parts_named(names: dict[str, zipfile.ZipInfo], pattern: str) -> list[zipfile.ZipInfo]:
    return [names[name] for name in sorted(
        (name for name in names if re.fullmatch(pattern, name)), key=natural,
    )]


def read_zip(path: Path, extension: str, reading: Reading) -> None:
    from xml.parsers import expat

    budget = [MAX_XML_BYTES]
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise Unreadable("damaged")
            names = {info.filename.lower(): info for info in infos}
            parts: list[tuple[zipfile.ZipInfo, XmlText]] = []
            if extension == "docx":
                parts = [(info, RunText(reading)) for info in [
                    *parts_named(names, r"word/document\.xml"),
                    *parts_named(names, r"word/(?:header|footer)\d*\.xml"),
                    *parts_named(names, r"word/(?:footnotes|endnotes)\.xml"),
                ]]
            elif extension == "pptx":
                parts = [
                    (info, RunText(reading))
                    for info in parts_named(names, r"ppt/slides/slide\d+\.xml")
                ]
            elif extension == "xlsx":
                strings = SharedStrings(reading)
                for info in parts_named(names, r"xl/sharedstrings\.xml"):
                    with archive.open(info) as stream:
                        parse_xml(stream, strings, budget)
                parts = [
                    (info, SheetText(reading, strings.strings))
                    for info in parts_named(names, r"xl/worksheets/sheet\d+\.xml")
                ]
            elif extension in OPEN_DOCUMENTS:
                parts = [
                    (info, OpenDocumentText(reading))
                    for info in parts_named(names, r"content\.xml")
                ]
            for info, handler in parts:
                if reading.full or budget[0] < 0 or reading.late:
                    reading.partial = True
                    break
                with archive.open(info) as stream:
                    parse_xml(stream, handler, budget)
    except (
        zipfile.BadZipFile, zipfile.LargeZipFile, expat.ExpatError, NotImplementedError,
        RuntimeError, ValueError, EOFError, OSError,
    ):
        raise Unreadable("damaged") from None


@dataclass
class Ocr:
    """Tesseract, one page or picture at a time, with orientation detection: sideways and
    upside-down scans and photos are read too."""

    model: str

    def read(self, image: bytes, dpi: int | None, reading: Reading) -> str | None:
        remaining = reading.deadline - time.monotonic()
        if remaining < 1:
            reading.partial = True
            return None
        command = ["tesseract", "stdin", "stdout", "-l", self.model, "--psm", "1"]
        if dpi:
            command += ["--dpi", str(dpi)]
        try:
            result = subprocess.run(
                [*command, "tsv"], input=image, capture_output=True, check=False,
                timeout=min(OCR_TIMEOUT, remaining),
            )
        except subprocess.TimeoutExpired:
            reading.partial = True
            return None
        except OSError:
            raise Unreadable("failed") from None
        if result.returncode != 0:
            reading.partial = True
            return None
        return words(result.stdout.decode("utf-8", "replace"))


def words(tsv: str) -> str:
    """The lines of Tesseract's TSV output, without what it is unsure of."""
    lines: dict[tuple[str, ...], list[tuple[float, str]]] = {}
    for row in tsv.splitlines()[1:]:
        cells = row.split("\t")
        if len(cells) != 12 or cells[0] != "5":
            continue
        try:
            confidence = float(cells[10])
        except ValueError:
            continue
        word = cells[11].strip()
        if word and confidence >= 0:
            lines.setdefault(tuple(cells[1:5]), []).append((confidence, word))
    kept = []
    for found in lines.values():
        weight = sum(len(word) for _, word in found)
        sure = sum(confidence * len(word) for confidence, word in found) / weight
        chosen = [
            word for confidence, word in found if sure >= MIN_LINE_CONFIDENCE or (
                confidence >= MIN_WORD_CONFIDENCE and any(char.isalnum() for char in word)
            )
        ]
        if chosen:
            kept.append(" ".join(chosen))
    return "\n".join(kept)


def portable_graymap(image: Any) -> bytes:
    """Uncompressed, which Tesseract reads from memory fastest."""
    buffer = io.BytesIO()
    image.save(buffer, format="PPM")
    return buffer.getvalue()


def picture_for_ocr(image: Any) -> bytes:
    """A picture upright, in shades of grey on white, and at most MAX_OCR_PIXELS."""
    from PIL import Image, ImageOps

    width, height = image.size
    if image.format == "JPEG" and width * height > MAX_OCR_PIXELS:
        factor = math.sqrt(MAX_OCR_PIXELS / (width * height))
        image.draft("L", (math.ceil(width * factor), math.ceil(height * factor)))
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
        picture = image.convert("RGBA")
        image = Image.new("RGBA", picture.size, "white")
        image.alpha_composite(picture)
    image = image.convert("L")
    width, height = image.size
    if width * height > MAX_OCR_PIXELS:
        factor = math.sqrt(MAX_OCR_PIXELS / (width * height))
        image = image.resize(
            (max(1, int(width * factor)), max(1, int(height * factor))),
            Image.Resampling.LANCZOS, reducing_gap=2.0,
        )
    return portable_graymap(image)


def read_picture(path: Path, reading: Reading, ocr: Ocr | None) -> None:
    if ocr is None:
        reading.needs_ocr = True
        return
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                data = picture_for_ocr(image)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, MemoryError):
        raise Unreadable("too_large") from None
    except Exception:
        raise Unreadable("damaged") from None
    text = ocr.read(data, None, reading)
    if text is not None:
        reading.ocr_pages = 1
        reading.add(text)


class Renderer:
    """Pages of a PDF as pictures for OCR, at 300 dpi or at most MAX_OCR_PIXELS."""

    def __init__(self, path: Path):
        import pypdfium2

        self.document = pypdfium2.PdfDocument(str(path))

    def render(self, index: int) -> tuple[bytes, int]:
        page = self.document[index]
        try:
            width, height = page.get_size()
            scale = min(
                RENDER_DPI / 72, math.sqrt(MAX_OCR_PIXELS / max(width * height, 1.0)),
            )
            bitmap = page.render(scale=scale, grayscale=True)
            try:
                return portable_graymap(bitmap.to_pil()), max(1, round(72 * scale))
            finally:
                bitmap.close()
        finally:
            page.close()

    def close(self) -> None:
        self.document.close()


def scanned(page: Any, text: str) -> bool:
    """Whether a page needs OCR: it has no text (a scan, or text drawn as shapes), or a scan
    with a few words added, such as a stamp or a signature, covers it."""
    letters = sum(character.isalnum() for character in text)
    if letters == 0:
        return True
    if letters >= SCANNED_TEXT or not page.images:
        return False
    if letters < MIN_TEXT:
        return True
    left, top, right, bottom = page.bbox
    area = max((right - left) * (bottom - top), 1.0)
    covered = max((
        max(0.0, min(image["x1"], right) - max(image["x0"], left))
        * max(0.0, min(image["bottom"], bottom) - max(image["top"], top))
        for image in page.images
    ), default=0.0)
    return covered >= SCANNED_COVER * area


def read_pdf(path: Path, reading: Reading, ocr: Ocr | None) -> None:
    import pdfplumber
    from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect

    logging.getLogger("pdfminer").setLevel(logging.ERROR)
    renderer: Renderer | None = None
    try:
        # One page more than is read tells that the rest was left out.
        with pdfplumber.open(
            path, pages=list(range(1, MAX_PAGES + 2)), password="", raise_unicode_errors=False,
        ) as document:
            if not document.pages:
                raise Unreadable("damaged")
            for index, page in enumerate(document.pages):
                if index >= MAX_PAGES or reading.late:
                    reading.partial = True
                    break
                try:
                    if len(page.chars) > MAX_PAGE_CHARACTERS:
                        reading.partial = True
                        continue
                    text = page.extract_text() or ""
                    needs = scanned(page, text)
                finally:
                    page.close()
                if needs and ocr is None:
                    reading.needs_ocr = True
                elif needs and reading.ocr_pages >= MAX_OCR_PAGES:
                    reading.partial = True
                elif needs and ocr is not None:
                    renderer = renderer or Renderer(path)
                    try:
                        image, dpi = renderer.render(index)
                    except MemoryError:
                        raise
                    except Exception:
                        reading.partial = True
                    else:
                        found = ocr.read(image, dpi, reading)
                        if found is not None:
                            reading.ocr_pages += 1
                            text = text + "\n" + found
                if not reading.add(text):
                    break
    except (Unreadable, MemoryError):
        raise
    except Exception as error:
        # pdfplumber wraps pdfminer's errors.
        causes = [error, *error.args, error.__cause__, error.__context__]
        if any(isinstance(cause, (PDFPasswordIncorrect, PDFEncryptionError)) for cause in causes):
            raise Unreadable("encrypted") from None
        raise Unreadable("damaged") from None
    finally:
        if renderer is not None:
            renderer.close()


def extract(path: Path, extension: str, model: str | None) -> dict[str, Any]:
    """The text of a stored file, or why it could not be read."""
    reading = Reading(deadline=time.monotonic() + TIME_BUDGET)
    ocr = Ocr(model) if model else None
    try:
        if not path.is_file():
            raise Unreadable("missing")
        if extension in ("txt", "csv"):
            read_text(path, reading)
        elif extension in ("docx", "xlsx", "pptx") or extension in OPEN_DOCUMENTS:
            read_zip(path, extension, reading)
        elif extension == "pdf":
            read_pdf(path, reading, ocr)
        elif extension in PICTURES:
            read_picture(path, reading, ocr)
        else:
            raise Unreadable("failed")
    except Unreadable as error:
        return {"error": error.reason}
    except MemoryError:
        return {"error": "too_large"}
    except OSError:
        return {"error": "damaged"}
    return {
        "content": reading.content, "ocr_pages": reading.ocr_pages,
        "needs_ocr": reading.needs_ocr, "partial": reading.partial,
    }


def limit_resources() -> None:
    """Lower priority, and bounded memory and processor time, for this process and Tesseract."""
    if sys.platform == "win32":
        return
    import resource

    try:
        os.nice(10)
        for kind, value in ((resource.RLIMIT_AS, MEMORY_LIMIT), (resource.RLIMIT_CPU, CPU_LIMIT)):
            _, hard = resource.getrlimit(kind)
            if hard != resource.RLIM_INFINITY:
                value = min(value, hard)
            resource.setrlimit(kind, (value, value))
    except (OSError, ValueError):
        pass


def check(model: str) -> int:
    """Read a generated picture with OCR, to check an installation."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("L", (1600, 240), 255)
    ImageDraw.Draw(image).text(
        (60, 80), CHECK_TEXT, fill=0, font=ImageFont.load_default(size=64),
    )
    reading = Reading(deadline=time.monotonic() + 120)
    found = Ocr(model).read(portable_graymap(image), 300, reading) or ""
    print(found)
    return 0 if "scanned documents" in clean(found).lower() else 1


def main(arguments: list[str]) -> int:
    if len(arguments) in (1, 2) and arguments[0] == "--check":
        return check(arguments[1] if len(arguments) == 2 else "eng")
    if len(arguments) != 3:
        print("Usage: python -m juntia.document_text FILE EXTENSION MODEL|- | --check [MODEL]")
        return 2
    path, extension, model = arguments
    limit_resources()
    result = extract(Path(path), extension, None if model == "-" else model)
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
