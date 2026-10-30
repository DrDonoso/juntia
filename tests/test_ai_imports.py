import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from openai import BadRequestError
from pydantic import SecretStr

from juntia import ai
from juntia.contracts import CatalogOut
from juntia.errors import AppError
from tests.support import ROWS, iban, statement_pdf
from tests.test_api import commit, preview


@pytest.mark.asyncio
async def test_json_mode_keyword_is_in_user_input_when_gateway_separates_system(
    config, monkeypatch
):
    config.openai_api_key = SecretStr("synthetic-test-key")
    config.openai_model = "synthetic-model"
    client = AsyncMock()
    client.__aenter__.return_value = client

    async def respond(**kwargs):
        forwarded_input = [
            message["content"] for message in kwargs["messages"] if message["role"] != "system"
        ]
        if not any("json" in text.lower() for text in forwarded_input):
            raise BadRequestError(
                "Response input messages must contain the word 'json' for JSON object mode.",
                response=httpx.Response(
                    400,
                    request=httpx.Request("POST", "https://provider.invalid/v1/chat/completions"),
                ),
                body={"param": "input"},
            )
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=(
                            '{"rows":[{"ordinal":0,"category_id":1,"merchant":"Synthetic cleaner","tags":[1]}]}'
                        )
                    )
                )
            ]
        )

    client.chat.completions.create = AsyncMock(side_effect=respond)
    monkeypatch.setattr(ai, "AsyncOpenAI", lambda **kwargs: client)
    result = await ai.classify(
        config,
        [ai.AIText(ordinal=0, text="Synthetic monthly cleaning invoice")],
        [CatalogOut(id=1, name="Cleaning")],
        [CatalogOut(id=1, name="Recurring")],
    )
    assert result.rows[0].category_id == 1
    request = client.chat.completions.create.call_args.kwargs
    assert request["response_format"] == {"type": "json_object"}
    assert request["model"] == config.openai_model
    assert len(request["messages"]) == 2
    user_input = request["messages"][1]["content"]
    payload = json.loads(user_input[user_input.index("{") :])
    assert payload["movements"] == [
        {"ordinal": 0, "description": "Synthetic monthly cleaning invoice"}
    ]
    assert set(payload) == {"movements", "categories", "tags"}


@pytest.fixture
def fake_provider(config, monkeypatch):
    config.openai_api_key = SecretStr("synthetic-test-key")
    config.openai_model = "synthetic-model"
    calls = []

    async def classify(settings, texts, categories, tags):
        calls.append(texts)
        return ai.Proposals(
            rows=[
                ai.AIPick(
                    ordinal=item.ordinal, category_id=5, merchant="Synthetic provider", tags=[1]
                )
                for item in texts
            ]
        )

    monkeypatch.setattr(ai, "classify", classify)
    return calls


def enrich(client, value, exclude=()):
    return client.post(
        f"/api/admin/imports/{value['id']}/ai",
        json={"version": value["version"], "exclude_ordinals": list(exclude)},
    )


def test_ai_requires_account_confirmation_and_uses_server_text(admin, fake_provider):
    value = admin.post(
        "/api/admin/imports/preview",
        files={"file": ("statement.pdf", statement_pdf(), "application/pdf")},
    ).json()
    assert value["ai_enabled"] and not value["ai_in_progress"]
    assert enrich(admin, value).json()["code"] == "account_confirmation_required"
    assert fake_provider == []
    confirmed = admin.post(
        f"/api/admin/imports/{value['id']}/account",
        json={
            "version": value["version"],
            "iban": value["iban"],
        },
    ).json()
    assert admin.get("/api/account").json() is None
    response = enrich(admin, confirmed)
    assert response.status_code == 200, response.text
    result = response.json()
    assert [text.text for text in fake_provider[0]] == [row[2] for row in ROWS]
    assert all(row["ai_reviewed"] and row["category_id"] == 5 for row in result["rows"])
    assert admin.get("/api/transactions").json()["total"] == 0
    assert not result["ai_in_progress"]
    assert enrich(admin, result).json()["version"] == result["version"]
    assert len(fake_provider) == 1
    assert enrich(admin, confirmed).json()["code"] == "preview_stale"
    assert len(fake_provider) == 1
    tampered = admin.post(
        f"/api/admin/imports/{result['id']}/ai",
        json={
            "version": result["version"],
            "texts": [{"ordinal": 0, "text": "Injected payload"}],
        },
    )
    assert tampered.status_code == 422


def test_ai_batches_every_eligible_row_beyond_thirty(admin, fake_provider):
    chronological = [
        (
            (date(2026, 7, 1) + timedelta(days=index)).strftime("%d/%m/%y"),
            (date(2026, 7, 1) + timedelta(days=index)).strftime("%d/%m/%y"),
            f"Synthetic contribution {index}",
            "10.00",
            f"{(index + 1) * 10}.00",
        )
        for index in range(65)
    ]
    rows = list(reversed(chronological))
    value = preview(admin, statement_pdf(pages=[rows[:30], rows[30:60], rows[60:]]))
    for expected in (30, 60, 65):
        response = enrich(admin, value)
        assert response.status_code == 200, response.text
        value = response.json()
        assert sum(row["ai_reviewed"] for row in value["rows"]) == expected
    assert [len(batch) for batch in fake_provider] == [30, 30, 5]
    assert len({row.ordinal for batch in fake_provider for row in batch}) == 65
    assert commit(admin, value).status_code == 200


def test_ai_skips_duplicates_rules_and_manual_exclusions(admin, fake_provider):
    assert commit(admin, preview(admin, statement_pdf(rows=ROWS[-1:]))).status_code == 200
    rule = {"name": "Cleaning", "description_value": "Cleaning", "set_category": 5, "skip_ai": True}
    assert admin.post("/api/admin/rules", json=rule).status_code == 201
    value = preview(admin)
    assert [row["status"] for row in value["rows"]] == ["new", "new", "duplicate"]
    assert enrich(admin, value, exclude=[1]).status_code == 200
    assert fake_provider == []
    response = enrich(admin, value)
    assert response.status_code == 200, response.text
    assert [[row.ordinal for row in batch] for batch in fake_provider] == [[1]]
    assert response.json()["rows"][0]["matched_rule"] == "Cleaning"


def test_ai_failure_is_recoverable_and_keeps_the_preview(admin, fake_provider, monkeypatch):
    successful = ai.classify
    value = preview(admin)

    async def fail(*args):
        raise AppError("ai_failed", 502)

    monkeypatch.setattr(ai, "classify", fail)
    assert enrich(admin, value).status_code == 502
    latest = admin.get(f"/api/admin/imports/{value['id']}").json()
    assert not latest["ai_in_progress"]
    assert latest["version"] == value["version"]
    assert not any(row["ai_reviewed"] for row in latest["rows"])
    assert admin.get("/api/transactions").json()["total"] == 0
    monkeypatch.setattr(ai, "classify", successful)
    response = enrich(admin, latest)
    assert response.status_code == 200
    assert len(fake_provider) == 1


def test_ai_never_receives_the_pdf_account_or_financial_fields(admin, fake_provider):
    rows = list(ROWS)
    first = rows[0]
    description = f"Receipt {iban()} person@example.invalid https://example.invalid/secret"
    rows[0] = (first[0], first[1], description, first[3], first[4])
    value = preview(admin, statement_pdf(rows=rows))
    response = enrich(admin, value)
    assert response.status_code == 200, response.text
    sent = [item.model_dump() for item in fake_provider[0]]
    assert all(set(item) == {"ordinal", "text"} for item in sent)
    assert iban() not in json.dumps(sent)
    assert "person@example.invalid" not in json.dumps(sent)
    assert "https://example.invalid" not in json.dumps(sent)


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Real PostgreSQL lease")
def test_parallel_ai_requests_do_not_double_bill_or_allow_confirmation(
    admin, fake_provider, monkeypatch
):
    entered, finish = Event(), Event()
    previous = ai.classify
    value = preview(admin)

    async def wait_for_provider(*args):
        entered.set()
        await asyncio.to_thread(finish.wait, 10)
        return await previous(*args)

    monkeypatch.setattr(ai, "classify", wait_for_provider)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(enrich, admin, value)
        try:
            assert entered.wait(10)
            assert admin.get(f"/api/admin/imports/{value['id']}").json()["ai_in_progress"]
            assert enrich(admin, value).json()["code"] == "ai_in_progress"
            assert commit(admin, value).json()["code"] == "ai_in_progress"
        finally:
            finish.set()
        assert pending.result(timeout=15).status_code == 200
    assert len(fake_provider) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["unknown_category", "unknown_tag", "repeated_ordinal"])
async def test_provider_output_is_validated_without_network(config, monkeypatch, invalid):
    config.openai_api_key = SecretStr("synthetic-test-key")
    config.openai_model = "synthetic-model"
    picks = [{"ordinal": 0, "category_id": 1, "tags": [], "merchant": ""}]
    if invalid == "unknown_category":
        picks[0]["category_id"] = 999
    elif invalid == "unknown_tag":
        picks[0]["tags"] = [999]
    else:
        picks.append(picks[0].copy())

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def create(self, **kwargs):
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=json.dumps({"rows": picks}),
                        )
                    )
                ]
            )

    monkeypatch.setattr(ai, "AsyncOpenAI", FakeClient)
    with pytest.raises(AppError, match="ai_invalid_output"):
        await ai.classify(
            config,
            [ai.AIText(ordinal=0, text="Synthetic receipt")],
            [CatalogOut(id=1, name="Cleaning")],
            [],
        )


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Real PostgreSQL lease")
def test_provider_response_cannot_overwrite_a_stale_preview(admin, fake_provider, monkeypatch):
    entered, finish = Event(), Event()
    previous = ai.classify
    value = preview(admin)

    async def wait_for_provider(*args):
        entered.set()
        await asyncio.to_thread(finish.wait, 10)
        return await previous(*args)

    monkeypatch.setattr(ai, "classify", wait_for_provider)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(enrich, admin, value)
        try:
            assert entered.wait(10)
            changed = admin.post("/api/admin/catalog/tags", json={"name": "Changed during AI"})
            assert changed.status_code == 201
            assert not pending.done()
        finally:
            finish.set()
        response = pending.result(timeout=15)
    assert response.status_code == 409 and response.json()["code"] == "preview_stale"
    current = admin.get(f"/api/admin/imports/{value['id']}").json()
    assert not current["ai_in_progress"]
    assert not any(row["ai_reviewed"] for row in current["rows"])
    assert len(fake_provider) == 1
