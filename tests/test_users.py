import asyncio
import re
import secrets
import smtplib
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia import auth, mail
from juntia import users as user_api
from juntia.app import create_app
from juntia.config import Settings
from juntia.db import State, User, UserSession, UserToken, aware, utcnow
from tests.test_api import commit, preview

PASSWORD = "a synthetic resident password"


@pytest.fixture
def mailbox(config, monkeypatch):
    messages = []
    config.smtp_host = "smtp.example.org"
    config.smtp_from = "community@example.org"
    monkeypatch.setattr(mail, "deliver", lambda config, message: messages.append(message))
    return messages


def token_from(message):
    return re.search(r"#token=([a-f0-9]{64})", message.get_content()).group(1)


def dwelling(admin, label="1 A", coefficient="1.23"):
    response = admin.post(
        "/api/admin/dwellings", json={"label": label, "coefficient": coefficient}
    )
    assert response.status_code == 201, response.text
    return response.json()


def invite(admin, mailbox, email="resident@example.org", dwelling_id=None):
    response = admin.post("/api/admin/users", json={
        "name": "Synthetic Resident", "email": email,
        "dwelling_id": dwelling_id or dwelling(admin)["id"],
    })
    assert response.status_code == 201, response.text
    return response.json(), token_from(mailbox[-1])


def activate(client, token, password=PASSWORD):
    response = client.post("/api/auth/activate", json={"token": token, "password": password})
    assert response.status_code == 204, response.text


def login(client, email="resident@example.org", password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def current_user(admin, user_id):
    return next(user for user in admin.get("/api/admin/users").json() if user["id"] == user_id)


def visitor(config):
    return TestClient(create_app(config), headers={
        "origin": config.public_origin, "x-juntia-request": "1",
    })


def database(config, operation):
    async def run():
        engine = create_async_engine(config.database_url)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            result = await operation(db)
            await db.commit()
        await engine.dispose()
        return result
    return asyncio.run(run())


@pytest.mark.parametrize("coefficient", ["0", "100", "0.01", "99.99"])
def test_coefficient_accepts_exact_boundaries(admin, coefficient):
    result = dwelling(admin, coefficient=coefficient)
    assert result["user_count"] == 0
    assert result["label"] == "1 A"


@pytest.mark.parametrize(
    "coefficient", ["-0.01", "100.01", "0.001", "1.234567", "NaN", "Infinity", None]
)
def test_coefficient_rejects_invalid_values_without_rounding(admin, coefficient):
    assert admin.post("/api/admin/dwellings", json={
        "label": "1 A", "coefficient": coefficient,
    }).status_code == 422
    assert admin.get("/api/admin/dwellings").json() == []


def test_invitation_shared_dwelling_and_reader_permissions(admin, config, mailbox):
    unit = dwelling(admin)
    user, token = invite(admin, mailbox, email="Resident@Example.ORG", dwelling_id=unit["id"])
    other, _ = invite(admin, mailbox, "second@example.org", unit["id"])
    assert user["email"] == "resident@example.org"
    assert user["status"] == "pending"
    assert user["last_login_at"] is None
    assert user["invitation_status"] == "sent"
    assert admin.get("/api/admin/dwellings").json()[0]["user_count"] == 2
    message = mailbox[0]
    assert message["To"] == user["email"]
    assert message["From"] == "community@example.org"
    assert f"{config.public_origin}/activate#token=" in message.get_content()
    assert PASSWORD not in message.get_content()
    assert token not in str(user)
    with visitor(config) as reader:
        for path in ["/account", "/summary", "/transactions", "/catalog/categories", "/catalog/tags"]:
            assert reader.get("/api" + path).status_code == 401
        assert login(reader).status_code == 401
        activate(reader, token)
        assert current_user(admin, user["id"])["last_login_at"] is None
        assert reader.get("/api/auth/session").json()["authenticated"] is False
        response = login(reader, "RESIDENT@example.org")
        assert response.status_code == 200, response.text
        assert "httponly" in response.headers["set-cookie"].lower()
        assert "path=/api" in response.headers["set-cookie"].lower()
        assert response.json()["kind"] == "resident"
        stamp = current_user(admin, user["id"])["last_login_at"]
        assert stamp is not None
        assert reader.get("/api/summary").status_code == 200
        assert reader.get("/api/auth/session").json()["dwelling_id"] == unit["id"]
        for path in ["/users", "/dwellings", "/statements", "/rules"]:
            assert reader.get("/api/admin" + path).status_code == 401
        assert reader.post("/api/admin/users", json={}).status_code == 401
        assert reader.get("/api/admin/auth/session").json()["authenticated"] is False
        assert login(reader, password="wrong").status_code == 401
        assert current_user(admin, user["id"])["last_login_at"] == stamp
        cookie = reader.cookies.get(auth.USER_COOKIE)
        assert reader.post("/api/auth/logout").status_code == 204
        reader.cookies.set(auth.USER_COOKIE, cookie, domain="testserver.local", path="/api")
        assert reader.get("/api/transactions").status_code == 401
    changed = admin.patch(f"/api/admin/dwellings/{unit['id']}", json={
        "label": "1 A renamed", "coefficient": "2.33", "version": unit["version"],
    })
    assert changed.status_code == 200
    rows = admin.get("/api/admin/users").json()
    assert {row["coefficient"] for row in rows} == {"2.33"}
    assert {row["dwelling_label"] for row in rows} == {"1 A renamed"}
    assert current_user(admin, other["id"])["last_login_at"] is None


def test_edit_email_disables_old_credentials_and_revokes_all_access(admin, mailbox, config):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        assert reader.post("/api/auth/forgot-password", json={"email": user["email"]}).status_code == 202
        recovery = token_from(mailbox[-1])
        user = current_user(admin, user["id"])
        result = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": "New Name", "email": "new@example.org", "dwelling_id": user["dwelling_id"],
            "version": user["version"],
        })
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "pending"
        assert result.json()["last_login_at"] == user["last_login_at"]
        assert reader.get("/api/summary").status_code == 401
        assert login(reader).status_code == 401
        assert login(reader, "new@example.org").status_code == 401
        assert reader.post("/api/auth/reset-password", json={
            "token": recovery, "password": PASSWORD,
        }).status_code == 400
        activate(reader, token_from(mailbox[-1]))
        assert login(reader, "new@example.org").status_code == 200


def test_deactivation_reactivation_and_dwelling_reassignment(admin, mailbox, config):
    user, token = invite(admin, mailbox)
    unit = dwelling(admin, "2 B")
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        user = current_user(admin, user["id"])
        moved = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": user["name"], "email": user["email"], "dwelling_id": unit["id"],
            "version": user["version"],
        }).json()
        assert reader.get("/api/auth/session").json()["dwelling_id"] == unit["id"]
        disabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "version": moved["version"], "disabled": True,
        }).json()
        assert disabled["status"] == "disabled"
        assert reader.get("/api/summary").status_code == 401
        assert login(reader).status_code == 401
        before = len(mailbox)
        reader.post("/api/auth/forgot-password", json={"email": user["email"]})
        assert len(mailbox) == before
        enabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "version": disabled["version"], "disabled": False,
        })
        assert enabled.json()["status"] == "active"
        assert reader.get("/api/summary").status_code == 401
        assert login(reader).status_code == 200


def test_recovery_is_single_use_and_does_not_count_as_login(admin, mailbox, config):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        before = current_user(admin, user["id"])["last_login_at"]
        existing = reader.post("/api/auth/forgot-password", json={"email": user["email"]})
        recovery = token_from(mailbox[-1])
        unknown = reader.post("/api/auth/forgot-password", json={"email": "unknown@example.org"})
        assert existing.status_code == unknown.status_code == 202
        assert existing.json() == unknown.json() == {"accepted": True}
        assert "/reset-password#token=" in mailbox[-1].get_content()
        assert reader.post("/api/auth/activate", json={
            "token": recovery, "password": PASSWORD,
        }).status_code == 400
        body = {"token": recovery, "password": "another synthetic password"}
        assert reader.post("/api/auth/reset-password", json=body).status_code == 204
        assert current_user(admin, user["id"])["last_login_at"] == before
        assert reader.get("/api/summary").status_code == 401
        assert login(reader).status_code == 401
        assert reader.post("/api/auth/reset-password", json=body).status_code == 400
        assert login(reader, password=body["password"]).status_code == 200


def test_recovery_sends_smtp_only_after_the_neutral_response(
    admin, mailbox, config, monkeypatch
):
    user, token = invite(admin, mailbox)
    activate(admin, token)
    response_sent = threading.Event()
    application = create_app(config)

    class ObserveResponse:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            async def observe(message):
                await send(message)
                if (
                    scope.get("path") == "/api/auth/forgot-password"
                    and message["type"] == "http.response.body"
                    and not message.get("more_body", False)
                ):
                    response_sent.set()
            await self.app(scope, receive, observe)

    application.add_middleware(ObserveResponse)

    def capture(config, message):
        assert response_sent.is_set(), "SMTP latency must not affect the public response"
        mailbox.append(message)

    monkeypatch.setattr(mail, "deliver", capture)
    with TestClient(application, headers={
        "origin": config.public_origin, "x-juntia-request": "1",
    }) as reader:
        response = reader.post("/api/auth/forgot-password", json={"email": user["email"]})
    assert response.status_code == 202
    assert response.json() == {"accepted": True}
    assert "/reset-password#token=" in mailbox[-1].get_content()


def test_resend_expiry_and_secret_rotation(admin, mailbox, config):
    user, first = invite(admin, mailbox)
    response = admin.post(f"/api/admin/users/{user['id']}/invite", json={"version": user["version"]})
    assert response.status_code == 200
    second = token_from(mailbox[-1])
    assert first != second
    assert admin.post("/api/auth/activate", json={
        "token": first, "password": PASSWORD,
    }).status_code == 400

    async def expire(db):
        await db.execute(update(UserToken).values(expires_at=utcnow() - timedelta(seconds=1)))
        await db.execute(update(User).values(invitation_expires_at=utcnow() - timedelta(seconds=1)))
    database(config, expire)
    assert current_user(admin, user["id"])["invitation_status"] == "expired"
    assert admin.post("/api/auth/activate", json={
        "token": second, "password": PASSWORD,
    }).status_code == 400
    user = current_user(admin, user["id"])
    admin.post(f"/api/admin/users/{user['id']}/invite", json={"version": user["version"]})
    third = token_from(mailbox[-1])
    rotated = config.model_copy(update={"auth_secret": SecretStr(secrets.token_urlsafe(32))})
    with visitor(rotated) as reader:
        assert reader.post("/api/auth/activate", json={
            "token": third, "password": PASSWORD,
        }).status_code == 400
    with visitor(config) as reader:
        activate(reader, third)
        assert login(reader).status_code == 200
        cookie = reader.cookies.get(auth.USER_COOKIE)
    with visitor(rotated) as reader:
        reader.cookies.set(auth.USER_COOKIE, cookie, domain="testserver.local", path="/api")
        assert reader.get("/api/summary").status_code == 401


@pytest.mark.parametrize(("purpose", "hours"), [("invitation", 72), ("recovery", 1)])
def test_account_links_expire_at_the_exact_documented_boundary(
    admin, mailbox, config, monkeypatch, purpose, hours
):
    start = utcnow()
    monkeypatch.setattr(user_api, "utcnow", lambda: start)
    user, token = invite(admin, mailbox)
    endpoint = "activate"
    if purpose == "recovery":
        activate(admin, token)
        admin.post("/api/auth/forgot-password", json={"email": user["email"]})
        token = token_from(mailbox[-1])
        endpoint = "reset-password"
    async def expiry(db):
        value = await db.scalar(select(UserToken).where(UserToken.purpose == purpose))
        return aware(value.expires_at)
    expires = database(config, expiry)
    assert expires == start + timedelta(hours=hours)
    monkeypatch.setattr(user_api, "utcnow", lambda: expires)
    assert admin.post(f"/api/auth/{endpoint}", json={
        "token": token, "password": PASSWORD,
    }).status_code == 400


def test_resident_session_expiry_is_enforced_without_a_browser_refresh(
    admin, mailbox, config, monkeypatch
):
    _, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        async def expiry(db):
            value = await db.scalar(select(UserSession))
            return aware(value.expires_at)
        expires = database(config, expiry)
        monkeypatch.setattr(auth, "utcnow", lambda: expires)
        assert reader.get("/api/summary").status_code == 401
        assert reader.get("/api/auth/session").json()["authenticated"] is False


def test_smtp_failure_is_explicit_persistent_and_retryable(admin, mailbox, monkeypatch, config):
    unit = dwelling(admin)
    def failed(config, message):
        mailbox.append(message)
        raise smtplib.SMTPServerDisconnected("synthetic SMTP failure")
    with monkeypatch.context() as patch:
        patch.setattr(mail, "deliver", failed)
        response = admin.post("/api/admin/users", json={
            "name": "Resident", "email": "resident@example.org", "dwelling_id": unit["id"],
        })
        assert response.status_code == 503
        assert response.json()["code"] == "smtp_failed"
    user = admin.get("/api/admin/users").json()[0]
    assert user["status"] == "pending"
    assert user["invitation_status"] == "failed"
    assert admin.post("/api/auth/activate", json={
        "token": token_from(mailbox[-1]), "password": PASSWORD,
    }).status_code == 400
    with visitor(config) as restarted:
        assert restarted.get("/api/auth/session").json()["authenticated"] is False
    response = admin.post(f"/api/admin/users/{user['id']}/invite", json={"version": user["version"]})
    assert response.status_code == 200
    activate(admin, token_from(mailbox[-1]))


def test_identity_validation_uniqueness_and_no_public_registration(admin, mailbox, config):
    unit = dwelling(admin)
    user, _ = invite(admin, mailbox, dwelling_id=unit["id"])
    assert admin.post("/api/admin/users", json={
        "name": "Another", "email": "RESIDENT@EXAMPLE.ORG", "dwelling_id": unit["id"],
    }).status_code == 409
    assert admin.post("/api/admin/users", json={
        "name": "Another", "email": "another@example.org", "dwelling_id": 9999,
    }).status_code == 422
    assert admin.post("/api/admin/dwellings", json={
        "label": "1 A", "coefficient": "2",
    }).status_code == 409
    other, other_token = invite(admin, mailbox, "another@example.org", unit["id"])
    response = admin.patch(f"/api/admin/users/{other['id']}", json={
        "name": other["name"], "email": user["email"], "dwelling_id": unit["id"],
        "version": other["version"],
    })
    assert response.status_code == 409, response.text
    activate(admin, other_token)
    with visitor(config) as reader:
        for path in ["/api/auth/setup", "/api/auth/register", "/api/users"]:
            assert reader.post(path, json={}).status_code in {404, 405}


def test_user_edits_do_not_invalidate_financial_previews(admin, mailbox, config):
    staged = preview(admin)
    user, _ = invite(admin, mailbox)
    assert commit(admin, staged).status_code == 200
    async def inspect(db):
        state = await db.get(State, 1)
        return state.revision, await db.scalar(select(User).where(User.id == user["id"]))
    revision, saved = database(config, inspect)
    assert revision > 0
    assert saved.password_hash is None


def test_resident_login_limit_is_separate_from_administrator(client, config):
    for _ in range(10):
        assert login(client, password="wrong").status_code == 401
    assert login(client, password="wrong").status_code == 429
    assert client.post("/api/admin/auth/login", json={
        "username": config.admin_username, "password": config.admin_password.get_secret_value(),
    }).status_code == 200


def test_legacy_admin_cookie_migrates_without_changing_ownership(admin, config):
    cookie = admin.cookies.get(auth.COOKIE)
    with visitor(config) as legacy:
        legacy.cookies.set(auth.COOKIE, cookie, domain="testserver.local", path="/api/admin")
        assert legacy.get("/api/summary").status_code == 401
        assert legacy.get("/api/admin/auth/session").json()["authenticated"]
        assert legacy.get("/api/summary").status_code == 200
        assert legacy.cookies.get(auth.COOKIE) == cookie
        assert legacy.post("/api/auth/logout").status_code == 204
        assert legacy.get("/api/summary").status_code == 401


def test_token_consumption_has_one_winner(admin, mailbox, config):
    _, token = invite(admin, mailbox)
    with visitor(config) as first, visitor(config) as second, ThreadPoolExecutor(2) as pool:
        def consume(client):
            return client.post("/api/auth/activate", json={
                "token": token, "password": PASSWORD,
            }).status_code
        results = list(pool.map(consume, [first, second]))
    assert sorted(results) == [204, 400]


def test_deactivation_during_password_verification_cannot_create_a_session(
    admin, mailbox, config, monkeypatch
):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        user = current_user(admin, user["id"])
        entered, release = threading.Event(), threading.Event()
        original = auth.bcrypt.checkpw

        def delayed(candidate, hashed):
            result = original(candidate, hashed)
            entered.set()
            assert release.wait(15), "Password verification was not released"
            return result

        monkeypatch.setattr(auth.bcrypt, "checkpw", delayed)
        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(login, reader)
            try:
                assert entered.wait(15), "Login did not reach password verification"
                result = admin.patch(f"/api/admin/users/{user['id']}/status", json={
                    "disabled": True, "version": user["version"],
                })
                assert result.status_code == 200
            finally:
                release.set()
            assert pending.result(timeout=15).status_code == 401
    async def inspect(db):
        saved = await db.get(User, user["id"])
        sessions = (await db.scalars(select(UserSession))).all()
        return saved.last_login_at, len(sessions)
    assert database(config, inspect) == (None, 0)


def test_disabled_email_change_waits_for_reactivation(admin, mailbox):
    user, original_token = invite(admin, mailbox)
    disabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
        "disabled": True, "version": user["version"],
    }).json()
    count = len(mailbox)
    edited = admin.patch(f"/api/admin/users/{user['id']}", json={
        "name": user["name"], "email": "changed@example.org",
        "dwelling_id": user["dwelling_id"], "version": disabled["version"],
    }).json()
    assert edited["status"] == "disabled"
    assert len(mailbox) == count
    enabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
        "disabled": False, "version": edited["version"],
    }).json()
    assert enabled["status"] == "pending"
    assert len(mailbox) == count + 1
    assert admin.post("/api/auth/activate", json={
        "token": original_token, "password": PASSWORD,
    }).status_code == 400
    activate(admin, token_from(mailbox[-1]))


def test_missing_smtp_does_not_create_a_pending_account(admin):
    unit = dwelling(admin)
    assert admin.post("/api/admin/users", json={
        "name": "Resident", "email": "resident@example.org", "dwelling_id": unit["id"],
    }).status_code == 503
    assert admin.get("/api/admin/users").json() == []
    assert admin.get("/api/admin/test-mailbox").status_code == 404


@pytest.mark.parametrize("password", ["short", "x" * 9, " " * 10, "ñ" * 37])
def test_activation_password_policy_preserves_the_token(admin, mailbox, password):
    _, token = invite(admin, mailbox)
    assert admin.post("/api/auth/activate", json={
        "token": token, "password": password,
    }).status_code == 422
    activate(admin, token)


@pytest.mark.parametrize("updates", [
    {"smtp_host": "smtp.example.org"},
    {"smtp_from": "not-an-email", "smtp_host": "smtp.example.org"},
    {"smtp_host": "smtp.example.org", "smtp_from": "sender@example.org", "smtp_username": "user"},
    {"smtp_host": "smtp.example.org", "smtp_from": "sender@example.org", "smtp_security": "none"},
])
def test_invalid_smtp_configuration_is_rejected(config, updates):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{**config.model_dump(), **updates})
