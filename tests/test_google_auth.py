import asyncio
import os
import secrets
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import create_async_engine

from juntia import auth, google_auth
from juntia.app import create_app
from juntia.config import Settings
from juntia.db import GoogleAuthFlow, User, UserSession, UserToken, utcnow
from juntia.errors import AppError
from tests.test_users import (
    PASSWORD,
    activate,
    current_user,
    database,
    invite,
    login,
    token_from,
    visitor,
)
from tests.test_users import (
    mailbox as mailbox,
)


@pytest.fixture
def google(config, monkeypatch):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    config.google_client_secret = SecretStr("synthetic-google-client-secret")
    provider = {
        "identity": google_auth.GoogleIdentity(subject="google-subject-1", email="resident@example.org"),
        "calls": [],
        "error": None,
    }

    async def exchange(self, code, state, origin):
        provider["calls"].append((code, state, origin))
        if provider["error"]:
            raise AppError(provider["error"], 503)
        return provider["identity"]

    monkeypatch.setattr(google_auth.GoogleProvider, "exchange", exchange)
    return provider


def start(client, token=None, return_path="/"):
    response = client.post("/api/auth/google/start", json={
        "invitation_token": token, "return_path": return_path,
    })
    assert response.status_code == 200, response.text
    url = response.json()["authorization_url"]
    assert url.startswith(google_auth.AUTHORIZATION_URL + "?")
    return parse_qs(urlsplit(url).query)


def finish(client, flow, **overrides):
    return client.get(
        google_auth.CALLBACK_PATH,
        params={"state": flow["state"][0], "code": "synthetic-code", **overrides},
        follow_redirects=False,
    )


def assert_google_error(response, code):
    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["google_error"] == [code]


def test_google_is_optional_and_disabled_without_credentials(client):
    assert client.get("/api/features").json()["google_login"] is False
    assert client.post("/api/auth/google/start", json={}).status_code == 503
    assert_google_error(client.get(
        google_auth.CALLBACK_PATH, follow_redirects=False,
    ), "google_disabled")


def test_google_returns_to_an_action_and_can_participate(google, admin, config, mailbox):
    created = admin.post("/api/actions/items", json={"title": "Google return action"})
    assert created.status_code == 201
    item_id = created.json()["id"]
    user, token = invite(admin, mailbox)
    target = f"/actions/{item_id}?view=board&scope=all"
    with visitor(config) as reader:
        response = finish(reader, start(reader, token, target))
        assert response.status_code == 303
        assert response.headers["location"] == target
        assert reader.get(f"/api/actions/items/{item_id}").status_code == 200
        comment = reader.post(f"/api/actions/items/{item_id}/comments", json={
            "body": "Participating after Google sign-in",
        })
        assert comment.status_code == 201
        assert comment.json()["author"]["user_id"] == user["id"]
        assert reader.get("/api/admin/statements").status_code == 401


def test_google_activation_preserves_invitation_details_without_a_local_password(
    google, admin, config, mailbox
):
    user, token = invite(admin, mailbox)
    assert "Google" in mailbox[-1].get_content()
    with visitor(config) as reader:
        assert reader.get("/api/features").json()["google_login"] is True
        flow = start(reader, token, "/neighbors")
        assert flow["scope"] == ["openid email profile"]
        assert flow["code_challenge_method"] == ["S256"]
        assert flow["prompt"] == ["select_account"]
        assert flow["redirect_uri"] == [config.public_origin + google_auth.CALLBACK_PATH]
        assert token not in str(flow)
        assert user["email"] not in str(flow)
        assert user["name"] not in str(flow)
        assert current_user(admin, user["id"])["last_login_at"] is None
        response = finish(reader, flow)
        assert response.status_code == 303
        assert response.headers["location"] == "/neighbors"
        assert reader.cookies.get(auth.USER_COOKIE)
        assert reader.cookies.get(auth.GOOGLE_COOKIE) is None
        profile = reader.get("/api/auth/profile").json()
        assert profile["email"] == user["email"]
        assert profile["name"] == user["name"]
        assert profile["dwelling_id"] == user["dwelling_id"]
        assert profile["has_password"] is False
        assert profile["google_linked"] is True
        assert profile["last_login_at"] is not None
        assert reader.get("/api/summary").status_code == 200
        assert reader.get("/api/admin/users").status_code == 401
        neighbors = reader.get("/api/neighbors").json()[0]["neighbors"]
        assert neighbors[0]["id"] == user["id"]
        assert current_user(admin, user["id"])["status"] == "active"
        assert reader.post("/api/auth/activate", json={"token": token, "password": PASSWORD}).status_code == 400
        assert login(reader).status_code == 401
        reader.post("/api/auth/logout")
        assert reader.get("/api/summary").status_code == 401
        assert finish(reader, start(reader)).headers["location"] == "/"
    assert len(google["calls"]) == 2


@pytest.mark.parametrize("profile", [
    {"name": "  Mar\u00eda   Garc\u00eda L\u00f3pez  "},
    {"name": "María", "given_name": "María", "family_name": "García López"},
    {"given_name": "María", "family_name": "García López"},
])
def test_google_activation_imports_profile_name_without_resyncing(
    google, admin, config, mailbox, profile
):
    user, token = invite(admin, mailbox)
    google["identity"] = google_auth.GoogleIdentity(
        subject="google-subject-1", email=user["email"],
        name=google_auth.GoogleIdentity.profile_name(
            profile.get("name"), profile.get("given_name"), profile.get("family_name"),
        ),
    )
    with visitor(config) as reader:
        assert finish(reader, start(reader, token)).headers["location"] == "/"
        profile = reader.get("/api/auth/profile").json()
        assert profile["name"] == "Mar\u00eda Garc\u00eda L\u00f3pez"
        assert profile["email"] == user["email"]
        assert profile["phone"] == user["phone"]
        assert profile["dwelling_id"] == user["dwelling_id"]
        assert current_user(admin, user["id"])["name"] == profile["name"]
        neighbors = reader.get("/api/neighbors").json()[0]["neighbors"]
        assert neighbors[0]["name"] == profile["name"]

        edited = reader.patch("/api/auth/profile", json={
            "name": "Nombre elegido", "version": profile["version"],
        })
        assert edited.status_code == 200, edited.text
        google["identity"] = google_auth.GoogleIdentity(
            subject="google-subject-1", email=user["email"], name="Otro nombre de Google",
        )
        assert reader.post("/api/auth/logout").status_code == 204
        assert finish(reader, start(reader)).headers["location"] == "/"
        assert reader.get("/api/auth/profile").json()["name"] == "Nombre elegido"
        assert current_user(admin, user["id"])["name"] == "Nombre elegido"


@pytest.mark.parametrize("name", ["", "   ", "N" * 151, "Hidden\nName", 42])
def test_google_activation_preserves_invited_name_when_profile_name_is_invalid(
    google, admin, config, mailbox, name
):
    user, token = invite(admin, mailbox)
    google["identity"] = google_auth.GoogleIdentity(
        subject="google-subject-1", email=user["email"], name=name,
    )
    with visitor(config) as reader:
        assert finish(reader, start(reader, token)).headers["location"] == "/"
        assert reader.get("/api/auth/profile").json()["name"] == user["name"]
        current = current_user(admin, user["id"])
        assert current["status"] == "active"
        assert current["name"] == user["name"]


def test_google_never_registers_or_links_a_user_by_email_alone(google, admin, config, mailbox):
    with visitor(config) as reader:
        assert_google_error(finish(reader, start(reader)), "google_access_denied")
        assert admin.get("/api/admin/users").json() == []
        user, token = invite(admin, mailbox)
        assert_google_error(finish(reader, start(reader)), "google_access_denied")
        assert current_user(admin, user["id"])["status"] == "pending"
        activate(reader, token)
        assert_google_error(finish(reader, start(reader)), "google_access_denied")
        assert current_user(admin, user["id"])["google_linked"] is False
        assert reader.get("/api/summary").status_code == 401


def test_invitation_email_must_match_and_failures_do_not_consume_it(google, admin, config, mailbox):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        google["identity"] = google_auth.GoogleIdentity(
            subject="different", email="someone@example.org", name="Unrelated Google profile",
        )
        assert_google_error(finish(reader, start(reader, token)), "google_access_denied")
        assert current_user(admin, user["id"])["status"] == "pending"
        assert current_user(admin, user["id"])["name"] == user["name"]
        google["identity"] = google_auth.GoogleIdentity(subject="correct", email=user["email"])
        assert finish(reader, start(reader, token)).headers["location"] == "/"
        assert current_user(admin, user["id"])["status"] == "active"


def test_linking_requires_current_password_and_keeps_both_login_methods(google, admin, config, mailbox):
    user, token = invite(admin, mailbox)
    google["identity"] = google_auth.GoogleIdentity(
        subject="google-subject-1", email=user["email"], name="Different Google profile name",
    )
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        before = current_user(admin, user["id"])["last_login_at"]
        assert reader.post("/api/auth/google/link", json={"current_password": "wrong"}).status_code == 400
        response = reader.post("/api/auth/google/link", json={"current_password": PASSWORD})
        assert response.status_code == 200, response.text
        flow = parse_qs(urlsplit(response.json()["authorization_url"]).query)
        assert finish(reader, flow).headers["location"] == "/profile?google=linked"
        current = current_user(admin, user["id"])
        assert current["google_linked"] and current["has_password"]
        assert current["last_login_at"] == before
        assert current["name"] == user["name"]
        assert reader.get("/api/summary").status_code == 200
        reader.post("/api/auth/logout")
        assert finish(reader, start(reader)).status_code == 303
        assert reader.get("/api/auth/session").json()["user_id"] == user["id"]
        assert reader.get("/api/auth/profile").json()["name"] == user["name"]
        reader.post("/api/auth/logout")
        assert login(reader).status_code == 200
        assert reader.request("DELETE", "/api/auth/google/link", json={
            "current_password": "wrong",
        }).status_code == 400
        assert reader.request("DELETE", "/api/auth/google/link", json={
            "current_password": PASSWORD,
        }).status_code == 204
        assert reader.get("/api/summary").status_code == 401
        assert_google_error(finish(reader, start(reader)), "google_access_denied")
        assert login(reader).status_code == 200


def test_google_only_users_can_add_a_password_by_mail(google, admin, config, mailbox):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        finish(reader, start(reader, token))
        assert reader.request("DELETE", "/api/auth/google/link", json={
            "current_password": PASSWORD,
        }).json()["code"] == "password_not_set"
        before = current_user(admin, user["id"])["last_login_at"]
        assert reader.post("/api/auth/forgot-password", json={"email": user["email"]}).status_code == 202
        recovery = token_from(mailbox[-1])
        assert reader.post("/api/auth/reset-password", json={
            "token": recovery, "password": PASSWORD,
        }).status_code == 204
        current = current_user(admin, user["id"])
        assert current["has_password"] and current["google_linked"]
        assert current["last_login_at"] == before
        assert reader.get("/api/summary").status_code == 401
        assert login(reader).status_code == 200


def test_google_identity_is_unique_and_duplicate_claim_does_not_activate_second_user(
    google, admin, config, mailbox
):
    first, token = invite(admin, mailbox)
    second, other_token = invite(admin, mailbox, "other@example.org", first["dwelling_id"])
    with visitor(config) as reader:
        finish(reader, start(reader, token))
        reader.post("/api/auth/logout")
        google["identity"] = google_auth.GoogleIdentity(
            subject="google-subject-1", email=second["email"], name="Conflicting Google profile",
        )
        assert_google_error(finish(reader, start(reader, other_token)), "google_access_denied")
        assert current_user(admin, second["id"])["status"] == "pending"
        assert current_user(admin, second["id"])["name"] == second["name"]
        activate(reader, other_token)
    assert current_user(admin, first["id"])["google_linked"] is True


def test_disable_reactivate_and_email_change_apply_to_google_accounts(google, admin, config, mailbox):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        finish(reader, start(reader, token))
        current = current_user(admin, user["id"])
        disabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": True, "version": current["version"],
        }).json()
        assert disabled["google_linked"] is True
        assert reader.get("/api/summary").status_code == 401
        assert_google_error(finish(reader, start(reader)), "google_access_denied")
        count = len(mailbox)
        enabled = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": False, "version": disabled["version"],
        }).json()
        assert enabled["status"] == "active" and len(mailbox) == count
        finish(reader, start(reader))
        assert reader.get("/api/summary").status_code == 200
        changed = admin.patch(f"/api/admin/users/{user['id']}", json={
            "name": user["name"], "email": "new@example.org",
            "dwelling_id": user["dwelling_id"], "version": enabled["version"],
        }).json()
        assert changed["status"] == "pending"
        assert changed["google_linked"] is False
        assert reader.get("/api/summary").status_code == 401
        assert_google_error(finish(reader, start(reader)), "google_access_denied")


@pytest.mark.parametrize("change", ["expire-invitation", "disable", "resend"])
def test_invitation_is_rechecked_after_returning_from_google(google, admin, config, mailbox, change):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        flow = start(reader, token)
        if change == "expire-invitation":
            async def expire(db):
                await db.execute(update(UserToken).values(expires_at=utcnow() - timedelta(seconds=1)))
            database(config, expire)
        elif change == "disable":
            admin.patch(f"/api/admin/users/{user['id']}/status", json={
                "disabled": True, "version": user["version"],
            })
        else:
            admin.post(f"/api/admin/users/{user['id']}/invite", json={"version": user["version"]})
        response = finish(reader, flow)
        assert "google_error=" in response.headers["location"]
        assert reader.get("/api/summary").status_code == 401
        assert current_user(admin, user["id"])["google_linked"] is False


def test_google_flow_is_browser_bound_and_single_use(google, admin, config, mailbox):
    _, token = invite(admin, mailbox)
    with visitor(config) as first, visitor(config) as other:
        flow = start(first, token)
        assert_google_error(finish(other, flow), "google_invalid_flow")
        assert not google["calls"]
        assert finish(first, flow).headers["location"] == "/"
        assert_google_error(finish(first, flow), "google_invalid_flow")
        assert len(google["calls"]) == 1


def test_expired_replaced_and_secret_rotated_flows_cannot_authenticate(google, config):
    with visitor(config) as reader:
        old = start(reader)
        new = start(reader)
        assert_google_error(finish(reader, old), "google_invalid_flow")
        async def expire(db):
            await db.execute(update(GoogleAuthFlow).values(expires_at=utcnow()))
        database(config, expire)
        assert_google_error(finish(reader, new), "google_invalid_flow")
        flow = start(reader)
        cookie = reader.cookies.get(auth.GOOGLE_COOKIE)
    rotated = config.model_copy(update={"auth_secret": SecretStr(secrets.token_urlsafe(32))})
    with visitor(rotated) as reader:
        reader.cookies.set(auth.GOOGLE_COOKIE, cookie, domain="testserver.local", path="/api/auth")
        assert_google_error(finish(reader, flow), "google_invalid_flow")
    assert not google["calls"]


def test_cancelled_or_failed_google_preserves_password_login_and_invitation(
    google, admin, config, mailbox
):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        assert_google_error(finish(reader, start(reader, token), error="access_denied"), "google_cancelled")
        assert not google["calls"]
        google["error"] = "google_unavailable"
        assert_google_error(finish(reader, start(reader, token)), "google_unavailable")
        activate(reader, token)
        assert login(reader).status_code == 200
    assert current_user(admin, user["id"])["google_linked"] is False


def test_security_headers_scopes_and_administrator_separation(google, admin, config, mailbox):
    assert admin.post("/api/auth/google/start", json={}).status_code == 403
    assert admin.post("/api/auth/google/link", json={"current_password": PASSWORD}).status_code == 403
    with visitor(config) as reader:
        assert reader.post("/api/auth/google/link", json={"current_password": PASSWORD}).status_code == 401
        assert reader.post("/api/auth/google/start", json={}, headers={
            "origin": "https://attacker.invalid",
        }).status_code == 403
        for path in ["https://attacker.invalid/", "//attacker.invalid/", "/admin", "/\\attacker.invalid", "/login"]:
            assert reader.post("/api/auth/google/start", json={"return_path": path}).status_code == 422
        response = reader.post("/api/auth/google/start", json={})
        cookie = SimpleCookie(response.headers["set-cookie"])[auth.GOOGLE_COOKIE]
        assert cookie["path"] == "/api/auth" and cookie["samesite"].lower() == "lax"
        assert cookie["httponly"] and not cookie["domain"]
        assert response.headers["cache-control"] == "no-store"
        assert "accounts.google.com" not in response.headers["content-security-policy"]


def test_duplicate_callback_parameters_are_rejected(google, config):
    with visitor(config) as reader:
        flow = start(reader)
        params = [("state", flow["state"][0]), ("state", flow["state"][0]), ("code", "test")]
        response = reader.get(google_auth.CALLBACK_PATH + "?" + urlencode(params), follow_redirects=False)
        assert_google_error(response, "google_invalid_flow")
        assert not google["calls"]


def test_google_link_cannot_survive_logout_or_password_revocation(google, admin, config, mailbox):
    _, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        result = reader.post("/api/auth/google/link", json={"current_password": PASSWORD})
        flow = parse_qs(urlsplit(result.json()["authorization_url"]).query)
        reader.post("/api/auth/logout")
        assert_google_error(finish(reader, flow), "google_invalid_flow")


def test_google_login_rotates_the_previous_strict_session_cookie(google, admin, config, mailbox):
    _, token = invite(admin, mailbox)
    with visitor(config) as reader, visitor(config) as copied:
        finish(reader, start(reader, token))
        old_cookie = reader.cookies.get(auth.USER_COOKIE)
        flow = start(reader)
        reader.cookies.delete(auth.USER_COOKIE, domain="testserver.local", path="/api")
        assert finish(reader, flow).headers["location"] == "/"
        assert reader.cookies.get(auth.USER_COOKIE) != old_cookie
        copied.cookies.set(auth.USER_COOKIE, old_cookie, domain="testserver.local", path="/api")
        assert copied.get("/api/summary").status_code == 401
        assert reader.get("/api/summary").status_code == 200


def test_google_callback_has_one_winner_under_concurrent_replay(google, admin, config, mailbox):
    _, token = invite(admin, mailbox)
    with visitor(config) as first, visitor(config) as second:
        flow = start(first, token)
        second.cookies.set(auth.GOOGLE_COOKIE, first.cookies.get(auth.GOOGLE_COOKIE),
                           domain="testserver.local", path="/api/auth")
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(lambda client: finish(client, flow), [first, second]))
        assert sum(result.headers["location"] == "/" for result in responses) == 1
        assert len(google["calls"]) == 1


def test_google_uses_the_initiating_allowed_origin_and_rejects_cross_origin_replay(
    google, admin, config, mailbox
):
    _, token = invite(admin, mailbox)
    multi = Settings(_env_file=None, **{
        **config.model_dump(), "public_origin": "https://one.example.org,https://two.example.org:8443",
        "auth_cookie_secure": True,
    })
    origin = multi.public_origins[1]
    with TestClient(create_app(multi), base_url=origin, headers={
        "origin": origin, "x-juntia-request": "1",
    }) as reader:
        flow = start(reader, token)
        assert flow["redirect_uri"] == [origin + google_auth.CALLBACK_PATH]
        other_origin = multi.public_origins[0]
        binding = reader.cookies.get(auth.GOOGLE_COOKIE)
        wrong = reader.get(
            other_origin + google_auth.CALLBACK_PATH,
            params={"state": flow["state"][0], "code": "synthetic-code"},
            headers={"cookie": f"{auth.GOOGLE_COOKIE}={binding}"}, follow_redirects=False,
        )
        assert_google_error(wrong, "google_invalid_flow")
        assert not google["calls"]
        assert finish(reader, flow).headers["location"] == "/"
        assert reader.get("/api/summary").status_code == 200
        assert reader.get(other_origin + "/api/summary").status_code == 401
        assert google["calls"][0][2] == origin


def test_deactivation_during_google_exchange_cannot_create_a_session(
    google, admin, config, mailbox, monkeypatch
):
    user, token = invite(admin, mailbox)
    entered, release = threading.Event(), threading.Event()
    async def delayed_exchange(self, code, state, origin):
        entered.set()
        assert await asyncio.to_thread(release.wait, 15)
        return google["identity"]
    monkeypatch.setattr(google_auth.GoogleProvider, "exchange", delayed_exchange)
    with visitor(config) as reader:
        flow = start(reader, token)
        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(finish, reader, flow)
            try:
                assert entered.wait(15)
                changed = admin.patch(f"/api/admin/users/{user['id']}/status", json={
                    "disabled": True, "version": user["version"],
                })
                assert changed.status_code == 200
            finally:
                release.set()
            assert_google_error(pending.result(timeout=15), "google_access_denied")
        assert reader.get("/api/summary").status_code == 401
        current = current_user(admin, user["id"])
        assert current["google_linked"] is False
        assert current["last_login_at"] is None


@pytest.mark.parametrize("updates", [
    {"google_client_id": "test.apps.googleusercontent.com"},
    {"google_client_secret": "secret-without-client"},
    {"google_client_id": "not-a-client", "google_client_secret": "secret"},
    {"google_client_id": "test.apps.googleusercontent.com", "google_client_secret": "contains space"},
    {"google_client_id": "test.apps.googleusercontent.com", "google_client_secret": "secret",
     "public_origin": "http://public.example.org"},
])
def test_google_configuration_fails_closed(config, updates):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{**config.model_dump(), **updates})


def test_activation_migration_preserves_existing_accounts_and_sessions(config):
    environment = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0006"],
        env=environment, check=True, capture_output=True,
    )

    async def legacy_data():
        engine = create_async_engine(config.database_url)
        async with engine.begin() as db:
            await db.execute(text(
                "INSERT INTO dwellings (id,label,coefficient,version) VALUES (1,'1 A',1.00,1)"
            ))
            for index, password_hash, disabled in [
                (1, "synthetic-hash", False), (2, None, False), (3, "synthetic-hash", True),
            ]:
                await db.execute(text(
                    "INSERT INTO users (id,name,email,dwelling_id,password_hash,disabled,"
                    "auth_version,version,invitation_delivery) "
                    "VALUES (:id,'Resident',:email,1,:password_hash,:disabled,7,9,'none')"
                ), {"id": index, "email": f"user{index}@example.org",
                    "password_hash": password_hash, "disabled": disabled})
            await db.execute(UserSession.__table__.insert().values(
                token_hash=auth.access_hash(config, "session", "b" * 64), user_id=1,
                auth_version=7, expires_at=utcnow() + timedelta(hours=1),
            ))
        await engine.dispose()

    asyncio.run(legacy_data())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=environment, check=True, capture_output=True,
    )

    async def verify(db):
        rows = (await db.scalars(select(User).order_by(User.id))).all()
        assert [user.activated for user in rows] == [True, False, True]
        assert [user.disabled for user in rows] == [False, False, True]
        assert all(user.google_subject is None for user in rows)
        assert all((user.auth_version, user.version) == (7, 9) for user in rows)
        assert len((await db.scalars(select(UserSession))).all()) == 1
    database(config, verify)
    with visitor(config) as reader:
        reader.cookies.set(auth.USER_COOKIE, "b" * 64, domain="testserver.local", path="/api")
        assert reader.get("/api/auth/session").json()["user_id"] == 1
        assert reader.get("/api/summary").status_code == 200
