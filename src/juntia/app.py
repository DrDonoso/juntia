import logging
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import bcrypt
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.responses import FileResponse, JSONResponse
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp

from . import (
    api,
    auth,
    community_actions,
    community_events,
    contacts,
    google_auth,
    queries,
    storage_admin,
    users,
)
from .config import Settings
from .contracts import Contract, reader_route
from .db import State
from .errors import AppError
from .imports import clean_expired
from .middleware import SecurityMiddleware
from .texts import ServerLanguage, texts

log = logging.getLogger(__name__)


class FinanceApp(FastAPI):
    def build_middleware_stack(self) -> ASGIApp:
        return SecurityMiddleware(super().build_middleware_stack(), lambda: self.state.settings)


class HealthOut(Contract):
    status: str


class VersionOut(Contract):
    version: str
    build_date: str


def create_app(config: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        current = config or Settings()
        application.state.settings = current
        current.upload_dir.mkdir(parents=True, exist_ok=True)
        # SQL parameters can hold personal data: keep them out of error messages and logs.
        engine = create_async_engine(current.database_url, pool_pre_ping=True, hide_parameters=True)
        application.state.sessions = async_sessionmaker(engine, expire_on_commit=False)
        application.state.password_hash = bcrypt.hashpw(
            current.admin_password.get_secret_value().encode(), bcrypt.gensalt()
        )
        application.state.google_provider = google_auth.GoogleProvider(current)
        try:
            async with application.state.sessions() as db:
                if await db.get(State, 1) is None:
                    raise RuntimeError("Run migrations and seed before starting the application")
                await clean_expired(db, current.upload_dir)
                await auth.clean_user_access(db)
            yield
        finally:
            await application.state.google_provider.close()
            await engine.dispose()

    application = FinanceApp(
        title="Juntia",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @application.exception_handler(AppError)
    async def known_error(request: Request, error: AppError) -> JSONResponse:
        content: dict[str, object] = {"code": error.code}
        if error.fields:
            content["fields"] = error.fields
        return JSONResponse(content, status_code=error.status)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        content: dict[str, object] = {"code": "invalid_request"}
        path = request.url.path
        if path == "/api/admin/dwellings/layout":
            content["code"] = "dwelling_layout_invalid"
        if path == "/api/events" or path.startswith("/api/events/"):
            fields = community_events.validation_fields(error.errors())
            if fields:
                content["fields"] = fields
        if path == "/api/contacts" or path.startswith("/api/contacts/") or (
            path == "/api/contact-tags" or path.startswith("/api/contact-tags/")
        ) or path.startswith(("/api/admin/contact-tags", "/api/admin/action-labels")):
            fields = contacts.validation_fields(
                error.errors(), tag=path.startswith((
                    "/api/contact-tags", "/api/admin/contact-tags", "/api/admin/action-labels",
                )),
            )
            if fields:
                content["fields"] = fields
        return JSONResponse(content, status_code=422)

    @application.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception) -> JSONResponse:
        # Exception strings can contain SQL parameters or imported personal data.
        log.error(
            "Unhandled %s\n%s",
            type(error).__name__,
            "".join(traceback.format_tb(error.__traceback__)),
        )
        return JSONResponse({"code": "internal_error"}, status_code=500)

    application.include_router(auth.router)
    application.include_router(auth.user_router)
    application.include_router(google_auth.router)
    application.include_router(users.router)
    application.include_router(users.public_router)
    application.include_router(users.profile_router)
    application.include_router(community_actions.router)
    application.include_router(community_actions.admin_router)
    application.include_router(storage_admin.router)
    application.include_router(community_events.router)
    application.include_router(contacts.router)
    application.include_router(api.public_router)
    application.include_router(api.reader)
    application.include_router(api.admin_router)

    @application.get("/health", response_model=HealthOut)
    async def health(db: auth.DB) -> HealthOut:
        if await db.scalar(select(State.id).where(State.id == 1)) != 1:
            raise AppError("not_ready", 503)
        return HealthOut(status="ok")

    @application.get("/api/version", response_model=VersionOut)
    async def version(request: Request) -> VersionOut:
        current = auth.settings(request)
        return VersionOut(version=current.image_tag, build_date=current.build_date)

    @application.get("/manifest.webmanifest", include_in_schema=False)
    async def manifest(db: auth.DB, language: ServerLanguage) -> JSONResponse:
        general = await queries.general_settings(db)
        return JSONResponse(
            {
                "id": "/",
                "name": general.community_name,
                "short_name": general.community_name,
                "description": texts(language).manifest_description,
                "lang": language,
                "dir": "ltr",
                "start_url": "/",
                "scope": "/",
                "display": "standalone",
                "background_color": "#f4f6f9",
                "theme_color": "#123a6b",
                "icons": [
                    {
                        "src": "/icons/icon-192.png",
                        "sizes": "192x192",
                        "type": "image/png",
                        "purpose": "any",
                    },
                    {
                        "src": "/icons/icon-512.png",
                        "sizes": "512x512",
                        "type": "image/png",
                        "purpose": "any",
                    },
                    {
                        "src": "/icons/icon-maskable-512.png",
                        "sizes": "512x512",
                        "type": "image/png",
                        "purpose": "maskable",
                    },
                    {"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"},
                ],
            },
            media_type="application/manifest+json",
        )

    dist = Path("frontend/dist")
    if (dist / "assets").is_dir():
        application.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    if (dist / "fonts").is_dir():
        application.mount("/fonts", StaticFiles(directory=dist / "fonts"), name="fonts")
    if (dist / "icons").is_dir():
        application.mount("/icons", StaticFiles(directory=dist / "icons"), name="icons")

    @application.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path in {"theme-init.js", "icon.svg"} and (dist / path).is_file():
            return FileResponse(dist / path)
        if path not in {
            "",
            "transactions",
            "admin",
            "login",
            "activate",
            "forgot-password",
            "reset-password",
            "profile",
            "neighbors",
        } and not path.startswith("admin/") and not reader_route("/" + path):
            raise AppError("not_found", 404)
        if not (dist / "index.html").is_file():
            raise AppError("frontend_not_built", 503)
        return FileResponse(dist / "index.html")

    return application


app = create_app()
