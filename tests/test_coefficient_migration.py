import asyncio
import os
import subprocess
import sys
from decimal import Decimal

from sqlalchemy import inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from juntia.db import Dwelling, State, User
from tests.support import iban


def test_coefficient_migration_rounds_existing_values_and_preserves_associations(config):
    environment = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0003"],
        env=environment, check=True, capture_output=True,
    )
    values = ["0.004900", "0.005000", "1.234567", "8.125000", "99.995000", "12.500000"]

    async def seed_existing():
        engine = create_async_engine(config.database_url)
        async with async_sessionmaker(engine)() as db:
            for index, value in enumerate(values, start=1):
                await db.execute(text(
                    "INSERT INTO dwellings (id, label, coefficient, version) "
                    "VALUES (:id, :label, :coefficient, 7)"
                ), {"id": index, "label": f"Legacy {index}", "coefficient": Decimal(value)
                    if config.database_url.startswith("postgresql") else value})
            await db.execute(text(
                "INSERT INTO users (name, email, dwelling_id, disabled, auth_version, version, "
                "invitation_delivery) VALUES "
                "('Existing resident', 'existing@example.org', 4, false, 1, 1, 'none')"
            ))
            await db.execute(text("UPDATE state SET revision = 42 WHERE id = 1"))
            await db.execute(text(
                "INSERT INTO accounts (id, iban, name) VALUES (1, :iban, 'Existing account')"
            ), {"iban": iban()})
            await db.commit()
        await engine.dispose()

    asyncio.run(seed_existing())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=environment, check=True, capture_output=True,
    )

    async def verify():
        engine = create_async_engine(config.database_url)
        async with async_sessionmaker(engine)() as db:
            dwellings = (await db.scalars(select(Dwelling).order_by(Dwelling.id))).all()
            assert [row.coefficient for row in dwellings] == list(map(
                Decimal, ["0.00", "0.01", "1.23", "8.13", "100.00", "12.50"]
            ))
            assert [row.version for row in dwellings] == [8, 8, 8, 8, 8, 7]
            assert (await db.scalar(select(User))).dwelling_id == 4
            assert (await db.get(State, 1)).revision == 42
            assert await db.scalar(text("SELECT iban FROM accounts WHERE id=1")) == iban()
        async with engine.connect() as connection:
            columns = await connection.run_sync(
                lambda sync: inspect(sync).get_columns("dwellings")
            )
            numeric = next(column["type"] for column in columns if column["name"] == "coefficient")
            assert (numeric.precision, numeric.scale) == (5, 2)
        await engine.dispose()

    asyncio.run(verify())
