"""What's new: the notes each account has read (``/api/whats-new``), only ever its own, merged and
capped, with the ids' format checked; and the migration that lets existing accounts read the notes
of the version that brings them."""

import pytest
from sqlalchemy import select, text

from juntia import whats_new
from juntia.db import User
from tests.test_action_migration import migrate
from tests.test_users import activate, database, invite, login, visitor
from tests.test_users import (
    mailbox as mailbox,
)

SEEN = "/api/whats-new/seen"
LAUNCH = "2026-11-17-whats-new"


def mark(client, *ids):
    response = client.post(SEEN, json={"ids": list(ids)})
    assert response.status_code == 200, response.text
    return response.json()


def stored(config, user_id):
    async def read(db):
        return await db.scalar(select(User.whats_new_seen).where(User.id == user_id))

    return database(config, read)


@pytest.fixture
def neighbor(admin, config, mailbox):
    user, token = invite(admin, mailbox)
    with visitor(config) as client:
        activate(client, token)
        assert login(client).status_code == 200
        yield client, user["id"]


def test_whats_new_needs_a_session(client):
    assert client.get("/api/whats-new").status_code == 401
    response = client.post(SEEN, json={"ids": [LAUNCH]})
    assert response.status_code == 401
    assert response.json() == {"code": "authentication_required"}


def test_new_accounts_have_read_nothing_yet_then_their_notes_add_up(neighbor, config):
    client, user_id = neighbor
    # NULL until the interface records the notes for the first time.
    assert client.get("/api/whats-new").json() == {"seen": None}
    assert mark(client, LAUNCH) == {"seen": [LAUNCH]}
    # Repeated ids change nothing; the list stays sorted (oldest first).
    later, earlier = "2027-02-03-shared-calendar", "2026-12-01-search"
    assert mark(client, later, LAUNCH, earlier, later) == {"seen": [LAUNCH, earlier, later]}
    assert client.get("/api/whats-new").json() == {"seen": [LAUNCH, earlier, later]}
    assert stored(config, user_id) == [LAUNCH, earlier, later]


def test_each_account_keeps_its_own_notes(admin, config, mailbox):
    first, first_token = invite(admin, mailbox, "first@example.org")
    second, second_token = invite(admin, mailbox, "second@example.org", first["dwelling_id"])
    with visitor(config) as one, visitor(config) as other:
        activate(one, first_token)
        activate(other, second_token)
        assert login(one, "first@example.org").status_code == 200
        assert login(other, "second@example.org").status_code == 200
        mark(one, LAUNCH)
        assert other.get("/api/whats-new").json() == {"seen": None}
        mark(other, "2026-12-01-search")
    assert stored(config, first["id"]) == [LAUNCH]
    assert stored(config, second["id"]) == ["2026-12-01-search"]


def test_administrators_without_a_dwelling_keep_their_notes_too(admin):
    assert admin.get("/api/auth/session").json()["administrator"] is True
    assert admin.get("/api/whats-new").json() == {"seen": None}
    assert mark(admin, LAUNCH) == {"seen": [LAUNCH]}
    assert admin.get("/api/whats-new").json() == {"seen": [LAUNCH]}


def test_only_the_newest_notes_are_kept(neighbor, monkeypatch):
    client, _ = neighbor
    monkeypatch.setattr(whats_new, "MAX_SEEN", 3)
    mark(client, "2026-01-01-a", "2026-02-01-b", "2026-03-01-c")
    assert mark(client, "2026-04-01-d", "2025-12-31-z") == {
        "seen": ["2026-02-01-b", "2026-03-01-c", "2026-04-01-d"]
    }


@pytest.mark.parametrize(
    "body",
    [
        {"ids": []},
        {"ids": [f"2026-01-01-n{index}" for index in range(501)]},
        {"ids": LAUNCH},
        {"ids": [7]},
        {"ids": ["whats-new"]},
        {"ids": ["2026-11-17-Whats-New"]},
        {"ids": ["2026-11-17-whats-new.json"]},
        {"ids": [" 2026-11-17-whats-new"]},
        {"ids": ["2026-11-17-" + "a" * 70]},
        {},
        {"ids": [LAUNCH], "all": True},
    ],
)
def test_note_ids_are_checked(neighbor, config, body):
    client, user_id = neighbor
    response = client.post(SEEN, json=body)
    assert response.status_code == 422
    assert response.json() == {"code": "invalid_request"}
    assert stored(config, user_id) is None


def test_upgrade_lets_accounts_that_signed_in_read_the_new_notes_once(admin, config, mailbox):
    signed_in, token = invite(admin, mailbox)
    pending, _ = invite(admin, mailbox, "pending@example.org", signed_in["dwelling_id"])
    with visitor(config) as client:
        activate(client, token)
        assert login(client).status_code == 200

    async def ddl(db):
        return await db.scalar(text("SELECT sql FROM sqlite_master WHERE name = 'users'"))

    sqlite = config.database_url.startswith("sqlite")
    migrate(config, "downgrade", "0024")
    if sqlite:
        assert "AUTOINCREMENT" in database(config, ddl)
    migrate(config, "upgrade", "head")
    # Signed in before this version: the launch note is new to them. Never signed in: nothing to
    # catch up on (the interface marks every note as read at their first visit).
    assert stored(config, signed_in["id"]) == []
    assert stored(config, pending["id"]) is None
    if sqlite:
        assert "AUTOINCREMENT" in database(config, ddl)
