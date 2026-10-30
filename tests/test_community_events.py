from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier

import pytest
from sqlalchemy import select

from juntia import community_events
from juntia.contracts import GoogleStartIn, reader_route
from juntia.db import CommunityEvent, CommunityEventHistory, State
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item
from tests.test_feature_flags import set_flag
from tests.test_users import current_user, database, visitor
from tests.test_users import mailbox as mailbox


@pytest.fixture
def enabled(admin):
    set_flag(admin, "events", True)
    return admin


def event_body(**fields):
    return {
        "title": "Revision del ascensor", "description": "Visita del servicio tecnico",
        "location": "Portal", "timezone": "Europe/Madrid", "all_day": False,
        "starts_at": "2030-05-10T18:00:00", "ends_at": "2030-05-10T20:00:00",
        **fields,
    }


def create_event(client, **fields):
    response = client.post("/api/events", json=event_body(**fields))
    assert response.status_code == 201, response.text
    return response.json()


def path(value):
    return f"/api/events/{value['id']}"


def test_shared_crud_retains_authorship_history_and_financial_revision(enabled, actors, config):
    a, b, first, second = actors
    action = create_item(a)
    value = create_event(a, action_id=action["id"])
    assert value["author"]["user_id"] == first["id"]
    assert value["starts_at"] == "2030-05-10T16:00:00Z"
    assert value["ends_at"] == "2030-05-10T18:00:00Z"
    assert b.get(path(value)).json() == value
    body = event_body(version=value["version"], title="Revision y peritaje")
    changed = b.patch(path(value), json=body)
    assert changed.status_code == 200, changed.text
    saved = changed.json()
    assert saved["version"] == 2
    assert saved["action"] == {"id": action["id"], "title": action["title"]}
    assert b.patch(path(value), json=body).status_code == 409
    same = b.patch(path(value), json={**body, "version": saved["version"]})
    assert same.json() == saved
    assert b.request("DELETE", path(value), json={"version": 1}).status_code == 409
    deleted = b.request("DELETE", path(value), json={"version": saved["version"]})
    assert deleted.status_code == 204
    assert b.get(path(value)).json()["deleted_at"] is not None
    assert b.patch(path(value), json={**body, "version": 3}).json()["code"] == "event_deleted"
    assert b.get(path(value) + "/calendar").status_code == 409
    history = b.get(path(value) + "/history").json()
    assert history["total"] == 3
    assert [item["kind"] for item in history["items"]] == ["deleted", "updated", "created"]
    assert history["items"][0]["author"]["user_id"] == second["id"]
    assert history["items"][1]["before"]["title"] == value["title"]
    assert history["items"][1]["after"]["title"] == "Revision y peritaje"
    assert history["items"][2]["author"]["user_id"] == first["id"]
    assert b.get("/api/events").json()["total"] == 0
    assert b.get("/api/events?scope=deleted").json()["total"] == 1
    assert a.get(f"/api/actions/items/{action['id']}").json()["version"] == 1

    async def revision(db):
        return (await db.get(State, 1)).revision
    assert database(config, revision) == 0


def test_flag_gates_all_routes_and_preserves_data(admin, config):
    assert admin.get("/api/features").json()["events"] is False
    assert admin.get("/api/events/config").json() == {"code": "events_disabled"}
    set_flag(admin, "events", True)
    value = create_event(admin)
    routes = [
        "/api/events", "/api/events/agenda", "/api/events/config", path(value), path(value) + "/history",
        path(value) + "/calendar", path(value) + "/calendar.ics",
    ]
    with visitor(config) as anonymous:
        for route in routes:
            assert anonymous.get(route).status_code == 401
        assert anonymous.post("/api/events", json=event_body()).status_code == 401
    set_flag(admin, "events", False)
    for route in routes:
        response = admin.get(route)
        assert response.status_code == 404, response.text
        assert response.json() == {"code": "events_disabled"}
    for method, route in (("POST", "/api/events"), ("PATCH", path(value)), ("DELETE", path(value))):
        response = admin.request(method, route, content=b"{invalid")
        assert response.status_code == 404
    with visitor(config) as restarted:
        assert restarted.get("/api/features").json()["events"] is False
    set_flag(admin, "events", True)
    assert admin.get(path(value)).json() == value


def test_action_links_are_optional_and_hidden_but_retained_when_actions_disabled(enabled, config):
    action = create_item(enabled, title="Sensitive action title")
    a = create_event(enabled, action_id=action["id"])
    b = create_event(enabled, title="Second visit", action_id=action["id"])
    create_event(enabled, title="Independent")
    assert enabled.get(f"/api/events?action_id={action['id']}").json()["total"] == 2
    set_flag(enabled, "actions", False)
    assert enabled.get("/api/events").json()["total"] == 3
    assert enabled.get(path(a)).json()["action"] is None
    assert action["title"] not in enabled.get(path(a) + "/history").text
    assert action["title"] not in enabled.get(path(a) + "/calendar.ics").text
    assert action["title"] not in enabled.get(path(a) + "/calendar").text
    assert enabled.get(f"/api/events?action_id={action['id']}").status_code == 404
    changed = enabled.patch(path(a), json=event_body(version=1, title="Updated independent fields"))
    assert changed.status_code == 200, changed.text
    assert changed.json()["action"] is None
    assert enabled.patch(path(b), json=event_body(version=1, action_id=None)).status_code == 404
    create_event(enabled, title="Created while actions disabled")
    set_flag(enabled, "actions", True)
    assert enabled.get(path(a)).json()["action"]["id"] == action["id"]
    assert enabled.get(path(a) + "/history").json()["items"][0]["after"]["action"]["id"] == action["id"]
    unlinked = enabled.patch(path(a), json=event_body(version=2, action_id=None))
    assert unlinked.status_code == 200
    assert unlinked.json()["action"] is None
    assert enabled.post("/api/events", json=event_body(action_id=2147483647)).json()["fields"] == {
        "action_id": "event_action_not_found",
    }


def test_upcoming_includes_ongoing_and_all_day_until_local_midnight(enabled, monkeypatch):
    monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
        2030, 5, 10, 10, 0, tzinfo=timezone.utc,
    ))
    ongoing = create_event(enabled, starts_at="2030-05-10T11:00:00", ends_at="2030-05-10T13:00:00")
    past = create_event(enabled, starts_at="2030-05-10T09:00:00", ends_at="2030-05-10T12:00:00")
    full_day = create_event(enabled, all_day=True, starts_at=None, ends_at=None,
                            starts_on="2030-05-10", ends_on="2030-05-11")
    future = create_event(enabled, starts_at="2030-05-11T00:30:00", ends_at="2030-05-11T01:00:00")
    assert [row["id"] for row in enabled.get("/api/events").json()["items"]] == [
        full_day["id"], ongoing["id"], future["id"],
    ]
    assert [row["id"] for row in enabled.get("/api/events?scope=past").json()["items"]] == [past["id"]]
    assert [row["id"] for row in enabled.get("/api/events?scope=all").json()["items"]] == [
        full_day["id"], past["id"], ongoing["id"], future["id"],
    ]
    monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
        2030, 5, 10, 22, 0, tzinfo=timezone.utc,
    ))
    assert [row["id"] for row in enabled.get("/api/events").json()["items"]] == [future["id"]]


def test_sorting_search_and_pagination_happen_across_all_matches(enabled):
    values = [create_event(
        enabled, title=f"Revision {i}", starts_at=f"2030-05-{(i * 7 % 23) + 1:02}T18:00:00",
        ends_at=f"2030-05-{(i * 7 % 23) + 1:02}T19:00:00",
    ) for i in range(23)]
    first = enabled.get("/api/events?q=revision").json()
    second = enabled.get("/api/events?q=revision&page=2").json()
    assert (first["total"], first["pages"], len(first["items"]), len(second["items"])) == (23, 2, 20, 3)
    assert [row["id"] for row in first["items"] + second["items"]] == [
        row["id"] for row in sorted(values, key=lambda row: (row["starts_at"], row["id"]))
    ]
    assert enabled.get("/api/events?q=no-match").json()["total"] == 0
    assert enabled.get("/api/events?page=0").status_code == 422
    assert enabled.get("/api/events?scope=unknown").status_code == 422


@pytest.mark.parametrize(("start", "end", "code"), [
    ("2026-03-29T02:30:00", "2026-03-29T04:00:00", "event_time_nonexistent"),
    ("2026-10-25T02:30:00", "2026-10-25T04:00:00", "event_time_ambiguous"),
])
def test_dst_rejects_ambiguous_or_nonexistent_local_times(enabled, start, end, code):
    result = enabled.post("/api/events", json=event_body(starts_at=start, ends_at=end))
    assert result.status_code == 422
    assert result.json() == {"code": code, "fields": {"starts_at": code}}


@pytest.mark.parametrize(("start", "end", "utc_start", "utc_end"), [
    ("2026-03-29T01:30:00", "2026-03-29T04:30:00", "2026-03-29T00:30:00Z", "2026-03-29T02:30:00Z"),
    ("2026-10-25T01:30:00", "2026-10-25T04:30:00", "2026-10-24T23:30:00Z", "2026-10-25T03:30:00Z"),
    ("2027-01-10T18:00:00", "2027-01-10T19:00:00", "2027-01-10T17:00:00Z", "2027-01-10T18:00:00Z"),
])
def test_dst_offsets_are_applied_to_each_boundary(enabled, start, end, utc_start, utc_end):
    value = create_event(enabled, starts_at=start, ends_at=end)
    assert (value["starts_at"], value["ends_at"]) == (utc_start, utc_end)


@pytest.mark.parametrize("fields", [
    {"title": "   "}, {"title": "x" * 201}, {"description": "x" * 20001},
    {"location": "x" * 201}, {"starts_at": None}, {"ends_at": "2030-05-10T17:00:00"},
    {"starts_at": "2030-05-10T18:00:00Z"}, {"all_day": "false"},
    {"all_day": True}, {"action_id": 0}, {"unexpected": True},
    {"all_day": True, "starts_at": None, "ends_at": None,
     "starts_on": "2030-05-10", "ends_on": "2030-05-10"},
])
def test_validation_is_atomic(enabled, config, fields):
    response = enabled.post("/api/events", json=event_body(**fields))
    assert response.status_code == 422, response.text

    async def counts(db):
        return len((await db.scalars(select(CommunityEvent))).all()), len((
            await db.scalars(select(CommunityEventHistory))
        ).all())
    assert database(config, counts) == (0, 0)


def test_timezone_mismatch_and_csrf_do_not_save(enabled):
    assert enabled.get("/api/events/config").json() == {"timezone": "Europe/Madrid"}
    result = enabled.post("/api/events", json=event_body(timezone="UTC"))
    assert result.status_code == 409
    assert result.json()["code"] == "event_timezone_changed"
    for headers in ({"origin": "https://other.invalid"}, {"x-juntia-request": ""}):
        assert enabled.post("/api/events", json=event_body(), headers=headers).status_code == 403
    assert enabled.get("/api/events").json()["total"] == 0


def test_timezone_change_preserves_instants_and_calendar_dates(enabled, config, monkeypatch):
    timed = create_event(enabled, starts_at="2030-05-10T00:30:00", ends_at="2030-05-10T01:00:00")
    all_day = create_event(enabled, all_day=True, starts_at=None, ends_at=None,
                           starts_on="2030-05-10", ends_on="2030-05-11")
    monkeypatch.setattr(config, "tz", "America/Los_Angeles")
    assert enabled.get("/api/events/config").json()["timezone"] == "America/Los_Angeles"
    assert enabled.get(path(timed)).json()["starts_at"] == timed["starts_at"]
    assert enabled.get(path(all_day)).json()["starts_on"] == "2030-05-10"
    assert [row["id"] for row in enabled.get("/api/events").json()["items"]] == [
        timed["id"], all_day["id"],
    ]
    assert enabled.patch(path(timed), json=event_body(version=1)).json()["code"] == "event_timezone_changed"


def test_deactivated_residents_cannot_read_mutate_or_export(enabled, actors):
    first, _, user, _ = actors
    value = create_event(first)
    current = current_user(enabled, user["id"])
    assert enabled.patch(f"/api/admin/users/{user['id']}/status", json={
        "version": current["version"], "disabled": True,
    }).status_code == 200
    for route in ["/api/events", "/api/events/agenda", "/api/events/config", path(value), path(value) + "/history",
                  path(value) + "/calendar", path(value) + "/calendar.ics"]:
        assert first.get(route).status_code == 401
    assert first.patch(path(value), json=event_body(version=1)).status_code == 401
    assert first.post("/api/events", json=event_body()).status_code == 401
    assert first.request("DELETE", path(value), json={"version": 1}).status_code == 401
    assert enabled.get(path(value) + "/history").json()["items"][0]["author"]["user_id"] == user["id"]


def test_concurrent_edits_commit_only_one_history_entry(enabled, config):
    value = create_event(enabled)
    barrier = Barrier(2)
    with visitor(config) as second:
        second.cookies.update(enabled.cookies)

        def edit(client, title):
            barrier.wait()
            return client.patch(path(value), json=event_body(version=1, title=title)).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(edit, enabled, "First")
            other = pool.submit(edit, second, "Second")
            assert sorted([first.result(), other.result()]) == [200, 409]
    assert enabled.get(path(value) + "/history").json()["total"] == 2


def test_event_routes_are_safe_login_destinations():
    for route in ["/events", "/events/12"]:
        assert reader_route(route)
        assert GoogleStartIn(return_path=route).return_path == route
    for route in ["/events/0", "/events/12/calendar.ics", "/events/../../admin"]:
        assert not reader_route(route)
