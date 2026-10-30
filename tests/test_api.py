import asyncio
import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia import ai, imports
from juntia.contracts import ConfirmIn
from juntia.errors import AppError
from juntia.identity import digest
from tests.support import ROWS, iban, statement_pdf


def preview(client, content=None, filename="statement.pdf"):
    response = client.post(
        "/api/admin/imports/preview",
        files={"file": (filename, content or statement_pdf(), "application/pdf")},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    if not result["account_confirmed"]:
        response = client.post(
            f"/api/admin/imports/{result['id']}/account",
            json={"iban": result["iban"], "version": result["version"]},
        )
        assert response.status_code == 200, response.text
        result = response.json()
    return result


def commit(client, value, decisions=None):
    return client.post(
        f"/api/admin/imports/{value['id']}/confirm",
        json={
            "version": value["version"],
            "decisions": decisions or [],
        },
    )


def test_reader_and_admin_security(client, config):
    assert client.get("/api/summary").status_code == 401
    assert client.get("/api/transactions").status_code == 401
    assert client.post("/api/admin/rules", json={}).status_code == 401
    assert client.post("/api/auth/setup", json={}).status_code in {404, 405}
    response = client.post(
        "/api/admin/auth/login",
        json={
            "username": "admin",
            "password": config.admin_password.get_secret_value(),
        },
        headers={"origin": "https://attacker.invalid"},
    )
    assert response.status_code == 403
    for _ in range(10):
        assert (
            client.post(
                "/api/admin/auth/login", json={"username": "admin", "password": "bad"}
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/admin/auth/login", json={"username": "admin", "password": "bad"}
        ).status_code
        == 429
    )
    assert client.get("/api/summary").headers["x-frame-options"] == "DENY"


def test_account_confirmed_only_on_successful_commit(admin):
    value = admin.post(
        "/api/admin/imports/preview",
        files={"file": ("statement.pdf", statement_pdf(), "application/pdf")},
    ).json()
    assert admin.get("/api/account").json() is None
    assert commit(admin, value).json()["code"] == "account_confirmation_required"
    wrong = admin.post(
        f"/api/admin/imports/{value['id']}/account",
        json={"iban": iban("0000000002"), "version": value["version"]},
    )
    assert wrong.status_code == 409
    value = admin.post(
        f"/api/admin/imports/{value['id']}/account",
        json={"iban": value["iban"], "version": value["version"]},
    ).json()
    assert admin.get("/api/account").json() is None
    response = commit(admin, value)
    assert response.status_code == 200, response.text
    assert admin.get("/api/account").json()["iban"] == iban()
    bad = admin.post(
        "/api/admin/imports/preview",
        files={"file": ("other.pdf", statement_pdf(account=iban("0000000002")), "application/pdf")},
    )
    assert bad.status_code == 409 and bad.json()["code"] == "account_mismatch"
    assert admin.get("/api/transactions").json()["total"] == 3


@pytest.mark.parametrize("month_first", [True, False])
def test_overlap_retry_rename_enrichment_and_originals(admin, month_first):
    first = statement_pdf(rows=ROWS[:2]) if month_first else statement_pdf()
    second = statement_pdf() if month_first else statement_pdf(rows=ROWS[:2])
    initial = preview(admin, first)
    saved = commit(admin, initial).json()
    assert commit(admin, initial).json()["id"] == saved["id"]
    assert commit(admin, preview(admin, second)).status_code == 200
    assert admin.get("/api/transactions").json()["total"] == 3
    row = admin.get("/api/transactions").json()["items"][0]
    assert (
        admin.patch(
            f"/api/admin/transactions/{row['id']}",
            json={
                "version": row["version"],
                "category_id": 2,
                "tags": [1],
                "merchant": "Manual merchant",
            },
        ).status_code
        == 200
    )
    assert (
        admin.patch("/api/admin/account", json={"name": "Renamed community account"}).status_code
        == 200
    )
    reprint = preview(admin, statement_pdf(shifted=False), filename="renamed.pdf")
    assert all(item["status"] == "duplicate" for item in reprint["rows"])
    assert commit(admin, reprint).status_code == 200
    rows = admin.get("/api/transactions").json()
    assert rows["total"] == 3 and rows["items"][0]["merchant"] == "Manual merchant"
    assert admin.get(f"/api/admin/statements/{saved['id']}/original").content == first
    impact = admin.get(f"/api/admin/statements/{saved['id']}/removal").json()
    assert impact["removed_transactions"] == 0
    assert (
        admin.request(
            "DELETE", f"/api/admin/statements/{saved['id']}", json={"revision": impact["revision"]}
        ).status_code
        == 204
    )
    assert admin.get("/api/transactions").json()["total"] == 3


def test_stale_preview_and_immutable_financial_fields(admin):
    value = preview(admin)
    admin.post("/api/admin/catalog/tags", json={"name": "New tag", "color": "#123456"})
    assert commit(admin, value).json()["code"] == "preview_stale"
    current = preview(admin)
    malicious = admin.post(
        f"/api/admin/imports/{current['id']}/confirm",
        json={
            "version": current["version"],
            "decisions": [{"ordinal": 0, "amount": "99999"}],
        },
    )
    assert malicious.status_code == 422
    assert admin.get("/api/transactions").json()["total"] == 0
    assert commit(admin, current).status_code == 200
    row = admin.get("/api/transactions").json()["items"][0]
    assert (
        admin.patch(
            f"/api/admin/transactions/{row['id']}",
            json={
                "version": row["version"],
                "amount": "100",
            },
        ).status_code
        == 422
    )


def test_totals_filters_and_bank_order(admin):
    rows = [
        ("02/10/26", "02/10/26", "Repeated payment", "-20", "160"),
        ("02/10/26", "02/10/26", "Repeated payment", "-20", "180"),
        ("30/09/26", "30/09/26", "Credit", "200", "200"),
    ]
    assert commit(admin, preview(admin, statement_pdf(rows=rows))).status_code == 200
    listed = admin.get("/api/transactions").json()["items"]
    assert [row["balance_after"] for row in listed] == ["160.00", "180.00", "200.00"]
    total = admin.get("/api/summary").json()
    assert total["income"] == "200.00" and total["expense"] == "40.00"
    assert total["balance"] == "160.00"
    filtered = admin.get("/api/summary?start=2026-10-01&end=2026-10-31").json()
    assert filtered["income"] == "0.00" and filtered["balance"] == "160.00"
    assert admin.get("/api/transactions?flow=expense&q=repeated").json()["total"] == 2


def test_ambiguous_complete_identity_is_reviewed(admin):
    rows = [
        ("02/10/26", "02/10/26", "Repeated", "-20", "100"),
        ("02/10/26", "02/10/26", "Reversal", "20", "120"),
        ("02/10/26", "02/10/26", "Repeated", "-20", "100"),
    ]
    value = preview(admin, statement_pdf(rows=rows))
    assert [r["status"] for r in value["rows"]] == ["review", "new", "review"]
    assert commit(admin, value).json()["code"] == "review_required"
    assert admin.get("/api/account").json() is None
    response = commit(
        admin, value, [{"ordinal": 0, "create_new": True}, {"ordinal": 2, "create_new": True}]
    )
    assert response.status_code == 200, response.text
    assert admin.get("/api/transactions").json()["total"] == 3
    repeat = preview(admin, statement_pdf(rows=rows))
    assert all(row["status"] == "duplicate" for row in repeat["rows"])
    replay = commit(admin, repeat).json()
    assert replay["inserted"] == 0 and replay["duplicates"] == 3


def test_rules_optional_ai_and_manual_precedence(admin, config, monkeypatch):
    rule = {
        "name": "Electricity",
        "description_value": "electricity",
        "set_category": 4,
        "add_tags": [1],
        "skip_ai": False,
    }
    assert admin.post("/api/admin/rules", json=rule).status_code == 201
    value = preview(admin)
    assert value["rows"][1]["category_id"] == 4

    async def fake_classify(config, texts, categories, tags):
        assert all(iban() not in item.text for item in texts)
        return ai.Proposals(
            rows=[ai.AIPick(ordinal=item.ordinal, category_id=1, tags=[]) for item in texts]
        )

    monkeypatch.setattr(ai, "classify", fake_classify)
    config.openai_api_key = SecretStr("synthetic-test-key")
    config.openai_model = "synthetic-model"
    enriched = admin.post(
        f"/api/admin/imports/{value['id']}/ai",
        json={
            "version": value["version"],
            "exclude_ordinals": [0, 2],
        },
    )
    assert enriched.status_code == 200, enriched.text
    value = enriched.json()
    assert value["rows"][1]["category_id"] == 4
    response = commit(
        admin,
        value,
        [
            {
                "ordinal": 1,
                "enrichment": {
                    "category_id": 3,
                    "tags": [2],
                    "merchant": "Manual provider",
                },
            }
        ],
    )
    assert response.status_code == 200, response.text
    row = admin.get("/api/transactions?q=electricity").json()["items"][0]
    assert row["category_id"] == 3 and row["classification_source"] == "manual"
    impact = admin.post("/api/admin/rules/preview", json=rule).json()
    assert impact["count"] == 1
    applied = admin.post(
        "/api/admin/rules/apply", json={"revision": impact["revision"], "rule": rule}
    )
    assert applied.status_code == 200
    assert admin.get("/api/transactions?q=electricity").json()["items"][0]["category_id"] == 4


def test_logout_revokes_copied_cookie_and_preview(admin):
    cookie = admin.cookies.get("juntia_admin")
    value = preview(admin)
    assert admin.post("/api/admin/auth/logout").status_code == 204
    admin.cookies.set("juntia_admin", cookie, domain="testserver.local", path="/api/admin")
    assert admin.get("/api/admin/rules").status_code == 401
    assert commit(admin, value).status_code == 401


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Real PostgreSQL concurrency")
def test_concurrent_first_accounts_cannot_both_commit(admin, config):
    first = preview(admin)
    second = preview(admin, statement_pdf(account=iban("0000000002")))
    owner = digest(admin.cookies.get("juntia_admin"))

    async def execute(value):
        engine = create_async_engine(config.database_url)
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                try:
                    await imports.confirm(
                        db, owner, value["id"], ConfirmIn(version=value["version"]),
                        language=config.app_language,
                    )
                    return "ok"
                except AppError as error:
                    return error.code
        finally:
            await engine.dispose()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda value: asyncio.run(execute(value)), [first, second]))
    assert results.count("ok") == 1
    assert "account_mismatch" in results
    assert admin.get("/api/transactions").json()["total"] == 3
