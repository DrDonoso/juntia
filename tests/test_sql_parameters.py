"""SQL parameters can carry personal data, so database errors must never show them."""

import ast
import logging
import secrets
import traceback
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from juntia import auth
from juntia.app import create_app

ROOT = Path(__file__).resolve().parents[1]
ENGINE_FACTORIES = {
    "create_engine", "create_async_engine", "engine_from_config", "async_engine_from_config",
}


def test_database_errors_through_the_app_hide_bound_parameters(config, caplog):
    secret = "synthetic-sql-parameter-" + secrets.token_hex(8)
    application = create_app(config)

    @application.get("/api/test-database-error")
    async def failing_query(db: auth.DB) -> None:
        await db.execute(text("SELECT 1 FROM missing_table WHERE name = :name"), {"name": secret})

    # The test-only route must precede the SPA catch-all.
    application.router.routes.insert(0, application.router.routes.pop())
    # INFO and above, as in production (the test-only SQLite driver logs parameters at DEBUG).
    with caplog.at_level(logging.INFO), TestClient(application) as client:
        with pytest.raises(DBAPIError) as error:
            client.get("/api/test-database-error")

    # The exception reaches the server's error log with its message and traceback.
    logged = "".join(traceback.format_exception(error.value))
    assert "[SQL parameters hidden due to hide_parameters=True]" in logged
    assert secret not in logged
    assert "Unhandled" in caplog.text
    assert secret not in caplog.text


def test_every_engine_outside_the_tests_hides_sql_parameters():
    sources = [
        ROOT / "seed.py",
        *(ROOT / "src").rglob("*.py"),
        *(ROOT / "scripts").rglob("*.py"),
        *(ROOT / "alembic").rglob("*.py"),
    ]
    engines = []
    for path in sources:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and (
                getattr(node.func, "id", None) in ENGINE_FACTORIES
                or getattr(node.func, "attr", None) in ENGINE_FACTORIES
            ):
                hidden = any(
                    keyword.arg == "hide_parameters"
                    and isinstance(keyword.value, ast.Constant) and keyword.value.value is True
                    for keyword in node.keywords
                )
                engines.append((f"{path.relative_to(ROOT).as_posix()}:{node.lineno}", hidden))
    assert {location.split(":")[0] for location, _ in engines} >= {
        "src/juntia/app.py", "src/juntia/bootstrap.py", "alembic/env.py", "scripts/smoke_server.py",
    }
    assert [location for location, hidden in engines if not hidden] == []
