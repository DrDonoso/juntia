import json
import secrets
from http.cookies import SimpleCookie

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from juntia.app import create_app
from juntia.config import Settings
from juntia.middleware import SecurityMiddleware
from juntia.parser import MAX_BYTES
from tests.support import ROWS, statement_pdf
from tests.test_api import commit, preview


def test_same_day_refresh_uses_known_bank_order_for_current_balance(admin):
    assert commit(admin, preview(admin)).status_code == 200
    newer = [("02/10/26", "02/10/26", "Later receipt", "-10", "140"), *ROWS]
    assert commit(admin, preview(admin, statement_pdf(rows=newer))).status_code == 200
    summary = admin.get("/api/summary").json()
    assert summary["balance"] == "140.00"
    assert summary["count"] == 4
    assert admin.get("/api/transactions").json()["items"][0]["description"] == "Later receipt"
    assert commit(admin, preview(admin, statement_pdf(rows=ROWS[:1]))).status_code == 200
    assert admin.get("/api/summary").json()["balance"] == "140.00"


def test_credential_rotation_invalidates_old_cookies(admin, config):
    cookie = admin.cookies.get("juntia_admin")
    rotated = config.model_copy(update={"auth_secret": SecretStr(secrets.token_urlsafe(32))})
    with TestClient(create_app(rotated)) as other:
        other.cookies.set("juntia_admin", cookie, domain="testserver.local", path="/api/admin")
        assert other.get("/api/admin/auth/session").json()["authenticated"] is False
        assert other.get("/api/admin/rules").status_code == 401


def test_local_default_credentials_authenticate_with_normal_session_protection(config):
    local = Settings(
        _env_file=None,
        **{
            **config.model_dump(),
            "admin_username": "admin",
            "admin_password": "admin",
            "allow_insecure_local_admin": True,
            "public_origin": "http://localhost:7778",
        },
    )
    with TestClient(create_app(local), base_url=local.public_origin) as client:
        client.headers.update({"origin": local.public_origin, "x-juntia-request": "1"})
        assert client.get("/api/admin/rules").status_code == 401
        response = client.post(
            "/api/admin/auth/login", json={"username": "admin", "password": "admin"}
        )
        assert response.status_code == 200
        assert "httponly" in response.headers["set-cookie"].lower()
        assert client.get("/api/admin/rules").status_code == 200
        assert client.post("/api/admin/auth/logout").status_code == 204
        assert client.get("/api/admin/rules").status_code == 401


def test_blank_credentials_are_rejected_without_echoing_secrets(config):
    values = config.model_dump()
    values["admin_password"] = " " * 20
    with pytest.raises(ValidationError):
        Settings.model_validate(values)
    values["admin_password"] = "short-private-value"
    values["auth_secret"] = " " * 40
    with pytest.raises(ValidationError) as error:
        Settings.model_validate(values)
    assert "short-private-value" not in str(error.value)


def test_foreign_host_and_oversized_request_are_rejected(client):
    assert client.get("/api/summary", headers={"host": "untrusted.invalid"}).status_code == 400
    response = client.post("/api/admin/imports/preview", content=b"x" * (21 * 1024 * 1024))
    assert response.status_code == 413


@pytest.fixture
def multi_origin_config(config):
    return Settings(
        _env_file=None,
        **{
            **config.model_dump(),
            "public_origin": "https://finances.example.com,https://finances.internal.example.com:8443",
            "auth_cookie_secure": True,
        },
    )


@pytest.fixture
def multi_origin_client(multi_origin_config):
    with TestClient(
        create_app(multi_origin_config), base_url=multi_origin_config.public_origins[0]
    ) as client:
        yield client


def test_both_origins_share_state_with_separate_host_only_sessions(
    multi_origin_client, multi_origin_config
):
    client = multi_origin_client
    origins = multi_origin_config.public_origins
    rules = []
    cookies = {}
    for index, origin in enumerate(origins):
        headers = {"origin": origin, "x-juntia-request": "1"}
        assert client.get(f"{origin}/health").json() == {"status": "ok"}
        assert client.get(f"{origin}/api/summary").status_code == 401
        session = client.get(f"{origin}/api/admin/auth/session")
        assert session.json()["authenticated"] is False
        assert "cookie" not in session.request.headers
        assert client.get(f"{origin}/api/admin/rules").status_code == 401
        body = {"name": f"Origin {index}", "description_value": f"Synthetic {index}"}
        assert (
            client.post(f"{origin}/api/admin/rules", json=body, headers=headers).status_code == 401
        )
        response = client.post(
            f"{origin}/api/admin/auth/login",
            headers=headers,
            json={
                "username": multi_origin_config.admin_username,
                "password": multi_origin_config.admin_password.get_secret_value(),
            },
        )
        assert response.status_code == 200, response.text
        cookie = next(
            parsed["juntia_admin"]
            for header in response.headers.get_list("set-cookie")
            if "juntia_admin" in (parsed := SimpleCookie(header))
            and parsed["juntia_admin"]["path"] == "/api"
        )
        assert not cookie["domain"]
        assert cookie["path"] == "/api"
        assert cookie["httponly"] and cookie["secure"]
        assert cookie["samesite"].lower() == "strict"
        assert 0 < int(cookie["max-age"]) <= multi_origin_config.session_hours * 3600
        cookies[origin] = cookie.value
        assert client.get(f"{origin}/api/admin/auth/session").json()["authenticated"] is True
        assert client.get(f"{origin}/api/admin/rules").json() == rules
        response = client.post(f"{origin}/api/admin/rules", json=body, headers=headers)
        assert response.status_code == 201, response.text
        rule_id = response.json()["id"]
        response = client.put(
            f"{origin}/api/admin/rules/{rule_id}",
            json={**body, "name": f"Updated origin {index}"},
            headers=headers,
        )
        assert response.status_code == 200
        rules.append(response.json())
        general = {"community_name": f"Shared community {index}"}
        assert (
            client.patch(
                f"{origin}/api/admin/settings/general", json=general, headers=headers
            ).status_code
            == 200
        )
        other_origin = origins[1 - index]
        assert client.get(f"{other_origin}/api/settings/general").json() == general
        summary = client.get(f"{origin}/api/summary")
        assert summary.status_code == 200
        assert "juntia_admin=" in summary.request.headers["cookie"]
        manifest = client.get(f"{origin}/manifest.webmanifest").json()
        assert manifest["id"] == manifest["start_url"] == manifest["scope"] == "/"
        assert all(icon["src"].startswith("/") for icon in manifest["icons"])

    assert cookies[origins[0]] != cookies[origins[1]]
    for origin in origins:
        assert client.get(f"{origin}/api/admin/rules").json() == rules
    for index, origin in enumerate(origins):
        headers = {"origin": origin, "x-juntia-request": "1"}
        assert (
            client.delete(
                f"{origin}/api/admin/rules/{rules[index]['id']}", headers=headers
            ).status_code
            == 204
        )
        assert client.post(f"{origin}/api/admin/auth/logout", headers=headers).status_code == 204
        assert client.get(f"{origin}/api/summary").status_code == 401
        assert client.get(f"{origin}/api/admin/rules").status_code == 401
        assert (
            client.get(
                f"{origin}/api/admin/rules",
                headers={"cookie": f"juntia_admin={cookies[origin]}"},
            ).status_code
            == 401
        )
        if index == 0:
            assert client.get(f"{origins[1]}/api/admin/rules").json() == rules[1:]


def test_unconfigured_hosts_are_not_trusted_even_with_forwarded_headers(
    multi_origin_client, multi_origin_config
):
    origin = multi_origin_config.public_origins[0]
    for host in [
        "untrusted.example",
        "finances.example.com.attacker.example",
        "not-finances.example.com",
        "subdomain.finances.example.com",
        "finances.internal.example.com.attacker.example",
        "attacker@finances.example.com",
        "finances.example.com:invalid",
        "[::1",
    ]:
        response = multi_origin_client.get(
            "/health",
            headers={
                "host": host,
                "origin": origin,
                "x-forwarded-host": "finances.example.com",
                "x-forwarded-proto": "https",
                "forwarded": 'host="finances.example.com";proto=https',
            },
        )
        assert response.status_code == 400
        assert response.json() == {"code": "invalid_host"}
    response = multi_origin_client.get(
        "/health", headers=[("host", "finances.example.com"), ("host", "untrusted.example")]
    )
    assert response.status_code == 400
    assert response.json() == {"code": "invalid_host"}


def test_invalid_mutation_headers_cannot_change_shared_state(
    multi_origin_client, multi_origin_config
):
    client = multi_origin_client
    origin, other_origin = multi_origin_config.public_origins
    valid_headers = {"origin": origin, "x-juntia-request": "1"}
    assert (
        client.post(
            "/api/admin/auth/login",
            headers=valid_headers,
            json={
                "username": multi_origin_config.admin_username,
                "password": multi_origin_config.admin_password.get_secret_value(),
            },
        ).status_code
        == 200
    )
    body = {"name": "Unchanged rule", "description_value": "Synthetic"}
    response = client.post("/api/admin/rules", headers=valid_headers, json=body)
    assert response.status_code == 201
    rules = client.get("/api/admin/rules").json()
    general = client.get("/api/settings/general").json()
    rule_id = response.json()["id"]
    invalid_headers = [
        [("x-juntia-request", "1")],
        [("origin", origin)],
        [("origin", origin), ("x-juntia-request", "0")],
        [("origin", origin), ("x-juntia-request", "1"), ("x-juntia-request", "0")],
        [("origin", origin), ("origin", other_origin), ("x-juntia-request", "1")],
        [("origin", origin), ("origin", origin), ("x-juntia-request", "1")],
        *[
            [("origin", invalid), ("x-juntia-request", "1")]
            for invalid in [
                "",
                "null",
                "https://untrusted.example",
                "https://finances.example.com.attacker.example",
                "http://finances.example.com",
                "https://finances.example.com:8443",
                "https://finances.internal.example.com",
                "https://finances.example.com:invalid",
                f"{origin},{other_origin}",
                f"{origin} {other_origin}",
                f"{origin}/path",
                f"{origin}?query",
                f"{origin}#fragment",
                "https://operator@finances.example.com",
            ]
        ],
    ]
    mutations = [
        ("POST", "/api/admin/rules", {**body, "name": "Unexpected rule"}),
        ("PUT", f"/api/admin/rules/{rule_id}", {**body, "name": "Unexpected update"}),
        ("PATCH", "/api/admin/settings/general", {"community_name": "Unexpected community"}),
        ("DELETE", f"/api/admin/rules/{rule_id}", None),
    ]
    for headers in invalid_headers:
        for method, path, payload in mutations:
            response = client.request(method, path, headers=headers, json=payload)
            assert response.status_code == 403, (method, headers, response.text)
            assert response.json() == {"code": "invalid_origin"}
    assert client.get("/api/admin/rules").json() == rules
    assert client.get(f"{other_origin}/api/settings/general").json() == general


def test_origin_comparison_uses_normalized_scheme_host_and_port(multi_origin_client):
    for origin in [
        "HTTPS://FINANCES.EXAMPLE.COM:443",
        "https://finances.example.com/",
        "https://FINANCES.INTERNAL.EXAMPLE.COM:8443",
    ]:
        response = multi_origin_client.post(
            "/api/admin/rules",
            json={"name": "Protected rule", "description_value": "Synthetic"},
            headers={"origin": origin, "x-juntia-request": "1"},
        )
        assert response.status_code == 401
        assert response.json() == {"code": "authentication_required"}


def test_multi_origin_health_headers_and_body_limits(multi_origin_client, multi_origin_config):
    for origin in [
        *multi_origin_config.public_origins,
        "http://localhost:7778",
        "http://127.0.0.1:7778",
        "http://[::1]:7778",
    ]:
        response = multi_origin_client.get(f"{origin}/health")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert response.headers["strict-transport-security"] == "max-age=31536000"
        assert "connect-src 'self'" in response.headers["content-security-policy"]
        assert "access-control-allow-origin" not in response.headers
    for origin in multi_origin_config.public_origins:
        response = multi_origin_client.post(
            f"{origin}/api/admin/imports/preview",
            content=b"x" * (MAX_BYTES + 65537),
            headers={"origin": origin, "x-juntia-request": "1"},
        )
        assert response.status_code == 413
        assert response.json() == {"code": "upload_too_large"}
        assert response.headers["cache-control"] == "no-store"


def test_adding_an_origin_preserves_existing_sessions(multi_origin_config):
    origin = multi_origin_config.public_origins[0]
    original = Settings(
        _env_file=None, **{**multi_origin_config.model_dump(), "public_origin": origin}
    )
    with TestClient(create_app(original), base_url=origin) as client:
        assert (
            client.post(
                "/api/admin/auth/login",
                headers={"origin": origin, "x-juntia-request": "1"},
                json={
                    "username": original.admin_username,
                    "password": original.admin_password.get_secret_value(),
                },
            ).status_code
            == 200
        )
        cookies = client.cookies
    with TestClient(create_app(multi_origin_config), base_url=origin, cookies=cookies) as client:
        assert client.get("/api/admin/auth/session").json()["authenticated"] is True
        assert client.get("/api/admin/rules").status_code == 200
        other_origin = multi_origin_config.public_origins[1]
        assert client.get(f"{other_origin}/api/admin/rules").status_code == 401


async def test_multi_origin_body_timeout_keeps_security_headers(multi_origin_config):
    async def app(scope, receive, send):
        pytest.fail("A timed-out request must not reach the application")

    async def receive():
        raise TimeoutError

    middleware = SecurityMiddleware(app, lambda: multi_origin_config)
    for origin in multi_origin_config.public_origins:
        messages = []

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "method": "POST",
            "headers": [
                (b"host", b"finances.example.com"),
                (b"origin", origin.encode()),
                (b"x-juntia-request", b"1"),
            ],
        }
        await middleware(scope, receive, send)
        assert messages[0]["status"] == 408
        assert json.loads(messages[1]["body"]) == {"code": "request_timeout"}
        headers = dict(messages[0]["headers"])
        assert headers[b"cache-control"] == b"no-store"
        assert headers[b"strict-transport-security"] == b"max-age=31536000"
