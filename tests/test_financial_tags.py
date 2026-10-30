from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from pydantic import ValidationError

from juntia.contracts import EnrichmentIn
from tests.support import statement_pdf
from tests.test_api import commit, preview


def test_transaction_tags_reuse_names_and_colors_without_sharing_contact_tags(admin):
    assert commit(admin, preview(admin)).status_code == 200
    rows = admin.get("/api/transactions").json()["items"]
    original = rows[0]
    existing = admin.get("/api/catalog/tags").json()[0]
    contact_tag = admin.post("/api/contact-tags", json={
        "name": "fam", "color": "#ffffff",
    }).json()
    response = admin.patch(f"/api/admin/transactions/{original['id']}", json={
        "version": original["version"], "category_id": original["category_id"],
        "merchant": "Manual provider", "tags": [existing["id"]],
        "new_tags": [{"name": "fam", "color": "#2bccb4"}],
    })
    assert response.status_code == 200, response.text
    saved = response.json()
    label = next(tag for tag in admin.get("/api/catalog/tags").json() if tag["name"] == "fam")
    assert saved["tags"] == sorted([existing["id"], label["id"]])
    assert saved["merchant"] == "Manual provider"
    assert saved["classification_source"] == "manual"
    assert saved["version"] == original["version"] + 1
    assert "new_tags" not in saved
    for field in ("booking_date", "value_date", "description", "amount", "balance_after"):
        assert saved[field] == original[field]

    second = admin.patch(f"/api/admin/transactions/{rows[1]['id']}", json={
        "version": rows[1]["version"],
        "new_tags": [{"name": "\uff26\uff21\uff2d", "color": "#ffffff"}],
    })
    assert second.status_code == 200, second.text
    assert second.json()["tags"] == [label["id"]]
    assert next(tag for tag in admin.get("/api/catalog/tags").json()
                if tag["id"] == label["id"]) == label
    assert label["color"] == "#2bccb4"
    assert admin.get("/api/contact-tags").json() == [contact_tag]
    assert admin.post("/api/admin/catalog/tags", json={
        "name": "\uff26\uff21\uff2d",
    }).status_code == 409

    cleared = admin.patch(f"/api/admin/transactions/{original['id']}", json={
        "version": saved["version"], "tags": [],
    })
    assert cleared.status_code == 200
    assert cleared.json()["tags"] == []
    assert any(tag["id"] == label["id"] for tag in admin.get("/api/catalog/tags").json())


@pytest.mark.parametrize("fields", [
    {"new_tags": [{"name": " "}]},
    {"new_tags": [{"name": "Bad\nname"}]},
    {"new_tags": [{"name": "\ufdfa" * 100}]},
    {"new_tags": [{"name": "Tag", "color": "red"}]},
    {"new_tags": [{"name": "fam"}, {"name": "\uff26\uff21\uff2d"}]},
    {"tags": list(range(1, 31)), "new_tags": [{"name": "One more"}]},
    {"new_tags": [{"name": str(index)} for index in range(31)]},
])
def test_new_financial_tag_validation(fields):
    with pytest.raises(ValidationError):
        EnrichmentIn.model_validate(fields)


def test_failed_transaction_updates_do_not_create_tags(admin):
    assert commit(admin, preview(admin)).status_code == 200
    original = admin.get("/api/transactions").json()["items"][0]
    before = admin.get("/api/catalog/tags").json()
    for fields, status in [
        ({"version": original["version"] + 1}, 409),
        ({"tags": [999999]}, 409),
        ({"category_id": 999999}, 409),
        ({"new_tags": [{"name": "Invalid", "color": "red"}]}, 422),
    ]:
        response = admin.patch(f"/api/admin/transactions/{original['id']}", json={
            "version": original["version"],
            "new_tags": [{"name": "Not saved", "color": "#2bccb4"}],
            **fields,
        })
        assert response.status_code == status, response.text
        assert admin.get("/api/catalog/tags").json() == before
        assert admin.get("/api/transactions").json()["items"][0] == original


def test_import_creates_tags_with_movements_and_retries_do_not_duplicate_them(admin):
    value = preview(admin)
    before = admin.get("/api/catalog/tags").json()
    decisions = [
        {"ordinal": 0, "enrichment": {
            "new_tags": [{"name": "fam", "color": "#2bccb4"}],
        }},
        {"ordinal": 1, "enrichment": {
            "new_tags": [{"name": "FAM", "color": "#ffffff"}],
        }},
    ]
    assert admin.get("/api/catalog/tags").json() == before
    response = commit(admin, value, decisions)
    assert response.status_code == 200, response.text
    assert commit(admin, value, decisions).json()["id"] == response.json()["id"]
    tags = admin.get("/api/catalog/tags").json()
    assert len(tags) == len(before) + 1
    assert tags[0]["name"] == "fam"
    assert tags[0]["color"] == "#2bccb4"
    rows = admin.get("/api/transactions").json()["items"]
    assert rows[0]["tags"] == rows[1]["tags"] == [tags[0]["id"]]
    assert rows[2]["tags"] == []


def test_failed_import_rolls_back_new_tags_with_the_movements(admin):
    value = preview(admin, statement_pdf(rows=[
        ("02/10/26", "02/10/26", "Repeated", "-20", "100"),
        ("02/10/26", "02/10/26", "Reversal", "20", "120"),
        ("02/10/26", "02/10/26", "Repeated", "-20", "100"),
    ]))
    before = admin.get("/api/catalog/tags").json()
    first = {"ordinal": 0, "create_new": True, "enrichment": {
        "new_tags": [{"name": "Only on success", "color": "#2bccb4"}],
    }}
    response = commit(admin, value, [first])
    assert response.status_code == 409
    assert response.json()["code"] == "review_required"
    assert admin.get("/api/catalog/tags").json() == before
    assert admin.get("/api/transactions").json()["total"] == 0
    assert admin.get("/api/account").json() is None
    assert commit(admin, value, [first, {"ordinal": 2, "create_new": True}]).status_code == 200
    assert len(admin.get("/api/catalog/tags").json()) == len(before) + 1


def test_tag_suggestions_follow_usage_and_keep_unused_tags(admin):
    rare, frequent, unused = [
        admin.post("/api/admin/catalog/tags", json={"name": name}).json()
        for name in ("AAA occasional", "ZZZ frequent", "MMM unused")
    ]
    assert commit(admin, preview(admin)).status_code == 200
    rows = admin.get("/api/transactions").json()["items"]
    for row, tags in zip(rows, [
        [rare["id"], frequent["id"]], [frequent["id"]], [frequent["id"]],
    ], strict=True):
        assert admin.patch(f"/api/admin/transactions/{row['id']}", json={
            "version": row["version"], "tags": tags,
        }).status_code == 200
    suggestions = admin.get("/api/catalog/tags").json()
    assert suggestions[:2] == [frequent, rare]
    assert unused in suggestions
    assert admin.get("/api/transactions", params={"tag": frequent["id"]}).json()["total"] == 3
    for row in admin.get("/api/transactions").json()["items"]:
        assert admin.patch(f"/api/admin/transactions/{row['id']}", json={
            "version": row["version"], "tags": [],
        }).status_code == 200
    assert admin.get("/api/catalog/tags").json()[0] == rare


def test_concurrent_inline_creations_reuse_one_financial_tag(admin):
    assert commit(admin, preview(admin)).status_code == 200
    rows = admin.get("/api/transactions").json()["items"]
    before = admin.get("/api/catalog/tags").json()
    ready = Barrier(2)

    def save(row, name, color):
        ready.wait(timeout=10)
        return admin.patch(f"/api/admin/transactions/{row['id']}", json={
            "version": row["version"], "new_tags": [{"name": name, "color": color}],
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(save, rows[0], "Shared", "#2bccb4")
        second = pool.submit(save, rows[1], "SHARED", "#ffffff")
        results = [first.result(), second.result()]
    assert all(result.status_code == 200 for result in results)
    tags = admin.get("/api/catalog/tags").json()
    assert len(tags) == len(before) + 1
    assert results[0].json()["tags"] == results[1].json()["tags"] == [tags[0]["id"]]
    assert tags[0]["color"] in {"#2bccb4", "#ffffff"}
