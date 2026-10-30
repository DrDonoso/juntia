import asyncio
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from juntia.app import create_app
from tests.test_api import commit, preview


def test_general_settings_require_admin_but_name_is_reader_safe(client):
    assert client.get("/api/settings/general").json() == {"community_name": "Residential community"}
    assert (
        client.patch(
            "/api/admin/settings/general", json={"community_name": "Unauthorized"}
        ).status_code
        == 401
    )


def test_community_name_persists_and_does_not_invalidate_imports(admin, config):
    staged = preview(admin)
    assert admin.patch(
        "/api/admin/settings/general",
        json={
            "community_name": "  Comunidad  del Parque  ",
        },
    ).json() == {"community_name": "Comunidad del Parque"}
    assert commit(admin, staged).status_code == 200
    before = admin.get("/api/summary").json()
    with TestClient(create_app(config)) as restarted:
        assert (
            restarted.get("/api/settings/general").json()["community_name"]
            == "Comunidad del Parque"
        )
        manifest = restarted.get("/manifest.webmanifest")
        assert manifest.headers["content-type"].startswith("application/manifest+json")
        assert manifest.json()["name"] == "Comunidad del Parque"
        assert manifest.json()["start_url"] == "/"
        assert {icon["purpose"] for icon in manifest.json()["icons"]} == {"any", "maskable"}
        assert restarted.get("/api/summary").status_code == 401
        restarted.post("/api/admin/auth/login", json={
            "username": config.admin_username,
            "password": config.admin_password.get_secret_value(),
        }, headers={"origin": config.public_origin, "x-juntia-request": "1"})
        assert restarted.get("/api/summary").json() == before


@pytest.mark.parametrize("name", ["", "   ", "x" * 151, "Name\x00"])
def test_invalid_community_names_do_not_replace_saved_name(admin, name):
    assert (
        admin.patch("/api/admin/settings/general", json={"community_name": name}).status_code == 422
    )
    assert admin.get("/api/settings/general").json()["community_name"] == "Residential community"


def test_pdfs_and_statement_metadata_are_administrator_only(admin, config):
    record = commit(admin, preview(admin)).json()
    path = f"/api/admin/statements/{record['id']}/original"
    assert admin.get(path).status_code == 200
    assert len(admin.get("/api/admin/statements").json()) == 1
    with TestClient(create_app(config)) as reader:
        assert reader.get("/api/admin/statements").status_code == 401
        assert reader.get(path).status_code == 401
        assert reader.get("/api/statements").status_code == 404
        assert reader.get(f"/api/statements/{record['id']}/original").status_code == 404
        assert reader.get("/statements").status_code == 404
        assert reader.get("/analytics").status_code == 404
        assert reader.get("/api/transactions").status_code == 401


def test_community_migration_backfills_and_preserves_existing_state(config):
    env = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0001"],
        env=env,
        check=True,
        capture_output=True,
    )

    async def inspect(update=False):
        engine = create_async_engine(config.database_url)
        async with engine.begin() as connection:
            if update:
                await connection.execute(text("UPDATE state SET revision=27 WHERE id=1"))
                result = None
            else:
                result = (
                    await connection.execute(
                        text("SELECT revision, community_name FROM state WHERE id=1")
                    )
                ).one()
        await engine.dispose()
        return result

    asyncio.run(inspect(update=True))
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=env,
        check=True,
        capture_output=True,
    )
    # The backfill is migration 0002's server default, which predates APP_LANGUAGE.
    assert tuple(asyncio.run(inspect())) == (27, "Comunidad de vecinos")
