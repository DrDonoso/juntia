from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier

import pytest
from pydantic import ValidationError
from sqlalchemy import select, update

from juntia import community_actions
from juntia.contracts import (
    ACTION_STATUSES,
    ActionCommentIn,
    ActionEdit,
    ActionIn,
    GoogleStartIn,
)
from juntia.db import CommunityAction, State
from juntia.errors import AppError
from tests.test_api import commit, preview
from tests.test_users import activate, current_user, database, dwelling, invite, login, visitor
from tests.test_users import mailbox as mailbox


@pytest.fixture
def actors(admin, config, mailbox):
    unit = dwelling(admin)
    first, first_token = invite(admin, mailbox, dwelling_id=unit["id"])
    second, second_token = invite(admin, mailbox, "second@example.org", unit["id"])
    with visitor(config) as a, visitor(config) as b:
        activate(a, first_token)
        activate(b, second_token)
        assert login(a).status_code == 200
        assert login(b, "second@example.org").status_code == 200
        yield a, b, first, second


def create_item(client, title="Arreglar la puerta", **fields):
    response = client.post("/api/actions/items", json={"title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def item_path(value):
    return f"/api/actions/items/{value['id']}"


def test_list_sorts_all_matches_before_pagination_with_stable_ties(admin, config):
    values = [
        create_item(
            admin, f"{'tarea' if index % 2 else 'Tarea'} {(index * 7 % 23) // 2:02}",
            status=ACTION_STATUSES[index * 3 % len(ACTION_STATUSES)],
            labels=["Solo"] if index % 2 == 0 else ["General"],
        )
        for index in range(23)
    ]
    baseline = datetime.now(timezone.utc)
    activity = {
        value["id"]: baseline + timedelta(minutes=index * 5 % 7)
        for index, value in enumerate(values)
    }

    async def set_activity(db):
        for item_id, timestamp in activity.items():
            await db.execute(update(CommunityAction).where(CommunityAction.id == item_id).values(
                updated_at=timestamp,
            ))

    database(config, set_activity)
    keys = {
        "title": lambda value: (value["title"].casefold(), value["id"]),
        "status": lambda value: (ACTION_STATUSES.index(value["status"]), value["id"]),
        "activity": lambda value: (activity[value["id"]], value["id"]),
    }
    for sort, key in keys.items():
        for direction in ("asc", "desc"):
            params = {"scope": "all", "sort": sort, "direction": direction}
            first = admin.get("/api/actions/items", params=params)
            assert first.status_code == 200, first.text
            second = admin.get("/api/actions/items", params={**params, "page": 2}).json()
            assert (first.json()["total"], first.json()["pages"]) == (23, 2)
            assert len(first.json()["items"]) == 20
            assert len(second["items"]) == 3
            ordered = first.json()["items"] + second["items"]
            assert [row["id"] for row in ordered] == [
                row["id"] for row in sorted(values, key=key, reverse=direction == "desc")
            ]

    default = admin.get("/api/actions/items", params={"scope": "all"}).json()
    explicit = admin.get("/api/actions/items", params={
        "scope": "all", "sort": "activity", "direction": "desc",
    }).json()
    assert default == explicit
    label_id = values[0]["labels"][0]["id"]
    filtered = admin.get("/api/actions/items", params={
        "scope": "all", "status": "detected", "q": "Tarea 0", "label": label_id,
        "sort": "title", "direction": "asc",
    }).json()
    matching = [
        row for row in values
        if row["status"] == "detected" and "tarea 0" in row["title"].casefold()
        and any(label["id"] == label_id for label in row["labels"])
    ]
    assert [row["id"] for row in filtered["items"]] == [
        row["id"] for row in sorted(matching, key=keys["title"])
    ]
    assert admin.get(item_path(values[0]) + "/history").json()["total"] == 1
    for params in ({"sort": "unsupported"}, {"direction": "sideways"}):
        assert admin.get("/api/actions/items", params=params).status_code == 422


def test_shared_actions_record_changes_without_changing_financial_permissions(actors, admin):
    a, b, first, second = actors
    value = create_item(a, description="No cierra bien.", labels=["Puertas"])
    path = item_path(value)
    assert value["author"]["user_id"] == first["id"]
    assert value["status"] == "detected"
    assert b.get(path).json() == value
    changed = b.patch(path, json={
        "version": value["version"], "title": "Reparar puerta del portal",
        "description": "Solicitar dos presupuestos.\nTambién revisar el muelle.",
        "status": "quoting", "labels": ["Puertas", "Accesos"],
    })
    assert changed.status_code == 200, changed.text
    saved = changed.json()
    assert saved["version"] == 2
    assert saved["author"]["user_id"] == first["id"]
    assert a.get(path).json() == saved
    events = b.get(path + "/history").json()["items"]
    assert [event["kind"] for event in events] == ["updated", "created"]
    assert events[0]["author"]["user_id"] == second["id"]
    assert events[1]["author"]["user_id"] == first["id"]
    changes = {change["field"]: change for change in events[0]["changes"]}
    assert changes["title"] == {
        "field": "title", "before": value["title"], "after": saved["title"],
    }
    assert changes["labels"]["before"] == ["Puertas"]
    assert changes["labels"]["after"] == ["Accesos", "Puertas"]
    assert all(event["created_at"].endswith("Z") for event in events)
    for reader in (a, b):
        assert reader.get("/api/summary").status_code == 200
        assert reader.get("/api/admin/statements").status_code == 401
        assert reader.patch("/api/admin/account", json={"name": "Forbidden"}).status_code == 401
        assert reader.post("/api/admin/imports/preview").status_code == 401
        assert reader.post("/api/admin/users", json={}).status_code == 401
    assert admin.get(path).json() == saved
    assert a.request("DELETE", path, json={}).status_code == 405
    assert a.patch(path + "/history", json={}).status_code in {404, 405}


def test_comment_ownership_versions_retirement_and_author_snapshots(actors, admin):
    a, b, first, second = actors
    value = create_item(a)
    path = item_path(value)
    response = a.post(path + "/comments", json={"body": "Primer comentario"})
    assert response.status_code == 201
    comment = response.json()
    endpoint = path + f"/comments/{comment['id']}"
    assert b.patch(endpoint, json={"version": 1, "body": "No autorizado"}).status_code == 403
    assert b.request("DELETE", endpoint, json={"version": 1}).status_code == 403
    edited = a.patch(endpoint, json={"version": 1, "body": "Comentario corregido"}).json()
    assert edited["version"] == 2
    assert a.patch(endpoint, json={"version": 1, "body": "Obsoleto"}).status_code == 409
    assert a.request("DELETE", endpoint, json={"version": 2}).status_code == 204
    assert a.patch(endpoint, json={"version": 3, "body": "Restaurar"}).status_code == 409
    listing = b.get(path + "/comments").json()["items"]
    assert listing[0]["body"] is None
    assert listing[0]["withdrawn_at"]
    assert a.get(path).json()["comment_count"] == 0
    other = create_item(a)
    assert admin.patch(item_path(other) + f"/comments/{comment['id']}", json={
        "version": 3, "body": "Wrong parent",
    }).status_code == 404
    profile = a.get("/api/auth/profile").json()
    assert a.patch("/api/auth/profile", json={
        "name": "Nombre nuevo", "version": profile["version"],
    }).status_code == 200
    history = b.get(path + "/history").json()["items"]
    assert history[0]["kind"] == "comment_withdrawn"
    assert history[0]["changes"][0]["before"] == "Comentario corregido"
    assert history[1]["changes"][0]["before"] == "Primer comentario"
    assert history[1]["changes"][0]["after"] == "Comentario corregido"
    assert all(event["author"]["name"] == first["name"] for event in history)
    assert all(event["author"]["user_id"] == first["id"] for event in history)
    another = b.post(path + "/comments", json={"body": "Comentario del segundo vecino"}).json()
    assert another["author"]["user_id"] == second["id"]
    assert admin.request("DELETE", path + f"/comments/{another['id']}", json={
        "version": another["version"],
    }).status_code == 204
    assert a.get(path + "/history").json()["items"][0]["author"]["kind"] == "administrator"


def test_comments_do_not_stale_metadata_edits_and_noops_do_not_add_events(admin):
    value = create_item(admin)
    path = item_path(value)
    assert admin.post(path + "/comments", json={"body": "Información nueva"}).status_code == 201
    assert admin.get(path).json()["version"] == value["version"]
    saved = admin.patch(path, json={"version": 1, "title": "Título actualizado"}).json()
    assert saved["version"] == 2
    assert admin.patch(path, json={"version": 1, "title": "Cambio obsoleto"}).status_code == 409
    assert admin.patch(path, json={"version": 2, "title": saved["title"]}).json()["version"] == 2
    assert admin.get(path + "/history").json()["total"] == 3
    assert admin.get(path).json()["title"] == saved["title"]


def test_all_states_allow_skips_and_reopening(admin):
    value = create_item(admin)
    path = item_path(value)
    for status in (*ACTION_STATUSES[1:], "detected", "done", "quoting"):
        response = admin.patch(path, json={"version": value["version"], "status": status})
        assert response.status_code == 200, response.text
        value = response.json()
        assert value["status"] == status
    assert admin.get(path + "/history").json()["total"] == 11


def test_labels_are_normalized_reusable_and_separate_from_financial_catalogs(admin):
    financial = admin.get("/api/catalog/tags").json()
    value = create_item(admin, labels=["  Fontanería ", "fontanería", "Ｐｉｎｔｕｒａ"])
    assert [label["name"] for label in value["labels"]] == ["Fontanería", "Pintura"]
    other = create_item(admin, labels=["FONTANERÍA"])
    assert other["labels"][0] == value["labels"][0]
    assert admin.get("/api/actions/labels?q=fontan").json()["total"] == 1
    assert admin.get("/api/catalog/tags").json() == financial
    assert admin.patch(item_path(value), json={"version": 1, "labels": []}).status_code == 200
    assert admin.get(item_path(other)).json()["labels"] == other["labels"]
    change = admin.get(item_path(value) + "/history").json()["items"][0]["changes"][0]
    assert change == {"field": "labels", "before": ["Fontanería", "Pintura"], "after": []}


def test_board_pages_each_column_and_shares_list_filters(admin):
    created = [
        create_item(admin, f"Puerta {index}", labels=["Puertas"], description="Revisar el muelle")
        for index in range(23)
    ]
    create_item(admin, "Presupuesto de pintura", status="quoting", labels=["Pintura"])
    create_item(admin, "Otro presupuesto", status="quoting", labels=["Pintura"])
    closed = create_item(admin, "Trabajo terminado", status="done")
    columns = {column["status"]: column for column in admin.get("/api/actions/board").json()["columns"]}
    assert set(columns) == set(ACTION_STATUSES)
    assert columns["detected"]["total"] == 23
    assert columns["detected"]["pages"] == 2
    assert len(columns["detected"]["items"]) == 20
    assert columns["quoting"]["total"] == 2
    assert len(columns["quoting"]["items"]) == 2
    assert columns["done"]["total"] == 0
    second = admin.get("/api/actions/items", params={"status": "detected", "page": 2}).json()
    assert len(second["items"]) == 3
    ids = {row["id"] for row in columns["detected"]["items"] + second["items"]}
    assert ids == {row["id"] for row in created}
    selected = {"label": created[0]["labels"][0]["id"], "q": "muelle"}
    assert admin.get("/api/actions/items", params=selected).json()["total"] == 23
    filtered = admin.get("/api/actions/board", params=selected).json()["columns"]
    assert sum(column["total"] for column in filtered) == 23
    assert admin.get("/api/actions/items?scope=closed").json()["items"][0]["id"] == closed["id"]
    assert admin.get("/api/actions/items?scope=all").json()["total"] == 26
    literal = create_item(admin, "Descuento 20%_literal")
    assert admin.get("/api/actions/items", params={"q": "%_"}).json()["items"][0]["id"] == literal["id"]
    assert admin.get("/api/actions/items", params={"q": "%_"}).json()["total"] == 1
    for params in ({"page": 0}, {"label": -1}, {"scope": "invalid"}, {"status": "invalid"}):
        assert admin.get("/api/actions/items", params=params).status_code == 422


def test_failed_mutation_rolls_back_both_data_and_history(admin, monkeypatch):
    value = create_item(admin)
    path = item_path(value)

    def fail(*args, **kwargs):
        raise AppError("action_storage_error", 503)

    monkeypatch.setattr(community_actions, "add_event", fail)
    assert admin.patch(path, json={
        "version": 1, "title": "Should roll back", "labels": ["Unused"],
    }).status_code == 503
    assert admin.get(path).json() == value
    assert admin.get(path + "/history").json()["total"] == 1
    assert admin.get("/api/actions/labels").json()["items"] == []


def test_actions_do_not_invalidate_financial_previews(admin, config):
    pending = preview(admin)

    async def revision(db):
        return await db.scalar(select(State.revision))

    before = database(config, revision)
    value = create_item(admin, labels=["Puertas"])
    assert admin.patch(item_path(value), json={"version": 1, "status": "approved"}).status_code == 200
    assert database(config, revision) == before
    assert commit(admin, pending).status_code == 200


def test_anonymous_and_disabled_accounts_cannot_access_actions(actors, admin, config):
    a, b, first, _ = actors
    value = create_item(a)
    path = item_path(value)
    endpoints = [
        "/api/actions/items", "/api/actions/board", "/api/actions/labels", path,
        path + "/comments", path + "/history", path + "/attachments",
    ]
    with visitor(config) as anonymous:
        for endpoint in endpoints:
            assert anonymous.get(endpoint).status_code == 401
        assert anonymous.post("/api/actions/items", json={"title": "Hidden"}).status_code == 401
    current = current_user(admin, first["id"])
    assert admin.patch(f"/api/admin/users/{first['id']}/status", json={
        "version": current["version"], "disabled": True,
    }).status_code == 200
    for endpoint in endpoints:
        assert a.get(endpoint).status_code == 401
    assert a.patch(path, json={"version": 1, "title": "Hidden"}).status_code == 401
    assert b.get(path).json()["author"]["user_id"] == first["id"]
    assert b.post(path + "/comments", json={"body": "Still available"}).status_code == 201


def test_cross_origin_and_forged_authorship_are_rejected(admin):
    assert admin.post("/api/actions/items", json={"title": "Hidden"}, headers={
        "origin": "https://other.example",
    }).status_code == 403
    assert admin.post("/api/actions/items", json={"title": "Hidden"}, headers={
        "x-juntia-request": "0",
    }).status_code == 403
    for field, value in (("author_user_id", 1), ("author", {"name": "Forged"}), ("created_at", "2020")):
        assert admin.post("/api/actions/items", json={"title": "Hidden", field: value}).status_code == 422
    assert admin.get("/api/actions/items").json()["total"] == 0


@pytest.mark.parametrize("body", [
    {"title": "  "}, {"title": "a" * 201}, {"title": "A", "description": "a" * 20001},
    {"title": "A", "description": "\0"}, {"title": "A", "status": "paid"},
    {"title": "A", "labels": [""]}, {"title": "A", "labels": ["a" * 101]},
    {"title": "A", "labels": [str(i) for i in range(21)]},
])
def test_invalid_action_contracts(body):
    with pytest.raises(ValidationError):
        ActionIn.model_validate(body)


@pytest.mark.parametrize("body", [
    {"version": 1}, {"version": 1, "title": None}, {"version": 1, "labels": None},
    {"version": 0, "status": "done"}, {"version": 1, "description": None},
])
def test_invalid_action_edits(body):
    with pytest.raises(ValidationError):
        ActionEdit.model_validate(body)


@pytest.mark.parametrize("body", [" ", "\0", "a" * 10001])
def test_invalid_comments(body):
    with pytest.raises(ValidationError):
        ActionCommentIn(body=body)


@pytest.mark.parametrize("path", ["/actions", "/actions?view=board&scope=all", "/actions/42?scope=all"])
def test_google_can_return_to_real_action_routes(path):
    assert GoogleStartIn(return_path=path).return_path == path


@pytest.mark.parametrize("path", [
    "/actions/nope", "/actions/0", "/actions/1/extra", "//evil.example/actions",
    "/actions\\evil", "/admin/actions", "/actions/1#fragment", "/actions/%2f%2fevil",
])
def test_google_action_return_paths_remain_restricted(path):
    with pytest.raises(ValidationError):
        GoogleStartIn(return_path=path)


def test_action_routes_support_direct_navigation(client, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><body>Synthetic SPA</body></html>", encoding="utf-8")
    for path in ["/actions", "/actions/42", "/admin/actions", "/admin/actions/42"]:
        assert client.get(path).status_code == 200
        assert "Synthetic SPA" in client.get(path).text
    assert client.get("/actions/nope").status_code == 404
    assert client.get("/actions/42/extra").status_code == 404


def test_concurrent_edit_has_one_winner(actors, config):
    if not config.database_url.startswith("postgresql"):
        pytest.skip("Requires the disposable juntia_test PostgreSQL database")
    a, b, _, _ = actors
    value = create_item(a)
    barrier = Barrier(2)

    def change(client, title):
        barrier.wait(timeout=10)
        return client.patch(item_path(value), json={"version": 1, "title": title}).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(change, a, "First edit")
        second = workers.submit(change, b, "Second edit")
        assert sorted([first.result(), second.result()]) == [200, 409]
    assert a.get(item_path(value)).json()["version"] == 2
    assert a.get(item_path(value) + "/history").json()["total"] == 2
