import logging
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from sqlalchemy import DateTime, column, select, table, text, update

from juntia import admins, users
from juntia.db import State, User, UserSession, utcnow
from juntia.errors import AppError
from tests.support import ADMINISTRATOR
from tests.test_users import (
    PASSWORD,
    activate,
    current_user,
    database,
    dwelling,
    invite,
    login,
    token_from,
    visitor,
)
from tests.test_users import mailbox as mailbox

SETUP = {"name": "First Administrator", "email": "first@example.org", "password": PASSWORD}
# The technical administrator's sessions, which migration 0024 drops.
LEGACY_SESSIONS = table(
    "sessions", column("token_hash"), column("credential_version"),
    column("expires_at", DateTime(timezone=True)),
)


def setup_available(client):
    return client.get("/api/auth/setup").json()["available"]


def invite_administrator(admin, email="second-admin@example.org", **fields):
    response = admin.post("/api/admin/users", json={
        "name": "Second Administrator", "email": email, "administrator": True, **fields,
    })
    assert response.status_code == 201, response.text
    return response.json()


def edit(admin, user, **changes):
    return admin.patch(f"/api/admin/users/{user['id']}", json={
        "name": user["name"], "email": user["email"], "phone": user["phone"],
        "dwelling_id": user["dwelling_id"], "administrator": user["administrator"],
        "version": user["version"], **changes,
    })


def own_id(client):
    return client.get("/api/auth/session").json()["user_id"]


def test_the_first_visitor_creates_the_administration_account(client, config):
    assert setup_available(client) is True
    for invalid in (
        {**SETUP, "password": "short"}, {**SETUP, "password": " " * 12},
        {**SETUP, "name": " "}, {**SETUP, "email": "not-an-email"}, {**SETUP, "extra": True},
    ):
        assert client.post("/api/auth/setup", json=invalid).status_code == 422
    assert client.post("/api/auth/setup", json=SETUP, headers={
        "origin": "https://attacker.invalid",
    }).json() == {"code": "invalid_origin"}
    assert setup_available(client) is True
    response = client.post("/api/auth/setup", json={**SETUP, "email": "First@Example.ORG"})
    assert response.status_code == 201, response.text
    identity = response.json()
    assert identity["administrator"] is True
    assert (identity["email"], identity["dwelling_id"]) == ("first@example.org", None)
    assert client.get("/api/auth/session").json() == identity
    assert client.get("/api/admin/rules").status_code == 200
    profile = client.get("/api/auth/profile").json()
    assert (profile["dwelling_id"], profile["dwelling_label"]) == (None, None)
    assert (profile["administrator"], profile["has_password"]) == (True, True)
    assert setup_available(client) is False
    with visitor(config) as other:
        assert setup_available(other) is False
        assert other.post("/api/auth/setup", json={
            **SETUP, "email": "second@example.org",
        }).json() == {"code": "setup_unavailable"}
        assert login(other, "first@example.org").status_code == 200
    rows = client.get("/api/admin/users").json()
    assert [(row["email"], row["administrator"], row["status"]) for row in rows] == [
        ("first@example.org", True, "active"),
    ]


def test_installations_with_accounts_or_upgraded_never_offer_the_setup(client, config):
    async def resident_only(db):
        await db.execute(text("INSERT INTO dwellings (label, version) VALUES ('1 A', 1)"))
        db.add(User(email="resident@example.org", name="Resident", dwelling_id=1))

    database(config, resident_only)
    assert setup_available(client) is False
    assert client.post("/api/auth/setup", json=SETUP).json() == {"code": "setup_unavailable"}

    async def upgraded_without_accounts(db):
        await db.execute(text("DELETE FROM users"))
        await db.execute(update(State).values(setup_open=False))

    database(config, upgraded_without_accounts)
    assert setup_available(client) is False
    assert client.post("/api/auth/setup", json=SETUP).json() == {"code": "setup_unavailable"}

    async def accounts(db):
        return list(await db.scalars(select(User.email)))

    assert database(config, accounts) == []


def test_setup_is_throttled_like_other_account_endpoints(admin):
    for _ in range(5):
        assert admin.post("/api/auth/setup", json=SETUP).json() == {"code": "setup_unavailable"}
    assert admin.post("/api/auth/setup", json=SETUP).json() == {"code": "request_throttled"}


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Real PostgreSQL concurrency")
def test_simultaneous_setups_create_a_single_administrator(client, config):
    barrier = Barrier(2)
    with visitor(config) as first, visitor(config) as second:
        def create(pair):
            browser, email = pair
            barrier.wait(timeout=10)
            return browser.post("/api/auth/setup", json={**SETUP, "email": email}).status_code

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(create, [
                (first, "first@example.org"), (second, "second@example.org"),
            ]))
    assert sorted(results) == [201, 409]

    async def count(db):
        return len(list(await db.scalars(select(User.id))))

    assert database(config, count) == 1


def test_administrators_invite_administrators_and_residents_need_a_dwelling(
    admin, config, mailbox,
):
    unit = dwelling(admin)
    assert admin.post("/api/admin/users", json={
        "name": "Resident", "email": "resident@example.org",
    }).json() == {"code": "dwelling_required"}
    assert admin.post("/api/admin/users", json={
        "name": "Resident", "email": "resident@example.org", "dwelling_id": None,
        "administrator": False,
    }).json() == {"code": "dwelling_required"}
    assert admin.post("/api/admin/users", json={
        "name": "Resident", "email": "resident@example.org", "administrator": "yes",
    }).status_code == 422
    invited = invite_administrator(admin)
    assert (invited["administrator"], invited["dwelling_id"]) == (True, None)
    assert (invited["dwelling_label"], invited["coefficient"]) == (None, None)
    neighbor = invite_administrator(
        admin, "neighbor-admin@example.org", dwelling_id=unit["id"],
    )
    assert (neighbor["administrator"], neighbor["dwelling_label"]) == (True, unit["label"])
    with visitor(config) as browser:
        activate(browser, token_from(mailbox[-2]))
        assert login(browser, "second-admin@example.org").status_code == 200
        assert browser.get("/api/auth/session").json()["administrator"] is True
        assert browser.get("/api/admin/users").status_code == 200
        assert browser.get("/api/auth/profile").json()["dwelling_label"] is None
        assert browser.get("/api/neighbors").json() == [
            {"id": unit["id"], "label": unit["label"], "neighbors": []},
        ]


def test_roles_apply_at_once_without_ending_sessions(admin, config, mailbox):
    user, token = invite(admin, mailbox)
    with visitor(config) as resident:
        activate(resident, token)
        assert login(resident).status_code == 200
        assert resident.get("/api/admin/rules").json() == {"code": "administrator_required"}
        user = current_user(admin, user["id"])
        granted = edit(admin, user, administrator=True)
        assert granted.status_code == 200, granted.text
        assert granted.json()["administrator"] is True
        assert resident.get("/api/auth/session").json()["administrator"] is True
        assert resident.get("/api/admin/rules").status_code == 200
        revoked = edit(admin, granted.json(), administrator=False)
        assert revoked.status_code == 200, revoked.text
        assert resident.get("/api/admin/rules").json() == {"code": "administrator_required"}
        assert resident.get("/api/summary").status_code == 200
        assert resident.get("/api/auth/session").json()["administrator"] is False


def test_an_administrator_without_a_dwelling_keeps_the_role_until_given_one(admin, mailbox):
    unit = dwelling(admin)
    invited = invite_administrator(admin)
    assert edit(admin, invited, administrator=False).json() == {"code": "dwelling_required"}
    moved = edit(admin, invited, administrator=False, dwelling_id=unit["id"])
    assert moved.status_code == 200, moved.text
    assert (moved.json()["administrator"], moved.json()["dwelling_id"]) == (False, unit["id"])
    assert edit(admin, moved.json(), dwelling_id=None).json() == {"code": "dwelling_required"}


def test_nobody_changes_their_own_role_status_or_account(admin, mailbox):
    me = current_user(admin, own_id(admin))
    unit = dwelling(admin)
    for changes in ({"administrator": False, "dwelling_id": unit["id"]}, {
        "email": "renamed@example.org",
    }):
        assert edit(admin, me, **changes).json() == {"code": "cannot_modify_self"}
    assert admin.patch(f"/api/admin/users/{me['id']}/status", json={
        "disabled": True, "version": me["version"],
    }).json() == {"code": "cannot_modify_self"}
    assert admin.request("DELETE", f"/api/admin/users/{me['id']}", json={
        "email": me["email"], "version": me["version"],
    }).json() == {"code": "cannot_modify_self"}
    renamed = edit(admin, me, name="Renamed Administrator", phone="+44 20 7946 0123",
                   dwelling_id=unit["id"])
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["administrator"] is True
    assert admin.get("/api/admin/rules").status_code == 200


def test_administrators_manage_other_administrators(admin, config, mailbox):
    other = invite_administrator(admin)
    with visitor(config) as browser:
        activate(browser, token_from(mailbox[-1]))
        assert login(browser, other["email"]).status_code == 200
        other = current_user(admin, other["id"])
        disabled = admin.patch(f"/api/admin/users/{other['id']}/status", json={
            "disabled": True, "version": other["version"],
        })
        assert disabled.status_code == 200, disabled.text
        assert browser.get("/api/admin/rules").status_code == 401
    me = current_user(admin, own_id(admin))
    with visitor(config) as browser:
        assert browser.post("/api/auth/login", json={
            "email": other["email"], "password": PASSWORD,
        }).status_code == 401
    assert admin.request("DELETE", f"/api/admin/users/{other['id']}", json={
        "email": other["email"], "version": disabled.json()["version"],
    }).status_code == 204
    assert [row["id"] for row in admin.get("/api/admin/users").json()] == [me["id"]]


def test_an_email_address_in_use_is_a_conflict_for_administrators_too(admin, config, mailbox):
    other = invite_administrator(admin)
    with visitor(config) as browser:
        activate(browser, token_from(mailbox[-1]))
    other = current_user(admin, other["id"])
    # A new address ends the activation, so the remaining administrators are counted before the
    # address reaches the database.
    response = edit(admin, other, email=ADMINISTRATOR["email"])
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "record_conflict"
    assert current_user(admin, other["id"]) == other


def test_no_change_leaves_the_community_without_an_active_administrator(admin, config):
    async def check(db):
        await db.execute(text("INSERT INTO dwellings (label, version) VALUES ('1 A', 1)"))
        await db.execute(update(User).values(administrator=False, dwelling_id=1))
        with pytest.raises(AppError) as refused:
            await users.require_administrator_remains(db)
        assert refused.value.code == "last_administrator"
        await db.rollback()

    database(config, check)
    assert admin.get("/api/admin/rules").status_code == 200


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Real PostgreSQL concurrency")
def test_two_administrators_cannot_revoke_each_other_at_once(admin, config, mailbox):
    unit = dwelling(admin)
    other = invite_administrator(admin, dwelling_id=unit["id"])
    activate(admin, token_from(mailbox[-1]))
    me = edit(admin, current_user(admin, own_id(admin)), dwelling_id=unit["id"]).json()
    other = current_user(admin, other["id"])
    barrier = Barrier(2)

    def revoke(pair):
        client, target = pair
        barrier.wait(timeout=10)
        return edit(client, target, administrator=False)

    with visitor(config) as browser, ThreadPoolExecutor(2) as pool:
        assert login(browser, other["email"]).status_code == 200
        responses = list(pool.map(revoke, [(admin, other), (browser, me)]))
    # The loser is refused for the last administrator, or as no longer one if it came later.
    assert sorted(response.status_code for response in responses) in ([200, 403], [200, 409])

    async def remaining(db):
        return list(await db.scalars(select(User.email).where(User.administrator.is_(True))))

    assert len(database(config, remaining)) == 1


def test_the_presidency_and_the_directory_only_consider_dwellings(admin, config, mailbox):
    unit = dwelling(admin)
    administrator = own_id(admin)
    assert admin.put("/api/admin/presidency", json={
        "user_id": administrator, "version": 0,
    }).json() == {"code": "presidency_inactive"}
    me = edit(admin, current_user(admin, administrator), dwelling_id=unit["id"]).json()
    assert admin.put("/api/admin/presidency", json={
        "user_id": administrator, "version": 0,
    }).status_code == 200
    assert [person["id"] for person in admin.get("/api/neighbors").json()[0]["neighbors"]] == [
        administrator,
    ]
    assert edit(admin, me, dwelling_id=None).status_code == 200
    assert admin.get("/api/admin/presidency").json()["president"] is None
    assert admin.get("/api/neighbors").json()[0]["neighbors"] == []


def test_every_account_has_a_profile(admin):
    profile = admin.get("/api/auth/profile").json()
    assert profile["email"] == ADMINISTRATOR["email"]
    assert (profile["dwelling_id"], profile["dwelling_label"], profile["coefficient"]) == (
        None, None, None,
    )
    edited = admin.patch("/api/auth/profile", json={
        "name": "Renamed Administrator", "version": profile["version"],
    })
    assert edited.status_code == 200, edited.text
    assert admin.get("/api/auth/session").json()["name"] == "Renamed Administrator"


def test_startup_warns_about_retired_settings_and_missing_administrators(
    client, config, caplog, monkeypatch,
):
    caplog.set_level(logging.WARNING, logger="juntia.app")
    monkeypatch.setenv("ADMIN_PASSWORD", "a retired password")

    async def resident_only(db):
        await db.execute(text("INSERT INTO dwellings (label, version) VALUES ('1 A', 1)"))
        db.add(User(email="resident@example.org", name="Resident", dwelling_id=1))

    database(config, resident_only)
    with visitor(config):
        pass
    messages = [record.getMessage() for record in caplog.records if record.name == "juntia.app"]
    assert any(message.startswith("ADMIN_PASSWORD is no longer used") for message in messages)
    assert "a retired password" not in caplog.text
    assert any(message.startswith("No account is an administrator") for message in messages)
    caplog.clear()
    monkeypatch.delenv("ADMIN_PASSWORD")

    async def promote(db):
        await db.execute(update(User).values(administrator=True))

    database(config, promote)
    with visitor(config):
        pass
    assert not [record for record in caplog.records if record.name == "juntia.app"]


def command(config, monkeypatch, capsys, *arguments):
    monkeypatch.setattr(admins, "Settings", lambda: config)
    status = admins.main(list(arguments))
    output = capsys.readouterr()
    return status, output.out, output.err


def link_token(output, route):
    return re.search(rf"/{route}#token=([0-9a-f]{{64}})", output).group(1)


def test_the_command_invites_an_administrator_into_an_upgraded_installation(
    config, monkeypatch, capsys,
):
    origins = config.model_copy(update={"public_origin": "http://testserver,http://other.example.org"})

    async def upgraded(db):
        await db.execute(update(State).values(setup_open=False))

    database(config, upgraded)
    status, output, _ = command(config, monkeypatch, capsys, "list")
    assert (status, output) == (0, "No account is an administrator.\n")
    status, output, _ = command(
        origins, monkeypatch, capsys, "invite", "Operator@Example.org", "--name", " The  Operator ",
    )
    assert status == 0
    token = link_token(output, "activate")
    assert f"http://testserver/activate#token={token}" in output
    assert f"http://other.example.org/activate#token={token}" in output
    status, _, error = command(
        config, monkeypatch, capsys, "invite", "operator@example.org", "--name", "Again",
    )
    assert (status, error) == (1, "operator@example.org already has an account: use grant or "
                                  "password-link.\n")
    with visitor(config) as browser:
        assert setup_available(browser) is False
        activate(browser, token)
        assert login(browser, "operator@example.org").status_code == 200
        identity = browser.get("/api/auth/session").json()
        assert (identity["administrator"], identity["dwelling_id"]) == (True, None)
        assert identity["name"] == "The Operator"
        row = current_user(browser, identity["user_id"])
        assert (row["status"], row["invitation_status"]) == ("active", "none")
    status, output, _ = command(config, monkeypatch, capsys, "list")
    assert output == "operator@example.org\tThe Operator\tactive\tno dwelling\n"


def test_the_command_grants_and_revokes_the_role(admin, config, mailbox, monkeypatch, capsys):
    user, token = invite(admin, mailbox)
    status, _, error = command(config, monkeypatch, capsys, "grant", user["email"])
    assert (status, error) == (
        1, "resident@example.org is pending: only an active account becomes an administrator.\n",
    )
    assert command(config, monkeypatch, capsys, "grant", "nobody@example.org")[2] == (
        "No account uses nobody@example.org.\n"
    )
    assert command(config, monkeypatch, capsys, "grant", "not an email")[0] == 1
    with visitor(config) as resident:
        activate(resident, token)
        assert login(resident).status_code == 200
        status, output, _ = command(config, monkeypatch, capsys, "grant", "RESIDENT@example.org")
        assert (status, output) == (
            0, "resident@example.org is now an administrator: Administration is in their user "
               "menu.\n",
        )
        assert resident.get("/api/admin/rules").status_code == 200
        assert current_user(admin, user["id"])["version"] == user["version"] + 2
        assert command(config, monkeypatch, capsys, "grant", user["email"])[1] == (
            "resident@example.org is already an administrator.\n"
        )
        status, output, _ = command(config, monkeypatch, capsys, "revoke", user["email"])
        assert (status, output) == (0, "resident@example.org is no longer an administrator.\n")
        assert resident.get("/api/admin/rules").json() == {"code": "administrator_required"}
    status, _, error = command(config, monkeypatch, capsys, "revoke", ADMINISTRATOR["email"])
    assert status == 1
    assert "has no dwelling" in error

    async def give_a_dwelling(db):
        await db.execute(update(User).where(User.email == ADMINISTRATOR["email"]).values(
            dwelling_id=user["dwelling_id"],
        ))

    database(config, give_a_dwelling)
    status, _, error = command(config, monkeypatch, capsys, "revoke", ADMINISTRATOR["email"])
    assert (status, error) == (
        1, "administrator@example.org is the last active administrator: grant the role to "
           "someone else first.\n",
    )
    assert admin.get("/api/admin/rules").status_code == 200


def test_the_command_prints_password_links_without_smtp(admin, config, mailbox, monkeypatch,
                                                        capsys):
    status, output, _ = command(
        config, monkeypatch, capsys, "password-link", ADMINISTRATOR["email"],
    )
    assert status == 0
    assert "within 1 hour" in output
    with visitor(config) as browser:
        assert browser.post("/api/auth/reset-password", json={
            "token": link_token(output, "reset-password"), "password": "a new synthetic password",
        }).status_code == 204
        assert login(browser, ADMINISTRATOR["email"], "a new synthetic password").status_code == 200
    assert admin.get("/api/admin/rules").status_code == 401
    assert login(admin, ADMINISTRATOR["email"], "a new synthetic password").status_code == 200
    user, _ = invite(admin, mailbox)
    status, output, _ = command(config, monkeypatch, capsys, "password-link", user["email"])
    assert (status, "within 72 hours" in output) == (0, True)
    with visitor(config) as browser:
        activate(browser, link_token(output, "activate"))
        assert login(browser).status_code == 200

    async def disable(db):
        await db.execute(update(User).where(User.id == user["id"]).values(disabled=True))

    database(config, disable)
    status, _, error = command(config, monkeypatch, capsys, "password-link", user["email"])
    assert (status, "is disabled" in error) == (1, True)


def alembic(config, *arguments):
    return subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        env={**os.environ, "DATABASE_URL": config.database_url},
        capture_output=True, text=True,
    )


def test_upgrading_makes_nobody_an_administrator_and_downgrading_keeps_accounts(config):
    assert alembic(config, "downgrade", "0023").returncode == 0
    sqlite = config.database_url.startswith("sqlite")

    async def legacy(db):
        await db.execute(text("INSERT INTO dwellings (id, label, version) VALUES (1, '1 A', 1)"))
        for user_id in (3, 7):
            await db.execute(text(
                "INSERT INTO users (id, email, name, dwelling_id, activated, disabled, "
                "auth_version, version, invitation_delivery) VALUES "
                f"({user_id}, 'resident{user_id}@example.org', 'Resident', 1, true, false, 1, 1, "
                "'none')"
            ))
        await db.execute(text("DELETE FROM users WHERE id = 7"))
        await db.execute(LEGACY_SESSIONS.insert().values(
            token_hash="a" * 64, credential_version="b" * 64,
            expires_at=utcnow() + timedelta(hours=1),
        ))
        await db.execute(UserSession.__table__.insert().values(
            token_hash="c" * 64, user_id=3, auth_version=1,
            expires_at=utcnow() + timedelta(hours=1),
        ))

    database(config, legacy)
    assert alembic(config, "upgrade", "head").returncode == 0

    async def upgraded(db):
        resident = await db.get(User, 3)
        assert (resident.administrator, resident.dwelling_id) == (False, 1)
        assert (await db.get(State, 1)).setup_open is False
        assert (await db.get(UserSession, "c" * 64)).user_id == 3
        tables = await db.run_sync(lambda session: session.get_bind().dialect.get_table_names(
            session.connection()
        ))
        assert "sessions" not in tables
        # A dwelling is required unless the account is an administrator.
        db.add(User(email="nowhere@example.org", name="Nowhere"))
        with pytest.raises(Exception, match="user_dwelling"):
            await db.flush()
        await db.rollback()
        db.add(User(email="operator@example.org", name="Operator", administrator=True))
        await db.flush()
        if sqlite:
            assert (await db.get(User, 8)) is not None

    database(config, upgraded)
    refused = alembic(config, "downgrade", "0023")
    assert refused.returncode != 0
    assert "Assign a dwelling to every account" in refused.stderr

    async def remove_operator(db):
        await db.execute(text("DELETE FROM users WHERE email = 'operator@example.org'"))

    database(config, remove_operator)
    assert alembic(config, "downgrade", "0023").returncode == 0

    async def downgraded(db):
        columns = [row[1] for row in (await db.execute(text("PRAGMA table_info(users)"))).all()]
        assert "administrator" not in columns
        ddl = await db.scalar(text("SELECT sql FROM sqlite_master WHERE name = 'users'"))
        assert "AUTOINCREMENT" in ddl
        assert await db.scalar(text("SELECT seq FROM sqlite_sequence WHERE name = 'users'")) == 8
        assert await db.scalar(text("SELECT count(*) FROM sessions")) == 0

    if sqlite:
        database(config, downgraded)
    else:
        async def postgresql(db):
            assert await db.scalar(text("SELECT count(*) FROM sessions")) == 0
        database(config, postgresql)
    assert alembic(config, "upgrade", "head").returncode == 0


def test_the_command_needs_the_application_settings(monkeypatch, capsys):
    for name in ("DATABASE_URL", "AUTH_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(os.path.dirname(__file__))
    assert admins.main(["list"]) == 2
    assert "Invalid settings" in capsys.readouterr().err


def test_an_unready_database_is_reported(config, monkeypatch, capsys):
    async def unseeded(db):
        await db.execute(text("DELETE FROM state"))

    database(config, unseeded)
    status, _, error = command(config, monkeypatch, capsys, "list")
    assert (status, error) == (1, "Run the migrations and seed.py first.\n")
