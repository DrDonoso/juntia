import os
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from juntia.errors import AppError
from juntia.identity import normalize_iban, source_key
from juntia.parser import parse_pdf
from tests.support import ROWS, iban, statement_pdf


def test_columns_balances_dates_and_identity():
    result = parse_pdf(statement_pdf())
    assert result.iban == iban()
    assert len(result.rows) == 3
    assert result.rows[1].booking_date != result.rows[1].value_date
    assert [row.amount for row in result.rows] == [Decimal("-20"), Decimal("-30"), Decimal("200")]
    assert all(
        a.balance_after - b.balance_after == a.amount for a, b in zip(result.rows, result.rows[1:])
    )
    reprinted = parse_pdf(statement_pdf(shifted=False))
    assert [source_key(r) for r in result.rows] == [source_key(r) for r in reprinted.rows]
    single_month = parse_pdf(statement_pdf(rows=ROWS[:2]))
    assert source_key(single_month.rows[0]) == source_key(result.rows[0])


def test_ascending_multiple_pages_and_year_boundary():
    result = parse_pdf(statement_pdf(rows=list(reversed(ROWS))))
    assert [row.description for row in result.rows] == [row[2] for row in ROWS]
    assert [row.ordinal for row in result.rows] == [0, 1, 2]
    multi = parse_pdf(statement_pdf(pages=[ROWS[:2], ROWS[2:]]))
    assert len(multi.rows) == 3 and multi.rows[-1].page == 2
    years = parse_pdf(
        statement_pdf(
            rows=[
                ("01/01/26", "02/01/26", "New year debit", "-20", "80"),
                ("31/12/25", "31/12/25", "Previous year credit", "100", "100"),
            ]
        )
    )
    assert years.rows[-1].booking_date == date(2025, 12, 31)


@pytest.mark.parametrize(
    "account,code",
    [
        ("", "missing_iban"),
        ("ES00" + iban()[4:], "invalid_iban"),
        ("ES** 9999 ****", "missing_iban"),
    ],
)
def test_invalid_or_missing_header_account(account, code):
    with pytest.raises(AppError) as error:
        parse_pdf(statement_pdf(account=account))
    assert error.value.code == code


def test_normalization_conflicting_headers_and_beneficiary():
    spaced = " ".join(iban()[i : i + 4] for i in range(0, 24, 4)).lower()
    assert parse_pdf(statement_pdf(account=spaced)).iban == iban()
    with pytest.raises(AppError, match="ambiguous_iban"):
        parse_pdf(statement_pdf(extra_header=iban("0000000002")))
    rows = [(a, b, "Transfer to " + iban(), c, d) for a, b, _, c, d in ROWS]
    with pytest.raises(AppError, match="missing_iban"):
        parse_pdf(statement_pdf(rows=rows, account=""))
    assert normalize_iban(spaced) == iban()


def test_invalid_financial_input_fails_closed():
    broken = [(*ROWS[0][:3], "-21", ROWS[0][4]), *ROWS[1:]]
    with pytest.raises(AppError, match="balance_mismatch"):
        parse_pdf(statement_pdf(rows=broken))
    with pytest.raises(AppError, match="unsupported_pdf"):
        parse_pdf(b"not a PDF")
    with pytest.raises(AppError, match="upload_too_large"):
        parse_pdf(b"%PDF-" + b"x" * (20 * 1024 * 1024))


def test_repeated_payments_with_different_balances_are_distinct():
    result = parse_pdf(
        statement_pdf(
            rows=[
                ("02/10/26", "02/10/26", "Identical receipt", "-20", "160"),
                ("02/10/26", "02/10/26", "Identical receipt", "-20", "180"),
                ("01/10/26", "01/10/26", "Credit", "200", "200"),
            ]
        )
    )
    assert source_key(result.rows[0]) != source_key(result.rows[1])


@pytest.mark.parametrize(
    "url", ["https://example.invalid/receipt", "https://bank.example/receipt"]
)
def test_description_url_is_not_mistaken_for_a_page_footer(url):
    rows = list(ROWS)
    row = rows[1]
    rows[1] = (row[0], row[1], "Receipt " + url, row[3], row[4])
    parsed = parse_pdf(statement_pdf(rows=rows))
    assert len(parsed.rows) == 3
    assert url in parsed.rows[1].description


@pytest.mark.skipif(
    not os.environ.get("PRIVATE_STATEMENT_PATH"), reason="Private local sample only"
)
def test_private_sample_without_ai():
    """Parse a real statement kept outside the repository.

    Only invariants are asserted here, so the sample's own facts never live in this file. Set
    PRIVATE_STATEMENT_ROWS, PRIVATE_STATEMENT_FIRST_DATE and PRIVATE_STATEMENT_LAST_DATE (ISO
    booking dates) and PRIVATE_STATEMENT_VALUE_DATE_DIFFERENCES to check them as well.
    """
    result = parse_pdf(Path(os.environ["PRIVATE_STATEMENT_PATH"]).read_bytes())
    rows = result.rows
    assert rows
    assert normalize_iban(result.iban) == result.iban
    assert [row.ordinal for row in rows] == list(range(len(rows)))
    assert all(row.description for row in rows)
    assert all(a.booking_date >= b.booking_date for a, b in zip(rows, rows[1:]))
    assert all(a.balance_after - b.balance_after == a.amount for a, b in zip(rows, rows[1:]))
    checks = {
        "PRIVATE_STATEMENT_ROWS": (int, len(rows)),
        "PRIVATE_STATEMENT_FIRST_DATE": (
            date.fromisoformat, min(row.booking_date for row in rows)
        ),
        "PRIVATE_STATEMENT_LAST_DATE": (
            date.fromisoformat, max(row.booking_date for row in rows)
        ),
        "PRIVATE_STATEMENT_VALUE_DATE_DIFFERENCES": (
            int, sum(row.booking_date != row.value_date for row in rows)
        ),
    }
    for name, (parse, actual) in checks.items():
        if expected := os.environ.get(name, "").strip():
            assert actual == parse(expected), name
