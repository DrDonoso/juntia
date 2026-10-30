from sqlalchemy import text

from tests.test_action_migration import migrate
from tests.test_community_events import create_event
from tests.test_feature_flags import set_flag
from tests.test_users import database


def test_event_migration_preserves_state_and_starts_disabled(admin, config):
    migrate(config, "downgrade", "0015")

    async def legacy(db):
        await db.execute(text(
            "UPDATE state SET revision=37, community_name='Legacy', feature_actions=false WHERE id=1"
        ))
    database(config, legacy)
    migrate(config, "upgrade", "head")
    assert admin.get("/api/features").json() == {
        "coefficient": True, "actions": False, "events": False, "google_login": False,
    }

    async def state(db):
        return (await db.execute(text("SELECT revision, community_name FROM state"))).one()
    assert database(config, state) == (37, "Legacy")


def test_downgrade_refuses_active_flag_and_retained_history(admin, config):
    set_flag(admin, "events", True)
    result = migrate(config, "downgrade", "0015", check=False)
    assert result.returncode != 0
    assert "Disable Events before downgrading" in result.stderr
    value = create_event(admin)
    assert admin.request("DELETE", f"/api/events/{value['id']}", json={"version": 1}).status_code == 204
    set_flag(admin, "events", False)
    result = migrate(config, "downgrade", "0015", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove event history" in result.stderr
