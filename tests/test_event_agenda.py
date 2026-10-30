from datetime import date, datetime, timezone

import pytest

from juntia import community_events
from tests.test_community_actions import create_item
from tests.test_community_events import create_event, event_body, path
from tests.test_community_events import enabled as enabled
from tests.test_feature_flags import set_flag
from tests.test_users import visitor


@pytest.fixture(autouse=True)
def agenda_clock(monkeypatch):
    monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
        2026, 1, 1, tzinfo=timezone.utc,
    ))


def read_agenda(client, **params):
    response = client.get("/api/events/agenda", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def full_day(client, start, end, **fields):
    return create_event(client, all_day=True, starts_at=None, ends_at=None,
                        starts_on=start, ends_on=end, **fields)


def test_two_day_event_has_one_record_and_daily_continuations(enabled):
    value = full_day(enabled, "2030-05-10", "2030-05-12")
    other = create_event(enabled, starts_at="2030-05-11T10:00:00", ends_at="2030-05-11T11:00:00")
    agenda = read_agenda(enabled)
    assert (agenda["total"], agenda["pages"]) == (3, 1)
    assert [(entry["day"], entry["event"]["id"]) for entry in agenda["items"]] == [
        ("2030-05-10", value["id"]), ("2030-05-11", value["id"]), ("2030-05-11", other["id"]),
    ]
    first, continuation, _ = agenda["items"]
    assert first["is_continuation"] is False
    assert first["is_last_day"] is False
    assert continuation["is_continuation"] is True
    assert continuation["is_last_day"] is True
    assert first["event"] == continuation["event"] == value
    assert enabled.get("/api/events").json()["total"] == 2
    assert enabled.get(path(value) + "/history").json()["total"] == 1
    changed = enabled.patch(path(value), json=event_body(
        version=1, title="Updated event", all_day=True, starts_at=None, ends_at=None,
        starts_on="2030-05-10", ends_on="2030-05-13",
    ))
    assert changed.status_code == 200
    entries = read_agenda(enabled, q="Updated event")["items"]
    assert len(entries) == 3
    assert all(entry["event"]["id"] == value["id"] and entry["event"]["version"] == 2 for entry in entries)
    assert [entry["is_last_day"] for entry in entries] == [False, False, True]


@pytest.mark.parametrize(("start", "end", "days"), [
    ("2030-05-10T23:00:00", "2030-05-11T01:00:00", ["2030-05-10", "2030-05-11"]),
    ("2030-05-10T22:00:00", "2030-05-11T00:00:00", ["2030-05-10"]),
    ("2030-05-10T22:00:00", "2030-05-11T00:00:00.000001", ["2030-05-10", "2030-05-11"]),
    ("2026-03-28T23:00:00", "2026-03-30T00:00:00", ["2026-03-28", "2026-03-29"]),
    ("2026-10-24T23:00:00", "2026-10-26T00:00:00", ["2026-10-24", "2026-10-25"]),
])
def test_timed_days_respect_exclusive_midnight_and_dst(enabled, start, end, days):
    create_event(enabled, starts_at=start, ends_at=end)
    entries = read_agenda(enabled)["items"]
    assert [entry["day"] for entry in entries] == days
    assert entries[0]["is_continuation"] is False
    assert entries[-1]["is_last_day"] is True


def test_day_boundaries_use_the_community_zone_not_utc(enabled, config, monkeypatch):
    monkeypatch.setattr(config, "tz", "America/New_York")
    value = create_event(
        enabled, timezone="America/New_York",
        starts_at="2030-05-10T19:30:00", ends_at="2030-05-10T21:00:00",
    )
    assert value["starts_at"].startswith("2030-05-10")
    assert value["ends_at"].startswith("2030-05-11")
    assert [entry["day"] for entry in read_agenda(enabled)["items"]] == ["2030-05-10"]


def test_ongoing_events_start_at_today_and_past_and_deleted_keep_reverse_order(enabled, monkeypatch):
    ongoing = full_day(enabled, "2030-05-10", "2030-05-13")
    finished = full_day(enabled, "2030-05-08", "2030-05-10")
    monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
        2030, 5, 10, 22, 0, tzinfo=timezone.utc,
    ))
    entries = read_agenda(enabled)["items"]
    assert [entry["day"] for entry in entries] == ["2030-05-11", "2030-05-12"]
    assert all(entry["is_continuation"] for entry in entries)
    past = read_agenda(enabled, scope="past")["items"]
    assert [entry["day"] for entry in past] == ["2030-05-09", "2030-05-08"]
    assert all(entry["event"]["id"] == finished["id"] for entry in past)
    assert enabled.request("DELETE", path(ongoing), json={"version": 1}).status_code == 204
    assert read_agenda(enabled)["items"] == []
    deleted = read_agenda(enabled, scope="deleted")["items"]
    assert [entry["day"] for entry in deleted] == ["2030-05-12", "2030-05-11", "2030-05-10"]
    assert all(entry["event"]["deleted_at"] is not None for entry in deleted)


def test_pagination_orders_all_daily_occurrences_before_slicing(enabled, monkeypatch):
    spanning = full_day(enabled, "2030-05-01", "2030-05-29")
    expected = [
        (f"2030-05-{day:02}", "", spanning["id"]) for day in range(1, 29)
    ]
    for index in range(23):
        day = index * 7 % 23 + 1
        value = create_event(
            enabled, title=f"Visit {index}", starts_at=f"2030-05-{day:02}T10:00:00",
            ends_at=f"2030-05-{day:02}T11:00:00",
        )
        expected.append((f"2030-05-{day:02}", "10:00", value["id"]))
    for scope, reverse in (("upcoming", False), ("past", True)):
        if reverse:
            monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
                2031, 1, 1, tzinfo=timezone.utc,
            ))
        pages = [read_agenda(enabled, scope=scope, page=page) for page in (1, 2, 3)]
        assert all(page["total"] == 51 and page["pages"] == 3 for page in pages)
        assert [len(page["items"]) for page in pages] == [20, 20, 11]
        entries = [entry for page in pages for entry in page["items"]]
        assert [(entry["day"], entry["event"]["id"]) for entry in entries] == [
            (day, event_id) for day, _, event_id in sorted(expected, reverse=reverse)
        ]
        assert len({(entry["day"], entry["event"]["id"]) for entry in entries}) == 51


def test_long_events_remain_bounded_to_one_page_without_losing_later_days(enabled):
    full_day(enabled, "2030-01-01", "9999-12-31")
    first = read_agenda(enabled)
    second = read_agenda(enabled, page=2)
    assert first["total"] == (date(9999, 12, 31) - date(2030, 1, 1)).days
    assert len(first["items"]) == len(second["items"]) == 20
    assert first["items"][0]["day"] == "2030-01-01"
    assert first["items"][-1]["day"] == "2030-01-20"
    assert second["items"][0]["day"] == "2030-01-21"
    assert all(entry["is_continuation"] for entry in second["items"])
    assert read_agenda(enabled, page=1000000)["items"] == []


def test_minimum_calendar_date_remains_finite_in_the_daily_projection(enabled):
    value = full_day(enabled, "0001-01-01", "0001-01-04")
    entries = read_agenda(enabled, scope="past")["items"]
    assert [entry["day"] for entry in entries] == ["0001-01-03", "0001-01-02", "0001-01-01"]
    assert all(entry["event"]["id"] == value["id"] for entry in entries)
    assert entries[0]["is_last_day"] is True
    assert entries[-1]["is_continuation"] is False


def test_agenda_respects_authentication_feature_flags_and_filters(enabled, config):
    action = create_item(enabled, title="Linked action")
    value = full_day(enabled, "2030-05-10", "2030-05-12", action_id=action["id"], title="Searchable")
    full_day(enabled, "2030-05-10", "2030-05-11", title="Independent")
    assert read_agenda(enabled, action_id=action["id"])["total"] == 2
    assert read_agenda(enabled, q="searchable")["total"] == 2
    assert read_agenda(enabled, q="no-match")["total"] == 0
    with visitor(config) as anonymous:
        assert anonymous.get("/api/events/agenda").status_code == 401
    set_flag(enabled, "actions", False)
    entries = read_agenda(enabled)["items"]
    assert all(entry["event"]["action"] is None for entry in entries)
    assert enabled.get("/api/events/agenda", params={"action_id": action["id"]}).status_code == 404
    set_flag(enabled, "events", False)
    assert enabled.get("/api/events/agenda").json() == {"code": "events_disabled"}
    set_flag(enabled, "events", True)
    set_flag(enabled, "actions", True)
    assert read_agenda(enabled, action_id=action["id"])["items"][0]["event"] == value
    for params in ({"page": 0}, {"scope": "unknown"}, {"action_id": 0}):
        assert enabled.get("/api/events/agenda", params=params).status_code == 422


def test_single_day_and_leap_day_events_have_no_extra_continuation(enabled):
    first = full_day(enabled, "2028-02-28", "2028-03-01")
    single = full_day(enabled, "2028-03-01", "2028-03-02")
    entries = read_agenda(enabled)["items"]
    assert [(entry["day"], entry["event"]["id"]) for entry in entries] == [
        ("2028-02-28", first["id"]), ("2028-02-29", first["id"]), ("2028-03-01", single["id"]),
    ]
    assert entries[-1]["is_continuation"] is False
    assert entries[-1]["is_last_day"] is True


def at_noon_on_may_10(monkeypatch):
    monkeypatch.setattr(community_events, "utcnow", lambda: datetime(
        2030, 5, 10, 10, 0, tzinfo=timezone.utc,
    ))


def test_complete_timeline_is_chronological_and_marks_only_finished_events(enabled, monkeypatch):
    action = create_item(enabled, title="Timeline action")
    finished = full_day(enabled, "2030-05-01", "2030-05-03", action_id=action["id"])
    ongoing = full_day(enabled, "2030-05-09", "2030-05-12")
    earlier = create_event(enabled, starts_at="2030-05-10T08:00:00", ends_at="2030-05-10T09:00:00")
    later = create_event(enabled, starts_at="2030-05-10T18:00:00", ends_at="2030-05-10T19:00:00",
                         action_id=action["id"])
    removed = full_day(enabled, "2030-05-10", "2030-05-11")
    assert enabled.request("DELETE", path(removed), json={"version": 1}).status_code == 204
    at_noon_on_may_10(monkeypatch)
    agenda = read_agenda(enabled, scope="all")
    assert (agenda["total"], agenda["page"], agenda["pages"]) == (7, 1, 1)
    assert [
        (entry["day"], entry["event"]["id"], entry["is_continuation"], entry["is_past"])
        for entry in agenda["items"]
    ] == [
        ("2030-05-01", finished["id"], False, True),
        ("2030-05-02", finished["id"], True, True),
        ("2030-05-09", ongoing["id"], False, False),
        ("2030-05-10", ongoing["id"], True, False),
        ("2030-05-10", earlier["id"], False, True),
        ("2030-05-10", later["id"], False, False),
        ("2030-05-11", ongoing["id"], True, False),
    ]
    linked = read_agenda(enabled, scope="all", action_id=action["id"])["items"]
    assert [(entry["event"]["id"], entry["is_past"]) for entry in linked] == [
        (finished["id"], True), (finished["id"], True), (later["id"], False),
    ]
    assert not any(entry["is_past"] for entry in read_agenda(enabled)["items"])
    assert all(entry["is_past"] for entry in read_agenda(enabled, scope="past")["items"])
    deleted = read_agenda(enabled, scope="deleted")["items"]
    assert [entry["event"]["id"] for entry in deleted] == [removed["id"]]
    assert [row["id"] for row in enabled.get("/api/events?scope=all").json()["items"]] == [
        finished["id"], ongoing["id"], earlier["id"], later["id"],
    ]


def test_complete_timeline_opens_on_the_page_reaching_today(enabled, monkeypatch):
    at_noon_on_may_10(monkeypatch)
    full_day(enabled, "2030-03-01", "2030-04-15")
    full_day(enabled, "2030-05-08", "2030-05-12")
    full_day(enabled, "2030-05-20", "2030-07-01")
    agenda = read_agenda(enabled, scope="all")
    assert (agenda["total"], agenda["page"], agenda["pages"]) == (91, 3, 5)
    days = [entry["day"] for entry in agenda["items"]]
    assert days[:9] == [
        "2030-04-10", "2030-04-11", "2030-04-12", "2030-04-13", "2030-04-14",
        "2030-05-08", "2030-05-09", "2030-05-10", "2030-05-11",
    ]
    assert (len(days), days[9], days[-1]) == (20, "2030-05-20", "2030-05-30")
    assert [entry["is_past"] for entry in agenda["items"]] == [True] * 5 + [False] * 15
    first = read_agenda(enabled, scope="all", page=1)
    assert (first["page"], first["items"][0]["day"]) == (1, "2030-03-01")
    last = read_agenda(enabled, scope="all", page=5)
    assert (last["page"], len(last["items"]), last["items"][-1]["day"]) == (5, 11, "2030-06-30")
    assert read_agenda(enabled)["page"] == 1


def test_complete_timeline_without_upcoming_entries_opens_on_its_latest_page(enabled, monkeypatch):
    at_noon_on_may_10(monkeypatch)
    empty = read_agenda(enabled, scope="all")
    assert (empty["total"], empty["page"], empty["pages"], empty["items"]) == (0, 1, 1, [])
    value = full_day(enabled, "2030-03-01", "2030-04-10")
    agenda = read_agenda(enabled, scope="all")
    assert (agenda["total"], agenda["page"], agenda["pages"]) == (40, 2, 2)
    assert agenda["items"][-1]["day"] == "2030-04-09"
    assert all(entry["is_past"] and entry["event"]["id"] == value["id"] for entry in agenda["items"])
