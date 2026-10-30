from sqlalchemy import text

from juntia.db import State
from tests.test_action_migration import migrate
from tests.test_dwelling_layout import READ, layout, save
from tests.test_users import database, dwelling


def test_layout_migration_preserves_legacy_state_and_dwellings(admin, config):
    unit = dwelling(admin)
    directory = admin.get("/api/neighbors").json()
    migrate(config, "downgrade", "0010")
    async def legacy(db):
        await db.execute(text(
            "UPDATE state SET revision = 37, community_name = 'Existing community' WHERE id = 1"
        ))
    database(config, legacy)
    migrate(config, "upgrade", "head")
    async def verify(db):
        state = await db.get(State, 1)
        assert state.revision == 37
        assert state.community_name == "Existing community"
        assert state.dwelling_layout is None
        assert state.dwelling_layout_version == 0
    database(config, verify)
    assert admin.get("/api/admin/dwellings").json() == [unit]
    assert admin.get("/api/neighbors").json() == directory
    assert admin.get(READ).json()["layout"] is None
    assert save(admin, layout(unit["id"], None)).status_code == 200
    saved = admin.get(READ).json()
    result = migrate(config, "downgrade", "0010", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove the dwelling layout" in result.stderr
    assert admin.get(READ).json() == saved
