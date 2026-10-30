from datetime import date, datetime, timezone
from urllib.parse import parse_qs, urlsplit

from icalendar import Calendar

from juntia.db import CommunityEvent
from juntia.event_calendar import GOOGLE_URL_LIMIT, calendar_links
from tests.test_community_events import create_event, event_body, path
from tests.test_community_events import enabled as enabled


def read_calendar(client, value):
    response = client.get(path(value) + "/calendar.ics")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/calendar")
    assert response.headers["content-disposition"] == f'attachment; filename="event-{value["id"]}.ics"'
    assert response.headers["cache-control"] == "no-store"
    assert b"\r\n" in response.content
    assert all(len(line) <= 75 for line in response.content.split(b"\r\n"))
    events = Calendar.from_ical(response.content).walk("VEVENT")
    assert len(events) == 1
    return events[0]


def test_timed_export_and_google_link_use_same_instants_and_complete_text(enabled):
    text = "Revisión; electricidad, portal \\ entrada\nBEGIN:VEVENT\n" + "á" * 200
    value = create_event(enabled, title="Peritaje eléctrico", description=text)
    event = read_calendar(enabled, value)
    assert event.decoded("dtstart") == datetime(2030, 5, 10, 16, tzinfo=timezone.utc)
    assert event.decoded("dtend") == datetime(2030, 5, 10, 18, tzinfo=timezone.utc)
    assert str(event["summary"]) == value["title"]
    assert str(event["description"]) == text
    assert str(event["url"]) == f"http://testserver/events/{value['id']}"
    assert int(event["sequence"]) == 0
    link = enabled.get(path(value) + "/calendar").json()
    params = parse_qs(urlsplit(link["google_url"]).query)
    assert params["action"] == ["TEMPLATE"]
    assert params["dates"] == ["20300510T160000Z/20300510T180000Z"]
    assert params["ctz"] == ["Europe/Madrid"]
    assert params["text"] == [value["title"]]
    assert text in params["details"][0]
    saved = enabled.patch(path(value), json=event_body(version=1, title="Changed")).json()
    revised = read_calendar(enabled, saved)
    assert event["uid"] == revised["uid"]
    assert int(revised["sequence"]) == 1
    assert event["uid"] == read_calendar(enabled, saved)["uid"]


def test_all_day_exports_use_dates_and_exclusive_final_day(enabled):
    value = create_event(enabled, all_day=True, starts_at=None, ends_at=None,
                         starts_on="2030-05-10", ends_on="2030-05-13")
    event = read_calendar(enabled, value)
    assert event["dtstart"].params["VALUE"] == "DATE"
    assert event.decoded("dtstart") == date(2030, 5, 10)
    assert event.decoded("dtend") == date(2030, 5, 13)
    link = enabled.get(path(value) + "/calendar").json()["google_url"]
    assert parse_qs(urlsplit(link).query)["dates"] == ["20300510/20300513"]


def test_long_google_link_reports_limit_without_truncating_ics(enabled):
    description = "x" * 9000
    value = create_event(enabled, description=description)
    assert enabled.get(path(value) + "/calendar").json() == {
        "google_url": None, "google_error": "event_calendar_too_long",
    }
    assert str(read_calendar(enabled, value)["description"]) == description


def test_google_url_limit_accepts_exact_boundary_and_rejects_one_more_character():
    value = CommunityEvent(
        id=1, title="Event", description="x", location="", all_day=False,
        starts_at=datetime(2030, 5, 10, 16, tzinfo=timezone.utc),
        ends_at=datetime(2030, 5, 10, 18, tzinfo=timezone.utc),
    )
    first = calendar_links(value, "https://community.example.org", "Europe/Madrid")
    assert first.google_url is not None
    overhead = len(first.google_url) - 1
    value.description = "x" * (GOOGLE_URL_LIMIT - overhead)
    exact = calendar_links(value, "https://community.example.org", "Europe/Madrid")
    assert exact.google_url is not None and len(exact.google_url) == GOOGLE_URL_LIMIT
    assert exact.google_error is None
    value.description += "x"
    assert calendar_links(value, "https://community.example.org", "Europe/Madrid").google_url is None
