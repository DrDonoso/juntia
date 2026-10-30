import asyncio
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine

from juntia.db import ImportRun
from tests.test_api import commit, preview


def edit(client, row, **changes):
    response = client.patch(
        f"/api/admin/transactions/{row['id']}",
        json={
            "version": row["version"],
            "category_id": row["category_id"],
            "merchant": row["merchant"],
            "tags": row["tags"],
            **changes,
        },
    )
    assert response.status_code == 200, response.text


def test_drilldown_keys_and_filters_select_only_matching_expenses(admin):
    assert commit(admin, preview(admin)).status_code == 200
    rows = admin.get("/api/transactions").json()["items"]
    edit(admin, rows[0], category_id=5, merchant="Acme", tags=[1, 2])
    edit(admin, rows[1], merchant="Acme Express", tags=[1])
    edit(admin, rows[2], category_id=5, merchant="Acme", tags=[1, 2])
    summary = admin.get("/api/summary").json()
    assert {item["category_id"]: item["amount"] for item in summary["categories"]} == {
        None: "30.00",
        5: "20.00",
    }
    assert {item["merchant"]: item["amount"] for item in summary["merchants"]} == {
        "Acme": "20.00",
        "Acme Express": "30.00",
    }
    exact = admin.get(
        "/api/transactions",
        params=[
            ("start", "2026-01-01"),
            ("end", "2026-12-31"),
            ("q", "cleaning"),
            ("category", "5"),
            ("merchant", "Ac"),
            ("merchant_exact", "Acme"),
            ("tag", "1"),
            ("tag", "2"),
            ("flow", "expense"),
            ("minimum", "-21"),
            ("maximum", "-19"),
        ],
    ).json()
    assert exact["total"] == 1 and exact["items"][0]["id"] == rows[0]["id"]
    unassigned = admin.get("/api/transactions?uncategorized=true&flow=expense").json()
    assert unassigned["total"] == 1 and unassigned["items"][0]["id"] == rows[1]["id"]
    assert admin.get("/api/summary?merchant_exact=Acme&flow=expense").json()["expense"] == "20.00"


def test_missing_merchant_is_distinct_from_a_provider_named_like_the_placeholder(admin):
    assert commit(admin, preview(admin)).status_code == 200
    rows = admin.get("/api/transactions").json()["items"]
    edit(admin, rows[0], merchant="No merchant")
    summary = admin.get("/api/summary").json()
    assert {row["merchant"] for row in summary["merchants"]} == {"", "No merchant"}
    assert {row["name"] for row in summary["merchants"]} == {"No merchant"}
    missing = admin.get("/api/transactions?merchant_exact=&flow=expense").json()
    assert missing["total"] == 1 and missing["items"][0]["id"] == rows[1]["id"]
    named = admin.get(
        "/api/transactions", params={"merchant_exact": "No merchant", "flow": "expense"}
    ).json()
    assert named["total"] == 1 and named["items"][0]["id"] == rows[0]["id"]


def test_last_data_date_is_global_booking_date_not_upload_timestamp(admin, config):
    record = commit(admin, preview(admin)).json()

    async def move_upload_timestamp():
        engine = create_async_engine(config.database_url)
        async with engine.begin() as connection:
            await connection.execute(
                update(ImportRun)
                .where(ImportRun.id == record["id"])
                .values(
                    created_at=datetime(2040, 1, 1, tzinfo=timezone.utc),
                )
            )
        await engine.dispose()

    asyncio.run(move_upload_timestamp())
    result = admin.get("/api/summary?start=2025-01-01&end=2025-12-31").json()
    assert result["count"] == 0
    assert result["coverage_end"] == "2026-10-02"
    assert result["coverage_start"] == "2026-09-30"
    assert result["balance_date"] == "2026-10-02"
