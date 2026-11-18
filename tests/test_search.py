"""The search box at the top of every page (src/juntia/search.py)."""

import time

import pytest

from juntia import search as search_module
from juntia.search import plain_text
from tests.test_action_pdfs import upload as upload_pdf
from tests.test_api import commit, preview
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_community_events import create_event
from tests.test_contacts import create as create_contact
from tests.test_contacts import remove as remove_contact
from tests.test_document_text import read_texts
from tests.test_documents import folder, refused, remove, uploaded
from tests.test_feature_flags import set_flag
from tests.test_neighbors import create_neighbor
from tests.test_presidency import assign
from tests.test_users import dwelling, visitor
from tests.test_users import mailbox as mailbox

PATH = "/api/search"


def search(client, q):
    response = client.get(PATH, params={"q": q})
    assert response.status_code == 200, response.text
    return response.json()


def found(client, q):
    """What the search lists, by kind and title."""
    return [(item["kind"], item["title"]) for item in search(client, q)["items"]]


def only(client, q):
    items = search(client, q)["items"]
    assert len(items) == 1, items
    return items[0]


@pytest.mark.parametrize(("markdown", "text"), [
    ("Presupuesto **pendiente** de [Cerrajería](https://example.org/a_b)",
     "Presupuesto pendiente de Cerrajería"),
    ("Mira ![foto del portal](/api/actions/images/1234) y `nota_final`",
     "Mira foto del portal y nota_final"),
    ("# Orden del día\n\n- Cuotas\n1. Obras\n> - [x] _Hecho_ ~~antes~~\n\nfin",
     "Orden del día Cuotas Obras Hecho antes fin"),
    ("2 * 3 = 6", "2 * 3 = 6"),
])
def test_excerpts_read_markdown_as_text(markdown, text):
    assert plain_text(markdown) == text


@pytest.mark.parametrize(
    "markdown", ["[" * 40_000 + " zzz", "![" * 20_000 + " zzz"], ids=["links", "images"],
)
def test_excerpts_read_any_member_text_in_linear_time(markdown):
    # Unclosed brackets made each link pattern rescan the rest of the text from every bracket:
    # seconds of work that held up every other request.
    start = time.perf_counter()
    assert plain_text(markdown).endswith(" zzz")
    assert time.perf_counter() - start < 0.25


def test_search_needs_a_session_and_a_valid_text(admin, config):
    with visitor(config) as anonymous:
        refused(anonymous.get(PATH, params={"q": "puerta"}), 401, "authentication_required")
    for params in ({}, {"q": ""}, {"q": "x" * 201}):
        refused(admin.get(PATH, params=params), 422, "invalid_request")
    assert search(admin, "   ") == {"items": [], "more": False}
    create_item(admin, "Puerta del garaje")
    # Text with NUL is never stored, so it is never found, on every database.
    assert search(admin, "puerta\x00") == {"items": [], "more": False}


def test_every_kind_is_found_by_its_title_and_its_other_fields(actors, admin, mailbox):
    a, b, _, _ = actors
    set_flag(admin, "events", True)
    set_flag(admin, "documents", True)
    action = create_item(
        a, "Reparar la puerta del garaje", labels=["Urgente"],
        description="Presupuesto **pendiente** de [Cerrajería](https://example.org)",
    )
    event = create_event(
        a, title="Junta de vecinos", location="Sala común",
        description="Orden del día:\n\n- Cuotas de 2027",
    )
    minutes = folder(a, "Actas")
    record = uploaded(
        a, "Acta de marzo.txt", "La junta aprobó la reparación del ascensor.\n".encode(),
        folder_id=minutes["id"],
    )
    assert read_texts(admin) == 1
    lucia = create_neighbor(
        admin, mailbox, dwelling(admin, "2 B"), "lucia@example.org", "Lucía Martín",
        "+34 600 123 456",
    )
    contact = create_contact(
        a, "Fontanería Pérez", company="Pérez e hijos", notes="Llamar\npor la mañana.",
        new_tags=[{"name": "Urgencias", "color": "#21639f"}],
    )
    assert commit(admin, preview(admin)).status_code == 200
    # Actions: by their title, description and labels, whoever searches.
    assert only(b, "GARAJE") == {
        "kind": "action", "id": action["id"], "title": "Reparar la puerta del garaje",
        "status": "detected", "excerpt": None,
    }
    # Words missing from the title show where they are, in the description as it reads.
    assert only(b, "pendiente puerta")["excerpt"] == {
        "text": "Presupuesto pendiente de Cerrajería", "source": "description",
    }
    assert only(b, "urgente")["excerpt"] == {"text": "Urgente", "source": "labels"}
    # Events: by their title, location and description.
    assert only(b, "cuotas 2027") == {
        "kind": "event", "id": event["id"], "title": "Junta de vecinos", "location": "Sala común",
        "all_day": False, "starts_at": event["starts_at"], "ends_at": event["ends_at"],
        "starts_on": None, "ends_on": None,
        "excerpt": {"text": "Orden del día: Cuotas de 2027", "source": "description"},
    }
    assert only(b, "sala comun")["excerpt"] is None
    # Folders and files by their name, and files by the text inside them, with where they are.
    assert search(b, "acta")["items"] == [{
        "kind": "folder", "id": minutes["id"], "title": "Actas", "location": [], "excerpt": None,
    }, {
        "kind": "file", "id": record["id"], "title": "Acta de marzo.txt", "document_kind": "text",
        "folder_id": minutes["id"], "location": [{"id": minutes["id"], "name": "Actas"}],
        "excerpt": None,
    }]
    assert only(b, "reparacion ascensor")["excerpt"] == {
        "text": "La junta aprobó la reparación del ascensor.", "source": "text",
    }
    # Neighbors: by their name, email, phone and dwelling; phones as they are written too.
    assert only(b, "lucia 2 b") == {
        "kind": "neighbor", "id": lucia["id"], "title": "Lucía Martín",
        "email": "lucia@example.org", "phone": "+34600123456", "dwelling": "2 B",
        "is_president": False, "excerpt": None,
    }
    assert only(b, "600-123-456")["id"] == lucia["id"]
    assert only(b, "(600) 123")["id"] == lucia["id"]
    assert assign(admin, lucia["id"]).status_code == 200
    assert only(b, "martin")["is_president"] is True
    # Contacts: by every field and tag.
    assert only(b, "fontaneria") == {
        "kind": "contact", "id": contact["id"], "title": "Fontanería Pérez",
        "company": "Pérez e hijos", "email": None, "phone": "+34900123456", "excerpt": None,
    }
    assert only(b, "perez hijos")["excerpt"] is None
    assert only(b, "manana")["excerpt"] == {"text": "Llamar por la mañana.", "source": "notes"}
    assert only(b, "urgencias")["excerpt"] == {"text": "Urgencias", "source": "tags"}
    assert only(b, "900 123 456")["id"] == contact["id"]
    # Bank transactions: by their description and merchant, the latest first.
    assert [
        {key: item[key] for key in ("kind", "title", "booking_date", "amount", "merchant")}
        for item in search(b, "receipt")["items"]
    ] == [
        {"kind": "transaction", "title": "Cleaning receipt", "booking_date": "2026-10-02",
         "amount": "-20.00", "merchant": ""},
        {"kind": "transaction", "title": "Electricity receipt", "booking_date": "2026-10-01",
         "amount": "-30.00", "merchant": ""},
    ]


def test_actions_are_found_by_one_of_their_comments_or_pdfs(actors):
    a, b, _, _ = actors
    value = create_item(a, "Cambiar la bombilla")
    response = a.post(item_path(value) + "/comments", json={
        "body": "El **presupuesto** de [Luz Norte](https://example.org) llega el lunes",
    })
    assert response.status_code == 201, response.text
    comment = response.json()
    response = upload_pdf(a, value, filename="Factura Luz Norte.pdf")
    assert response.status_code == 201, response.text
    pdf = response.json()
    assert only(b, "presupuesto lunes") == {
        "kind": "action", "id": value["id"], "title": "Cambiar la bombilla", "status": "detected",
        "excerpt": {"text": "El presupuesto de Luz Norte llega el lunes", "source": "comment"},
    }
    assert only(b, "factura norte")["excerpt"] == {
        "text": "Factura Luz Norte.pdf", "source": "attachment",
    }
    # Words of the action and of a comment do not add up.
    assert found(b, "bombilla lunes") == []
    # What was withdrawn is no longer found.
    path = item_path(value)
    assert a.request("DELETE", f"{path}/comments/{comment['id']}", json={
        "version": comment["version"],
    }).status_code == 204
    assert a.request("DELETE", f"{path}/attachments/{pdf['id']}", json={
        "version": pdf["version"],
    }).status_code == 204
    assert found(b, "presupuesto") == []
    assert found(b, "factura") == []


def test_only_what_members_can_read_is_found(actors, admin, mailbox):
    a, b, _, _ = actors
    set_flag(admin, "events", True)
    set_flag(admin, "documents", True)
    create_item(a, "Revisar la piscina")
    event = create_event(a, title="Apertura de la piscina")
    files = folder(a, "Piscina")
    uploaded(a, "Normas de la piscina.txt", b"Horario de verano\n", folder_id=files["id"])
    pool = [
        ("folder", "Piscina"), ("action", "Revisar la piscina"),
        ("event", "Apertura de la piscina"), ("file", "Normas de la piscina.txt"),
    ]
    assert found(b, "piscina") == pool
    # A section that is off is not searched.
    set_flag(admin, "actions", False)
    set_flag(admin, "events", False)
    set_flag(admin, "documents", False)
    assert found(b, "piscina") == []
    set_flag(admin, "actions", True)
    set_flag(admin, "events", True)
    set_flag(admin, "documents", True)
    assert found(b, "piscina") == pool
    # Deleted events, documents and contacts are not found.
    assert a.request("DELETE", f"/api/events/{event['id']}", json={
        "version": event["version"],
    }).status_code == 204
    assert remove(a, files, "folders").status_code == 204
    assert found(b, "piscina") == [("action", "Revisar la piscina")]
    contact = create_contact(a, "Socorrista")
    assert found(b, "socorrista") == [("contact", "Socorrista")]
    assert remove_contact(a, contact).status_code == 204
    assert found(b, "socorrista") == []
    # Only the neighbors of the directory: not pending or deactivated accounts, nor
    # administrators without a dwelling.
    unit = dwelling(admin, "3 C")
    create_neighbor(admin, mailbox, unit, "pending@example.org", "Vecino pendiente", active=False)
    gone = create_neighbor(admin, mailbox, unit, "gone@example.org", "Vecino desactivado")
    response = admin.patch(f"/api/admin/users/{gone['id']}/status", json={
        "disabled": True, "version": gone["version"],
    })
    assert response.status_code == 200, response.text
    assert found(b, "vecino") == []
    assert found(b, "synthetic") == [
        ("neighbor", "Synthetic Resident"), ("neighbor", "Synthetic Resident"),
    ]


def test_best_matches_come_first_and_a_few_of_each_kind(admin, monkeypatch):
    create_item(admin, "Pintar el portal", description="Antes de llamar al ascensor")
    create_item(admin, "Revisar el ascensor")
    create_item(admin, "Ascensor")
    create_contact(admin, "Ascensores Norte")
    # Titles that start with the search, then titles with every word, then the words elsewhere;
    # equally good ones by kind, then the latest activity first.
    best = [
        ("action", "Ascensor"), ("contact", "Ascensores Norte"),
        ("action", "Revisar el ascensor"), ("action", "Pintar el portal"),
    ]
    assert search(admin, "ascensor")["more"] is False
    assert found(admin, "ascensor") == best
    assert found(admin, "revisar el") == [("action", "Revisar el ascensor")]
    assert found(admin, "el revisar") == [("action", "Revisar el ascensor")]
    monkeypatch.setattr(search_module, "PER_KIND", 2)
    assert search(admin, "ascensor")["more"] is True
    assert found(admin, "ascensor") == best[:3]
    monkeypatch.setattr(search_module, "LIMIT", 2)
    assert search(admin, "ascensor")["more"] is True
    assert found(admin, "ascensor") == best[:2]


def test_upcoming_events_come_before_past_ones(admin):
    set_flag(admin, "events", True)
    for title, day in (("Limpieza pasada", "2020-05-10"), ("Limpieza lejana", "2031-05-10"),
                       ("Limpieza cercana", "2030-05-10")):
        create_event(
            admin, title=title, starts_at=f"{day}T18:00:00", ends_at=f"{day}T20:00:00",
        )
    assert found(admin, "limpieza") == [
        ("event", "Limpieza cercana"), ("event", "Limpieza lejana"), ("event", "Limpieza pasada"),
    ]
