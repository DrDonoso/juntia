from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier

import pytest
from pydantic import ValidationError

from juntia.contracts import DwellingLayoutIn
from juntia.db import State
from tests.test_users import activate, database, dwelling, invite, login, visitor
from tests.test_users import mailbox as mailbox

READ = "/api/neighbors/layout"
WRITE = "/api/admin/dwellings/layout"


def layout(*cells):
    return {"show_row_names": False, "show_column_names": False, "zones": [{
        "id": "block", "name": "Main block", "columns": len(cells),
        "rows": [{"id": "ground", "name": "Ground", "cells": list(cells)}],
    }]}


def save(client, document, version=0):
    return client.put(WRITE, json={"version": version, "layout": document})


def test_layout_is_shared_private_and_admin_only(admin, config, mailbox):
    unit = dwelling(admin)
    _, token = invite(admin, mailbox, dwelling_id=unit["id"])
    activate(admin, token)
    initial = admin.get(READ).json()
    assert initial["layout"] is None
    assert initial["version"] == 0
    with visitor(config) as reader:
        assert reader.get(READ).status_code == 401
        assert save(reader, layout(unit["id"])).status_code == 401
        assert login(reader).status_code == 200
        assert reader.get(READ).json() == initial
        assert save(reader, layout(unit["id"])).status_code == 401
        saved = save(admin, layout(unit["id"], None))
        assert saved.status_code == 200, saved.text
        assert saved.json()["version"] == 1
        assert reader.get(READ).json() == saved.json()
        assert set(saved.json()) == {"version", "layout", "limits"}
        assert "coefficient" not in saved.text
        assert "resident@example.org" not in saved.text
    assert save(admin, layout(unit["id"]), version=0).status_code == 409
    assert admin.get(READ).json() == saved.json()


def test_layout_preserves_directory_and_uses_ids_not_names(admin, config):
    units = [dwelling(admin, label) for label in ["Bajo A", "1 A", "2 A", "Patio"]]
    doc = layout(units[2]["id"], None)
    doc["zones"][0]["rows"] += [
        {"id": "first", "name": "First", "cells": [units[1]["id"], None]},
        {"id": "bottom", "name": "Ground", "cells": [units[0]["id"], None]},
    ]
    doc["zones"].append({
        "id": "outside", "name": "Outside", "columns": 1,
        "rows": [{"id": "patio", "name": "", "cells": [units[3]["id"]]}],
    })
    async def revision(db):
        state = await db.get(State, 1)
        return state.revision, state.community_name
    before = database(config, revision)
    directory = admin.get("/api/neighbors").json()
    assert save(admin, doc).status_code == 200
    assert admin.get("/api/admin/dwellings").json() == units
    assert admin.get("/api/neighbors").json() == directory
    assert database(config, revision) == before
    renamed = admin.patch(f"/api/admin/dwellings/{units[0]['id']}", json={
        "label": "New name", "version": units[0]["version"],
    })
    assert renamed.status_code == 200
    dwelling(admin, "Unplaced")
    assert admin.get(READ).json()["layout"] == doc
    assert len(admin.get("/api/neighbors").json()) == 5
    assert save(admin, {"zones": []}, version=1).status_code == 200
    assert len(admin.get("/api/neighbors").json()) == 5


def test_invalid_layout_is_atomic_and_missing_dwelling_is_explicit(admin):
    unit = dwelling(admin)
    document = layout(unit["id"], None)
    assert save(admin, document).status_code == 200
    saved = admin.get(READ).json()
    invalid = layout(unit["id"], unit["id"])
    response = save(admin, invalid, version=1)
    assert response.status_code == 422
    assert response.json()["code"] == "dwelling_layout_invalid"
    response = save(admin, layout(unit["id"], 2147483647), version=1)
    assert response.status_code == 422
    assert response.json()["code"] == "dwelling_layout_missing"
    assert admin.get(READ).json() == saved


@pytest.mark.parametrize("cell", [True, False, 0, -1, 1.0, "1", {}, [], 2147483648])
def test_cell_ids_are_strict_positive_integers(cell):
    with pytest.raises(ValidationError):
        DwellingLayoutIn(version=0, layout=layout(cell))


def test_layout_contract_rejects_ambiguous_or_excessive_structures():
    valid = {"version": 0, "layout": layout(1, None)}
    invalid = []
    for field, value in [
        ("columns", 1), ("columns", True), ("columns", 25), ("name", " "),
        ("name", "Bad\nname"), ("name", "x" * 151), ("rows", []), ("id", "bad:id"),
    ]:
        body = deepcopy(valid)
        body["layout"]["zones"][0][field] = value
        invalid.append(body)
    body = deepcopy(valid)
    body["layout"]["zones"] *= 2
    invalid.append(body)
    body = deepcopy(valid)
    body["layout"]["zones"][0]["rows"] *= 2
    invalid.append(body)
    body = deepcopy(valid)
    body["layout"]["zones"][0]["rows"][0]["cells"] = [1, 1]
    invalid.append(body)
    for version in [True, -1, "0", 0.0]:
        invalid.append({**valid, "version": version})
    invalid.append({**valid, "layout": None})
    for body in invalid:
        with pytest.raises(ValidationError):
            DwellingLayoutIn.model_validate(body)
    assert DwellingLayoutIn.model_validate(valid).layout.zones[0].rows[0].cells == [1, None]


@pytest.mark.parametrize("initial_version", [0, 1])
def test_simultaneous_layout_saves_have_exactly_one_winner(admin, config, initial_version):
    unit = dwelling(admin)
    if initial_version:
        assert save(admin, layout(unit["id"])).status_code == 200
    with visitor(config) as other:
        assert other.post("/api/admin/auth/login", json={
            "username": config.admin_username,
            "password": config.admin_password.get_secret_value(),
        }).status_code == 200
        barrier = Barrier(2)
        def write(client, name):
            doc = layout(unit["id"])
            doc["zones"][0]["name"] = name
            barrier.wait()
            return save(client, doc, version=initial_version)
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(write, admin, "One")
            b = pool.submit(write, other, "Two")
            results = [a.result(), b.result()]
        assert sorted(response.status_code for response in results) == [200, 409]
        winner = next(response.json() for response in results if response.status_code == 200)
        assert admin.get(READ).json() == winner
        assert winner["version"] == initial_version + 1


def test_layout_does_not_depend_on_feature_flags(admin):
    for feature in ("coefficient", "actions"):
        assert admin.patch(
            f"/api/admin/settings/features/{feature}", json={"enabled": False},
        ).status_code == 200
    unit = admin.post("/api/admin/dwellings", json={"label": "No coefficient"}).json()
    assert save(admin, layout(unit["id"])).status_code == 200
    assert admin.get(READ).json()["layout"] == layout(unit["id"])


def test_legacy_layout_hides_names_without_changing_saved_positions_or_version(admin, config):
    unit = dwelling(admin)
    expected = layout(unit["id"], None)
    legacy = {"zones": expected["zones"]}

    async def store_legacy(db):
        state = await db.get(State, 1)
        state.dwelling_layout = legacy
        state.dwelling_layout_version = 7
    database(config, store_legacy)
    result = admin.get(READ).json()
    assert result["layout"] == expected
    assert result["version"] == 7

    async def verify_unchanged(db):
        state = await db.get(State, 1)
        assert state.dwelling_layout == legacy
        assert state.dwelling_layout_version == 7
    database(config, verify_unchanged)
    saved = save(admin, legacy, version=7)
    assert saved.status_code == 200
    assert saved.json()["layout"] == expected


@pytest.mark.parametrize(("rows", "columns"), [
    (False, False), (True, False), (False, True), (True, True),
])
def test_layout_display_preferences_are_independent_and_versioned(admin, rows, columns):
    unit = dwelling(admin)
    document = {**layout(unit["id"], None), "show_row_names": rows, "show_column_names": columns}
    response = save(admin, document)
    assert response.status_code == 200
    assert response.json()["layout"] == document
    assert admin.get(READ).json() == response.json()
    stale = save(admin, {**document, "show_row_names": not rows})
    assert stale.status_code == 409
    assert admin.get(READ).json()["layout"] == document


@pytest.mark.parametrize("field", ["show_row_names", "show_column_names"])
@pytest.mark.parametrize("invalid", [None, "true", "false", 1, 0, [], {}])
def test_layout_display_preferences_require_booleans(field, invalid):
    with pytest.raises(ValidationError):
        DwellingLayoutIn(version=0, layout={**layout(1), field: invalid})
