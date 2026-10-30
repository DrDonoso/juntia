import unicodedata
from datetime import date, datetime, timedelta, timezone
from functools import cache
from zoneinfo import ZoneInfo

from sqlalchemy import (
    Integer,
    SQLColumnExpression,
    Text,
    case,
    cast,
    event,
    false,
    func,
    literal_column,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

CALENDAR_EPOCH = date(1970, 1, 1)


def fold_text(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFKD", value.casefold())
        if not unicodedata.combining(char)
    )


def local_datetime(value: str | None, zone: str, exclusive_end: bool = False) -> str | None:
    if value is None:
        return None
    instant = datetime.fromisoformat(value)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    if exclusive_end:
        instant -= timedelta(microseconds=1)
    return instant.astimezone(ZoneInfo(zone)).replace(tzinfo=None).isoformat(
        sep=" ", timespec="microseconds",
    )


def local_day_number(value: str | None, zone: str, exclusive_end: bool) -> int | None:
    local = local_datetime(value, zone, exclusive_end)
    return (date.fromisoformat(local[:10]) - CALENDAR_EPOCH).days if local else None


def date_number(
    db: AsyncSession, value: SQLColumnExpression[date] | SQLColumnExpression[date | None],
) -> ColumnElement[int]:
    if db.get_bind().dialect.name == "sqlite":
        return cast(func.julianday(value) - func.julianday(CALENDAR_EPOCH), Integer)
    # asyncpg round-trips Python's date.min/max as PostgreSQL infinities.
    return case(
        (value == literal_column("'infinity'::date"), (date.max - CALENDAR_EPOCH).days),
        (value == literal_column("'-infinity'::date"), (date.min - CALENDAR_EPOCH).days),
        else_=cast(value - CALENDAR_EPOCH, Integer),
    )


@event.listens_for(Engine, "engine_connect")
def sqlite_text_functions(connection: Connection) -> None:
    if connection.dialect.name != "sqlite" or connection.info.get("juntia_text_functions"):
        return
    create_function = getattr(connection.connection.dbapi_connection, "create_function", None)
    if not callable(create_function):
        raise RuntimeError("SQLite Unicode function registration is unavailable")
    create_function("juntia_casefold", 1, str.casefold, deterministic=True)
    create_function("juntia_fold", 1, fold_text, deterministic=True)
    create_function("juntia_local_datetime", 2, local_datetime, deterministic=True)
    create_function("juntia_local_day_number", 3, local_day_number, deterministic=True)
    connection.info["juntia_text_functions"] = True


@cache
def combining_characters() -> str:
    return "".join(chr(code) for code in range(0x110000) if unicodedata.combining(chr(code)))


def binary_text(db: AsyncSession, value: SQLColumnExpression[str]) -> ColumnElement[str]:
    dialect = db.get_bind().dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        raise RuntimeError("Unsupported query database")
    return value.collate("C" if dialect == "postgresql" else "BINARY")


def casefold_sql(db: AsyncSession, value: SQLColumnExpression[str]) -> ColumnElement[str]:
    value = func.coalesce(value, "", type_=Text)
    if db.get_bind().dialect.name == "sqlite":
        return func.juntia_casefold(value, type_=Text)
    return binary_text(
        db, func.casefold(value.collate("pg_unicode_fast"), type_=Text),
    )


def fold_sql(db: AsyncSession, value: SQLColumnExpression[str]) -> ColumnElement[str]:
    if db.get_bind().dialect.name == "sqlite":
        return func.juntia_fold(func.coalesce(value, ""), type_=Text)
    # Unlike translate, a character class does not scan the entire set for every input character.
    return binary_text(db, func.regexp_replace(
        func.normalize(casefold_sql(db, value), literal_column("NFKD"), type_=Text),
        f"[{combining_characters()}]", "", "g", type_=Text,
    ))


def contains_text(
    db: AsyncSession, value: ColumnElement[str], needle: str,
) -> ColumnElement[bool]:
    # PostgreSQL text cannot contain NUL; binding it would turn a no-match search into an error.
    if db.get_bind().dialect.name == "postgresql" and "\0" in needle:
        return false()
    position = func.instr if db.get_bind().dialect.name == "sqlite" else func.strpos
    return position(value, needle) > 0
