import re
from datetime import date, datetime, timezone
from urllib.parse import urlencode

from icalendar import Calendar, Event

from .contracts import EventCalendarOut
from .db import CommunityEvent, aware

GOOGLE_URL_LIMIT = 8000
# Markdown destinations of the community's own images, as the editor inserts them.
OWN_IMAGE = re.compile(r"\]\((/api/(?:actions|events)/images/[0-9A-Fa-f-]{36})\)")


def exported_text(value: str, origin: str) -> str:
    """The description for other apps: the community's image addresses become absolute."""
    return OWN_IMAGE.sub(lambda match: f"]({origin}{match.group(1)})", value)


def interval(value: CommunityEvent) -> tuple[date, date]:
    if value.all_day:
        assert value.starts_on is not None and value.ends_on is not None
        return value.starts_on, value.ends_on
    assert value.starts_at is not None and value.ends_at is not None
    return aware(value.starts_at), aware(value.ends_at)


def compact(value: date) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return value.strftime("%Y%m%d")


def calendar_links(value: CommunityEvent, origin: str, zone: str) -> EventCalendarOut:
    start, end = interval(value)
    url = f"{origin}/events/{value.id}"
    google = "https://calendar.google.com/calendar/render?" + urlencode({
        "action": "TEMPLATE", "text": value.title,
        "dates": f"{compact(start)}/{compact(end)}", "ctz": zone,
        "details": f"{exported_text(value.description, origin)}\n\n{url}".strip(),
        "location": value.location,
    })
    if len(google) > GOOGLE_URL_LIMIT:
        return EventCalendarOut(google_url=None, google_error="event_calendar_too_long")
    return EventCalendarOut(google_url=google, google_error=None)


def calendar_file(value: CommunityEvent, origin: str) -> bytes:
    start, end = interval(value)
    calendar = Calendar()
    calendar.add("prodid", "-//Juntia//Community events//EN")
    calendar.add("version", "2.0")
    calendar.add("calscale", "GREGORIAN")
    event = Event()
    event.add("uid", f"{value.calendar_uid}@juntia")
    event.add("dtstamp", aware(value.updated_at))
    event.add("created", aware(value.created_at))
    event.add("last-modified", aware(value.updated_at))
    event.add("sequence", value.version - 1)
    event.add("dtstart", start)
    event.add("dtend", end)
    event.add("summary", value.title)
    event.add("description", exported_text(value.description, origin))
    event.add("location", value.location)
    event.add("url", f"{origin}/events/{value.id}")
    calendar.add_component(event)
    return calendar.to_ical()
