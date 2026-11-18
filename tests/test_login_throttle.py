from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import bcrypt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from juntia import auth
from juntia.app import create_app
from juntia.db import AuthLimit, State, User
from tests.support import ADMINISTRATOR
from tests.test_users import PASSWORD, activate, database, invite
from tests.test_users import mailbox as mailbox

PATH = "/api/auth/login"


def browser(config, address):
    return TestClient(
        create_app(config), client=(address, 1234),
        headers={"origin": config.public_origin, "x-juntia-request": "1"},
    )


def credentials(password=ADMINISTRATOR["password"]):
    return {"email": ADMINISTRATOR["email"], "password": password}


def test_failures_for_one_account_do_not_lock_out_another(admin, config):
    with browser(config, "192.0.2.1") as attacker:
        for _ in range(10):
            assert attacker.post(PATH, json={
                "email": "resident@example.org", "password": "incorrect",
            }).status_code == 401
        blocked = attacker.post(PATH, json={
            "email": "resident@example.org", "password": "incorrect",
        })
        assert blocked.status_code == 429
        assert blocked.json() == {"code": "login_throttled"}
        assert attacker.post(PATH, json=credentials()).status_code == 200
        assert attacker.get("/api/admin/rules").status_code == 200


def test_failures_from_one_client_never_lock_an_administrator_out_elsewhere(admin, config):
    with browser(config, "192.0.2.1") as attacker, browser(config, "198.51.100.1") as legitimate:
        for _ in range(10):
            assert attacker.post(PATH, json=credentials("incorrect")).status_code == 401
        blocked = attacker.post(PATH, json=credentials())
        assert blocked.status_code == 429
        assert blocked.json() == {"code": "login_throttled"}
        assert legitimate.post(PATH, json=credentials()).status_code == 200
        assert legitimate.get("/api/admin/rules").status_code == 200


def test_a_neighbors_failures_count_from_every_client(admin, config, mailbox):
    resident, token = invite(admin, mailbox)
    with browser(config, "192.0.2.1") as attacker, browser(config, "198.51.100.1") as owner:
        activate(owner, token)
        wrong = {"email": resident["email"], "password": "incorrect"}
        for _ in range(10):
            assert attacker.post(PATH, json=wrong).status_code == 401
        right = {"email": resident["email"], "password": PASSWORD}
        assert owner.post(PATH, json=right).json() == {"code": "login_throttled"}


def test_unknown_accounts_and_spoofed_proxy_headers_cannot_evade_the_client_limit(
    config, monkeypatch,
):
    monkeypatch.setattr(auth.bcrypt, "checkpw", lambda candidate, hashed: False)
    with browser(config, "192.0.2.1") as client:
        for index in range(50):
            assert client.post(PATH, json={
                "email": f"unknown-{index}@example.org", "password": "incorrect",
            }, headers={"x-forwarded-for": f"198.51.100.{index + 1}"}).status_code == 401
        response = client.post(PATH, json={"email": "another@example.org", "password": "x"})
        assert response.status_code == 429
    async def inspect(db):
        state = await db.get(State, 1)
        return state.login_attempts, list(await db.scalars(select(AuthLimit)))
    old_attempts, limits = database(config, inspect)
    assert old_attempts == []
    assert len(limits) == 51
    assert all(len(row.key) == 64 for row in limits)


def test_limits_are_shared_persisted_and_expire_at_the_window_boundary(admin, config, monkeypatch):
    now = auth.utcnow()
    monkeypatch.setattr(auth, "utcnow", lambda: now)
    with browser(config, "192.0.2.1") as first:
        for _ in range(10):
            assert first.post(PATH, json=credentials("incorrect")).status_code == 401
    with browser(config, "192.0.2.1") as restarted:
        assert restarted.post(PATH, json=credentials()).status_code == 429
        now += timedelta(minutes=5)
        assert restarted.post(PATH, json=credentials()).status_code == 200


def test_concurrent_attempts_share_one_atomic_allowance(admin, config, monkeypatch):
    monkeypatch.setattr(auth.bcrypt, "checkpw", lambda candidate, hashed: False)
    with browser(config, "192.0.2.1") as first, browser(config, "192.0.2.1") as second:
        wrong = credentials("incorrect")
        for _ in range(9):
            assert first.post(PATH, json=wrong).status_code == 401
        barrier = Barrier(2)

        def attempt(client):
            barrier.wait(timeout=5)
            return client.post(PATH, json=wrong).status_code

        with ThreadPoolExecutor(2) as pool:
            assert sorted(pool.map(attempt, [first, second])) == [401, 429]


@pytest.mark.parametrize("password", ["", "x" * 73, "\U0001f600" * 19])
def test_invalid_password_lengths_cannot_match_the_placeholder_password(admin, config, password):
    async def placeholder(db):
        # A stored password equal to the value compared for passwords of an invalid length.
        await db.execute(update(User).values(
            password_hash=bcrypt.hashpw(b"invalid-password", bcrypt.gensalt()).decode(),
        ))
    database(config, placeholder)
    with browser(config, "192.0.2.1") as client:
        response = client.post(PATH, json=credentials(password))
        assert response.status_code == 401
        assert not client.cookies.get(auth.USER_COOKIE)
        assert client.post(PATH, json=credentials("invalid-password")).status_code == 200


def test_accounts_that_cannot_sign_in_take_as_long_as_a_real_check():
    # The placeholder compared for unknown accounts uses bcrypt's default cost, like real ones.
    assert auth.UNUSABLE_HASH.startswith(b"$2b$12$")
    assert bcrypt.gensalt().startswith(b"$2b$12$")
