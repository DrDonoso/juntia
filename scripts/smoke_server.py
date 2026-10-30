"""Loopback-only, disposable synthetic application for browser tests. Never use in production."""

import argparse
import asyncio
import hashlib
import os
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from email.message import EmailMessage
from pathlib import Path
from typing import get_args

import uvicorn
from fastapi import Request
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia import auth, google_auth, mail
from juntia.app import create_app
from juntia.bootstrap import seed
from juntia.config import Language, Settings
from juntia.db import AuthLimit
from juntia.errors import AppError

ROOT = Path(__file__).resolve().parents[1]


async def initialize(url, language):
    engine = create_async_engine(url, hide_parameters=True)
    async with async_sessionmaker(engine)() as db:
        await seed(db, language)
    await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=7889)
    parser.add_argument("--data-dir", type=Path, help="Retain only local preview data in this folder")
    parser.add_argument("--fake-google", action="store_true", help="Synthetic provider for browser tests only")
    parser.add_argument(
        "--language", choices=get_args(Language), default="en",
        help="APP_LANGUAGE for emails and first-run defaults (the web UI follows the browser)",
    )
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    os.chdir(ROOT)
    storage = (
        nullcontext(args.data_dir)
        if args.data_dir else tempfile.TemporaryDirectory(prefix="juntia-browser-")
    )
    with storage as directory:
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        url = "sqlite+aiosqlite:///" + str(root / "smoke.db")
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            env={**os.environ, "DATABASE_URL": url}, check=True,
        )
        asyncio.run(initialize(url, args.language))
        config = Settings(
            _env_file=None,
            database_url=url,
            app_language=args.language,
            admin_username="browser-test",
            admin_password="synthetic-browser-test-password",
            auth_secret="synthetic-browser-secret-not-for-production-123",
            public_origin=f"http://127.0.0.1:{args.port}",
            auth_cookie_secure=False,
            openai_api_key="",
            openai_model="",
            smtp_host="smtp.example.org",
            smtp_from="synthetic-community@example.org",
            smtp_username="",
            smtp_password="",
            smtp_security="starttls",
            google_client_id="synthetic-client.apps.googleusercontent.com" if args.fake_google else "",
            google_client_secret="synthetic-google-secret" if args.fake_google else "",
            upload_dir=root / "uploads",
        )
        messages: list[EmailMessage] = []

        def capture(config: Settings, message: EmailMessage) -> None:
            messages.append(message)

        mail.deliver = capture
        if args.fake_google:
            async def fake_exchange(
                self: google_auth.GoogleProvider, code: str, state: str, origin: str
            ) -> google_auth.GoogleIdentity:
                if not code.startswith("synthetic-code:"):
                    raise AppError("google_invalid_identity", 400)
                email = code.removeprefix("synthetic-code:").lower()
                return google_auth.GoogleIdentity(
                    subject="synthetic-" + hashlib.sha256(email.encode()).hexdigest(), email=email,
                    name="Synthetic Google Resident",
                )
            google_auth.GoogleProvider.exchange = fake_exchange
        app = create_app(config)

        @app.get("/api/admin/test-mailbox")
        async def mailbox(admin: auth.Admin):
            return [{"to": message["To"], "body": message.get_content()} for message in messages]

        # The test-only endpoint must precede the production SPA catch-all.
        app.router.routes.insert(0, app.router.routes.pop())

        @app.post("/api/admin/test-reset-login-attempts", status_code=204)
        async def reset_login_attempts(request: Request, db: auth.DB, admin: auth.Admin) -> None:
            keys = auth.throttle_keys(
                request, "admin-login", config.admin_username, per_client_identity=True,
            )
            await db.execute(delete(AuthLimit).where(AuthLimit.key.in_(keys)))
            await db.commit()

        app.router.routes.insert(0, app.router.routes.pop())

        uvicorn.run(
            app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False
        )


if __name__ == "__main__":
    main()
