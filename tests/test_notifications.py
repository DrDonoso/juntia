"""Notifications under the bell (``/api/notifications``): the alert of a missing bank statement for
the administrators; the news of the community for every account (the accounts of a month, the
actions and their comments, the events and their reminders); and what each account reads,
dismisses and chooses. Push messages: tests/test_push.py."""

import datetime as dt
from contextlib import contextmanager
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from juntia import notifications
from juntia.app import create_app
from juntia.db import Notification
from tests.support import statement_pdf
from tests.test_action_pdfs import upload
from tests.test_api import commit, preview
from tests.test_community_actions import create_item, item_path
from tests.test_community_events import create_event, event_body
from tests.test_community_events import path as event_path
from tests.test_feature_flags import set_flag
from tests.test_users import activate, current_user, database, invite, login
from tests.test_users import mailbox as mailbox

# A statement of November 2026; the default one (tests/support.py) runs from 30 September to
# 2 October 2026.
NOVEMBER = [("05/11/26", "05/11/26", "Water receipt", "-10.00", "140.00")]
# The kinds of an administrator and of a neighbor while Events is off, as at first.
ADMINISTRATOR_KINDS = ["statement_missing", "accounts_ready", "action_changes", "action_comments"]
NEIGHBOR_KINDS = ADMINISTRATOR_KINDS[1:]
MEETING = {
    "title": "Owners' meeting", "description": "", "location": "Portal",
    "starts_at": "2030-03-05T19:00:00", "ends_at": "2030-03-05T21:00:00",
}


def at(config, *moment):
    """A moment of the community's day (``TZ``)."""
    return dt.datetime(*moment, tzinfo=ZoneInfo(config.tz))


def tick(client, moment):
    """One round of the notifier at ``moment``."""
    client.portal.call(client.app.state.notifier.tick, moment)


@pytest.fixture
def clock(monkeypatch):
    """What the notifications take as now while someone acts (``clock["now"]``); the notifier's
    rounds have their own (``tick``). In UTC, as ``utcnow``."""
    moment = {"now": dt.datetime.now(dt.timezone.utc)}
    monkeypatch.setattr(
        notifications, "utcnow", lambda: moment["now"].astimezone(dt.timezone.utc)
    )
    return moment


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


def items(client, kind=None):
    return [item for item in bell(client)["items"] if kind in (None, item["kind"])]


def told(client, kind=None):
    """(kind, parameters, page, read) of the notifications under the bell, newest first."""
    return [
        (item["kind"], item["params"], item["link"], item["read"]) for item in items(client, kind)
    ]


def kinds(client):
    return [kind["kind"] for kind in bell(client)["kinds"]]


def months(client):
    return [item["params"]["month"] for item in items(client)]


def stored(config, user_id):
    async def count(db):
        return await db.scalar(
            select(func.count()).select_from(Notification).where(Notification.user_id == user_id)
        )
    return database(config, count)


def act(client, notification, action):
    response = client.post(f"/api/notifications/{notification['id']}/{action}")
    assert response.status_code == 200, response.text
    return response.json()


def set_administrator(admin, user_id, administrator):
    user = current_user(admin, user_id)
    response = admin.patch(f"/api/admin/users/{user_id}", json={
        "name": user["name"], "email": user["email"], "dwelling_id": user["dwelling_id"],
        "administrator": administrator, "version": user["version"],
    })
    assert response.status_code == 200, response.text


def edit_action(client, item, **fields):
    current = client.get(item_path(item)).json()
    response = client.patch(item_path(item), json={"version": current["version"], **fields})
    assert response.status_code == 200, response.text
    return response.json()


def comment(client, item, body):
    response = client.post(item_path(item) + "/comments", json={"body": body})
    assert response.status_code == 201, response.text


def edit_event(client, event, **fields):
    current = client.get(event_path(event)).json()
    body = event_body(**{
        name: current[name] for name in (
            "title", "description", "location", "all_day", "starts_on", "ends_on",
        )
    })
    if not current["all_day"]:
        zone = ZoneInfo(body["timezone"])
        for name in ("starts_at", "ends_at"):
            moment = dt.datetime.fromisoformat(current[name]).astimezone(zone)
            body[name] = moment.replace(tzinfo=None).isoformat()
    response = client.patch(event_path(event), json={
        **body, **fields, "version": current["version"],
    })
    assert response.status_code == 200, response.text
    return response.json()


def delete_event(client, event):
    current = client.get(event_path(event)).json()
    response = client.request("DELETE", event_path(event), json={"version": current["version"]})
    assert response.status_code == 204, response.text


@contextmanager
def neighbor(config, admin, mailbox, email="resident@example.org", dwelling_id=None):
    """A neighbor, signed in on a client of their own."""
    user, token = invite(admin, mailbox, email, dwelling_id)
    with TestClient(create_app(config, text_worker=False, notifier=False), headers={
        "origin": config.public_origin, "x-juntia-request": "1",
    }) as client:
        activate(client, token)
        assert login(client, email).status_code == 200
        yield client, user


def test_a_missing_statement_is_told_from_the_first_day_of_the_next_month(admin, config):
    # Without statements there is nothing to watch.
    tick(admin, at(config, 2026, 12, 1, 8))
    assert (bell(admin)["unread"], items(admin)) == (0, [])
    import_statement(admin)
    # October has movements: nothing is missing until November ends.
    tick(admin, at(config, 2026, 11, 30, 23, 59))
    assert months(admin) == []
    tick(admin, at(config, 2026, 12, 1, 0, 0))
    tick(admin, at(config, 2026, 12, 1, 0, 1))
    (alert,) = items(admin)
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
    (alert,) = items(admin)
    act(admin, alert, "read")
    # Importing November's statement resolves it at once, and it is not created again.
    november = import_statement(admin, NOVEMBER)
    assert (bell(admin)["unread"], items(admin)) == (0, [])
    tick(admin, at(config, 2026, 12, 2, 8))
    assert months(admin) == []
    # Removing it brings the same alert back, read as it was.
    remove_statement(admin, november["id"])
    assert items(admin) == [{**alert, "read": True}]
    # Dismissed, it never comes back.
    assert act(admin, alert, "dismiss")["items"] == []
    tick(admin, at(config, 2026, 12, 3, 8))
    assert months(admin) == []


def test_alerts_belong_to_the_active_administrators(admin, config, mailbox):
    import_statement(admin)
    with neighbor(config, admin, mailbox) as (reader, user):
        tick(admin, at(config, 2026, 12, 1, 8))
        assert (kinds(reader), items(reader)) == (NEIGHBOR_KINDS, [])
        refused = reader.patch(
            "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": False}
        )
        assert (refused.status_code, refused.json()["code"]) == (
            403, "notification_kind_unavailable",
        )
        # Nobody reads or dismisses someone else's.
        (alert,) = items(admin)
        for action in ("read", "dismiss"):
            response = reader.post(f"/api/notifications/{alert['id']}/{action}")
            assert (response.status_code, response.json()["code"]) == (
                404, "notification_not_found",
            )
        assert items(admin) == [alert]
        # An administrator is told in the next round; without the role, theirs are gone.
        set_administrator(admin, user["id"], True)
        tick(admin, at(config, 2026, 12, 1, 8, 1))
        assert months(reader) == ["2026-11"]
        set_administrator(admin, user["id"], False)
        tick(admin, at(config, 2026, 12, 1, 8, 2))
        assert stored(config, user["id"]) == 0
        assert (kinds(reader), items(reader)) == (NEIGHBOR_KINDS, [])
        assert months(admin) == ["2026-11"]


def test_reading_dismissing_and_choosing(admin, config):
    import_statement(admin)
    tick(admin, at(config, 2026, 12, 1, 8))
    tick(admin, at(config, 2027, 1, 1, 8))
    december, november = items(admin)
    read = act(admin, november, "read")
    assert (read["unread"], [item["read"] for item in read["items"]]) == (1, [False, True])
    assert admin.post("/api/notifications/read-all").json()["unread"] == 0
    # Turned off, they are not listed; turned on, they are back.
    off = admin.patch(
        "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": False}
    ).json()
    assert off["kinds"][0] == {"kind": "statement_missing", "enabled": False}
    assert (off["unread"], off["items"]) == (0, [])
    on = admin.patch(
        "/api/notifications/preferences", json={"kind": "statement_missing", "enabled": True}
    ).json()
    assert on["kinds"][0] == {"kind": "statement_missing", "enabled": True}
    assert [item["id"] for item in on["items"]] == [december["id"], november["id"]]
    dismissed = act(admin, december, "dismiss")
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


def test_the_kinds_follow_the_role_and_the_sections_turned_on(admin, config, mailbox):
    with neighbor(config, admin, mailbox) as (reader, _):
        assert kinds(admin) == ADMINISTRATOR_KINDS
        assert kinds(reader) == NEIGHBOR_KINDS
        # Days are told against the community's date.
        today = dt.datetime.now(ZoneInfo(config.tz)).date()
        assert bell(reader)["today"] in {today.isoformat(), (today + dt.timedelta(1)).isoformat()}
        set_flag(admin, "events", True)
        assert kinds(reader) == [*NEIGHBOR_KINDS, "event_changes", "event_reminder"]
        set_flag(admin, "actions", False)
        assert kinds(reader) == ["accounts_ready", "event_changes", "event_reminder"]
        refused = reader.patch(
            "/api/notifications/preferences", json={"kind": "action_changes", "enabled": False}
        )
        assert (refused.status_code, refused.json()["code"]) == (
            403, "notification_kind_unavailable",
        )
        chosen = reader.patch(
            "/api/notifications/preferences", json={"kind": "event_reminder", "enabled": False}
        ).json()
        assert chosen["kinds"] == [
            {"kind": "accounts_ready", "enabled": True},
            {"kind": "event_changes", "enabled": True},
            {"kind": "event_reminder", "enabled": False},
        ]


def test_the_accounts_of_the_month_that_ended_are_told_once(admin, config, mailbox, clock):
    # The month that ended last is March 2030.
    clock["now"] = at(config, 2030, 4, 2, 10)
    with neighbor(config, admin, mailbox) as (reader, _):
        # A statement of earlier months tells nothing.
        import_statement(admin, [("10/02/30", "10/02/30", "Water receipt", "-10.00", "140.00")])
        assert items(reader) == []
        march = import_statement(
            admin, [("05/03/30", "05/03/30", "Lift maintenance", "-50.00", "90.00")]
        )
        accounts = ("accounts_ready", {"month": "2030-03"}, "/?start=2030-03-01&end=2030-03-31")
        # Not who imported it.
        assert told(reader) == [(*accounts, False)]
        assert items(admin) == []
        # More movements of March tell nothing more.
        later = import_statement(
            admin, [("20/03/30", "20/03/30", "Cleaning receipt", "-20.00", "70.00")]
        )
        assert told(reader) == [(*accounts, False)]
        # Once March has no movements, it is resolved; it comes back with them.
        remove_statement(admin, march["id"])
        assert told(reader) == [(*accounts, False)]
        remove_statement(admin, later["id"])
        assert items(reader) == []
        import_statement(admin, [("05/03/30", "05/03/30", "Lift maintenance", "-50.00", "90.00")])
        assert told(reader) == [(*accounts, False)]


def test_actions_tell_every_other_account_once_with_the_latest(admin, config, mailbox, clock):
    clock["now"] = at(config, 2030, 3, 4, 10)
    with neighbor(config, admin, mailbox) as (reader, user):
        item = create_item(admin, "Leak in the garage")
        link = f"/actions/{item['id']}"
        news = {"title": "Leak in the garage", "status": "detected", "change": "created"}
        # Not who created it.
        assert items(admin) == []
        assert told(reader) == [("action_changes", news, link, False)]
        (first,) = items(reader)
        assert dt.datetime.fromisoformat(first["created_at"]) == clock["now"]
        # Still unread, a new status keeps it new.
        edit_action(admin, item, status="voting")
        assert told(reader) == [("action_changes", {**news, "status": "voting"}, link, False)]
        # Once read, the next status is news again, at the top.
        act(reader, first, "read")
        clock["now"] = at(config, 2030, 3, 4, 11)
        edit_action(admin, item, status="done")
        news = {**news, "status": "done", "change": "status"}
        (second,) = items(reader)
        assert (second["id"], second["params"], second["read"]) == (first["id"], news, False)
        assert dt.datetime.fromisoformat(second["created_at"]) == clock["now"]
        # A new title alone tells nobody: it renames what was told.
        act(reader, second, "read")
        edit_action(admin, item, title="Leak in the car park", description="Water on the floor")
        news = {**news, "title": "Leak in the car park"}
        assert told(reader) == [("action_changes", news, link, True)]
        # Dismissed, it comes back with the next news.
        act(reader, second, "dismiss")
        edit_action(admin, item, title="Leak in the garage")
        assert items(reader) == []
        edit_action(admin, item, status="in_progress")
        news = {**news, "title": "Leak in the garage", "status": "in_progress"}
        assert told(reader) == [("action_changes", news, link, False)]
        # What the reader does tells the administrator, and reads what the reader was told.
        edit_action(reader, item, status="done")
        assert told(admin) == [("action_changes", {**news, "status": "done"}, link, False)]
        assert told(reader) == [("action_changes", news, link, True)]
        # Forgotten 90 days after it came.
        tick(admin, at(config, 2030, 6, 2, 10))
        assert len(items(reader)) == 1
        tick(admin, at(config, 2030, 6, 3, 10))
        assert (items(reader), stored(config, user["id"])) == ([], 0)


def test_comments_and_pdfs_tell_who_follows_the_action(admin, config, mailbox):
    with (
        neighbor(config, admin, mailbox) as (reader, first),
        neighbor(config, admin, mailbox, "second@example.org", first["dwelling_id"]) as (other, _),
    ):
        item = create_item(admin, "Leak in the garage")
        link = f"/actions/{item['id']}"

        def contributions(client):
            return [(item["params"], item["read"]) for item in items(client, "action_comments")]

        # Nobody follows it but who created it.
        comment(admin, item, "The plumber is coming")
        assert contributions(reader) == contributions(other) == []
        # Commenting follows it.
        comment(reader, item, "Thanks")
        news = {
            "title": "Leak in the garage", "comments": "1", "attachments": "0",
            "author": "Synthetic Resident",
        }
        assert told(admin, "action_comments") == [("action_comments", news, link, False)]
        # Until read, one notification counts them all, with who sent the latest.
        comment(reader, item, "It is getting worse")
        assert upload(reader, item).status_code == 201
        assert contributions(admin) == [({**news, "comments": "2", "attachments": "1"}, False)]
        # Once read, it starts again.
        (notification,) = items(admin, "action_comments")
        act(admin, notification, "read")
        comment(reader, item, "Still leaking")
        assert contributions(admin) == [(news, False)]
        # The administrator answers: the reader is told, and the administrator's own is read.
        comment(admin, item, "The plumber comes on Monday")
        assert contributions(reader) == [({**news, "author": "Synthetic Administrator"}, False)]
        assert contributions(admin) == [(news, True)]
        # Who never took part is told about the action, not about its comments.
        assert [item["kind"] for item in items(other)] == ["action_changes"]


def test_renaming_a_label_follows_none_of_its_actions(admin, config, mailbox):
    with (
        neighbor(config, admin, mailbox) as (reader, first),
        neighbor(config, admin, mailbox, "second@example.org", first["dwelling_id"]) as (other, _),
    ):
        item = create_item(reader, "Leak in the garage", labels=["Water"])
        (label,) = item["labels"]
        renamed = admin.patch(f"/api/admin/action-labels/{label['id']}", json={
            "name": "Leaks", "color": "#336699", "version": label["version"],
        })
        assert renamed.status_code == 200, renamed.text
        # Only who created it follows it; the administrator recorded the new label on it.
        comment(other, item, "Same here")
        assert items(admin, "action_comments") == []
        assert [item["params"]["author"] for item in items(reader, "action_comments")] == [
            "Synthetic Resident",
        ]


def test_events_tell_their_news_until_they_end(admin, config, mailbox, clock):
    set_flag(admin, "events", True)
    clock["now"] = at(config, 2030, 3, 1, 10)
    with neighbor(config, admin, mailbox) as (reader, _):
        event = create_event(admin, **MEETING)
        link = f"/events/{event['id']}"
        news = {
            "title": "Owners' meeting", "day": "2030-03-05", "time": "19:00",
            "location": "Portal", "change": "created",
        }
        assert items(admin) == []
        assert told(reader) == [("event_changes", news, link, False)]
        (notification,) = items(reader)
        # Moved while still unread: still new, at its new time.
        edit_event(admin, event, starts_at="2030-03-05T20:00:00", ends_at="2030-03-05T22:00:00")
        news = {**news, "time": "20:00"}
        assert told(reader) == [("event_changes", news, link, False)]
        # Once read, another place is news.
        act(reader, notification, "read")
        edit_event(admin, event, location="Garden")
        news = {**news, "location": "Garden", "change": "changed"}
        assert told(reader) == [("event_changes", news, link, False)]
        # Another description tells nobody; another title renames what was told.
        act(reader, notification, "read")
        edit_event(admin, event, description="Bring the minutes", title="General meeting")
        news = {**news, "title": "General meeting"}
        assert told(reader) == [("event_changes", news, link, True)]
        # Deleted, it is cancelled.
        delete_event(admin, event)
        news = {**news, "change": "cancelled"}
        assert told(reader) == [("event_changes", news, link, False)]
        # Resolved when it would have ended.
        tick(admin, at(config, 2030, 3, 5, 21, 59))
        assert told(reader) == [("event_changes", news, link, False)]
        tick(admin, at(config, 2030, 3, 5, 22))
        assert items(reader) == []
        # Events that already ended tell nothing; those of a whole day have no time.
        create_event(admin, starts_at="2020-01-01T10:00:00", ends_at="2020-01-01T11:00:00")
        day = create_event(
            admin, title="Cleaning day", all_day=True, starts_at=None, ends_at=None,
            starts_on="2030-04-10", ends_on="2030-04-11",
        )
        assert told(reader) == [(
            "event_changes",
            {
                "title": "Cleaning day", "day": "2030-04-10", "time": "", "location": "Portal",
                "change": "created",
            },
            f"/events/{day['id']}", False,
        )]


def test_events_are_reminded_to_everyone_a_day_before(admin, config, mailbox):
    set_flag(admin, "events", True)
    with neighbor(config, admin, mailbox) as (reader, _):
        event = create_event(admin, **MEETING)
        link = f"/events/{event['id']}"
        reminder = {
            "title": "Owners' meeting", "day": "2030-03-05", "time": "19:00", "location": "Portal",
        }
        tick(admin, at(config, 2030, 3, 4, 18, 59))
        assert items(admin, "event_reminder") == []
        # Its author too.
        tick(admin, at(config, 2030, 3, 4, 19))
        for client in (admin, reader):
            assert told(client, "event_reminder") == [("event_reminder", reminder, link, False)]
        tick(admin, at(config, 2030, 3, 4, 19, 1))
        assert len(items(reader, "event_reminder")) == 1
        # Moved, its reminder goes; another comes a day before its new start.
        edit_event(admin, event, starts_at="2030-03-06T19:00:00", ends_at="2030-03-06T21:00:00")
        assert items(reader, "event_reminder") == []
        tick(admin, at(config, 2030, 3, 5, 19))
        reminder = {**reminder, "day": "2030-03-06"}
        assert told(reader, "event_reminder") == [("event_reminder", reminder, link, False)]
        # Another place is told in it too, and it is resolved when the event starts.
        edit_event(admin, event, location="Garden")
        reminder = {**reminder, "location": "Garden"}
        assert told(reader, "event_reminder") == [("event_reminder", reminder, link, False)]
        tick(admin, at(config, 2030, 3, 6, 19))
        assert items(reader, "event_reminder") == []
        # An event of a whole day, from midnight of the day before; deleted, its reminder goes.
        day = create_event(
            admin, title="Cleaning day", all_day=True, starts_at=None, ends_at=None,
            starts_on="2030-04-10", ends_on="2030-04-11",
        )
        tick(admin, at(config, 2030, 4, 8, 23, 59))
        assert items(reader, "event_reminder") == []
        tick(admin, at(config, 2030, 4, 9))
        assert told(reader, "event_reminder") == [(
            "event_reminder",
            {"title": "Cleaning day", "day": "2030-04-10", "time": "", "location": "Portal"},
            f"/events/{day['id']}", False,
        )]
        delete_event(admin, day)
        assert items(reader, "event_reminder") == []
        # Without Events, nobody is reminded; once it is back, they are.
        later = create_event(
            admin, **{**MEETING, "starts_at": "2030-05-10T19:00:00", "ends_at": "2030-05-10T20:00:00"},
        )
        set_flag(admin, "events", False)
        tick(admin, at(config, 2030, 5, 9, 19))
        set_flag(admin, "events", True)
        assert items(reader, "event_reminder") == []
        tick(admin, at(config, 2030, 5, 9, 19, 1))
        assert [item["link"] for item in items(reader, "event_reminder")] == [
            f"/events/{later['id']}",
        ]


def test_an_event_set_less_than_a_day_before_it_starts_is_not_reminded(admin, config, mailbox):
    set_flag(admin, "events", True)
    zone = ZoneInfo(config.tz)
    soon = (dt.datetime.now(zone) + dt.timedelta(hours=3)).replace(second=0, microsecond=0)
    with neighbor(config, admin, mailbox) as (reader, _):
        create_event(
            admin, starts_at=soon.replace(tzinfo=None).isoformat(),
            ends_at=(soon + dt.timedelta(hours=1)).replace(tzinfo=None).isoformat(),
        )
        # Its news told everybody.
        assert [item["kind"] for item in items(reader)] == ["event_changes"]
        tick(admin, dt.datetime.now(zone) + dt.timedelta(minutes=1))
        assert [item["kind"] for item in items(reader)] == ["event_changes"]


def test_push_texts_tell_what_happened_in_the_language_of_each_device():
    today = dt.date(2030, 3, 4)

    def text(kind, language="en", **params):
        return notifications.push_text(kind, params, language, today)

    assert text("accounts_ready", month="2030-03") == (
        "The accounts of March 2030 are ready",
        "See the month's income and expenses in Finances > Overview.",
    )
    assert text("accounts_ready", "es", month="2030-03") == (
        "Ya están las cuentas de marzo de 2030",
        "Consulta los ingresos y gastos del mes en Gastos > Resumen.",
    )
    assert text("action_changes", title="Leak", status="voting", change="created") == (
        "New action: Leak", "Status: Voting",
    )
    assert text("action_changes", "es", title="Leak", status="in_progress", change="status") == (
        "Leak", "Ahora: En ejecución",
    )
    base = {"title": "Leak", "author": "Ana"}
    assert text("action_comments", **base, comments="1", attachments="0") == (
        "Leak", "New comment by Ana",
    )
    assert text("action_comments", "es", **base, comments="0", attachments="1") == (
        "Leak", "Nuevo PDF de Ana",
    )
    assert text("action_comments", **base, comments="3", attachments="0")[1] == "3 new comments"
    assert text("action_comments", "es", **base, comments="0", attachments="2")[1] == (
        "2 PDF nuevos"
    )
    assert text("action_comments", **base, comments="2", attachments="1")[1] == (
        "2 new comments and 1 new PDF"
    )
    assert text("action_comments", "es", **base, comments="1", attachments="1")[1] == (
        "1 comentario y 1 PDF nuevos"
    )
    meeting = {"title": "Meeting", "day": "2030-03-05", "time": "19:00", "location": "Portal"}
    assert text("event_reminder", **meeting) == (
        "Tomorrow: Meeting", "Tuesday 5 March, 19:00 · Portal",
    )
    assert text("event_reminder", "es", **meeting) == (
        "Mañana: Meeting", "Martes 5 de marzo, 19:00 · Portal",
    )
    assert text("event_reminder", **{**meeting, "day": "2030-03-04"})[0] == "Today: Meeting"
    assert text("event_reminder", "es", **{**meeting, "day": "2030-03-04"})[0] == "Hoy: Meeting"
    assert text("event_reminder", **{**meeting, "day": "2030-03-07"})[0] == "Reminder: Meeting"
    assert text("event_changes", **meeting, change="cancelled") == (
        "Event cancelled: Meeting", "Tuesday 5 March, 19:00 · Portal",
    )
    # A whole day of another year, nowhere in particular.
    assert text(
        "event_changes", "es", title="Limpieza", day="2031-01-15", time="", location="",
        change="created",
    ) == ("Nuevo evento: Limpieza", "Miércoles 15 de enero de 2031")
    # What cannot be told is not sent.
    assert text("action_changes", title="Leak", status="unknown", change="status") is None
    assert text("action_comments", title="Leak", comments="0", attachments="0") is None
    assert text("event_changes", **meeting, change="unknown") is None
    assert text("event_reminder", title="Meeting", day="soon") is None
    assert text("unknown", title="Meeting") is None
