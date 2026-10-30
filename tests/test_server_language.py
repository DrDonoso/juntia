import asyncio
import os
import secrets
import string
import subprocess
import sys
from dataclasses import fields
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia.bootstrap import CATEGORY_COLORS, seed
from juntia.config import LanguageSettings, Settings
from juntia.db import Category, State, Tag
from juntia.texts import TEXTS, Texts
from tests.test_api import commit, preview
from tests.test_users import database

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "en": {
        "community": "Residential community",
        "account": "Community account",
        "categories": [
            "Regular fees", "Special assessments", "Water", "Electricity", "Cleaning",
            "Maintenance", "Repairs", "Administration", "Insurance", "Professional services",
            "Taxes", "Bank fees", "Other",
        ],
        "tags": ["Recurring", "Extraordinary", "Refund", "Transfer", "Direct debit", "Review"],
        "uncategorized": "Uncategorized",
        "no_merchant": "No merchant",
        "description": "Community finances, actions and events.",
    },
    "es": {
        "community": "Comunidad de vecinos",
        "account": "Cuenta de la comunidad",
        "categories": [
            "Cuotas ordinarias", "Derramas", "Agua", "Electricidad", "Limpieza",
            "Mantenimiento", "Reparaciones", "Administración", "Seguros",
            "Servicios profesionales", "Impuestos", "Comisiones bancarias", "Otros",
        ],
        "tags": [
            "Recurrente", "Extraordinario", "Devolución", "Transferencia", "Recibo", "Revisión",
        ],
        "uncategorized": "Sin categoría",
        "no_merchant": "Sin proveedor",
        "description": "Finanzas y actuaciones de la comunidad.",
    },
}


@pytest.fixture
def values(monkeypatch):
    monkeypatch.delenv("APP_LANGUAGE", raising=False)
    return {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "admin_username": "admin",
        "admin_password": "admin",
        "allow_insecure_local_admin": True,
        "auth_secret": secrets.token_urlsafe(32),
        "public_origin": "http://localhost:7778",
        "auth_cookie_secure": False,
    }


def test_app_language_defaults_to_english(values):
    assert Settings(_env_file=None, **values).app_language == "en"
    assert LanguageSettings(_env_file=None).app_language == "en"


@pytest.mark.parametrize("from_environment", [False, True])
@pytest.mark.parametrize(("configured", "expected"), [
    ("en", "en"), ("es", "es"), ("ES", "es"), (" En ", "en"), ("", "en"),
])
def test_app_language_accepts_case_insensitive_values(
    values, monkeypatch, from_environment, configured, expected,
):
    if from_environment:
        monkeypatch.setenv("APP_LANGUAGE", configured)
        assert LanguageSettings(_env_file=None).app_language == expected
    else:
        values["app_language"] = configured
    assert Settings(_env_file=None, **values).app_language == expected


@pytest.mark.parametrize("invalid", ["fr", "es-ES", "en_GB", "spanish", "e s", "1"])
def test_unknown_app_language_fails_at_startup(values, monkeypatch, invalid):
    with pytest.raises(ValidationError, match="APP_LANGUAGE must be en or es"):
        Settings(_env_file=None, **{**values, "app_language": invalid})
    monkeypatch.setenv("APP_LANGUAGE", invalid)
    with pytest.raises(ValidationError, match="APP_LANGUAGE must be en or es"):
        LanguageSettings(_env_file=None)


def test_every_text_exists_in_both_languages_with_the_same_placeholders():
    def placeholders(value):
        return sorted(name for _, name, _, _ in string.Formatter().parse(value) if name)

    english, spanish = TEXTS["en"], TEXTS["es"]
    assert set(TEXTS) == {"en", "es"}
    for field in fields(Texts):
        first, second = getattr(english, field.name), getattr(spanish, field.name)
        if isinstance(first, tuple):
            assert len(first) == len(second) and all(first) and all(second), field.name
            assert len(set(first)) == len(first) and len(set(second)) == len(second), field.name
        else:
            assert first and second and first != second, field.name
            assert placeholders(first) == placeholders(second), field.name
    assert len(CATEGORY_COLORS) == len(english.categories)


@pytest.mark.parametrize("language", ["en", "es"])
def test_first_run_seeds_use_the_configured_language(admin, language):
    expected = DEFAULTS[language]
    categories = sorted(admin.get("/api/catalog/categories").json(), key=lambda row: row["id"])
    assert [row["name"] for row in categories] == expected["categories"]
    assert [row["color"] for row in categories] == list(CATEGORY_COLORS)
    tags = sorted(admin.get("/api/catalog/tags").json(), key=lambda row: row["id"])
    assert [row["name"] for row in tags] == expected["tags"]
    assert admin.get("/api/settings/general").json() == {"community_name": expected["community"]}


def test_seeding_never_translates_an_existing_installation(admin, config):
    assert admin.patch("/api/admin/settings/general", json={
        "community_name": "Park Avenue 12",
    }).status_code == 200
    before = (
        admin.get("/api/catalog/categories").json(), admin.get("/api/catalog/tags").json(),
    )
    database(config, lambda db: seed(db, "es"))
    assert admin.get("/api/settings/general").json() == {"community_name": "Park Avenue 12"}
    assert (
        admin.get("/api/catalog/categories").json(), admin.get("/api/catalog/tags").json(),
    ) == before


def test_seed_script_reads_app_language_and_rejects_unknown_values(tmp_path):
    url = "sqlite+aiosqlite:///" + str(tmp_path / "fresh.db")
    environment = {key: value for key, value in os.environ.items() if key != "APP_LANGUAGE"}
    environment["DATABASE_URL"] = url
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=environment, cwd=ROOT, check=True, capture_output=True,
    )

    def seed_script(language):
        # Another working directory keeps a developer's .env out of the test.
        return subprocess.run(
            [sys.executable, str(ROOT / "seed.py")], env={**environment, "APP_LANGUAGE": language},
            cwd=tmp_path, capture_output=True, text=True,
        )

    async def installation():
        engine = create_async_engine(url)
        async with async_sessionmaker(engine)() as db:
            state = await db.get(State, 1)
            categories = (await db.scalars(select(Category.name).order_by(Category.id))).all()
            tags = await db.scalar(select(func.count()).select_from(Tag))
        await engine.dispose()
        return state.community_name if state else None, list(categories), tags

    rejected = seed_script("fr")
    assert rejected.returncode != 0
    assert "APP_LANGUAGE must be en or es" in rejected.stderr
    assert asyncio.run(installation()) == (None, [], 0)
    assert seed_script(" ES ").returncode == 0
    assert asyncio.run(installation()) == (
        DEFAULTS["es"]["community"], DEFAULTS["es"]["categories"], 6,
    )


@pytest.mark.parametrize("language", ["en", "es"])
def test_summary_fallbacks_and_first_account_name_use_the_configured_language(admin, language):
    expected = DEFAULTS[language]
    assert commit(admin, preview(admin)).status_code == 200
    assert admin.get("/api/account").json()["name"] == expected["account"]
    summary = admin.get("/api/summary").json()
    assert [(row["category_id"], row["name"]) for row in summary["categories"]] == [
        (None, expected["uncategorized"]),
    ]
    assert [(row["merchant"], row["name"]) for row in summary["merchants"]] == [
        ("", expected["no_merchant"]),
    ]


@pytest.mark.parametrize("language", ["en", "es"])
def test_web_manifest_uses_the_configured_language(client, language):
    manifest = client.get("/manifest.webmanifest").json()
    assert manifest["lang"] == language
    assert manifest["description"] == DEFAULTS[language]["description"]
    assert manifest["name"] == DEFAULTS[language]["community"]
