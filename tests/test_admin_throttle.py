from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import select

from juntia import auth
from juntia.app import create_app
from juntia.db import AuthLimit, State
from tests.test_users import database

PATH = "/api/admin/auth/login"


def admin_client(config, address):
    return TestClient(
        create_app(config), client=(address, 1234),
        headers={"origin": config.public_origin, "x-juntia-request": "1"},
    )


def credentials(config):
    return {
        "username": config.admin_username,
        "password": config.admin_password.get_secret_value(),
    }


def test_admin_failures_do_not_lock_out_other_clients(config):
    with admin_client(config, "192.0.2.1") as attacker, admin_client(
        config, "198.51.100.1",
    ) as legitimate:
        for _ in range(10):
            assert attacker.post(PATH, json={
                "username": config.admin_username, "password": "incorrect",
            }).status_code == 401
        blocked = attacker.post(PATH, json=credentials(config))
        assert blocked.status_code == 429
        assert blocked.json() == {"code": "login_throttled"}
        assert legitimate.post(PATH, json=credentials(config)).status_code == 200
        assert legitimate.get("/api/admin/rules").status_code == 200


def test_unknown_admin_names_and_spoofed_proxy_headers_cannot_evade_client_limit(
    config, monkeypatch,
):
    monkeypatch.setattr(auth.bcrypt, "checkpw", lambda candidate, hashed: False)
    with admin_client(config, "192.0.2.1") as client:
        for index in range(50):
            assert client.post(PATH, json={
                "username": f"unknown-{index}", "password": "incorrect",
            }, headers={"x-forwarded-for": f"198.51.100.{index + 1}"}).status_code == 401
        response = client.post(PATH, json={"username": "another", "password": "incorrect"})
        assert response.status_code == 429
    async def inspect(db):
        state = await db.get(State, 1)
        return state.login_attempts, list(await db.scalars(select(AuthLimit)))
    old_attempts, limits = database(config, inspect)
    assert old_attempts == []
    assert len(limits) == 51
    assert all(len(row.key) == 64 for row in limits)


def test_admin_limits_are_shared_persisted_and_expire_at_the_window_boundary(config, monkeypatch):
    now = auth.utcnow()
    monkeypatch.setattr(auth, "utcnow", lambda: now)
    with admin_client(config, "192.0.2.1") as first:
        for _ in range(10):
            assert first.post(PATH, json={
                "username": config.admin_username, "password": "incorrect",
            }).status_code == 401
    with admin_client(config, "192.0.2.1") as restarted:
        assert restarted.post(PATH, json=credentials(config)).status_code == 429
        now += timedelta(minutes=5)
        assert restarted.post(PATH, json=credentials(config)).status_code == 200


def test_concurrent_admin_attempts_share_one_atomic_allowance(config, monkeypatch):
    monkeypatch.setattr(auth.bcrypt, "checkpw", lambda candidate, hashed: False)
    with admin_client(config, "192.0.2.1") as first, admin_client(
        config, "192.0.2.1",
    ) as second:
        wrong = {"username": config.admin_username, "password": "incorrect"}
        for _ in range(9):
            assert first.post(PATH, json=wrong).status_code == 401
        barrier = Barrier(2)

        def attempt(client):
            barrier.wait(timeout=5)
            return client.post(PATH, json=wrong).status_code

        with ThreadPoolExecutor(2) as pool:
            assert sorted(pool.map(attempt, [first, second])) == [401, 429]


@pytest.mark.parametrize("password", ["", "x" * 73, "\U0001f600" * 19])
def test_invalid_admin_password_lengths_cannot_match_the_dummy_password(config, password):
    updated = config.model_copy(update={"admin_password": SecretStr("invalid-password")})
    with admin_client(updated, "192.0.2.1") as client:
        response = client.post(PATH, json={"username": updated.admin_username, "password": password})
        assert response.status_code == 401
        assert not client.cookies.get(auth.COOKIE)
