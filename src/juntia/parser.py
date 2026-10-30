"""Deterministic, column-aware reader of text-based bank statement PDFs. No network or AI."""

import io
import json
import logging
import re
import subprocess
import sys
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pdfplumber
from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect
from pdfminer.pdfparser import PDFSyntaxError

from .contracts import ParsedRow, Statement
from .errors import AppError
from .identity import normalize_iban

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 50
DATE = re.compile(r"^\d{2}/\d{2}/(?:\d{4}|\d{2})$")
MONEY = re.compile(r"^(-?)\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|\x80)?$")
log = logging.getLogger(__name__)


def parse_date(value: str) -> date:
    day, month, year = (int(part) for part in value.split("/"))
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        raise AppError("invalid_date") from None


def lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (item["top"], item["x0"])):
        if not grouped or abs(grouped[-1][0]["top"] - word["top"]) > 2:
            grouped.append([])
        grouped[-1].append(word)
    return [sorted(group, key=lambda item: item["x0"]) for group in grouped]


def text(words: list[dict[str, Any]]) -> str:
    return " ".join(word["text"] for word in words)


def monetary_column(words: list[dict[str, Any]]) -> list[Decimal]:
    values = []
    for group in lines(words):
        raw = text(group).replace("\u2212", "-")
        match = MONEY.fullmatch(raw)
        if not match:
            raise AppError("invalid_amount")
        try:
            value = Decimal((match[1] + match[2]).replace(".", "").replace(",", "."))
        except InvalidOperation:
            raise AppError("invalid_amount") from None
        if abs(value) >= Decimal("1000000000000"):
            raise AppError("invalid_amount")
        values.append(value)
    return values


def parse_pdf(data: bytes) -> Statement:
    if len(data) > MAX_BYTES:
        raise AppError("upload_too_large", 413)
    if not data.startswith(b"%PDF-"):
        raise AppError("unsupported_pdf")
    rows: list[ParsedRow] = []
    ibans: set[str] = set()
    try:
        with pdfplumber.open(io.BytesIO(data)) as document:
            if document.doc.encryption:
                raise AppError("encrypted_pdf")
            if not 1 <= len(document.pages) <= MAX_PAGES:
                raise AppError("pdf_page_limit")
            for page_number, page in enumerate(document.pages, 1):
                if len(page.chars) > 150000:
                    raise AppError("pdf_content_limit")
                words = page.extract_words(x_tolerance=1, y_tolerance=2)
                if not words:
                    raise AppError("scanned_pdf")
                header = next(
                    (
                        group
                        for group in lines(words)
                        if {"Data", "Valor", "Concepte", "Import", "Saldo"}
                        <= {word["text"] for word in group}
                    ),
                    None,
                )
                if header is None:
                    raise AppError("unsupported_pdf_layout")
                if "€" not in text(header).replace("\x80", "€"):
                    raise AppError("unsupported_currency")
                positions = {word["text"]: word for word in header}
                top = min(word["top"] for word in header)
                header_text = "\n".join(
                    text(group) for group in lines([w for w in words if w["top"] < top - 2])
                )
                found = re.findall(r"\bES(?:\s*\d){22}\b", header_text, re.IGNORECASE)
                if page_number == 1 and not found:
                    raise AppError("missing_iban")
                for candidate in found:
                    ibans.add(normalize_iban(candidate))
                if len(ibans) != 1:
                    raise AppError("ambiguous_iban")
                if re.search(r"\bES[\d*\s]*[*]", header_text, re.IGNORECASE):
                    raise AppError("invalid_iban")

                # The page footer starts at the first link printed left of the description column;
                # links inside descriptions belong to their transactions.
                footer = min(
                    (
                        w["top"]
                        for w in words
                        if w["text"].startswith("https://")
                        and w["x0"] < positions["Concepte"]["x0"]
                        and w["top"] > top
                    ),
                    default=page.height - 15,
                )
                body = [w for w in words if top + 4 < w["top"] < footer - 2]
                date_start = positions["Data"]["x0"] - 2
                value_start = positions["Valor"]["x0"] - 2
                concept_start = positions["Concepte"]["x0"] - 2
                amount_start = positions["Import"]["x0"] - 10
                balance_start = positions["Saldo"]["x0"] - 10
                if not date_start < value_start < concept_start < amount_start < balance_start:
                    raise AppError("unsupported_pdf_layout")
                booking_words = [w for w in body if date_start <= w["x0"] < value_start]
                value_words = [w for w in body if value_start <= w["x0"] < concept_start]
                booking = lines(booking_words)
                value_dates = lines(value_words)
                if not booking or any(not DATE.fullmatch(text(group)) for group in booking):
                    raise AppError("invalid_date")
                if any(not DATE.fullmatch(text(group)) for group in value_dates):
                    raise AppError("invalid_date")
                amounts = monetary_column(
                    [w for w in body if amount_start <= w["x0"] < balance_start]
                )
                balances = monetary_column([w for w in body if w["x0"] >= balance_start])
                if len({len(booking), len(value_dates), len(amounts), len(balances)}) != 1:
                    raise AppError("column_count_mismatch")
                concepts = [w for w in body if concept_start <= w["x0"] < amount_start]
                for index, group in enumerate(booking):
                    start = group[0]["top"] - 2
                    end = booking[index + 1][0]["top"] - 2 if index + 1 < len(booking) else footer
                    concept = " ".join(
                        text(line)
                        for line in lines([w for w in concepts if start <= w["top"] < end])
                    )
                    if not concept:
                        raise AppError("missing_description")
                    rows.append(
                        ParsedRow(
                            booking_date=parse_date(text(group)),
                            value_date=parse_date(text(value_dates[index])),
                            description=concept,
                            amount=amounts[index],
                            balance_after=balances[index],
                            page=page_number,
                            ordinal=len(rows),
                        )
                    )
    except (PDFPasswordIncorrect, PDFEncryptionError):
        raise AppError("encrypted_pdf") from None
    except (PDFSyntaxError, ValueError, TypeError, KeyError, IndexError, OSError) as error:
        log.warning("Unsupported or damaged PDF structure (%s)", type(error).__name__)
        raise AppError("invalid_pdf") from None

    if not rows or len(rows) > 10000:
        raise AppError("pdf_content_limit")
    descending = all(a.booking_date >= b.booking_date for a, b in zip(rows, rows[1:]))
    ascending = all(a.booking_date <= b.booking_date for a, b in zip(rows, rows[1:]))
    forward_valid = descending and all(
        a.balance_after - b.balance_after == a.amount for a, b in zip(rows, rows[1:])
    )
    backward_valid = ascending and all(
        b.balance_after - a.balance_after == b.amount for a, b in zip(rows, rows[1:])
    )
    if not forward_valid and not backward_valid:
        raise AppError("balance_mismatch")
    if not forward_valid:
        rows.reverse()
    rows = [row.model_copy(update={"ordinal": index}) for index, row in enumerate(rows)]
    return Statement(iban=next(iter(ibans)), rows=rows)


def parse_file_bounded(path: Path) -> Statement:
    try:
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-m", "juntia.parser", str(path)],
            capture_output=True,
            timeout=45,
            check=False,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired:
        log.warning("PDF parser exceeded the process execution limit")
        raise AppError("parser_timeout") from None
    if result.returncode:
        log.error("PDF parser process failed with exit code %s", result.returncode)
        raise AppError("invalid_pdf")
    payload = json.loads(result.stdout)
    if "error" in payload:
        raise AppError(payload["error"])
    return Statement.model_validate(payload)


if __name__ == "__main__":
    try:
        statement = parse_pdf(Path(sys.argv[1]).read_bytes())
        print(statement.model_dump_json())
    except AppError as error:
        print(json.dumps({"error": error.code}))
