import asyncio
import logging
import re
import uuid
from collections.abc import Callable
from tempfile import SpooledTemporaryFile
from urllib.parse import urlsplit

from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import queries
from .auth import administrator, reader_session
from .config import Settings, normalize_origin
from .errors import AppError
from .parser import MAX_BYTES

log = logging.getLogger(__name__)
AUTH_BODY_BYTES = 16 * 1024
JSON_BODY_BYTES = 512 * 1024
LAYOUT_BODY_BYTES = 12 * 1024 * 1024
BODY_CHUNK_BYTES = 64 * 1024
MAX_BODY_BYTES = MAX_BYTES + BODY_CHUNK_BYTES
MAX_ACTIVE_MUTATIONS = 16
MAX_ACTIVE_LARGE_BODIES = 4
MAX_ACTIVE_CLIENT_MUTATIONS = 4
UPLOAD_PATH = re.compile(r"/api/(?:admin/imports/preview|actions/items/[^/]+/attachments)")


def body_limit(path: str, method: str) -> int:
    if method == "POST" and (
        UPLOAD_PATH.fullmatch(path)
        or re.fullmatch(r"/api/admin/imports/[^/]+/confirm", path)
    ):
        return MAX_BODY_BYTES
    if method == "PUT" and path == "/api/admin/dwellings/layout":
        return LAYOUT_BODY_BYTES
    if path == "/api/auth/google/start":
        return 2 * AUTH_BODY_BYTES
    if path.startswith(("/api/auth/", "/api/admin/auth/")):
        return AUTH_BODY_BYTES
    return JSON_BODY_BYTES


async def authorize_body(scope: Scope) -> None:
    path = scope.get("path", "").rstrip("/")
    admin = path.startswith("/api/admin/") and not path.startswith("/api/admin/auth/")
    actions = path == "/api/actions" or path.startswith("/api/actions/")
    events = path == "/api/events" or path.startswith("/api/events/")
    if not admin and not actions and not events:
        return
    request = Request(scope)
    async with request.app.state.sessions() as db:
        if admin:
            await administrator(request, db)
        else:
            await reader_session(request, db)
            flags = await queries.feature_flags(db)
            if actions and not flags.actions:
                raise AppError("actions_disabled", 404)
            if events and not flags.events:
                raise AppError("events_disabled", 404)


class SecurityMiddleware:
    def __init__(self, app: ASGIApp, config: Callable[[], Settings]):
        self.app = app
        self.config = config
        self.active_mutations = 0
        self.active_large_bodies = 0
        self.active_clients: dict[str, int] = {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        config = self.config()
        origins = config.public_origins
        request_id = uuid.uuid4().hex

        async def secure_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    (b"x-request-id", request_id.encode()),
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"cache-control", b"no-store"),
                    (
                        b"content-security-policy",
                        b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                        b"img-src 'self' data:; font-src 'self'; connect-src 'self'; "
                        b"frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
                    ),
                ]
                if config.auth_cookie_secure:
                    message["headers"].append((b"strict-transport-security", b"max-age=31536000"))
            await send(message)

        headers = Headers(scope=scope)
        allowed_hosts = {
            *(urlsplit(origin).hostname for origin in origins),
            "localhost",
            "127.0.0.1",
            "::1",
        }
        host_headers = headers.getlist("host")
        try:
            host = (
                urlsplit(normalize_origin("http://" + host_headers[0])).hostname
                if len(host_headers) == 1
                else None
            )
        except ValueError:
            host = None
        if host not in allowed_hosts:
            await JSONResponse({"code": "invalid_host"}, 400)(scope, receive, secure_send)
            return
        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}:
            origin_headers = headers.getlist("origin")
            try:
                origin = normalize_origin(origin_headers[0]) if len(origin_headers) == 1 else None
            except ValueError:
                origin = None
            if origin not in origins or headers.getlist("x-juntia-request") != ["1"]:
                await JSONResponse({"code": "invalid_origin"}, 403)(scope, receive, secure_send)
                return
            path = scope.get("path", "").rstrip("/")
            limit = body_limit(path, scope["method"])
            size_error = (
                "upload_too_large"
                if scope["method"] == "POST" and UPLOAD_PATH.fullmatch(path)
                else "request_too_large"
            )
            lengths = headers.getlist("content-length")
            if lengths:
                if (
                    len(lengths) != 1 or not lengths[0].isascii()
                    or not lengths[0].isdigit() or len(lengths[0]) > 20
                ):
                    await JSONResponse({"code": "invalid_request"}, 400)(
                        scope, receive, secure_send
                    )
                    return
                if int(lengths[0]) > limit:
                    await JSONResponse({"code": size_error}, 413)(scope, receive, secure_send)
                    return
            client = scope["client"][0] if scope.get("client") else "unknown"
            large = limit > JSON_BODY_BYTES
            if (
                self.active_mutations >= MAX_ACTIVE_MUTATIONS
                or self.active_clients.get(client, 0) >= MAX_ACTIVE_CLIENT_MUTATIONS
                or large and self.active_large_bodies >= MAX_ACTIVE_LARGE_BODIES
            ):
                await JSONResponse(
                    {"code": "request_busy"}, 503, headers={"Retry-After": "1"},
                )(scope, receive, secure_send)
                return
            # No await separates admission from reservation on this worker's event loop.
            self.active_mutations += 1
            self.active_large_bodies += int(large)
            self.active_clients[client] = self.active_clients.get(client, 0) + 1
            try:
                try:
                    await authorize_body(scope)
                except AppError as error:
                    await JSONResponse({"code": error.code}, error.status)(
                        scope, receive, secure_send
                    )
                    return
                except SQLAlchemyError as error:
                    log.error("Request authentication unavailable (%s)", type(error).__name__)
                    await JSONResponse({"code": "internal_error"}, 503)(
                        scope, receive, secure_send
                    )
                    return
                with SpooledTemporaryFile(max_size=BODY_CHUNK_BYTES, mode="w+b") as body:
                    size = 0
                    on_disk = False
                    try:
                        async with asyncio.timeout(30):
                            while True:
                                message = await receive()
                                if message["type"] == "http.disconnect":
                                    return
                                chunk = message.get("body", b"")
                                size += len(chunk)
                                if size > limit:
                                    await JSONResponse({"code": size_error}, 413)(
                                        scope, receive, secure_send
                                    )
                                    return
                                if size > BODY_CHUNK_BYTES and not on_disk:
                                    await run_in_threadpool(body.rollover)
                                    on_disk = True
                                await run_in_threadpool(body.write, chunk)
                                if not message.get("more_body"):
                                    break
                        await run_in_threadpool(body.seek, 0)
                    except TimeoutError:
                        await JSONResponse({"code": "request_timeout"}, 408)(
                            scope, receive, secure_send
                        )
                        return
                    except OSError:
                        log.error("Request body could not be staged")
                        await JSONResponse({"code": "request_storage_error"}, 503)(
                            scope, receive, secure_send
                        )
                        return
                    consumed = False

                    async def bounded_receive() -> Message:
                        nonlocal consumed, size
                        if consumed:
                            return await receive()
                        chunk = await run_in_threadpool(body.read, BODY_CHUNK_BYTES)
                        size -= len(chunk)
                        consumed = size == 0
                        return {
                            "type": "http.request", "body": chunk, "more_body": not consumed,
                        }

                    await self.app(scope, bounded_receive, secure_send)
            finally:
                self.active_mutations -= 1
                self.active_large_bodies -= int(large)
                self.active_clients[client] -= 1
                if not self.active_clients[client]:
                    del self.active_clients[client]
        else:
            await self.app(scope, receive, secure_send)
