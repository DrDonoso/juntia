import asyncio
import os
import subprocess
import sys

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia.contracts import ProfileEdit, UserIn
from juntia.db import User
from juntia.queries import dwelling_sort_key
from tests.test_users import (
    activate,
    current_user,
    dwelling,
    login,
    token_from,
    visitor,
)
from tests.test_users import (
    mailbox as mailbox,
)


@pytest.mark.parametrize(("raw", "normalized"), [
    ("", ""), ("  ", ""), ("600123456", "600123456"),
    ("+1 (202) 555-0101", "+12025550101"),
    ("202.555.0101", "2025550101"),
    ("1234567", "1234567"), ("+123456789012345", "+123456789012345"),
])
def test_phone_normalization_is_shared_by_admin_and_profile(raw, normalized):
    assert ProfileEdit(name="Resident", version=1, phone=raw).phone == normalized
    assert UserIn(name="Resident", email="resident@example.org", dwelling_id=1, phone=raw).phone == normalized


@pytest.mark.parametrize("phone", [
    "123456", "1234567890123456", "++12025550101", "1202abc0101",
    "tel:+12025550101", "javascript:alert(1)", "*1234567#", "1234567;123", None, 123456789,
])
def test_invalid_phone_values_are_rejected(phone):
    with pytest.raises(ValidationError):
        ProfileEdit(name="Resident", version=1, phone=phone)


def test_dwelling_order_is_numeric_and_handles_common_floor_labels():
    labels = [
        "10 B", "2 A", "1 B", "10 A", "Bajo B", "Ático A",
        "1.º A", "-1 A", "Entresuelo A", "Bajo A", "2 B",
    ]
    assert sorted(labels, key=dwelling_sort_key) == [
        "-1 A", "Bajo A", "Bajo B", "Entresuelo A", "1.º A",
        "1 B", "2 A", "2 B", "10 A", "10 B", "Ático A",
    ]
    assert sorted(["Planta 10 A", "Piso 2 A", "PB A"], key=dwelling_sort_key) == [
        "PB A", "Piso 2 A", "Planta 10 A",
    ]
    assert sorted(["Portal A 10", "Portal A 2"], key=dwelling_sort_key) == [
        "Portal A 2", "Portal A 10",
    ]


def create_neighbor(admin, mailbox, unit, email, name, phone="", active=True):
    response = admin.post("/api/admin/users", json={
        "dwelling_id": unit["id"], "email": email, "name": name, "phone": phone,
    })
    assert response.status_code == 201, response.text
    user = response.json()
    if active:
        activate(admin, token_from(mailbox[-1]))
    return current_user(admin, user["id"])


def test_directory_groups_active_neighbors_and_exposes_only_contact_details(
    admin, mailbox, config
):
    units = {label: dwelling(admin, label) for label in ["10 A", "2 A", "1 B", "1 A"]}
    ana = create_neighbor(
        admin, mailbox, units["2 A"], "resident@example.org", "Ana", "+1 (202) 555-0101"
    )
    create_neighbor(admin, mailbox, units["2 A"], "luis@example.org", "Luis")
    create_neighbor(admin, mailbox, units["10 A"], "eva@example.org", "Eva", "+12025550102")
    create_neighbor(
        admin, mailbox, units["1 A"], "pending@example.org", "Pending private name", active=False
    )
    disabled = create_neighbor(
        admin, mailbox, units["1 B"], "disabled@example.org", "Disabled private name"
    )
    admin.patch(f"/api/admin/users/{disabled['id']}/status", json={
        "version": disabled["version"], "disabled": True,
    })
    expected_order = ["1 A", "1 B", "2 A", "10 A"]
    assert [unit["label"] for unit in admin.get("/api/admin/dwellings").json()] == expected_order
    with visitor(config) as reader:
        assert reader.get("/api/neighbors").status_code == 401
        assert login(reader).status_code == 200
        response = reader.get("/api/neighbors")
        assert response.status_code == 200
        groups = response.json()
        assert groups == admin.get("/api/neighbors").json()
        assert [group["label"] for group in groups] == expected_order
        assert groups[0]["neighbors"] == groups[1]["neighbors"] == []
        assert [person["name"] for person in groups[2]["neighbors"]] == ["Ana", "Luis"]
        assert groups[2]["neighbors"][0] == {
            "id": ana["id"], "name": "Ana", "email": "resident@example.org",
            "phone": "+12025550101", "is_president": False,
        }
        assert groups[2]["neighbors"][1]["phone"] == ""
        for group in groups:
            assert set(group) == {"id", "label", "neighbors"}
            for person in group["neighbors"]:
                assert set(person) == {"id", "name", "email", "phone", "is_president"}
        assert "pending@example.org" not in response.text
        assert "disabled@example.org" not in response.text
        assert "private name" not in response.text
        assert "coefficient" not in response.text
        assert "last_login" not in response.text
        assert reader.post("/api/neighbors", json={}).status_code == 405
        assert reader.post("/api/auth/logout").status_code == 204
        assert reader.get("/api/neighbors").status_code == 401


def test_phone_edits_are_visible_and_omitted_fields_do_not_erase_numbers(admin, mailbox, config):
    unit = dwelling(admin)
    user = create_neighbor(
        admin, mailbox, unit, "resident@example.org", "Resident", "+12025550101"
    )
    with visitor(config) as reader:
        assert login(reader).status_code == 200
        profile = reader.get("/api/auth/profile").json()
        before = profile["last_login_at"]
        assert profile["phone"] == "+12025550101"
        result = reader.patch("/api/auth/profile", json={
            "name": profile["name"], "version": profile["version"], "phone": "+1 202 555 0102",
        })
        assert result.status_code == 200
        saved = result.json()
        assert saved["phone"] == "+12025550102"
        assert saved["last_login_at"] == before
        assert reader.get("/api/neighbors").json()[0]["neighbors"][0]["phone"] == saved["phone"]
        renamed = reader.patch("/api/auth/profile", json={
            "name": "Renamed", "version": saved["version"],
        }).json()
        assert renamed["phone"] == saved["phone"]
        current = current_user(admin, user["id"])
        edited = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": current["name"], "email": current["email"], "dwelling_id": unit["id"],
            "version": current["version"],
        }).json()
        assert edited["phone"] == saved["phone"]
        changed = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": current["name"], "email": current["email"], "dwelling_id": unit["id"],
            "version": edited["version"], "phone": "202 555 0103",
        }).json()
        assert changed["phone"] == "2025550103"
        assert reader.get("/api/auth/profile").json()["phone"] == "2025550103"
        assert reader.get("/api/summary").status_code == 200
        cleared = reader.patch("/api/auth/profile", json={
            "name": changed["name"], "version": changed["version"], "phone": "",
        }).json()
        assert cleared["phone"] == ""
        assert reader.get("/api/neighbors").json()[0]["neighbors"][0]["phone"] == ""


def test_phone_migration_preserves_existing_users_with_no_fabricated_number(config):
    environment = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0004"],
        env=environment, check=True, capture_output=True,
    )

    async def legacy_data():
        engine = create_async_engine(config.database_url)
        async with engine.begin() as db:
            await db.execute(text(
                "INSERT INTO dwellings (id, label, coefficient, version) VALUES (1, '1 A', 12.50, 1)"
            ))
            await db.execute(text(
                "INSERT INTO users (name, email, dwelling_id, disabled, auth_version, version, "
                "invitation_delivery) VALUES "
                "('Existing resident', 'existing@example.org', 1, false, 7, 9, 'none')"
            ))
        await engine.dispose()
    asyncio.run(legacy_data())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=environment, check=True, capture_output=True,
    )

    async def verify():
        engine = create_async_engine(config.database_url)
        async with async_sessionmaker(engine)() as db:
            user = await db.scalar(select(User))
            assert user.phone == ""
            assert user.email == "existing@example.org"
            assert (user.dwelling_id, user.auth_version, user.version) == (1, 7, 9)
        await engine.dispose()
    asyncio.run(verify())
