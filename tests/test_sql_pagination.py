import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import delete, event, insert, inspect, literal, select

from juntia.bank_order import rebuild_bank_order
from juntia.db import Contact, ImportRow, ImportRun, State, Transaction, TransactionOrder
from juntia.errors import AppError
from juntia.query_sql import casefold_sql, fold_sql, fold_text
from tests.test_action_migration import migrate
from tests.test_api import commit, preview
from tests.test_contacts import create, tag
from tests.test_users import database


def test_database_unicode_operations_match_existing_python_semantics(config):
    combining = "".join(
        chr(code) for code in range(0x110000) if unicodedata.combining(chr(code))
    )
    values = [
        None, "", "Stra\u00dfe", "STRASSE", "\u0130stanbul", "\u039f\u03a3", "\u03bf\u03c2",
        "A\u0301na", "\u00c1na", "\ufb03", "\uff21scensor", "100%_literal",
        "line\nsecond\tcolumn", "\U0001e4ecX", "\u034f", "\u0301",
        "\u034f\ufe0f\u200d", "[]^-\\.*+?(){}|\n\t", "A" + combining + "Z",
        "x" * 20000 + "\u00c1\u0301\u034f\U0001e4ec",
    ]

    async def compare(db):
        for value in values:
            folded, casefolded = (await db.execute(select(
                fold_sql(db, literal(value)), casefold_sql(db, literal(value)),
            ))).one()
            assert folded == fold_text(value or "")
            assert casefolded == (value or "").casefold()

    database(config, compare)


@pytest.mark.parametrize("deleted", [False, True])
def test_contact_pages_materialize_only_the_requested_fifty_records(admin, config, deleted):
    now = datetime.now(timezone.utc)

    async def populate(db):
        await db.execute(insert(Contact), [
            {
                "name": f"Contact {index:04}", "phone": "1234567",
                "notes": "x" * 10000 + f"{index:04}",
                "created_at": now, "updated_at": now,
                "deleted_at": now if deleted else None,
            } for index in range(600)
        ])

    database(config, populate)
    loaded = []

    def record(value, context):
        loaded.append(value.id)

    event.listen(Contact, "load", record)
    try:
        endpoint = "/api/admin/contacts/deleted" if deleted else "/api/contacts"
        for page, expected_count in [(1, 50), (5, 50), (12, 50), (13, 0)]:
            loaded.clear()
            response = admin.get(endpoint, params={"page": page, "sort": "notes"})
            assert response.status_code == 200, response.text
            result = response.json()
            assert (result["total"], result["pages"]) == (600, 12)
            assert len(loaded) == len(result["items"]) == expected_count
            assert loaded == [value["id"] for value in result["items"]]
    finally:
        event.remove(Contact, "load", record)


def test_contact_search_is_literal_unicode_aware_and_reflects_tag_renames(admin):
    labels = [tag(admin, "Stra\u00dfe"), tag(admin, "\u0301")]
    values = [
        create(admin, "\u00c1na", company="Service", notes="literal 100%_ '\\ path",
               tags=[value["id"] for value in labels]),
        create(admin, "Ana", company="", notes="100-anything", tags=[]),
        create(admin, "Other", company="Service", notes="\u2102", tags=[labels[1]["id"]]),
    ]
    for query in ["ANA", "STRASSE", "100%_", "'\\ path", "Service\n\n+34900", "' OR 1=1 --", "c", "\0"]:
        needle = fold_text(query.strip())
        expected = [
            value["id"] for value in values if needle in fold_text("\n".join([
                value["name"], value["company"], value["email"] or "", value["phone"],
                value["notes"], *(label["name"] for label in value["tags"]),
            ]))
        ]
        result = admin.get("/api/contacts", params={"q": query}).json()
        assert sorted(value["id"] for value in result["items"]) == sorted(expected)
    for direction in ["asc", "desc"]:
        def key(value):
            return "\0".join(sorted(fold_text(label["name"]) for label in value["tags"]))
        expected = sorted(
            [value for value in values if key(value)], key=key, reverse=direction == "desc",
        ) + [value for value in values if not key(value)]
        result = admin.get("/api/contacts", params={"sort": "tags", "direction": direction}).json()
        assert [value["id"] for value in result["items"]] == [value["id"] for value in expected]
    response = admin.patch(f"/api/contact-tags/{labels[0]['id']}", json={
        "name": "Actualizado", "color": labels[0]["color"], "version": labels[0]["version"],
    })
    assert response.status_code == 200
    assert admin.get("/api/contacts", params={"q": "strasse"}).json()["total"] == 0
    assert admin.get("/api/contacts", params={"q": "actualizado"}).json()["total"] == 1


@pytest.fixture
def ledger(config):
    start = date(2026, 1, 20)
    rows, balance = [], Decimal("0.00")
    for index in range(480):
        amount = Decimal("900000000000.01") if index % 2 == 0 else Decimal("-900000000000.00")
        balance += amount
        rows.append({
            "source_key": f"{index:064x}", "weak_key": f"{index:064x}",
            "identity_key": f"{index:064x}", "booking_date": start + timedelta(days=index // 16),
            "value_date": start + timedelta(days=index // 16),
            "description": f"Pago Stra\u00dfe {index % 7}" + (" 100%_" if index % 17 == 0 else ""),
            "amount": amount, "balance_after": balance,
            "category_id": index % 3 or None, "merchant": f"Proveedor {index % 4}" if index % 5 else "",
            "tags": [1, 2] if index % 3 == 0 else [1] if index % 3 == 1 else [],
        })

    async def populate(db):
        run = ImportRun(
            id=str(uuid4()), filename="synthetic.pdf", file_hash="a" * 64,
            start_date=start, end_date=rows[-1]["booking_date"],
            opening_balance=Decimal("0.00"), closing_balance=balance,
            inserted=len(rows), duplicates=0,
        )
        db.add(run)
        await db.flush()
        ids = list(await db.scalars(
            insert(Transaction).returning(Transaction.id, sort_by_parameter_order=True), rows,
        ))
        await db.execute(insert(ImportRow), [
            {"import_id": run.id, "ordinal": len(rows) - 1 - index, "page": 1,
             "source": {}, "transaction_id": key}
            for index, key in enumerate(ids)
        ])
        await db.run_sync(lambda session: rebuild_bank_order(session.connection()))
        return ids

    ids = database(config, populate)
    return [{**row, "id": key} for row, key in zip(rows, ids, strict=True)]


@pytest.mark.parametrize("sort", ["newest", "oldest", "amount", "description"])
def test_financial_pages_keep_canonical_order_without_loading_the_ledger(admin, ledger, sort):
    canonical = list(reversed(ledger))
    expected = (
        list(reversed(canonical)) if sort == "oldest"
        else sorted(canonical, key=lambda row: row["amount"]) if sort == "amount"
        else sorted(canonical, key=lambda row: row["description"].casefold())
        if sort == "description" else canonical
    )
    loaded = []

    def record(value, context):
        loaded.append(value.id)

    event.listen(Transaction, "load", record)
    try:
        for page in [1, 2, 10, 11, 10 ** 30]:
            loaded.clear()
            response = admin.get("/api/transactions", params={"page": page, "sort": sort})
            assert response.status_code == 200, response.text
            result = response.json()
            ids = [row["id"] for row in expected[(page - 1) * 50:page * 50]]
            assert (result["total"], result["pages"]) == (480, 10)
            assert [row["id"] for row in result["items"]] == ids
            assert loaded == ids
    finally:
        event.remove(Transaction, "load", record)


@pytest.mark.parametrize("sort,direction", [
    ("date", "desc"), ("date", "asc"),
    ("description", "desc"), ("amount", "desc"),
    ("balance", "asc"), ("balance", "desc"),
    ("category", "asc"), ("category", "desc"),
])
def test_financial_columns_sort_in_both_directions(admin, ledger, sort, direction):
    canonical = list(reversed(ledger))
    if sort == "date":
        expected = canonical if direction == "desc" else list(reversed(canonical))
    elif sort == "category":
        names = {
            row["id"]: fold_text(row["name"])
            for row in admin.get("/api/catalog/categories").json()
        }
        assigned = [row for row in canonical if row["category_id"] is not None]
        expected = sorted(
            assigned, key=lambda row: names[row["category_id"]], reverse=direction == "desc",
        ) + [row for row in canonical if row["category_id"] is None]
    else:
        key = (
            (lambda row: row["description"].casefold()) if sort == "description"
            else (lambda row: row["amount"]) if sort == "amount"
            else (lambda row: row["balance_after"])
        )
        expected = sorted(canonical, key=key, reverse=direction == "desc")
    response = admin.get(
        "/api/transactions", params={"sort": sort, "direction": direction},
    )
    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()["items"]] == [
        row["id"] for row in expected[:50]
    ]


def test_financial_sql_filters_intersect_and_keep_literal_search(admin, ledger):
    for query in ["STRASSE", "100%_", "' OR 1=1 --"]:
        params = [
            ("start", "2026-02-01"), ("q", query), ("flow", "expense"),
            ("category", "2"), ("merchant", "provei"), ("tag", "1"), ("tag", "2"),
        ]
        assert admin.get("/api/transactions", params=params).json()["total"] == 0
        params = [item for item in params if item[0] not in {"category", "merchant"}]
        expected = [
            row for row in reversed(ledger)
            if row["booking_date"] >= date(2026, 2, 1) and row["amount"] < 0
            and query.casefold() in row["description"].casefold() and {1, 2} <= set(row["tags"])
        ]
        result = admin.get("/api/transactions", params=params).json()
        assert result["total"] == len(expected)
        assert [row["id"] for row in result["items"]] == [row["id"] for row in expected[:50]]
    assert admin.get("/api/transactions", params=[("tag", str(key)) for key in range(31)]).json()["total"] == 0
    assert admin.get("/api/transactions", params={"tag": str(10 ** 30)}).json()["total"] == 0


def test_summary_aggregates_exact_cents_without_loading_transactions(admin, ledger):
    def unexpected_load(value, context):
        pytest.fail("Summary must aggregate in SQL, not load transaction entities")

    event.listen(Transaction, "load", unexpected_load)
    try:
        response = admin.get("/api/summary")
    finally:
        event.remove(Transaction, "load", unexpected_load)
    assert response.status_code == 200, response.text
    result = response.json()
    incoming = sum((row["amount"] for row in ledger if row["amount"] > 0), Decimal("0.00"))
    outgoing = -sum((row["amount"] for row in ledger if row["amount"] < 0), Decimal("0.00"))
    assert result["income"] == str(incoming)
    assert result["expense"] == str(outgoing)
    assert result["net"] == str(incoming - outgoing)
    assert result["balance"] == str(ledger[-1]["balance_after"])
    assert result["count"] == len(ledger)
    assert result["coverage_start"] == str(ledger[0]["booking_date"])
    assert result["coverage_end"] == str(ledger[-1]["booking_date"])
    months = defaultdict(lambda: [Decimal("0.00"), Decimal("0.00")])
    for row in ledger:
        months[str(row["booking_date"])[:7]][0 if row["amount"] > 0 else 1] += abs(row["amount"])
    assert result["monthly"] == [
        {"month": month, "income": str(values[0]), "expense": str(values[1]),
         "net": str(values[0] - values[1])} for month, values in sorted(months.items())
    ]
    assert sum(Decimal(row["amount"]) for row in result["daily"]) == outgoing
    assert sum(Decimal(row["amount"]) for row in result["categories"]) == outgoing


def test_missing_bank_order_is_an_explicit_error_not_an_empty_ledger(admin, config, ledger):
    async def remove_index(db):
        await db.execute(delete(TransactionOrder).where(TransactionOrder.transaction_id == ledger[0]["id"]))

    database(config, remove_index)
    for path in ["/api/transactions", "/api/summary"]:
        response = admin.get(path)
        assert response.status_code == 503
        assert response.json() == {"code": "bank_order_missing"}


def test_order_migration_backfills_without_changing_financial_data(admin, config):
    assert commit(admin, preview(admin)).status_code == 200
    before = admin.get("/api/transactions").json()
    summary = admin.get("/api/summary").json()

    async def revision(db):
        return await db.scalar(select(State.revision))

    original_revision = database(config, revision)
    # The transactions are re-keyed when upgrading again, so their keys may stay as they are.
    migrate(config, "downgrade", "0011", options=("-x", "keep_new_transaction_keys=true"))
    migrate(config, "upgrade", "head")
    assert admin.get("/api/transactions").json() == before
    assert admin.get("/api/summary").json() == summary
    assert database(config, revision) == original_revision


def test_refused_downgrade_preserves_the_order_table_atomically(admin, config):
    create(admin, "Retained contact")
    result = migrate(config, "downgrade", "0009", check=False)
    assert result.returncode != 0

    async def table_names(db):
        return await db.run_sync(lambda session: inspect(session.connection()).get_table_names())

    assert "transaction_order" in database(config, table_names)
    assert admin.get("/api/summary").status_code == 200
    assert admin.get("/api/contacts").json()["total"] == 1


@pytest.fixture
def disconnected_ledger(config):
    day = date(2026, 1, 1)

    async def populate(db):
        rows = [
            Transaction(
                source_key=f"{index:064x}", weak_key=f"{index:064x}",
                identity_key=f"{index:064x}", booking_date=day, value_date=day,
                description="Selected" if index >= 2 else "Other", amount=Decimal("-1.00"),
                balance_after=Decimal(70 + index), tags=[],
            ) for index in range(4)
        ]
        db.add_all(rows)
        await db.flush()
        runs = []
        for group, selected in enumerate([rows[:3], rows[3:]], start=1):
            run = ImportRun(
                id=str(uuid4()), filename="synthetic.pdf", file_hash=f"{group:064x}",
                start_date=day, end_date=day, opening_balance=Decimal("80.00"),
                closing_balance=Decimal("70.00"), inserted=len(selected), duplicates=0,
            )
            db.add(run)
            await db.flush()
            db.add_all([
                ImportRow(import_id=run.id, ordinal=index, page=1, source={}, transaction_id=row.id)
                for index, row in enumerate(selected)
            ])
            runs.append(run.id)
        await db.flush()
        await db.run_sync(lambda session: rebuild_bank_order(session.connection()))
        return [row.id for row in rows], runs

    return database(config, populate)


def test_filters_preserve_the_canonical_order_of_disconnected_observations(
    admin, disconnected_ledger,
):
    ids, _ = disconnected_ledger
    assert [row["id"] for row in admin.get("/api/transactions").json()["items"]] == [
        ids[0], ids[3], ids[1], ids[2],
    ]
    assert [row["id"] for row in admin.get("/api/transactions?q=selected").json()["items"]] == [
        ids[3], ids[2],
    ]
    assert admin.get("/api/summary").json()["balance"] is None


def test_statement_removal_refreshes_order_and_balance_in_the_same_commit(
    admin, config, disconnected_ledger,
):
    ids, runs = disconnected_ledger
    impact = admin.get(f"/api/admin/statements/{runs[0]}/removal").json()
    response = admin.request(
        "DELETE", f"/api/admin/statements/{runs[0]}", json={"revision": impact["revision"]},
    )
    assert response.status_code == 204, response.text
    assert [row["id"] for row in admin.get("/api/transactions").json()["items"]] == [ids[3]]
    assert admin.get("/api/summary").json()["balance"] == "73.00"

    async def index_rows(db):
        return list(await db.scalars(select(TransactionOrder.transaction_id)))

    assert database(config, index_rows) == [ids[3]]


def test_conflicting_evidence_rolls_back_without_replacing_the_order(
    admin, config, disconnected_ledger,
):
    ids, _ = disconnected_ledger
    before = admin.get("/api/transactions").json()

    async def contradiction(db):
        run = ImportRun(
            id=str(uuid4()), filename="conflict.pdf", file_hash="c" * 64,
            start_date=date(2026, 1, 1), end_date=date(2026, 1, 1),
            opening_balance=Decimal("80.00"), closing_balance=Decimal("70.00"),
            inserted=0, duplicates=2,
        )
        db.add(run)
        await db.flush()
        db.add_all([
            ImportRow(import_id=run.id, ordinal=index, page=1, source={}, transaction_id=key)
            for index, key in enumerate([ids[1], ids[0]])
        ])
        await db.flush()
        await db.run_sync(lambda session: rebuild_bank_order(session.connection()))

    with pytest.raises(AppError, match="conflicting_order"):
        database(config, contradiction)
    assert admin.get("/api/transactions").json() == before
    assert len(admin.get("/api/admin/statements").json()) == 2
