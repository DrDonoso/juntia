"""Notifications: the alert of a missing bank statement, for the administrators, under the bell
(``/api/notifications``); and what each account reads, dismisses and chooses."""

import datetime as dt
from contextlib import contextmanager
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from juntia.app import create_app
from juntia.db import Notification
from tests.support import statement_pdf
from tests.test_api import commit, preview
from tests.test_users import activate, current_user, database, invite, login
from tests.test_users import mailbox as mailbox

# A statement of November 2026; the default one (tests/support.py) runs from 30 September to
# 2 October 2026.
NOVEMBER = [("05/11/26", "05/11/26", "Water receipt", "-10.00", "140.00")]


def at(config, *moment):
    """A moment of the community's day (``TZ``)."""
    return dt.datetime(*moment, tzinfo=ZoneInfo(config.tz))


def tick(client, moment):
    """One round of the notifier at ``moment``."""
    client.portal.call(client.app.state.notifier.tick, moment)


def import_statement(admin, rows=None):
    response = commit(admin, preview(admin, statement_pdf(rows)))
    assert response.status_code == 200, response.text
    return response.json()


def remove_statement(admin, import_id):
    impact = admin.get(f"/api/admin/statements/{import_id}/removal").json()
    response = admin.request(
        "DELETE", f"/api/admin/statements/{import_id}", json={"revision": impact["revision"]}
    )
    assert response.status_code == 204, response.text


def bell(client):
    response = client.get("/api/notifications")
    assert response.status_code == 200, response.text
    return response.json()


def months(client):
    return [item["params"]["month"] for item in bell(client)["items"]]


def stored(config, user_id):
    async def count(db):
        return await db.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == user_id)
        )
    return database(config, count)


def set_administrator(admin, user_id, administrator):
    user = current_user(admin, user_id)
    response = admin.patch(f"/api/admin/users/{user_id}", json={
        "name": user["name"], "email": user["email"], "dwelling_id": user["dwelling_id"],
        "administrator": administrator, "version": user["version"],
    })
    assert response.status_code == 200, response.text


@contextmanager
def neighbor(config, admin, mailbox):
    """A neighbor, signed in on a client of their own."""
    user, token = invite(admin, mailbox)
    with TestClient(create_app(config, text_worker=False, notifier=False), headers={
        "origin": config.public_origin, "x-juntia-request": "1",
    }) as client:
        activate(client, token)
        assert login(client).status_code == 200
        yield client, user


def test_a_missing_statement_is_told_from_the_first_day_of_the_next_month(admin, config):
    # Without statements there is nothing to watch.
    tick(admin, at(config, 2026, 12, 1, 8))
    assert bell(admin) == {
        "kinds": [{"kind": "statement_missing", "enabled": True}], "unread": 0, "items": [],
    }
    import_statement(admin)
    # October has movements: nothing is missing until November ends.
    tick(admin, at(config, 2026, 11, 30, 23, 59))
    assert months(admin) == []
    tick(admin, at(config, 2026, 12, 1, 0, 0))
    tick(admin, at(config, 2026, 12, 1, 0, 1))
    (alert,) = bell(admin)["items"]
    assert alert == {
        "id": alert["id"], "kind": "statement_missing", "params": {"month": "2026-11"},
        "link": "/admin", "created_at": alert["created_at"], "read": False,
    }
    assert dt.datetime.fromisoformat(alert["created_at"]) == at(config, 2026, 12, 1)
    assert bell(admin)["unread"] == 1
    # In January, December is missing too: the newest first.
    tick(admin, at(config, 2027, 1, 1, 0, 0))
    assert months(admin) == ["2026-12", "2026-11"]


def test_each_alert_follows_its_month(admin, config):
    import_statement(admin)
    tick(admin, at(config, 2026, 12, 1, 8))
    (alert,) = bell(admin)["items"]
    assert admin.post(f"/api/notifications/{alert['id']}/read").status_code == 200
    # Importing November's statement resolves it at once, and it is not created again.
    november = import_statement(admin, NOVEMBER)
    assert bell(admin) == {
        "kinds": [{"kind": "statement_missing", "enabled": True}], "unread": 0, "items": [],
    }
    tick(admin, at(config, 2026, 12, 2, 8))
    assert months(admin) == []
    # Removing it brings the same alert back, read as it was.
    remove_statement(admin, november["id"])
    assert bell(admin)["items"] == [{**alert, "read": True}]
    # Dismissed, it never comes back.
    assert admin.post(f"/api/notifications/{alert['id']}/dismiss").json()["items"] == []
    tick(admin, at(config, 2026, 12, 3, 8))
    assert months(admin) == []


def test_alerts_belong_to_the_active_administrators(admin, config, mailbox):
    import_statement(admin)
    with neighbor(config, admin, mailbox) as (reader, user):
        tick(admin, at(config, 2026, 12, 1, 8))
        assert bell(reader) == {"kinds": [], "unread": 0, "items": []}
        refused = reader.patch(
            "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": False}
        )
        assert (refused.status_code, refused.json()["code"]) == (
            403, "notification_kind_unavailable",
        )
        # Nobody reads or dismisses someone else's.
        (alert,) = bell(admin)["items"]
        for action in ("read", "dismiss"):
            response = reader.post(f"/api/notifications/{alert['id']}/{action}")
            assert (response.status_code, response.json()["code"]) == (
                404, "notification_not_found",
            )
        assert bell(admin)["items"] == [alert]
        # An administrator is told in the next round; without the role, theirs are gone.
        set_administrator(admin, user["id"], True)
        tick(admin, at(config, 2026, 12, 1, 8, 1))
        assert months(reader) == ["2026-11"]
        set_administrator(admin, user["id"], False)
        tick(admin, at(config, 2026, 12, 1, 8, 2))
        assert stored(config, user["id"]) == 0
        assert bell(reader) == {"kinds": [], "unread": 0, "items": []}
        assert months(admin) == ["2026-11"]


def test_reading_dismissing_and_choosing(admin, config):
    import_statement(admin)
    tick(admin, at(config, 2026, 12, 1, 8))
    tick(admin, at(config, 2027, 1, 1, 8))
    december, november = bell(admin)["items"]
    read = admin.post(f"/api/notifications/{november['id']}/read").json()
    assert (read["unread"], [item["read"] for item in read["items"]]) == (1, [False, True])
    assert admin.post("/api/notifications/read-all").json()["unread"] == 0
    # Turned off, they are not listed; turned on, they are back.
    off = admin.patch(
        "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": False}
    )
    assert off.json() == {
        "kinds": [{"kind": "statement_missing", "enabled": False}], "unread": 0, "items": [],
    }
    on = admin.patch(
        "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": True}
    ).json()
    assert on["kinds"] == [{"kind": "statement_missing", "enabled": True}]
    assert [item["id"] for item in on["items"]] == [december["id"], november["id"]]
    dismissed = admin.post(f"/api/notifications/{december['id']}/dismiss").json()
    assert [item["id"] for item in dismissed["items"]] == [november["id"]]
    assert admin.post("/api/notifications/2147483647/read").status_code == 404
    assert admin.post("/api/notifications/0/read").status_code == 422
    unknown = admin.patch(
        "/api/notifications/preferences", json={"kind": "unknown", "enabled": False}
    )
    assert unknown.status_code == 422
    # Dismissed ones are forgotten 90 days later.
    tick(admin, at(config, 2099, 12, 1, 8))
    assert months(admin) == ["2099-11", "2026-11"]
    assert stored(config, admin.get("/api/auth/session").json()["user_id"]) == 2
    assert admin.post("/api/auth/logout").status_code == 204
    assert admin.get("/api/notifications").status_code == 401
