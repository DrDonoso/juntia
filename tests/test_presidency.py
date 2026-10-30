import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text

from juntia import users
from juntia.db import State, User
from juntia.errors import AppError
from tests.test_action_migration import migrate
from tests.test_neighbors import create_neighbor
from tests.test_user_deletion import remove
from tests.test_users import activate, current_user, database, dwelling, login, token_from, visitor
from tests.test_users import mailbox as mailbox

PATH = "/api/admin/presidency"


def assign(admin, user_id, version=0):
    return admin.put(PATH, json={"user_id": user_id, "version": version})


def holders(client):
    return [
        person["id"] for unit in client.get("/api/neighbors").json()
        for person in unit["neighbors"] if person["is_president"]
    ]


def test_assignment_transfer_and_vacancy_preserve_access_and_other_state(admin, mailbox, config):
    unit = dwelling(admin)
    ana = create_neighbor(admin, mailbox, unit, "resident@example.org", "Ana")
    pedro = create_neighbor(admin, mailbox, unit, "pedro@example.org", "Pedro")
    before_users = admin.get("/api/admin/users").json()
    before_dwellings = admin.get("/api/admin/dwellings").json()

    async def revisions(db):
        state = await db.get(State, 1)
        return state.revision, state.dwelling_layout_version

    before_revisions = database(config, revisions)
    assert admin.get(PATH).json() == {"president": None, "version": 0}
    assert holders(admin) == []
    result = assign(admin, ana["id"])
    assert result.status_code == 200, result.text
    assert result.json() == {
        "president": {
            "id": ana["id"], "name": "Ana", "dwelling_id": unit["id"],
            "dwelling_label": unit["label"],
        },
        "version": 1,
    }
    assert holders(admin) == [ana["id"]]
    with visitor(config) as reader:
        assert login(reader).status_code == 200
        assert holders(reader) == [ana["id"]]
        assert reader.get("/api/admin/auth/session").json()["authenticated"] is False
        assert reader.get(PATH).status_code == 401
        assert assign(reader, pedro["id"], 1).status_code == 401
        assert reader.get("/api/admin/users").status_code == 401
        assert reader.patch("/api/auth/profile", json={
            "name": "Ana", "version": ana["version"], "is_president": True,
        }).status_code == 422
        assert assign(admin, pedro["id"], 1).json()["version"] == 2
        assert holders(reader) == [pedro["id"]]
        assert reader.get("/api/auth/session").json()["authenticated"] is True
    assert assign(admin, None, 2).json() == {"president": None, "version": 3}
    assert holders(admin) == []
    current = admin.get("/api/admin/users").json()
    for before, after in zip(before_users, current, strict=True):
        assert {**before, "last_login_at": after["last_login_at"]} == after
    assert admin.get("/api/admin/dwellings").json() == before_dwellings
    assert database(config, revisions) == before_revisions
    with visitor(config) as anonymous:
        assert anonymous.get(PATH).status_code == 401
        assert assign(anonymous, ana["id"], 3).status_code == 401
        assert anonymous.get("/api/neighbors").status_code == 401
    assert "presiden" not in admin.get("/api/settings/general").text.lower()


@pytest.mark.parametrize("body", [
    {}, {"user_id": None}, {"version": 0}, {"user_id": 0, "version": 0},
    {"user_id": -1, "version": 0}, {"user_id": True, "version": 0},
    {"user_id": "1", "version": 0}, {"user_id": 1.5, "version": 0},
    {"user_id": None, "version": -1}, {"user_id": None, "version": False},
    {"user_id": None, "version": "0"}, {"user_id": None, "version": 0, "role": "admin"},
])
def test_invalid_assignments_are_rejected(admin, body):
    assert admin.put(PATH, json=body).status_code == 422
    assert admin.get(PATH).json() == {"president": None, "version": 0}


def test_only_active_existing_residents_can_be_assigned(admin, mailbox):
    unit = dwelling(admin)
    pending = create_neighbor(admin, mailbox, unit, "pending@example.org", "Pending", active=False)
    invitation = token_from(mailbox[-1])
    assert assign(admin, pending["id"]).json()["code"] == "presidency_inactive"
    activate(admin, invitation)
    active = current_user(admin, pending["id"])
    admin.patch(f"/api/admin/users/{active['id']}/status", json={
        "disabled": True, "version": active["version"],
    })
    assert assign(admin, active["id"]).status_code == 409
    assert assign(admin, 999999).status_code == 404
    assert admin.get(PATH).json() == {"president": None, "version": 0}


def test_stale_and_cross_origin_writes_cannot_replace_the_current_holder(admin, mailbox):
    unit = dwelling(admin)
    ana = create_neighbor(admin, mailbox, unit, "ana@example.org", "Ana")
    pedro = create_neighbor(admin, mailbox, unit, "pedro@example.org", "Pedro")
    assert assign(admin, ana["id"]).status_code == 200
    before = admin.get(PATH).json()
    for user_id in [pedro["id"], None]:
        response = assign(admin, user_id)
        assert response.status_code == 409
        assert response.json()["code"] == "presidency_stale"
        assert admin.get(PATH).json() == before
    assert admin.put(PATH, json={"user_id": pedro["id"], "version": 1}, headers={
        "origin": "https://attacker.invalid",
    }).status_code == 403
    assert holders(admin) == [ana["id"]]


@pytest.mark.parametrize("operation", ["disable", "delete", "email"])
def test_ineligible_or_removed_holder_leaves_a_versioned_vacancy(
    admin, mailbox, operation
):
    unit = dwelling(admin)
    user = create_neighbor(admin, mailbox, unit, "resident@example.org", "Resident")
    assert assign(admin, user["id"]).status_code == 200
    if operation == "delete":
        assert remove(admin, user).status_code == 204
    elif operation == "disable":
        response = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": True, "version": user["version"],
        })
        assert response.status_code == 200
        assert admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": False, "version": response.json()["version"],
        }).status_code == 200
    else:
        response = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": user["name"], "email": "changed@example.org",
            "dwelling_id": unit["id"], "version": user["version"],
        })
        assert response.status_code == 200, response.text
        activate(admin, token_from(mailbox[-1]))
    assert admin.get(PATH).json() == {"president": None, "version": 2}
    assert holders(admin) == []
    assert assign(admin, None, 1).status_code == 409


def test_name_phone_and_dwelling_edits_preserve_the_holder(admin, mailbox):
    first, second = dwelling(admin), dwelling(admin, "2 B")
    user = create_neighbor(admin, mailbox, first, "resident@example.org", "Resident")
    assert assign(admin, user["id"]).status_code == 200
    response = admin.patch(f"/api/admin/users/{user['id']}", json={
        "name": "Updated name", "phone": "+12025550101", "email": user["email"],
        "dwelling_id": second["id"], "version": user["version"],
    })
    assert response.status_code == 200
    saved = admin.get(PATH).json()
    assert saved["president"] == {
        "id": user["id"], "name": "Updated name", "dwelling_id": second["id"],
        "dwelling_label": "2 B",
    }
    assert saved["version"] == 1
    assert holders(admin) == [user["id"]]


def test_failed_deletion_rolls_back_the_presidency(admin, mailbox, monkeypatch):
    user = create_neighbor(admin, mailbox, dwelling(admin), "resident@example.org", "Resident")
    assert assign(admin, user["id"]).status_code == 200
    before = admin.get(PATH).json()

    async def fail(db, user_id):
        raise AppError("synthetic_delete_failure", 503)

    monkeypatch.setattr(users, "revoke_user_access", fail)
    assert remove(admin, user).status_code == 503
    assert admin.get(PATH).json() == before
    assert holders(admin) == [user["id"]]


def test_conflicting_email_edit_rolls_back_presidency_and_account_changes(admin, mailbox):
    unit = dwelling(admin)
    user = create_neighbor(admin, mailbox, unit, "resident@example.org", "Resident")
    other = create_neighbor(admin, mailbox, unit, "other@example.org", "Other")
    assert assign(admin, user["id"]).status_code == 200
    before = admin.get(PATH).json()
    response = admin.patch(f"/api/admin/users/{user['id']}", json={
        "name": "Changed name", "email": other["email"],
        "dwelling_id": unit["id"], "version": user["version"],
    })
    assert response.status_code == 409
    assert response.json()["code"] == "record_conflict"
    assert admin.get(PATH).json() == before
    assert current_user(admin, user["id"]) == user
    assert holders(admin) == [user["id"]]


def test_concurrent_assignments_have_one_winner(admin, mailbox, config):
    unit = dwelling(admin)
    first = create_neighbor(admin, mailbox, unit, "first@example.org", "First")
    second = create_neighbor(admin, mailbox, unit, "second@example.org", "Second")
    barrier = threading.Barrier(2)
    with visitor(config) as other:
        other.cookies.update(admin.cookies)

        def attempt(client, user_id):
            barrier.wait(timeout=15)
            return assign(client, user_id)

        with ThreadPoolExecutor(2) as pool:
            one = pool.submit(attempt, admin, first["id"])
            two = pool.submit(attempt, other, second["id"])
            results = [one.result(timeout=30), two.result(timeout=30)]
    assert sorted(result.status_code for result in results) == [200, 409]
    assert admin.get(PATH).json()["version"] == 1
    assert len(holders(admin)) == 1


def test_concurrent_deactivation_cannot_leave_an_inactive_president(admin, mailbox, config):
    user = create_neighbor(admin, mailbox, dwelling(admin), "resident@example.org", "Resident")
    barrier = threading.Barrier(2)
    with visitor(config) as other:
        other.cookies.update(admin.cookies)

        def disable():
            barrier.wait(timeout=15)
            return other.patch(f"/api/admin/users/{user['id']}/status", json={
                "disabled": True, "version": user["version"],
            })

        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(disable)
            barrier.wait(timeout=15)
            result = assign(admin, user["id"])
            assert pending.result(timeout=30).status_code == 200
    assert result.status_code in {200, 409}
    assert admin.get(PATH).json()["president"] is None
    assert holders(admin) == []


def test_migration_preserves_existing_data_and_requires_explicit_vacancy(admin, mailbox, config):
    user = create_neighbor(admin, mailbox, dwelling(admin), "resident@example.org", "Resident")
    before_users = admin.get("/api/admin/users").json()
    migrate(config, "downgrade", "0016")

    async def legacy(db):
        await db.execute(text("UPDATE state SET revision = 37 WHERE id = 1"))

    database(config, legacy)
    migrate(config, "upgrade", "head")
    assert admin.get(PATH).json() == {"president": None, "version": 0}
    assert admin.get("/api/admin/users").json() == before_users

    async def verify(db):
        assert (await db.get(State, 1)).revision == 37
        assert (await db.get(User, user["id"])).email == user["email"]

    database(config, verify)
    assert assign(admin, user["id"]).status_code == 200
    result = migrate(config, "downgrade", "0016", check=False)
    assert result.returncode != 0
    assert "Explicitly clear the community presidency" in result.stderr
    assert holders(admin) == [user["id"]]
    assert assign(admin, None, 1).status_code == 200
    migrate(config, "downgrade", "0016")
    migrate(config, "upgrade", "head")
    assert admin.get(PATH).json() == {"president": None, "version": 0}
    assert admin.get("/api/admin/users").json() == before_users
