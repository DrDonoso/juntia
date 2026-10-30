import pytest
from sqlalchemy import select, update

from juntia.db import (
    ActionAttachment,
    ActionComment,
    ActionEvent,
    CommunityAction,
    CommunityEvent,
    CommunityEventHistory,
    ContactEvent,
)
from tests.test_action_pdfs import upload
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_community_events import create_event, event_body
from tests.test_community_events import path as event_path
from tests.test_contacts import create as create_contact
from tests.test_contacts import edit as edit_contact
from tests.test_contacts import remove as remove_contact
from tests.test_contacts import tag as create_contact_tag
from tests.test_feature_flags import set_flag
from tests.test_users import database
from tests.test_users import mailbox as mailbox

OPERATOR = "synthetic-operator-4821"
LABELS = {"en": "Technical administrator", "es": "Administrador técnico"}
AUTHORED = (
    CommunityAction, ActionComment, ActionAttachment, ActionEvent,
    CommunityEvent, CommunityEventHistory, ContactEvent,
)


@pytest.fixture
def config(config):
    config.admin_username = OPERATOR
    return config


def authors(value):
    if isinstance(value, dict):
        if isinstance(value.get("author"), dict):
            yield value["author"]
        for item in value.values():
            yield from authors(item)
    elif isinstance(value, list):
        for item in value:
            yield from authors(item)


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json() if response.content else None


def administrator_content(admin):
    """Create every kind of administrator-authored record and return the routes that show them."""
    set_flag(admin, "events", True)
    action = create_item(admin, labels=["Lifts"])
    path = item_path(action)
    action = ok(admin.patch(path, json={"version": action["version"], "status": "quoting"}))
    comment = ok(admin.post(path + "/comments", json={"body": "Quote requested"}), 201)
    comment_path = path + f"/comments/{comment['id']}"
    ok(admin.patch(comment_path, json={"version": 1, "body": "Quote received"}))
    withdrawn = ok(admin.post(path + "/comments", json={"body": "Superseded"}), 201)
    ok(admin.request("DELETE", path + f"/comments/{withdrawn['id']}", json={"version": 1}), 204)
    attachment = ok(upload(admin, action), 201)
    attachment_path = path + f"/attachments/{attachment['id']}"
    ok(admin.patch(attachment_path, json={"version": 1, "filename": "Lift quote.pdf"}))
    retired = ok(upload(admin, action, filename="draft.pdf"), 201)
    ok(admin.request("DELETE", path + f"/attachments/{retired['id']}", json={"version": 1}), 204)
    ok(admin.post(f"/api/admin/storage/attachments/{retired['id']}/purge", json={"version": 2}))
    label = action["labels"][0]
    ok(admin.patch(f"/api/admin/action-labels/{label['id']}", json={
        "name": "Elevators", "color": "#123456", "version": label["version"],
    }))
    event = create_event(admin, action_id=action["id"])
    ok(admin.patch(event_path(event), json=event_body(version=event["version"], title="Lift")))
    deleted = create_event(admin, title="Cancelled inspection")
    ok(admin.request("DELETE", event_path(deleted), json={"version": deleted["version"]}), 204)
    contact_tag = create_contact_tag(admin, "Plumbing")
    ok(admin.patch(f"/api/admin/contact-tags/{contact_tag['id']}", json={
        "name": "Plumbers", "color": "#ffffff", "version": contact_tag["version"],
    }))
    contact = create_contact(admin, "Lift company", tags=[contact_tag["id"]], new_tags=[
        {"name": "Urgent", "color": "#b94644"},
    ])
    ok(edit_contact(admin, contact, notes="Call before noon"))
    ok(remove_contact(admin, create_contact(admin, "Old supplier")), 204)
    return [
        "/api/actions/items?scope=all", "/api/actions/board?scope=all", path,
        path + "/comments", comment_path, path + "/attachments?include_withdrawn=true",
        attachment_path, path + "/history",
        "/api/events?scope=all", "/api/events?scope=deleted", "/api/events/agenda?scope=all",
        event_path(event), event_path(event) + "/history", event_path(deleted),
        event_path(deleted) + "/history",
        "/api/contact-history", f"/api/contact-history?contact_id={contact['id']}",
    ]


def read_all(client, routes):
    found = []
    for route in routes:
        response = client.get(route)
        assert response.status_code == 200, (route, response.text)
        assert OPERATOR not in response.text, route
        found.extend(authors(response.json()))
    return found


@pytest.mark.parametrize("language", ["en", "es"])
def test_residents_never_receive_the_administrator_login_name(actors, admin, config, language):
    a, _, first, _ = actors
    routes = administrator_content(admin)
    resident_action = create_item(a, title="Resident report")
    routes.append(item_path(resident_action) + "/history")
    administrator = {"kind": "administrator", "user_id": None, "name": LABELS[language]}

    async def stored_administrator_names(db):
        names = set()
        for model in AUTHORED:
            names.update((await db.scalars(
                select(model.author_name).where(model.author_kind == "administrator")
            )).all())
        return names

    assert database(config, stored_administrator_names) == {LABELS[language]}
    found = read_all(a, routes)
    assert {author["kind"] for author in found} == {"administrator", "resident"}
    assert all(author == administrator for author in found if author["kind"] == "administrator")
    assert {"kind": "resident", "user_id": first["id"], "name": first["name"]} in found
    assert ok(admin.get("/api/admin/auth/session")) == {
        "authenticated": True, "username": OPERATOR,
    }
    assert ok(admin.get("/api/auth/session"))["name"] == OPERATOR
    assert OPERATOR not in a.get("/api/auth/session").text


def test_records_saved_with_the_login_name_are_hidden_when_read(actors, admin, config):
    a, _, _, _ = actors
    routes = administrator_content(admin)

    async def legacy(db):
        # Releases before the fix stored the administrator's login name in every snapshot.
        for model in AUTHORED:
            await db.execute(update(model).where(model.author_kind == "administrator").values(
                author_name=OPERATOR,
            ))

    database(config, legacy)
    for reader in (a, admin):
        found = read_all(reader, routes)
        assert {author["name"] for author in found if author["kind"] == "administrator"} == {
            LABELS["en"],
        }
