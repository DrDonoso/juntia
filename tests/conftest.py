import asyncio
import os
import secrets
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia.app import create_app
from juntia.bootstrap import seed
from juntia.config import Settings
from juntia.db import Base
from tests.support import ADMINISTRATOR


@pytest.fixture
def language():
    # Parametrize "language" in a test to run it against an installation in another language.
    return "en"


@pytest.fixture
def config(tmp_path, language):
    url = os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///" + str(tmp_path / "test.db"))
    if url.startswith("postgresql") and make_url(url).database != "juntia_test":
        raise RuntimeError("Integration tests require a dedicated database named juntia_test")

    async def clear():
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
            # Revision 0024 dropped the technical administrator's sessions, which the models no
            # longer know: a test that ends below it leaves the table behind.
            await connection.execute(text("DROP TABLE IF EXISTS sessions"))
            await connection.execute(text("DROP TABLE IF EXISTS alembic_version"))
        await engine.dispose()

    asyncio.run(clear())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env={**os.environ, "DATABASE_URL": url},
        check=True,
        capture_output=True,
    )

    async def initialize():
        engine = create_async_engine(url)
        async with async_sessionmaker(engine)() as db:
            await seed(db, language)
        await engine.dispose()

    asyncio.run(initialize())
    return Settings(
        _env_file=None,
        database_url=url,
        app_language=language,
        auth_secret=secrets.token_urlsafe(32),
        auth_cookie_secure=False,
        google_client_id="",
        google_client_secret="",
        openai_api_key="",
        openai_model="",
        smtp_host="",
        smtp_from="",
        smtp_username="",
        smtp_password="",
        smtp_security="starttls",
        public_origin="http://testserver",
        upload_dir=tmp_path / "uploads",
    )


@pytest.fixture
def client(config):
    # Tests read the shared documents' text themselves (tests/test_document_text.py: read_texts)
    # and run the notifier's rounds themselves (tests/test_push.py: tick).
    with TestClient(create_app(config, text_worker=False, notifier=False)) as client:
        client.headers.update({"origin": "http://testserver", "x-juntia-request": "1"})
        yield client


@pytest.fixture
def admin(client):
    # The first visitor of the new installation creates the administration account.
    response = client.post("/api/auth/setup", json=ADMINISTRATOR)
    assert response.status_code == 201, response.text
    return client
