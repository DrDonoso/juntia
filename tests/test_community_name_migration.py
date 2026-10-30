from sqlalchemy import inspect, select, text

from juntia.db import State
from tests.test_action_migration import migrate
from tests.test_users import database


async def name_default(db):
    connection = await db.connection()
    columns = await connection.run_sync(lambda sync: inspect(sync).get_columns("state"))
    return str(next(column["default"] for column in columns if column["name"] == "community_name"))


async def community_name(db):
    return await db.scalar(select(State.community_name).where(State.id == 1))


def test_community_name_default_is_english_and_existing_names_are_kept(config):
    async def rename(db):
        await db.execute(text("UPDATE state SET community_name = 'Maple Court' WHERE id = 1"))

    database(config, rename)
    assert "Residential community" in database(config, name_default)
    migrate(config, "downgrade", "0018")
    assert "Comunidad de vecinos" in database(config, name_default)
    assert database(config, community_name) == "Maple Court"
    migrate(config, "upgrade", "head")
    assert "Residential community" in database(config, name_default)
    assert database(config, community_name) == "Maple Court"
