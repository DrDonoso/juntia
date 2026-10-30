import asyncio
import json
from tempfile import SpooledTemporaryFile

import pytest

from juntia import middleware
from juntia.config import Settings
from juntia.contracts import ActionIn, ContactIn, DwellingLayoutIn, GoogleStartIn
from juntia.middleware import (
    AUTH_BODY_BYTES,
    BODY_CHUNK_BYTES,
    JSON_BODY_BYTES,
    MAX_ACTIVE_CLIENT_MUTATIONS,
    MAX_ACTIVE_LARGE_BODIES,
    MAX_ACTIVE_MUTATIONS,
    SecurityMiddleware,
    body_limit,
)


@pytest.fixture
def limits_config():
    return Settings(
        _env_file=None, database_url="sqlite+aiosqlite:///:memory:",
        admin_username="synthetic-admin", admin_password="synthetic-admin-password",
        auth_secret="synthetic-secret-for-request-limit-tests",
        public_origin="https://audit.example", auth_cookie_secure=True,
    )


def scope(path="/api/auth/login", *, method="POST", client="192.0.2.1", headers=()):
    return {
        "type": "http", "method": method, "path": path, "client": (client, 1234),
        "headers": [
            (b"host", b"audit.example"), (b"origin", b"https://audit.example"),
            (b"x-juntia-request", b"1"), *headers,
        ],
    }


async def invoke(app, request_scope, chunks=()):
    messages, received = [], []
    pending = iter(chunks)

    async def receive():
        message = next(pending)
        received.append(message)
        return message

    async def send(message):
        messages.append(message)

    await app(request_scope, receive, send)
    return messages, received


def assert_rejection(messages, status, code):
    assert messages[0]["status"] == status
    assert json.loads(messages[1]["body"]) == {"code": code}
    headers = dict(messages[0]["headers"])
    assert headers[b"cache-control"] == b"no-store"
    assert headers[b"strict-transport-security"] == b"max-age=31536000"
    assert b"content-security-policy" in headers


async def reject_downstream(scope, receive, send):
    pytest.fail("Rejected bodies must not reach the parser or route")


@pytest.mark.parametrize("declared", [None, b"1"])
async def test_streamed_login_limit_does_not_trust_content_length(limits_config, declared):
    app = SecurityMiddleware(reject_downstream, lambda: limits_config)
    headers = [(b"content-length", declared)] if declared else []
    messages, received = await invoke(app, scope(headers=headers), [
        {"type": "http.request", "body": b"x" * AUTH_BODY_BYTES, "more_body": True},
        {"type": "http.request", "body": b"x", "more_body": True},
    ])
    assert_rejection(messages, 413, "request_too_large")
    assert len(received) == 2
    assert app.active_mutations == 0
    assert app.active_clients == {}


@pytest.mark.parametrize("headers, status, code", [
    ([(b"content-length", str(AUTH_BODY_BYTES + 1).encode())], 413, "request_too_large"),
    ([(b"content-length", b"-1")], 400, "invalid_request"),
    ([(b"content-length", b"1,1")], 400, "invalid_request"),
    ([(b"content-length", b"1"), (b"content-length", b"1")], 400, "invalid_request"),
    ([(b"content-length", b"9" * 100)], 400, "invalid_request"),
])
async def test_declared_lengths_are_rejected_without_receiving(limits_config, headers, status, code):
    app = SecurityMiddleware(reject_downstream, lambda: limits_config)
    messages, received = await invoke(app, scope(headers=headers))
    assert_rejection(messages, status, code)
    assert received == []


@pytest.mark.parametrize("path,method", [
    ("/api/admin/imports/preview", "POST"),
    ("/api/admin/imports/preview/", "POST"),
    ("/api/actions/items/1/attachments", "POST"),
    ("/api/admin/dwellings/layout", "PUT"),
    ("/api/admin/settings/features/actions", "PATCH"),
    ("/api/admin/imports/00000000-0000-0000-0000-000000000001/confirm", "POST"),
    ("/api/admin/storage/attachments/00000000-0000-0000-0000-000000000001/purge", "POST"),
])
def test_protected_bodies_are_authenticated_before_receiving(client, path, method):
    def unread_body():
        pytest.fail("An unauthenticated upload must not be received")
        yield b"unreachable"

    response = client.request(method, path, content=unread_body(), follow_redirects=False)
    assert response.status_code == 401
    assert response.json() == {"code": "authentication_required"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/actions/items"),
    ("PATCH", "/api/actions/items/1"),
    ("POST", "/api/actions/items/1/attachments"),
    ("POST", "/api/actions/items/1/attachments/"),
    ("DELETE", "/api/actions/items/1/comments/1"),
])
def test_disabled_actions_are_rejected_before_receiving_after_a_live_update(admin, method, path):
    assert admin.patch(
        "/api/admin/settings/features/actions", json={"enabled": False},
    ).status_code == 200

    def unread_body():
        pytest.fail("A disabled feature must not receive request bodies")
        yield b"unreachable"

    response = admin.request(method, path, content=unread_body(), follow_redirects=False)
    assert response.status_code == 404
    assert response.json() == {"code": "actions_disabled"}


@pytest.mark.parametrize("size", [0, AUTH_BODY_BYTES])
async def test_auth_body_boundary_is_replayed_without_changes(limits_config, size):
    seen = []

    async def echo(scope, receive, send):
        message = await receive()
        seen.append(message)
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SecurityMiddleware(echo, lambda: limits_config)
    messages, _ = await invoke(app, scope(), [
        {"type": "http.request", "body": b"x" * size, "more_body": False},
    ])
    assert messages[0]["status"] == 204
    assert seen == [{"type": "http.request", "body": b"x" * size, "more_body": False}]


async def test_large_chunks_spool_before_writing_and_replay_in_bounded_chunks(
    limits_config, monkeypatch,
):
    writes, files, lengths = [], [], []

    class TrackedBody(SpooledTemporaryFile):
        def write(self, data):
            writes.append((len(data), self._rolled))
            return super().write(data)

    def body_file(*args, **kwargs):
        value = TrackedBody(*args, **kwargs)
        files.append(value)
        return value

    monkeypatch.setattr(middleware, "SpooledTemporaryFile", body_file)

    async def consume(scope, receive, send):
        while True:
            message = await receive()
            lengths.append(len(message["body"]))
            assert message["body"] == b"x" * len(message["body"])
            if not message["more_body"]:
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SecurityMiddleware(consume, lambda: limits_config)
    messages, _ = await invoke(app, scope("/api/contacts"), [
        {"type": "http.request", "body": b"x" * JSON_BODY_BYTES, "more_body": False},
    ])
    assert messages[0]["status"] == 204
    assert writes == [(JSON_BODY_BYTES, True)]
    assert sum(lengths) == JSON_BODY_BYTES
    assert max(lengths) <= BODY_CHUNK_BYTES
    assert all(value.closed for value in files)


@pytest.mark.parametrize("budget", ["global", "client", "large"])
async def test_mutation_budgets_reject_without_queueing_and_leave_reads_available(
    limits_config, monkeypatch, budget,
):
    async def authorized(scope):
        return None

    monkeypatch.setattr(middleware, "authorize_body", authorized)
    entered, release = asyncio.Queue(), asyncio.Event()

    async def downstream(request_scope, receive, send):
        if request_scope["method"] == "POST":
            await receive()
            entered.put_nowait(True)
            await release.wait()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    maximum = {
        "global": MAX_ACTIVE_MUTATIONS, "client": MAX_ACTIVE_CLIENT_MUTATIONS,
        "large": MAX_ACTIVE_LARGE_BODIES,
    }[budget]
    path = "/api/admin/imports/preview" if budget == "large" else "/api/auth/login"
    app = SecurityMiddleware(downstream, lambda: limits_config)
    tasks = []
    try:
        for index in range(maximum):
            address = "192.0.2.1" if budget == "client" else f"192.0.2.{index + 1}"
            tasks.append(asyncio.create_task(invoke(app, scope(path, client=address), [
                {"type": "http.request", "body": b"", "more_body": False},
            ])))
        for _ in tasks:
            await asyncio.wait_for(entered.get(), timeout=5)
        address = "192.0.2.1" if budget == "client" else "198.51.100.1"
        messages, received = await invoke(app, scope(path, client=address))
        assert_rejection(messages, 503, "request_busy")
        assert dict(messages[0]["headers"])[b"retry-after"] == b"1"
        assert received == []
        messages, _ = await invoke(app, scope("/health", method="GET"))
        assert messages[0]["status"] == 204
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert app.active_mutations == app.active_large_bodies == 0
    assert app.active_clients == {}
    messages, _ = await invoke(app, scope(path), [
        {"type": "http.request", "body": b"", "more_body": False},
    ])
    assert messages[0]["status"] == 204


async def test_cancellation_disconnect_and_storage_errors_release_admission(limits_config, monkeypatch):
    app = SecurityMiddleware(reject_downstream, lambda: limits_config)
    messages, _ = await invoke(app, scope(), [{"type": "http.disconnect"}])
    assert messages == []
    assert app.active_mutations == 0
    entered = asyncio.Event()

    async def receive():
        entered.set()
        await asyncio.Event().wait()

    async def send(message):
        pytest.fail("Cancellation should not send a fabricated success")

    task = asyncio.create_task(app(scope(), receive, send))
    await asyncio.wait_for(entered.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert app.active_mutations == 0
    assert app.active_clients == {}

    class FailedBody(SpooledTemporaryFile):
        def write(self, data):
            raise OSError("synthetic storage failure")

    monkeypatch.setattr(middleware, "SpooledTemporaryFile", FailedBody)
    messages, _ = await invoke(app, scope(), [
        {"type": "http.request", "body": b"x", "more_body": False},
    ])
    assert_rejection(messages, 503, "request_storage_error")
    assert app.active_mutations == 0
    assert app.active_clients == {}


def test_body_policies_allow_maximum_unicode_contracts():
    name = "\U0001f600" * 150
    document = DwellingLayoutIn(version=0, layout={"zones": [
        {"id": str(zone), "name": name, "columns": 2, "rows": [
            {"id": f"{zone}-{row}", "name": name, "cells": [None, None]}
            for row in range(100)
        ]} for zone in range(50)
    ]})
    contact = ContactIn(
        name=name, phone="+34123456789", notes="\U0001f600" * 20000,
        new_tags=[{"name": f"{index:02}" + "\U0001f600" * 98} for index in range(30)],
    )
    action = ActionIn(
        title="\U0001f600" * 200, description="\U0001f600" * 20000,
        labels=[f"{index:02}" + "\U0001f600" * 98 for index in range(20)],
    )
    google = GoogleStartIn(return_path="/transactions?q=" + "\U0001f600" * 2032)
    for path, method, value in [
        ("/api/admin/dwellings/layout", "PUT", document),
        ("/api/contacts", "POST", contact),
        ("/api/actions/items", "POST", action),
        ("/api/auth/google/start", "POST", google),
    ]:
        encoded = json.dumps(value.model_dump(mode="json"), ensure_ascii=True).encode()
        assert len(encoded) <= body_limit(path, method)
