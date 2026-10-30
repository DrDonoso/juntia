import hashlib
import json
import re
import unicodedata
from datetime import date
from decimal import Decimal

from .contracts import ParsedRow
from .errors import AppError

# Version of the statement reader. It is stored with every import and is part of every transaction
# key, so changing it means re-keying the stored transactions in a migration (see 0020).
PARSER_VERSION = "statement-v1"


def normalize_iban(value: str) -> str:
    iban = re.sub(r"\s+", "", value).upper()
    if not re.fullmatch(r"ES[0-9]{22}", iban):
        raise AppError("invalid_iban")
    rotated = iban[4:] + iban[:4]
    digits = "".join(str(ord(char) - 55) if char.isalpha() else char for char in rotated)
    if int(digits) % 97 != 1:
        raise AppError("invalid_iban")
    return iban


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def transaction_key(
    booking_date: date,
    value_date: date,
    description: str,
    amount: Decimal | None,
    balance_after: Decimal | None,
    *,
    include_balance: bool = True,
) -> str:
    # Account 1 is immutable: the database never admits another account or IBAN.
    values = [
        PARSER_VERSION,
        "1",
        booking_date.isoformat(),
        value_date.isoformat(),
        " ".join(unicodedata.normalize("NFKC", description).split()),
        format((amount or Decimal("0")).quantize(Decimal("0.01")), ".2f"),
        "EUR",
    ]
    if include_balance:
        values.append(format((balance_after or Decimal("0")).quantize(Decimal("0.01")), ".2f"))
    return digest(json.dumps(values, ensure_ascii=False, separators=(",", ":")))


def source_key(row: ParsedRow, *, include_balance: bool = True) -> str:
    return transaction_key(
        row.booking_date, row.value_date, row.description, row.amount, row.balance_after,
        include_balance=include_balance,
    )
