import asyncio
import os

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from juntia.db import Base


def migrate(connection):
    context.configure(
        connection=connection, target_metadata=Base.metadata, transactional_ddl=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run():
    engine = create_async_engine(os.environ["DATABASE_URL"], hide_parameters=True)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine.sync_engine, "connect")
        def sqlite_connect(connection, record):
            connection.isolation_level = None

        @event.listens_for(engine.sync_engine, "begin")
        def sqlite_begin(connection):
            connection.exec_driver_sql("BEGIN")

    async with engine.connect() as connection:
        await connection.run_sync(migrate)
    await engine.dispose()


asyncio.run(run())
