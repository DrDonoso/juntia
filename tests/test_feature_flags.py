import asyncio
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from juntia.config import Settings
from juntia.db import Dwelling, State
from tests.test_action_migration import migrate
from tests.test_api import commit, preview
from tests.test_users import (
    activate,
    current_user,
    database,
    dwelling,
    invite,
    login,
    visitor,
)
from tests.test_users import (
    mailbox as mailbox,
)


def set_flag(admin, feature, enabled):
    response = admin.patch(f"/api/admin/settings/features/{feature}", json={"enabled": enabled})
    assert response.status_code == 200, response.text
    assert response.json()[feature] is enabled
    return response.json()


def test_flags_default_to_enabled_and_environment_is_no_longer_used(
    admin, config, tmp_path, monkeypatch,
):
    assert admin.get("/api/features").json() == {
        "coefficient": True, "actions": True, "google_login": False, "events": False,
    }
    set_flag(admin, "actions", False)
    monkeypatch.setenv("FEATUREFLAG_COEFICIENTE", "false")
    monkeypatch.setenv("FEATUREFLAG_ACTUACIONES", "true")
    env_file = tmp_path / ".env"
    env_file.write_text(
        "FEATUREFLAG_COEFICIENTE=false\nFEATUREFLAG_ACTUACIONES=true\n", encoding="utf-8",
    )
    restarted_config = Settings(_env_file=env_file, **config.model_dump())
    assert "featureflag_coeficiente" not in Settings.model_fields
    assert "featureflag_actuaciones" not in Settings.model_fields
    with visitor(restarted_config) as restarted:
        assert restarted.get("/api/features").json() == {
            "coefficient": True, "actions": False, "google_login": False, "events": False,
        }


def test_flags_change_for_running_apps_and_persist_without_invalidating_imports(admin, config):
    staged = preview(admin)
    with visitor(config) as other_worker:
        assert other_worker.get("/api/features").json()["coefficient"] is True
        set_flag(admin, "coefficient", False)
        assert other_worker.get("/api/features").json()["coefficient"] is False
        assert set_flag(admin, "actions", False) == {
            "coefficient": False, "actions": False, "google_login": False, "events": False,
        }
        assert other_worker.get("/api/features").json() == admin.get("/api/features").json()
    with visitor(config) as restarted:
        assert restarted.get("/api/features").json() == {
            "coefficient": False, "actions": False, "google_login": False, "events": False,
        }
    assert admin.get("/api/auth/session").json()["authenticated"] is True
    assert commit(admin, staged).status_code == 200


def test_only_administrators_can_change_flags(admin, config, mailbox):
    _, token = invite(admin, mailbox)
    activate(admin, token)
    with visitor(config) as reader:
        response = reader.get("/api/features")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        for feature in ("coefficient", "actions", "events"):
            assert reader.patch(
                f"/api/admin/settings/features/{feature}", json={"enabled": False},
            ).status_code == 401
        assert login(reader).status_code == 200
        for feature in ("coefficient", "actions", "events"):
            assert reader.patch(
                f"/api/admin/settings/features/{feature}", json={"enabled": False},
            ).status_code == 401
    for headers in ({"origin": "https://other.invalid"}, {"x-juntia-request": ""}):
        assert admin.patch(
            "/api/admin/settings/features/actions", json={"enabled": False}, headers=headers,
        ).status_code == 403
    assert admin.get("/api/features").json() == {
        "coefficient": True, "actions": True, "google_login": False, "events": False,
    }


@pytest.mark.parametrize("body", [
    {}, {"enabled": None}, {"enabled": "false"}, {"enabled": 0}, {"enabled": 1},
    {"enabled": []}, {"enabled": False, "google_login": False},
])
def test_flag_updates_require_a_strict_boolean_and_reject_extra_fields(admin, body):
    response = admin.patch("/api/admin/settings/features/coefficient", json=body)
    assert response.status_code == 422
    assert response.json() == {"code": "invalid_request"}
    assert admin.get("/api/features").json()["coefficient"] is True


@pytest.mark.parametrize("feature", ["google_login", "unknown", "revision"])
def test_only_known_runtime_flags_can_be_changed(admin, feature):
    assert admin.patch(
        f"/api/admin/settings/features/{feature}", json={"enabled": False},
    ).status_code == 422


def test_independent_concurrent_flag_updates_do_not_overwrite_each_other(admin, config):
    barrier = threading.Barrier(2)
    with visitor(config) as other:
        other.cookies.update(admin.cookies)

        def change(client, feature):
            barrier.wait()
            return client.patch(
                f"/api/admin/settings/features/{feature}", json={"enabled": False},
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            coefficient = pool.submit(change, admin, "coefficient")
            actions = pool.submit(change, other, "actions")
            assert coefficient.result().status_code == 200
            assert actions.result().status_code == 200
    assert admin.get("/api/features").json() == {
        "coefficient": False, "actions": False, "google_login": False, "events": False,
    }


def admin_login(client, config):
    response = client.post("/api/admin/auth/login", json={
        "username": config.admin_username, "password": config.admin_password.get_secret_value(),
    })
    assert response.status_code == 200, response.text


def test_disabled_coefficients_are_hidden_without_erasing_existing_values(admin, config, mailbox):
    unit = dwelling(admin, coefficient="12.50")
    user, token = invite(admin, mailbox, dwelling_id=unit["id"])
    activate(admin, token)
    set_flag(admin, "coefficient", False)
    with visitor(config) as operator, visitor(config) as resident:
        assert operator.get("/api/features").json() == {
            "coefficient": False, "google_login": False, "actions": True, "events": False,
        }
        admin_login(operator, config)
        assert operator.get("/api/admin/dwellings").json()[0]["coefficient"] is None
        assert operator.get("/api/admin/users").json()[0]["coefficient"] is None
        assert login(resident).status_code == 200
        profile = resident.get("/api/auth/profile").json()
        assert profile["coefficient"] is None
        edited_profile = resident.patch("/api/auth/profile", json={
            "name": "Updated name", "version": profile["version"],
        })
        assert edited_profile.status_code == 200
        assert edited_profile.json()["coefficient"] is None
        current = current_user(operator, user["id"])
        edited_user = operator.patch(f"/api/admin/users/{user['id']}", json={
            "name": current["name"], "email": current["email"], "dwelling_id": unit["id"],
            "version": current["version"],
        })
        assert edited_user.status_code == 200
        assert edited_user.json()["coefficient"] is None
        changed = operator.patch(f"/api/admin/dwellings/{unit['id']}", json={
            "label": "Renamed dwelling", "version": unit["version"],
        })
        assert changed.status_code == 200
        assert changed.json()["coefficient"] is None
        for value in ["20.00", None]:
            attempt = operator.patch(f"/api/admin/dwellings/{unit['id']}", json={
                "label": "Must not change", "version": changed.json()["version"], "coefficient": value,
            })
            assert attempt.status_code == 409
            assert attempt.json()["code"] == "coefficient_disabled"
        created = operator.post("/api/admin/dwellings", json={"label": "Without coefficient"})
        assert created.status_code == 201
        assert created.json()["coefficient"] is None
        new_unit = created.json()
        assert operator.post("/api/admin/dwellings", json={
            "label": "Hidden write", "coefficient": "5.00",
        }).status_code == 409
        assert resident.get("/api/summary").status_code == 200
        assert resident.get("/api/neighbors").status_code == 200

    async def values(db):
        return [(item.label, item.coefficient) for item in (
            await db.scalars(select(Dwelling).order_by(Dwelling.id))
        ).all()]
    assert database(config, values) == [
        ("Renamed dwelling", Decimal("12.50")), ("Without coefficient", None),
    ]
    set_flag(admin, "coefficient", True)
    assert admin.get("/api/features").json() == {
        "coefficient": True, "google_login": False, "actions": True, "events": False,
    }
    assert current_user(admin, user["id"])["coefficient"] == "12.50"
    assert admin.post("/api/admin/dwellings", json={"label": "Requires coefficient"}).status_code == 422
    assert admin.patch(f"/api/admin/dwellings/{new_unit['id']}", json={
        "label": "Requires coefficient", "version": new_unit["version"],
    }).status_code == 422
    filled = admin.patch(f"/api/admin/dwellings/{new_unit['id']}", json={
        "label": "Defined later", "version": new_unit["version"], "coefficient": "0.00",
    })
    assert filled.status_code == 200
    assert filled.json()["coefficient"] == "0.00"


def test_runtime_flags_migration_preserves_existing_state_and_dwellings(admin, config):
    unit = dwelling(admin, coefficient="12.50")
    migrate(config, "downgrade", "0012")

    async def legacy(db):
        await db.execute(text(
            "UPDATE state SET revision = 37, community_name = 'Legacy community', "
            "dwelling_layout_version = 9 WHERE id = 1"
        ))

    database(config, legacy)
    migrate(config, "upgrade", "head")

    async def verify(db):
        state = await db.get(State, 1)
        assert (state.revision, state.community_name, state.dwelling_layout_version) == (
            37, "Legacy community", 9,
        )
        assert state.feature_coefficient is True
        assert state.feature_actions is True

    database(config, verify)
    assert admin.get("/api/admin/dwellings").json() == [unit]


def test_runtime_flags_downgrade_refuses_to_discard_disabled_configuration(admin, config):
    set_flag(admin, "actions", False)
    result = migrate(config, "downgrade", "0012", check=False)
    assert result.returncode != 0
    assert "Enable both feature flags before downgrading" in result.stderr
    assert admin.get("/api/features").json()["actions"] is False
    set_flag(admin, "actions", True)
    set_flag(admin, "coefficient", False)
    result = migrate(config, "downgrade", "0012", check=False)
    assert result.returncode != 0
    assert admin.get("/api/features").json()["coefficient"] is False
    set_flag(admin, "coefficient", True)
    migrate(config, "downgrade", "0012")
    migrate(config, "upgrade", "head")
    assert admin.get("/api/features").json() == {
        "coefficient": True, "actions": True, "google_login": False, "events": False,
    }


def test_optional_coefficient_migration_preserves_values_and_guards_downgrade(config):
    env = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0005"],
        env=env, check=True, capture_output=True,
    )

    async def seed_existing():
        engine = create_async_engine(config.database_url)
        async with engine.begin() as db:
            await db.execute(text(
                "INSERT INTO dwellings (id, label, coefficient, version) VALUES (1, 'Existing', 12.50, 4)"
            ))
        await engine.dispose()
    asyncio.run(seed_existing())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "0006"],
        env=env, check=True, capture_output=True,
    )

    async def add_missing(db):
        existing = await db.get(Dwelling, 1)
        assert (existing.coefficient, existing.version) == (Decimal("12.50"), 4)
        db.add(Dwelling(id=2, label="Pending coefficient", coefficient=None))
    database(config, add_missing)
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0005"],
        env=env, check=False, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "Assign missing dwelling coefficients" in result.stderr

    async def verify(db):
        assert (await db.get(Dwelling, 1)).coefficient == Decimal("12.50")
        assert (await db.get(Dwelling, 2)).coefficient is None
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
    database(config, verify)
