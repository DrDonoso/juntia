"""Reading the text of shared documents for the search, with OCR for scanned pages and pictures."""

import io
import shutil
import subprocess
import sys
import zipfile
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from sqlalchemy import select

from juntia import document_text
from juntia.app import create_app
from juntia.db import DocumentText, utcnow
from juntia.document_index import Engine, excerpt, reconcile
from juntia.document_text import clean, decode, extract, words
from juntia.query_sql import fold_text
from tests.test_action_storage import execute
from tests.test_community_actions import actors as actors
from tests.test_documents import (
    deletions,
    mp4,
    pdf,
    refused,
    remove,
    search,
    stored,
    upload,
    uploaded,
)
from tests.test_documents import enabled as enabled
from tests.test_feature_flags import set_flag
from tests.test_users import database
from tests.test_users import mailbox as mailbox

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
TEXT = 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
OOXML_MAIN = "application/vnd.openxmlformats-officedocument.{}.main+xml"


def tesseract_models():
    if shutil.which("tesseract") is None:
        return set()
    result = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True)
    return {line.strip() for line in (result.stdout + result.stderr).splitlines()}


OCR = pytest.mark.skipif(
    "eng" not in tesseract_models(), reason="Tesseract and its English model are not installed",
)


def read_texts(client):
    """What the reader of each process does in the background."""
    return client.portal.call(client.app.state.document_reader.drain)


def reader(client):
    return client.app.state.document_reader


def office(kind, main, xml, *extra):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", (
            f'<Types><Override PartName="/{main}" ContentType="{OOXML_MAIN.format(kind)}"/></Types>'
        ))
        archive.writestr(main, xml)
        for name, data in extra:
            archive.writestr(name, data)
    return output.getvalue()


def word(*paragraphs, prolog=""):
    body = "".join(f"<w:p>{paragraph}</w:p>" for paragraph in paragraphs)
    return office(
        "wordprocessingml.document", "word/document.xml",
        f"{prolog}<w:document {W}><w:body>{body}</w:body></w:document>",
    )


def run(text):
    return f"<w:r><w:t>{text}</w:t></w:r>"


def open_document(kind, body):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            zipfile.ZipInfo("mimetype"), f"application/vnd.oasis.opendocument.{kind}",
        )
        archive.writestr("content.xml", (
            f"<office:document-content {TEXT} "
            'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0">'
            f"<office:body>{body}</office:body></office:document-content>"
        ))
    return output.getvalue()


def text_pdf(*pages, encrypt=None):
    output = io.BytesIO()
    document = canvas.Canvas(output, encrypt=encrypt)
    for page in pages:
        for number, line in enumerate(page.splitlines()):
            document.drawString(72, 760 - 18 * number, line)
        document.showPage()
    document.save()
    return output.getvalue()


def picture(text, rotate=0, file_format="PNG", lines=1):
    image = Image.new("RGB", (1800, 360 * lines), "white")
    draw = ImageDraw.Draw(image)
    for line in range(lines):
        draw.text(
            (60, 120 + 120 * line), text, fill="black", font=ImageFont.load_default(size=72),
        )
    if rotate:
        image = image.rotate(rotate, expand=True, fillcolor="white")
    output = io.BytesIO()
    image.save(output, format=file_format)
    return output.getvalue()


def scanned_pdf(text):
    page = Image.new("L", (1654, 2339), 255)
    ImageDraw.Draw(page).text((150, 300), text, fill=0, font=ImageFont.load_default(size=56))
    output = io.BytesIO()
    page.save(output, format="PDF", resolution=200)
    return output.getvalue()


def read(tmp_path, extension, content, model=None):
    path = tmp_path / f"file.{extension}"
    path.write_bytes(content)
    return extract(path, extension, model)


def file_info(client, item):
    response = client.get(f"/api/documents/files/{item['id']}")
    assert response.status_code == 200, response.text
    return response.json()


def summary(client):
    response = client.get("/api/admin/documents/text")
    assert response.status_code == 200, response.text
    return response.json()


def text_files(client, **params):
    response = client.get("/api/admin/documents/text/files", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def names_of(found):
    return [item["name"] for item in found["files"]]


def test_text_is_cleaned_onto_one_line():
    assert clean(
        "Comu-\nnidad de\u00a0pro\u00adpietarios (cid:12)\tAlfa-\nBeta\x00\ufffd\ue000 cuota"
    ) == "Comunidad de propietarios Alfa- Beta cuota"
    assert clean("Reunio\u0301n") == "Reunión"


def test_text_files_are_decoded_like_the_viewer_does():
    assert decode("Reunión".encode("utf-8-sig"), False) == "Reunión"
    assert decode("\ufeffReunión".encode("utf-16-le"), False) == "Reunión"
    assert decode("\ufeffReunión".encode("utf-16-be"), False) == "Reunión"
    assert decode("Reunión".encode(), False) == "Reunión"
    assert decode("Reunión".encode("cp1252"), False) == "Reunión"
    # A file read in part may end in the middle of a character.
    assert decode("Reunión".encode()[:-2], True) == "Reuni"


def test_office_and_open_documents_give_their_text(tmp_path):
    document = word(
        run("Presupuesto del ") + run("ascensor"),
        "<w:r><w:t>Segunda</w:t><w:tab/><w:t>línea</w:t></w:r>",
        "<w:r><w:instrText>PAGE</w:instrText><w:delText>borrado</w:delText></w:r>",
    )
    assert read(tmp_path, "docx", document)["content"] == "Presupuesto del ascensor Segunda línea"
    sheet = office(
        "spreadsheetml.sheet", "xl/workbook.xml", "<workbook/>",
        ("xl/sharedStrings.xml", (
            f"<sst {S}><si><t>Fontanería</t></si>"
            "<si><r><t>Agua </t></r><r><t>caliente</t></r><rPh><t>x</t></rPh></si></sst>"
        )),
        ("xl/worksheets/sheet2.xml", (
            f'<worksheet {S}><sheetData><row><c t="inlineStr"><is><t>Portal</t></is></c>'
            '<c t="b"><v>1</v></c></row></sheetData></worksheet>'
        )),
        ("xl/worksheets/sheet1.xml", (
            f'<worksheet {S}><sheetData><row><c t="s"><v>0</v></c><c><v>620.5</v></c>'
            '<c><f>B1*2</f><v>1241</v></c></row><row><c t="s"><v>1</v></c>'
            '<c t="s"><v>9</v></c></row></sheetData></worksheet>'
        )),
    )
    assert read(tmp_path, "xlsx", sheet)["content"] == "Fontanería 620.5 1241 Agua caliente Portal"
    slides = office(
        "presentationml.presentation", "ppt/presentation.xml", "<presentation/>",
        *[(f"ppt/slides/slide{number}.xml", (
            f"<p:sld {A} xmlns:p='p'><a:p><a:r><a:t>Diapositiva</a:t></a:r>"
            f"<a:br/><a:r><a:t>{number}</a:t></a:r></a:p></p:sld>"
        )) for number in (10, 2, 1)],
    )
    assert read(tmp_path, "pptx", slides)["content"] == (
        "Diapositiva 1 Diapositiva 2 Diapositiva 10"
    )
    text = open_document("text", (
        "<office:text><text:h>Normas</text:h><text:p>Horario<text:s/>de<text:tab/>"
        "<text:span>silencio</text:span></text:p></office:text>"
    ))
    assert read(tmp_path, "odt", text) == {
        "content": "Normas Horario de silencio", "ocr_pages": 0, "needs_ocr": False,
        "partial": False,
    }
    # Declarations that could expand entities or reach other files are refused.
    entities = word(run("&x;"), prolog='<!DOCTYPE w:document [<!ENTITY x "boom">]>')
    assert read(tmp_path, "docx", entities) == {"error": "damaged"}
    assert read(tmp_path, "docx", b"not a zip archive") == {"error": "damaged"}


def test_long_files_are_read_in_part(tmp_path, monkeypatch):
    monkeypatch.setattr(document_text, "MAX_CHARACTERS", 40)
    found = read(tmp_path, "txt", b"Primera linea del acta\nsegunda linea del acta\n")
    assert found["content"] == "Primera linea del acta segunda linea"
    assert found["partial"] is True
    monkeypatch.setattr(document_text, "MAX_TEXT_BYTES", 8)
    assert read(tmp_path, "csv", "año,cuota\n".encode())["content"] == "año,cuo"
    monkeypatch.setattr(document_text, "MAX_CHARACTERS", 500_000)
    monkeypatch.setattr(document_text, "MAX_XML_BYTES", 300)
    long = read(tmp_path, "docx", word(*[run(f"Parrafo {number}") for number in range(80)]))
    assert long["partial"] is True and long["content"].startswith("Parrafo 0 Parrafo 1")


def test_pdfs_give_the_text_of_their_pages(tmp_path):
    found = read(tmp_path, "pdf", text_pdf(
        "Acta de la junta ordinaria\nSe aprueba revisar el ascensor.",
        "Segunda pagina con el presupuesto de pintura del portal.",
    ))
    assert found == {
        "content": "Acta de la junta ordinaria Se aprueba revisar el ascensor. Segunda pagina "
        "con el presupuesto de pintura del portal.",
        "ocr_pages": 0, "needs_ocr": False, "partial": False,
    }
    # Without OCR, a scan is left for when OCR is available.
    assert read(tmp_path, "pdf", scanned_pdf("Escaneado")) == {
        "content": "", "ocr_pages": 0, "needs_ocr": True, "partial": False,
    }
    assert read(tmp_path, "png", picture("Aviso")) == {
        "content": "", "ocr_pages": 0, "needs_ocr": True, "partial": False,
    }
    assert read(tmp_path, "pdf", text_pdf("Secreto", encrypt="clave")) == {"error": "encrypted"}
    assert read(tmp_path, "pdf", pdf("not really a PDF")) == {"error": "damaged"}
    assert extract(tmp_path / "gone.pdf", "pdf", None) == {"error": "missing"}


def test_ocr_keeps_good_lines_and_drops_what_it_is_unsure_of():
    header = "\t".join(["level", "page", "block", "par", "line", "word", "l", "t", "w", "h",
                        "conf", "text"])

    def row(line, confidence, text):
        return "\t".join(["5", "1", "1", "1", str(line), "1", "0", "0", "1", "1",
                          str(confidence), text])

    tsv = "\n".join([
        header, row(1, 95, "ACTA"), row(1, 8, "DE"), row(1, 90, "LA"), row(1, 96, "JUNTA"),
        row(2, 10, "eS"), row(2, 30, "%"), row(2, 13, "pos"), row(2, 10, "SES"),
        row(2, 88, "Portal"), row(3, -1, ""),
    ])
    assert words(tsv) == "ACTA DE LA JUNTA\nPortal"


@pytest.mark.parametrize(("content", "needle", "expected"), [
    ("La Reunión de VECINOS será el lunes.", "reunion de vecinos",
     ("La ", "Reunión de VECINOS", " será el lunes.")),
    ("Die Straße ist lang", "strasse", ("Die ", "Straße", " ist lang")),
    ("ﬁnca", "fi", ("", "ﬁ", "nca")),
    ("sin coincidencias", "ascensor", None),
])
def test_excerpts_show_the_original_text_around_the_match(content, needle, expected):
    found = excerpt(content, fold_text(needle))
    assert (found.before, found.match, found.after) == expected if found else expected is None


def test_long_excerpts_are_cut_at_words():
    content = " ".join(f"palabra{number}" for number in range(600)) + " Ascensor averiado " + (
        " ".join(f"final{number}" for number in range(200))
    )
    found = excerpt(content, "ascensor averiado")
    assert found.match == "Ascensor averiado"
    assert found.before.startswith("…palabra") and found.before.endswith("palabra599 ")
    assert found.after.startswith(" final0 ") and found.after.endswith("…")
    assert len(found.before) <= 82 and len(found.after) <= 162
    # A match across the chunks that are folded separately.
    edge = "x" * 2045 + " Ñandú grande"
    assert excerpt(edge, "nandu grande").match == "Ñandú grande"


def test_uploads_are_read_in_the_background_and_found_by_their_text(actors, enabled, config):
    a, b, _, _ = actors
    minutes = uploaded(a, "Acta.txt", "La junta aprobó la reparación del ascensor.\n".encode())
    budget = uploaded(b, "Presupuesto ascensor.pdf", text_pdf("Presupuesto de pintura"))
    letter = uploaded(a, "Carta.docx", word(run("Carta sobre el ascensor del portal")))
    video = uploaded(a, "Visita.mp4", mp4())
    # Until they are read, the search only knows their names, and says what is left.
    found = search(b, "reparacion del ascensor")
    assert (found["total"], found["pending"]) == (0, 3)
    assert file_info(b, minutes)["text"] == {"status": "pending", "ocr_pages": 0, "partial": False}
    assert file_info(b, video)["text"] == {"status": "unsupported", "ocr_pages": 0, "partial": False}
    assert read_texts(enabled) == 3
    assert file_info(b, minutes)["text"] == {"status": "ready", "ocr_pages": 0, "partial": False}
    found = search(b, " REPARACIÓN  del ascensor ")
    assert (found["total"], found["pending"], names_of(found)) == (1, 0, ["Acta.txt"])
    assert found["files"][0]["excerpt"] == {
        "before": "La junta aprobó la ", "match": "reparación del ascensor", "after": ".",
    }
    # Names come first, without excerpt; then the files found by their text, in the same order.
    found = search(b, "ascensor", sort="size")
    assert names_of(found) == ["Presupuesto ascensor.pdf", "Carta.docx", "Acta.txt"]
    assert [item["excerpt"] for item in found["files"]] == [None, {
        "before": "Carta sobre el ", "match": "ascensor", "after": " del portal",
    }, {"before": "La junta aprobó la reparación del ", "match": "ascensor", "after": "."}]
    assert search(b, "pintura")["files"][0]["id"] == budget["id"]
    # Deleted files are not found; restoring them brings their text back without reading it.
    assert remove(a, letter).status_code == 204
    assert names_of(search(b, "portal")) == []
    deletion = deletions(enabled)[0]
    assert enabled.post(
        f"/api/admin/documents/deletions/{deletion['id']}/restore"
    ).status_code == 204
    assert names_of(search(b, "portal")) == ["Carta.docx"]
    assert read_texts(enabled) == 0
    # A new version replaces the text: the earlier one is no longer found.
    replaced = upload(a, "Acta.txt", b"Nueva acta sobre la piscina\n", document_id=minutes["id"])
    assert replaced.status_code == 200, replaced.text
    assert search(b, "reparacion")["total"] == 0
    assert search(b, "piscina")["pending"] == 1
    assert read_texts(enabled) == 1
    assert names_of(search(b, "piscina")) == ["Acta.txt"]

    async def texts(db):
        return (await db.execute(select(DocumentText.version_id, DocumentText.status))).all()

    assert len(database(config, texts)) == 3
    # Purging deleted files removes their text with them.
    assert remove(b, budget).status_code == 204
    deletion = deletions(enabled)[0]
    assert enabled.post(f"/api/admin/documents/deletions/{deletion['id']}/purge").status_code == 204
    assert len(database(config, texts)) == 2


def test_files_stored_before_are_queued_when_the_application_starts(enabled, config):
    shared = uploaded(enabled, "Normas.txt", b"Horario de silencio desde las 22:00\n")
    uploaded(enabled, "Plano.png", picture("Plano"))
    read_texts(enabled)
    execute(config, "DELETE FROM document_texts")
    assert search(enabled, "silencio")["total"] == 0
    with TestClient(create_app(config, text_worker=False)) as restarted:
        assert summary(enabled)["counts"]["pending"] == 2
        assert read_texts(restarted) == 2
    assert search(enabled, "silencio")["files"][0]["id"] == shared["id"]

    async def requeue(db):
        engine = Engine("en", "eng", "5.5.0", True)
        await db.execute(DocumentText.__table__.update().values(
            ocr_pages=1, ocr_language="spa", needs_ocr=False,
        ).where(DocumentText.characters > 0))
        await db.execute(DocumentText.__table__.update().values(
            needs_ocr=True,
        ).where(DocumentText.characters == 0))
        await db.commit()
        await reconcile(db, engine)
        return sorted((await db.scalars(select(DocumentText.status))).all())

    # With OCR available, what was read without it or in another language is read again.
    assert database(config, requeue) == ["pending", "pending"]


def test_the_administrator_follows_the_reading(actors, enabled, config):
    a, _, _, _ = actors
    readable = uploaded(a, "Acta.pdf", text_pdf("Acta de la junta"))
    damaged = uploaded(a, "Roto.pdf", pdf("not really a PDF"))
    blank = uploaded(a, "Vacio.txt", b" \n")
    video = uploaded(a, "Visita.mp4", mp4())
    first = summary(enabled)
    assert first["engine"]["language"] == "en"
    assert first["counts"] == {
        "files": 4, "readable": 3, "pending": 3, "text": 0, "empty": 0, "failed": 0,
        "partial": 0, "ocr": 0, "needs_ocr": 0,
    }
    assert first["reading"] is None
    waiting = text_files(enabled, status="pending")
    assert [item["name"] for item in waiting["items"]] == ["Vacio.txt", "Roto.pdf", "Acta.pdf"]
    assert waiting["items"][0] | {"document_id": 0, "location": []} == {
        "document_id": 0, "name": "Vacio.txt", "kind": "text", "location": [],
        "status": "pending", "reading": False, "error": None, "characters": 0, "ocr_pages": 0,
        "partial": False, "needs_ocr": False, "read_at": None,
    }
    read_texts(enabled)
    counts = summary(enabled)["counts"]
    assert (counts["pending"], counts["text"], counts["empty"], counts["failed"]) == (0, 1, 1, 1)
    failed = text_files(enabled, status="failed")["items"]
    assert [(item["document_id"], item["error"]) for item in failed] == [(damaged["id"], "damaged")]
    assert [item["name"] for item in text_files(enabled, status="text")["items"]] == ["Acta.pdf"]
    assert [item["name"] for item in text_files(enabled, status="empty")["items"]] == ["Vacio.txt"]
    assert text_files(enabled)["total"] == 3
    # Reading one again, or every one that failed; one waiting keeps its place.
    again = enabled.post(f"/api/admin/documents/text/files/{readable['id']}/read")
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "pending"
    retried = enabled.post("/api/admin/documents/text/retry")
    assert retried.json() == {"queued": 1}
    assert enabled.post("/api/admin/documents/text/retry").json() == {"queued": 0}
    assert summary(enabled)["counts"]["pending"] == 2
    # The file being read now.
    started = utcnow() - timedelta(minutes=2)
    execute(
        config, "UPDATE document_texts SET claim_id = 'claim', claimed_at = :started, "
        "claimed_until = :until WHERE status = 'pending' AND characters > 0",
        started=started, until=utcnow() + timedelta(minutes=1),
    )
    reading = summary(enabled)["reading"]
    assert (reading["document_id"], reading["name"]) == (readable["id"], "Acta.pdf")
    assert [item["reading"] for item in text_files(enabled, status="pending")["items"]] == [
        False, True,
    ]
    refused(
        enabled.post(f"/api/admin/documents/text/files/{video['id']}/read"), 409,
        "document_text_unsupported",
    )
    assert remove(a, blank).status_code == 204
    refused(
        enabled.post(f"/api/admin/documents/text/files/{blank['id']}/read"), 404,
        "document_not_found",
    )
    refused(enabled.get("/api/admin/documents/text/files", params={"status": "x"}), 422,
            "invalid_request")
    refused(a.get("/api/admin/documents/text"), 403, "administrator_required")
    # It keeps working while Documents is turned off.
    set_flag(enabled, "documents", False)
    assert summary(enabled)["counts"]["files"] == 3


def test_a_claim_lets_one_reader_at_a_time_read_a_file(enabled, config):
    item = uploaded(enabled, "Acta.txt", b"Primera version\n")
    claim = enabled.portal.call(reader(enabled).claim)
    assert claim is not None and enabled.portal.call(reader(enabled).claim) is None
    # An abandoned claim expires.
    execute(config, "UPDATE document_texts SET claimed_until = :past", past=utcnow())
    abandoned = enabled.portal.call(reader(enabled).claim)
    assert abandoned is not None and abandoned.claim_id != claim.claim_id
    # A newer version replaces the file being read: what was read of the old one is dropped.
    assert upload(enabled, "Acta.txt", b"Segunda version\n", document_id=item["id"]).status_code == 200
    assert enabled.portal.call(reader(enabled).renew, abandoned) is False
    enabled.portal.call(reader(enabled).store, abandoned, {
        "content": "Primera version", "ocr_pages": 0, "needs_ocr": False, "partial": False,
    })
    assert search(enabled, "primera")["total"] == 0
    assert read_texts(enabled) == 1
    assert search(enabled, "segunda")["files"][0]["id"] == item["id"]


def test_a_missing_file_is_reported(enabled, config):
    item = uploaded(enabled, "Acta.txt", b"Texto\n")
    for name in stored(config, ".txt"):
        (config.upload_dir / "documents" / name).unlink()
    read_texts(enabled)
    assert text_files(enabled, status="failed")["items"][0]["error"] == "missing"
    assert file_info(enabled, item)["text"]["status"] == "failed"


@OCR
def test_scanned_pages_and_pictures_are_read_with_ocr(enabled):
    scan = uploaded(enabled, "Escaneo.pdf", scanned_pdf("Juntia reads scanned documents"))
    # Tesseract finds which way a picture is turned from a few lines of text.
    photo = uploaded(enabled, "Aviso.jpg", picture("Juntia reads photos too", 90, "JPEG", 3))
    wall = io.BytesIO()
    Image.linear_gradient("L").resize((1200, 900)).save(wall, format="PNG")
    uploaded(enabled, "Pared.png", wall.getvalue())
    assert read_texts(enabled) == 3
    assert search(enabled, "scanned documents")["files"][0]["id"] == scan["id"]
    assert search(enabled, "photos too")["files"][0]["id"] == photo["id"]
    assert file_info(enabled, scan)["text"] == {"status": "ready", "ocr_pages": 1, "partial": False}
    # The latest read first: the newest files are read first.
    assert [item["name"] for item in text_files(enabled, status="ocr")["items"]] == [
        "Escaneo.pdf", "Aviso.jpg", "Pared.png",
    ]
    assert [item["name"] for item in text_files(enabled, status="empty")["items"]] == ["Pared.png"]
    assert summary(enabled)["engine"]["available"] is True
    check = subprocess.run(
        [sys.executable, "-m", "juntia.document_text", "--check", "eng"],
        capture_output=True, text=True, timeout=120,
    )
    assert check.returncode == 0, check.stdout + check.stderr
