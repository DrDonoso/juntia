from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from juntia import community_actions
from juntia.db import ActionLabel, ContactTag, State
from juntia.errors import AppError
from tests.test_action_migration import migrate
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_contacts import create, history, path, tag
from tests.test_users import database, visitor
from tests.test_users import mailbox as mailbox


def label_endpoint(kind):
    return "/api/admin/action-labels" if kind == "actions" else "/api/admin/contact-tags"


def make_label(client, kind, name="Puertas"):
    return create_item(client, labels=[name])["labels"][0] if kind == "actions" else tag(client, name)


def test_admin_edits_apply_to_every_association_without_mixing_catalogs(admin, config):
    first = create_item(admin, labels=["Puertas", "Portal"])
    second = create_item(admin, labels=["Puertas"], status="done")
    label = next(label for label in first["labels"] if label["name"] == "Puertas")
    contact_tag = tag(admin, "Puertas")
    contact = create(admin, tags=[contact_tag["id"]])
    financial = admin.get("/api/catalog/tags").json()
    original_history = admin.get(item_path(first) + "/history").json()["items"]

    async def revision(db):
        return (await db.get(State, 1)).revision

    before_revision = database(config, revision)
    response = admin.patch(f"/api/admin/action-labels/{label['id']}", json={
        "name": "  Ａccesos  ", "color": "#AABBCC", "version": label["version"],
    })
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved == {"id": label["id"], "name": "Accesos", "color": "#aabbcc", "version": 2}
    for item in (first, second):
        current = admin.get(item_path(item)).json()
        assert saved in current["labels"]
        assert current["version"] == item["version"] + 1
        assert {value["id"] for value in current["labels"]} == {
            value["id"] for value in item["labels"]
        }
        event = admin.get(item_path(item) + "/history").json()["items"][0]
        assert event["author"]["kind"] == "administrator"
        assert {change["field"] for change in event["changes"]} == {"labels", "label_color"}
        assert "Puertas" in event["changes"][0]["before"]
        assert "Accesos" in event["changes"][0]["after"]
    assert admin.get(item_path(first) + "/history").json()["items"][1:] == original_history
    assert create_item(admin, labels=["ACCESOS"])["labels"] == [saved]
    assert admin.patch(item_path(first), json={
        "version": first["version"], "labels": ["Puertas"], "title": "Old draft",
    }).json() == {"code": "action_stale"}
    assert admin.get("/api/admin/action-labels?q=puertas").json()["total"] == 0
    assert admin.get(path(contact)).json()["tags"] == [contact_tag]

    response = admin.patch(f"/api/admin/contact-tags/{contact_tag['id']}", json={
        "name": "Urgencias", "color": "#FFFFFF", "version": contact_tag["version"],
    })
    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": contact_tag["id"], "name": "Urgencias", "color": "#ffffff", "version": 2,
    }
    assert admin.get(path(contact)).json()["tags"] == [response.json()]
    assert history(admin, contact)["items"][0]["after"]["tags"] == [contact_tag]
    assert history(admin)["items"][0]["target"] == "tag"
    assert admin.get(f"/api/admin/action-labels/{label['id']}").json() == saved
    assert admin.get("/api/catalog/tags").json() == financial
    assert database(config, revision) == before_revision


@pytest.mark.parametrize("kind", ["actions", "contacts"])
def test_admin_label_routes_require_the_technical_session_and_same_origin(
    kind, actors, admin, config,
):
    resident, _, _, _ = actors
    label = make_label(admin, kind)
    endpoint = label_endpoint(kind)
    body = {"name": "Changed", "color": "#123456", "version": 1}
    with visitor(config) as anonymous:
        for client in (anonymous, resident):
            assert client.get(endpoint).status_code == 401
            assert client.get(f"{endpoint}/{label['id']}").status_code == 401
            assert client.patch(f"{endpoint}/{label['id']}", json=body).status_code == 401
    assert admin.patch(f"{endpoint}/{label['id']}", json=body, headers={
        "origin": "https://other.invalid",
    }).status_code == 403
    assert admin.get(f"{endpoint}/{label['id']}").json() == label
    assert admin.get(f"{endpoint}/999999").status_code == 404


@pytest.mark.parametrize("kind", ["actions", "contacts"])
def test_admin_label_duplicates_stale_edits_and_noops_preserve_saved_data(kind, admin):
    label = make_label(admin, kind)
    make_label(admin, kind, "Occupied")
    endpoint = f"{label_endpoint(kind)}/{label['id']}"
    response = admin.patch(endpoint, json={
        "name": "ＯＣＣＵＰＩＥＤ", "color": "#123456", "version": 1,
    })
    assert response.status_code == 409
    assert response.json()["fields"]["name"].endswith("_exists")
    assert admin.get(endpoint).json() == label
    body = {"name": "Renamed", "color": "#123456", "version": 1}
    response = admin.patch(endpoint, json=body)
    assert response.status_code == 200, response.text
    current = response.json()
    assert current["version"] == 2
    assert admin.patch(endpoint, json=body).status_code == 409
    assert admin.patch(endpoint, json={**body, "version": 2}).json() == current
    assert admin.get(endpoint).json() == current
    if kind == "actions":
        assert admin.get("/api/actions/items/1/history").json()["total"] == 2


@pytest.mark.parametrize("kind", ["actions", "contacts"])
@pytest.mark.parametrize("invalid", [
    {"name": " "}, {"name": "a" * 101}, {"name": "Name\ninjection"},
    {"name": "\ufdfa" * 100}, {"color": "red"}, {"color": "#fff"},
    {"color": "#abcdef00"}, {"color": "#gggggg"}, {"version": 0},
])
def test_admin_label_validation_keeps_original_data(kind, invalid, admin):
    label = make_label(admin, kind)
    endpoint = f"{label_endpoint(kind)}/{label['id']}"
    response = admin.patch(endpoint, json={
        "name": "Changed", "color": "#123456", "version": 1, **invalid,
    })
    assert response.status_code == 422, response.text
    if "name" in invalid or "color" in invalid:
        assert response.json()["fields"]
    assert admin.get(endpoint).json() == label


@pytest.mark.parametrize("kind,model,size", [
    ("actions", ActionLabel, 20), ("contacts", ContactTag, 50),
])
def test_admin_catalogs_page_and_search_unused_labels(kind, model, size, admin, config):
    async def seed_labels(db):
        for index in range(size + 1):
            db.add(model(
                name=f"Label {index:02}", normalized_name=f"label {index:02}", color="#123456",
            ))
        db.add(model(name="20%_Literal", normalized_name="20%_literal", color="#123456"))

    database(config, seed_labels)
    endpoint = label_endpoint(kind)
    first = admin.get(endpoint).json()
    second = admin.get(endpoint, params={"page": 2}).json()
    assert (first["total"], first["pages"], len(first["items"])) == (size + 2, 2, size)
    assert len(second["items"]) == 2
    assert len({row["id"] for row in first["items"] + second["items"]}) == size + 2
    assert admin.get(endpoint, params={"q": "%_"}).json()["total"] == 1
    assert admin.get(endpoint, params={"q": "ＬＡＢＥＬ 00"}).json()["total"] == 1
    assert admin.get(endpoint, params={"page": 0}).status_code == 422
    assert admin.get(endpoint, params={"q": "a" * 101}).status_code == 422


@pytest.mark.parametrize("kind", ["actions", "contacts"])
def test_concurrent_admin_label_edits_require_reconciliation(kind, admin, config):
    label = make_label(admin, kind)
    endpoint = f"{label_endpoint(kind)}/{label['id']}"
    barrier = Barrier(2)
    with visitor(config) as first, visitor(config) as second:
        first.cookies.update(admin.cookies)
        second.cookies.update(admin.cookies)

        def save(client, name):
            barrier.wait(timeout=10)
            return client.patch(endpoint, json={"name": name, "color": "#123456", "version": 1})

        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(save, first, "First name")
            b = pool.submit(save, second, "Second name")
            responses = [a.result(timeout=20), b.result(timeout=20)]
    assert sorted(response.status_code for response in responses) == [200, 409]
    saved = next(response.json() for response in responses if response.status_code == 200)
    assert admin.get(endpoint).json() == saved


def test_renaming_a_label_during_an_action_edit_cannot_recreate_its_previous_name(admin, config):
    item = create_item(admin, labels=["Original"])
    label = item["labels"][0]
    barrier = Barrier(2)
    with visitor(config) as catalog, visitor(config) as editor:
        catalog.cookies.update(admin.cookies)
        editor.cookies.update(admin.cookies)

        def rename():
            barrier.wait(timeout=10)
            return catalog.patch(f"/api/admin/action-labels/{label['id']}", json={
                "name": "Renamed", "color": "#123456", "version": 1,
            })

        def edit():
            barrier.wait(timeout=10)
            return editor.patch(item_path(item), json={
                "title": "Edited concurrently", "labels": ["Original"], "version": item["version"],
            })

        with ThreadPoolExecutor(max_workers=2) as pool:
            renaming, editing = pool.submit(rename), pool.submit(edit)
            renamed, edited = renaming.result(timeout=20), editing.result(timeout=20)
    assert renamed.status_code == 200, renamed.text
    assert edited.status_code in {200, 409}, edited.text
    assert admin.get(item_path(item)).json()["labels"] == [renamed.json()]
    assert admin.get("/api/admin/action-labels").json()["items"] == [renamed.json()]


def test_action_label_edit_rolls_back_every_association_and_event(admin, monkeypatch):
    first = create_item(admin, labels=["Shared"])
    second = create_item(admin, labels=["Shared"])
    label = first["labels"][0]

    def fail(*args, **kwargs):
        raise AppError("internal_error", 503)

    monkeypatch.setattr(community_actions, "add_event", fail)
    response = admin.patch(f"/api/admin/action-labels/{label['id']}", json={
        "name": "Not saved", "color": "#123456", "version": 1,
    })
    assert response.status_code == 503
    for item in (first, second):
        assert admin.get(item_path(item)).json() == item
        assert admin.get(item_path(item) + "/history").json()["total"] == 1
    assert admin.get(f"/api/admin/action-labels/{label['id']}").json() == label


def test_catalog_management_remains_available_when_actions_are_disabled(admin):
    item = create_item(admin, labels=["Retained"])
    label = item["labels"][0]
    assert admin.patch("/api/admin/settings/features/actions", json={"enabled": False}).status_code == 200
    assert admin.get("/api/actions/labels").status_code == 404
    assert admin.get("/api/admin/action-labels").json()["items"] == [label]
    response = admin.patch(f"/api/admin/action-labels/{label['id']}", json={
        "name": "Prepared", "color": "#123456", "version": 1,
    })
    assert response.status_code == 200, response.text
    assert admin.get("/api/admin/contact-tags").status_code == 200
    assert admin.get(item_path(item)).status_code == 404
    assert admin.patch("/api/admin/settings/features/actions", json={"enabled": True}).status_code == 200
    assert admin.get(item_path(item)).json()["labels"] == [response.json()]


def test_label_migration_preserves_legacy_appearance_and_refuses_to_discard_edits(admin, config):
    item = create_item(admin, labels=["Legacy"])
    label = item["labels"][0]
    assert label["color"] is None
    assert label["version"] == 1
    original_history = admin.get(item_path(item) + "/history").json()
    migrate(config, "downgrade", "0014")
    migrate(config, "upgrade", "head")
    assert admin.get(item_path(item)).json() == item
    assert admin.get(item_path(item) + "/history").json() == original_history
    response = admin.patch(f"/api/admin/action-labels/{label['id']}", json={
        "name": "Saved name", "color": "#123456", "version": 1,
    })
    assert response.status_code == 200, response.text
    failed = migrate(config, "downgrade", "0014", check=False)
    assert failed.returncode != 0
    assert "Back up and explicitly remove action label edits" in failed.stderr
    assert admin.get(f"/api/admin/action-labels/{label['id']}").json() == response.json()
