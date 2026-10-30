import unicodedata
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from juntia import contacts
from juntia.contracts import ContactIn, ContactTagIn, GoogleStartIn
from juntia.db import Contact, State
from juntia.errors import AppError
from tests.test_action_migration import migrate
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_users import current_user, database, visitor
from tests.test_users import mailbox as mailbox


def create(client, name="Ascensor", **fields):
    response = client.post("/api/contacts", json={
        "name": name, "phone": "+34 900 123 456", **fields,
    })
    assert response.status_code == 201, response.text
    return response.json()


def tag(client, name="Mantenimiento", color="#21639f"):
    response = client.post("/api/contact-tags", json={"name": name, "color": color})
    assert response.status_code == 201, response.text
    return response.json()


def path(value):
    return f"/api/contacts/{value['id']}"


def edit(client, value, **changes):
    return client.patch(path(value), json={
        "name": value["name"], "email": value["email"], "phone": value["phone"],
        "company": value["company"], "notes": value["notes"],
        "tags": [item["id"] for item in value["tags"]], "version": value["version"],
        **changes,
    })


def remove(client, value):
    return client.request("DELETE", path(value), json={"version": value["version"]})


def history(client, value=None):
    response = client.get("/api/contact-history", params={
        "contact_id": value["id"],
    } if value else {})
    assert response.status_code == 200, response.text
    return response.json()


def test_every_member_can_edit_delete_and_see_retained_history(actors, admin):
    a, b, first, second = actors
    label = tag(a)
    value = create(a, tags=[label["id"]], email="SUPPORT@example.org")
    assert value["email"] == "support@example.org"
    assert value["phone"] == "+34900123456"
    assert b.get(path(value)).json() == value
    updated = edit(b, value, name="Servicio del ascensor", notes="Disponible por la tarde")
    assert updated.status_code == 200, updated.text
    saved = updated.json()
    assert saved["version"] == 2
    assert edit(a, value, name="Obsolete").status_code == 409
    assert remove(a, value).status_code == 409
    assert remove(a, saved).status_code == 204
    assert b.get("/api/contacts").json()["total"] == 0
    assert b.get(path(value)).status_code == 404
    assert edit(b, saved, name="Cannot restore").status_code == 404
    events = history(b, value)["items"]
    assert [event["kind"] for event in events] == ["deleted", "updated", "created"]
    assert [event["author"]["user_id"] for event in events] == [
        first["id"], second["id"], first["id"],
    ]
    assert events[0]["before"]["name"] == saved["name"]
    assert events[0]["after"] is None
    assert events[1]["before"]["notes"] == ""
    assert events[1]["after"]["notes"] == saved["notes"]
    assert events[2]["before"] is None
    assert events[2]["after"]["tags"][0]["color"] == label["color"]
    assert history(admin)["total"] == 4
    assert a.patch("/api/contact-history", json={}).status_code in {404, 405}
    assert a.delete("/api/contact-history").status_code in {404, 405}
    assert a.post("/api/admin/catalog/tags", json={"name": "Forbidden"}).status_code == 401
    assert a.get("/api/admin/users").status_code == 401
    technical = create(admin, "Administrador")
    assert history(b, technical)["items"][0]["author"]["kind"] == "administrator"


def test_tags_are_shared_versioned_audited_and_do_not_rewrite_snapshots(actors, admin):
    a, b, _, _ = actors
    before_financial = admin.get("/api/catalog/tags").json()
    before_actions = admin.get("/api/actions/labels").json()
    label = tag(a, " Ascensor ", "#FFAA00")
    assert label["name"] == "Ascensor"
    assert label["color"] == "#ffaa00"
    value = create(a, tags=[label["id"]])
    updated = b.patch(f"/api/contact-tags/{label['id']}", json={
        "name": "Urgencias", "color": "#ffffff", "version": label["version"],
    })
    assert updated.status_code == 200
    assert b.get(path(value)).json()["tags"][0] == updated.json()
    assert history(b, value)["items"][0]["after"]["tags"][0] == label
    assert a.patch(f"/api/contact-tags/{label['id']}", json={
        "name": "Old", "color": "#000000", "version": 1,
    }).status_code == 409
    assert a.post("/api/contact-tags", json={"name": "URGENCIAS"}).status_code == 409
    assert history(a)["total"] == 3
    assert history(a)["items"][0]["before"] == {"name": "Ascensor", "color": "#ffaa00"}
    assert history(a)["items"][0]["after"] == {"name": "Urgencias", "color": "#ffffff"}
    assert admin.get("/api/catalog/tags").json() == before_financial
    assert admin.get("/api/actions/labels").json() == before_actions
    current = b.get(path(value)).json()
    cleared = edit(b, current, tags=[]).json()
    assert cleared["tags"] == []
    assert history(a, value)["items"][0]["before"]["tags"][0]["name"] == "Urgencias"


def test_tag_suggestions_prioritize_usage_in_active_contacts(admin):
    rare = tag(admin, "AAA occasional")
    frequent = tag(admin, "ZZZ frequent")
    removed_only = tag(admin, "BBB removed")
    unused = tag(admin, "CCC unused")
    create(admin, tags=[rare["id"], frequent["id"]])
    create(admin, tags=[frequent["id"]])
    for index in range(3):
        contact = create(admin, name=f"Removed {index}", tags=[removed_only["id"]])
        assert remove(admin, contact).status_code == 204
    assert admin.get("/api/contact-tags").json() == [frequent, rare, removed_only, unused]


def test_unchanged_saves_and_failures_do_not_create_events(admin, monkeypatch):
    label = tag(admin)
    value = create(admin, tags=[label["id"]])
    assert edit(admin, value).json() == value
    assert admin.patch(f"/api/contact-tags/{label['id']}", json=label).status_code == 422
    assert admin.patch(f"/api/contact-tags/{label['id']}", json={
        key: label[key] for key in ("name", "color", "version")
    }).json() == label
    assert history(admin)["total"] == 2
    assert edit(admin, value, tags=[999999]).status_code == 422
    assert admin.get(path(value)).json() == value

    def fail(*args, **kwargs):
        raise AppError("internal_error", 503)

    monkeypatch.setattr(contacts, "add_event", fail)
    assert edit(admin, value, name="Rolled back").status_code == 503
    assert remove(admin, value).status_code == 503
    assert admin.post("/api/contacts", json={"name": "Not saved", "phone": "1234567"}).status_code == 503
    assert admin.get(path(value)).json() == value
    assert admin.get("/api/contacts").json()["total"] == 1
    assert history(admin)["total"] == 2


@pytest.mark.parametrize("fields", [
    {"name": " "}, {"phone": "", "email": None}, {"email": "not-an-email"},
    {"phone": "tel:1234567"}, {"phone": "123456"}, {"phone": "1234567;42"},
    {"phone": "1234567890123456"}, {"tags": [-1]}, {"tags": [2147483648]},
    {"name": "Name\ninjection"}, {"notes": "Text\0bad"},
    {"author_user_id": 123}, {"created_at": "2020-01-01"},
])
def test_contact_validation(fields):
    with pytest.raises(ValidationError):
        ContactIn.model_validate({"name": "Contact", "phone": "1234567", **fields})


@pytest.mark.parametrize("color", ["red", "#fff", "#abcdef00", "url(x)", "#gggggg"])
def test_invalid_tag_colors(color):
    with pytest.raises(ValidationError):
        ContactTagIn(name="Tag", color=color)


def test_tag_names_validate_the_normalized_length():
    assert ContactTagIn(name="\uff21scensor").name == "Ascensor"
    with pytest.raises(ValidationError):
        ContactTagIn(name="\ufdfa" * 100)


def test_read_write_authorization_origin_and_actions_flag(actors, admin, config):
    a, _, first, _ = actors
    assert admin.patch(
        "/api/admin/settings/features/actions", json={"enabled": False},
    ).status_code == 200
    value = create(a)
    assert a.get("/api/actions/items").status_code == 404
    assert a.get("/api/contacts").status_code == 200
    assert a.post("/api/contact-tags", json={"name": "Allowed"}).status_code == 201
    assert a.patch(path(value), json={
        "name": "Blocked", "phone": value["phone"], "version": value["version"],
    }, headers={"origin": "https://other.invalid"}).status_code == 403
    endpoints = ["/api/contacts", path(value), "/api/contact-tags", "/api/contact-history"]
    with visitor(config) as anonymous:
        for endpoint in endpoints:
            assert anonymous.get(endpoint).status_code == 401
        assert anonymous.post("/api/contacts", json={
            "name": "Anonymous", "phone": "1234567",
        }).status_code == 401
        assert remove(anonymous, value).status_code == 401
    current = current_user(admin, first["id"])
    admin.patch(f"/api/admin/users/{first['id']}/status", json={
        "version": current["version"], "disabled": True,
    })
    for endpoint in endpoints:
        assert a.get(endpoint).status_code == 401
    assert edit(a, value, name="Revoked").status_code == 401


def test_author_survives_renaming_and_deleting_account(actors, admin):
    a, b, first, _ = actors
    value = create(a)
    recorded = history(b, value)
    current = current_user(admin, first["id"])
    changed = admin.patch(f"/api/admin/users/{first['id']}", json={
        "name": "Renamed author", "email": current["email"], "phone": current["phone"],
        "dwelling_id": current["dwelling_id"], "version": current["version"],
    }).json()
    assert admin.request("DELETE", f"/api/admin/users/{first['id']}", json={
        "email": changed["email"], "version": changed["version"],
    }).status_code == 204
    assert history(b, value) == recorded
    assert b.get(path(value)).status_code == 200
    assert edit(b, value, notes="Still shared").status_code == 200


def fold(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold())
                   if not unicodedata.combining(c))


def test_search_and_every_sort_cover_all_pages_with_empty_values_last(admin):
    labels = [tag(admin, "Áscensor"), tag(admin, "Zeta")]
    values = [create(
        admin, f"{'Ána' if i % 2 else 'ana'} {(i * 7 % 53) // 2:02}",
        company=f"Proveedor {i % 4}" if i % 3 else "",
        email=f"contact{i % 7}@example.org" if i % 4 else None,
        phone=f"+34900{i % 6:06}", notes=f"Nota {i % 5}" if i % 4 else "",
        tags=[label["id"] for label in labels[:i % 3]],
    ) for i in range(53)]
    for field in ("name", "company", "email", "phone", "notes", "tags", "created_at", "updated_at"):
        def key(value):
            return "\0".join(sorted(fold(label["name"]) for label in value["tags"])) \
                if field == "tags" else fold(value[field] or "")
        for direction in ("asc", "desc"):
            expected = sorted([v for v in values if key(v)], key=key, reverse=direction == "desc")
            expected += [v for v in values if not key(v)]
            params = {"sort": field, "direction": direction}
            first = admin.get("/api/contacts", params=params).json()
            second = admin.get("/api/contacts", params={**params, "page": 2}).json()
            assert (first["total"], first["pages"], len(first["items"])) == (53, 2, 50)
            assert len(second["items"]) == 3
            assert [v["id"] for v in first["items"] + second["items"]] == [v["id"] for v in expected]
    cases = [
        ("ANA", lambda v: True),
        ("ASCENSOR", lambda v: bool(v["tags"])),
        ("proveedor 1", lambda v: v["company"] == "Proveedor 1"),
        ("contact2@", lambda v: v["email"] == "contact2@example.org"),
        ("+34 (900) 000-001", lambda v: v["phone"] == "+34900000001"),
        ("nota 3", lambda v: v["notes"] == "Nota 3"),
        ("not-found", lambda v: False),
    ]
    for query, matches in cases:
        result = admin.get("/api/contacts", params={"q": query}).json()
        assert result["total"] == sum(matches(value) for value in values)
        assert all(matches(value) for value in result["items"])
    for params in ({"sort": "bad"}, {"direction": "bad"}, {"page": 0}):
        assert admin.get("/api/contacts", params=params).status_code == 422


def test_concurrent_edit_has_one_winner(actors):
    a, b, _, _ = actors
    value = create(a)
    barrier = Barrier(2)

    def save(client, name):
        barrier.wait()
        return edit(client, value, name=name).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(save, a, "One")
        two = pool.submit(save, b, "Two")
        assert sorted([one.result(), two.result()]) == [200, 409]
    assert history(a, value)["total"] == 2


def test_migration_preserves_actions_and_finances_and_blocks_loss(admin, config):
    action = create_item(admin, labels=["Preserved"])
    action_history = admin.get(item_path(action) + "/history").json()
    async def revision(db):
        return await db.scalar(select(State.revision).where(State.id == 1))
    before = database(config, revision)
    migrate(config, "downgrade", "0009")
    migrate(config, "upgrade", "head")
    assert admin.get(item_path(action)).json() == action
    assert admin.get(item_path(action) + "/history").json() == action_history
    value = create(admin)
    assert remove(admin, value).status_code == 204
    result = migrate(config, "downgrade", "0009", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove contact history" in result.stderr
    assert history(admin, value)["total"] == 2
    assert database(config, revision) == before
    async def retained(db):
        return (await db.scalar(select(Contact).where(Contact.id == value["id"]))).deleted_at
    assert database(config, retained) is not None


def test_contact_routes_use_safe_login_and_spa(client, monkeypatch, tmp_path):
    assert GoogleStartIn(return_path="/contacts?q=ascensor").return_path == "/contacts?q=ascensor"
    with pytest.raises(ValidationError):
        GoogleStartIn(return_path="/contacts/unexpected")
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html>Contacts SPA</html>", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    for route in ("/contacts", "/admin/contacts", "/actions", "/actions/1"):
        assert client.get(route).status_code == 200


def test_contact_field_errors_are_codes_and_do_not_change_other_validation_responses(admin):
    response = admin.post("/api/contacts", json={
        "name": "Valid", "email": "not-an-email", "phone": "tel:123",
    })
    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "fields": {"email": "contact_email_invalid", "phone": "contact_phone_invalid"},
    }
    assert "not-an-email" not in response.text
    missing = admin.post("/api/contacts", json={"name": "Valid"})
    assert missing.json()["fields"] == {
        "email": "contact_channel_required", "phone": "contact_channel_required",
    }
    assert admin.post("/api/contact-tags", json={
        "name": " ", "color": "bad",
    }).json()["fields"] == {
        "name": "contact_tag_name_invalid", "color": "contact_tag_color_invalid",
    }
    assert admin.post("/api/auth/activate", json={}).json() == {"code": "invalid_request"}
    assert admin.get("/api/contacts").json()["total"] == 0
    assert history(admin)["total"] == 0


def test_inline_tags_commit_with_the_contact_and_preserve_existing_colors(actors, admin):
    a, b, first, _ = actors
    existing = tag(admin, "Ascensor", "#21639f")
    value = create(a, new_tags=[
        {"name": "ASCENSOR", "color": "#ffffff"},
        {"name": "fontaneria", "color": "#d77089"},
    ])
    assert [item["name"] for item in value["tags"]] == ["Ascensor", "fontaneria"]
    assert value["tags"][0] == existing
    assert value["tags"][1]["color"] == "#d77089"
    events = history(b)["items"]
    assert [(event["target"], event["kind"]) for event in events] == [
        ("contact", "created"), ("tag", "created"), ("tag", "created"),
    ]
    assert events[0]["author"]["user_id"] == events[1]["author"]["user_id"] == first["id"]
    assert edit(b, value, notes="Changed", new_tags=[{
        "name": "urgencias", "color": "#4963de",
    }]).status_code == 200
    assert len(b.get(path(value)).json()["tags"]) == 3
    assert len(admin.get("/api/contact-tags").json()) == 3
    assert edit(a, value, new_tags=[{"name": "stale draft", "color": "#b94644"}]).status_code == 409
    assert len(admin.get("/api/contact-tags").json()) == 3


def test_failed_contact_save_does_not_leave_inline_tags_or_history(admin, monkeypatch):
    original = contacts.add_event

    def fail_contact(*args, **kwargs):
        if kwargs.get("contact_id") is not None:
            raise AppError("internal_error", 503)
        return original(*args, **kwargs)

    monkeypatch.setattr(contacts, "add_event", fail_contact)
    response = admin.post("/api/contacts", json={
        "name": "Rolled back", "phone": "1234567",
        "new_tags": [{"name": "new draft", "color": "#b94644"}],
    })
    assert response.status_code == 503
    assert admin.get("/api/contact-tags").json() == []
    assert admin.get("/api/contacts").json()["total"] == 0
    assert history(admin)["total"] == 0


def test_inline_tag_errors_and_limits_roll_back_new_catalog_entries(admin):
    value = create(admin, new_tags=[
        {"name": f"Tag {i}", "color": "#b94644"} for i in range(30)
    ])
    before = history(admin)["total"]
    response = admin.patch(path(value), json={
        "name": value["name"], "phone": value["phone"], "version": value["version"],
        "new_tags": [{"name": "overflow", "color": "#b94644"}],
    })
    assert response.status_code == 422
    assert response.json()["fields"] == {"tags": "contact_tags_invalid"}
    assert len(admin.get("/api/contact-tags").json()) == 30
    assert history(admin)["total"] == before
    invalid = admin.post("/api/contacts", json={
        "name": "Bad tag", "phone": "1234567",
        "new_tags": [{"name": "Color", "color": "javascript:red"}],
    })
    assert invalid.status_code == 422
    assert invalid.json()["fields"] == {"tags": "contact_tag_color_invalid"}
    duplicate = admin.post("/api/contacts", json={
        "name": "Duplicate", "phone": "1234567",
        "new_tags": [{"name": "Duplicated"}, {"name": "DUPLICATED"}],
    })
    assert duplicate.status_code == 422
    assert duplicate.json()["fields"] == {"tags": "contact_tags_invalid"}


def test_concurrent_inline_tag_creation_uses_one_catalog_identity(actors):
    a, b, _, _ = actors
    barrier = Barrier(2)

    def save(client, name, color):
        barrier.wait()
        return create(client, name, new_tags=[{"name": "shared", "color": color}])

    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(save, a, "One", "#b94644")
        two = pool.submit(save, b, "Two", "#4963de")
        values = [one.result(), two.result()]
    assert values[0]["tags"] == values[1]["tags"]
    assert len(a.get("/api/contact-tags").json()) == 1
    events = history(a)["items"]
    assert sum(event["target"] == "tag" for event in events) == 1
    assert sum(event["target"] == "contact" for event in events) == 2


def test_only_administration_can_list_deleted_contacts(actors, admin, config):
    a, b, _, _ = actors
    active = create(a, "Active")
    deleted = create(a, "Deleted", email="deleted@example.org")
    assert active["deleted_at"] is None
    assert remove(b, deleted).status_code == 204
    endpoint = "/api/admin/contacts/deleted"
    with visitor(config) as anonymous:
        assert anonymous.get(endpoint).status_code == 401
    assert a.get(endpoint).status_code == 401
    response = admin.get(endpoint)
    assert response.status_code == 200
    items = response.json()["items"]
    assert response.json()["total"] == 1
    assert items[0]["id"] == deleted["id"]
    assert items[0]["deleted_at"] is not None
    assert items[0]["version"] == deleted["version"] + 1
    assert admin.get(endpoint, params={"q": "deleted@", "sort": "email", "direction": "desc"}).json()["items"] == items
    assert admin.get(endpoint, params={"q": "Active"}).json()["items"] == []
    assert [value["id"] for value in a.get("/api/contacts").json()["items"]] == [active["id"]]
    assert history(admin, deleted)["items"][0]["kind"] == "deleted"
    assert edit(admin, deleted, name="Cannot restore").status_code == 404
