import hashlib
import io
import struct
import zipfile
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from juntia import community_documents
from juntia.config import Settings
from juntia.contracts import DOCUMENT_QUOTA_LIMIT_MB, DOCUMENT_SIZE_LIMIT_MB, reader_route
from juntia.document_files import (
    check_content,
    checked_name,
    document_name,
    numbered,
    upload_name,
)
from juntia.errors import AppError
from juntia.middleware import body_limit
from tests.test_action_migration import migrate
from tests.test_action_storage import MIB, execute, free_space
from tests.test_community_actions import actors as actors
from tests.test_community_images import picture
from tests.test_feature_flags import set_flag
from tests.test_users import current_user, visitor
from tests.test_users import mailbox as mailbox

LIMITS = {
    "max_file_mb": 50, "max_video_mb": 1024, "user_quota_mb": 2048, "community_quota_mb": 20480,
}
OOXML_MAIN = "application/vnd.openxmlformats-officedocument.{}.main+xml"


@pytest.fixture
def enabled(admin):
    set_flag(admin, "documents", True)
    return admin


def refused(response, status, code):
    assert (response.status_code, response.json()["code"]) == (status, code), response.text


def set_limits(admin, **values):
    response = admin.patch("/api/admin/settings/documents", json=values)
    assert response.status_code == 200, response.text
    return response.json()


def pdf(text="Synthetic minutes", size=0):
    content = b"%PDF-1.7\n% " + text.encode() + b"\n"
    return content + b" " * max(0, size - len(content) - 7) + b"\n%%EOF\n"


def box(kind, body):
    return struct.pack(">I", 8 + len(body)) + kind + body


def mp4(payload=256, brand=b"isom"):
    return (
        box(b"ftyp", brand + b"\0\0\0\0isomiso2mp41") + box(b"moov", b"\0" * 32)
        + box(b"mdat", b"v" * payload)
    )


def heic():
    return box(b"ftyp", b"heic\0\0\0\0mif1heic") + box(b"meta", b"\0" * 24)


def zipped(entries, stored_first=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        if stored_first:
            archive.writestr(zipfile.ZipInfo(stored_first[0]), stored_first[1])
        for name, data in entries:
            archive.writestr(name, data)
    return output.getvalue()


def ooxml(kind="wordprocessingml.document", main="word/document.xml", *extra, declared=None):
    types = declared or (
        f'<Types><Override PartName="/{main}" ContentType="{OOXML_MAIN.format(kind)}"/></Types>'
    )
    return zipped([("[Content_Types].xml", types.encode()), (main, b"<document/>"), *extra])


def odf(kind="text", *extra):
    return zipped(
        [("content.xml", b"<office:document-content/>"), *extra],
        stored_first=("mimetype", f"application/vnd.oasis.opendocument.{kind}".encode()),
    )


def start(client, name, content, upload_id=None, **target):
    upload_id = str(upload_id or uuid4())
    response = client.post("/api/documents/uploads", json={
        "upload_id": upload_id, "name": name, "size": len(content), **target,
    })
    return upload_id, response


def send(client, upload_id, content, offset=0, chunk=4 * MIB):
    for position in range(offset, len(content), chunk):
        response = client.put(
            f"/api/documents/uploads/{upload_id}/content", params={"offset": position},
            content=content[position:position + chunk],
        )
        assert response.status_code == 200, response.text
    return response


def upload(client, name, content, **target):
    upload_id, response = start(client, name, content, **target)
    assert response.status_code == 201, response.text
    send(client, upload_id, content)
    return client.post(f"/api/documents/uploads/{upload_id}/complete")


def uploaded(client, name, content, **target):
    response = upload(client, name, content, **target)
    assert response.status_code == 200, response.text
    return response.json()


def folder(client, name, parent_id=None):
    response = client.post("/api/documents/folders", json={"name": name, "parent_id": parent_id})
    assert response.status_code == 201, response.text
    return response.json()


def browse(client, folder_id=None):
    response = client.get(
        "/api/documents/browse", params={} if folder_id is None else {"folder": folder_id},
    )
    assert response.status_code == 200, response.text
    return response.json()


def history(client, item, kind="files"):
    response = client.get(f"/api/documents/{kind}/{item['id']}/history")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def edit(client, item, kind="files", **fields):
    return client.patch(f"/api/documents/{kind}/{item['id']}", json={
        "version": item["version"], **fields,
    })


def remove(client, item, kind="files"):
    return client.request(
        "DELETE", f"/api/documents/{kind}/{item['id']}", json={"version": item["version"]},
    )


def stored(config, suffix=None):
    directory = config.upload_dir / "documents"
    paths = sorted(directory.iterdir()) if directory.exists() else []
    return [path.name for path in paths if suffix is None or path.suffix == suffix]


def deletions(client):
    response = client.get("/api/admin/documents/deleted")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def check(tmp_path, extension, content):
    path = tmp_path / "upload.part"
    path.write_bytes(content)
    check_content(path, extension)


@pytest.mark.parametrize(("extension", "content"), [
    ("pdf", pdf()), ("jpg", picture("JPEG")), ("jpeg", picture("JPEG")), ("png", picture()),
    ("gif", picture("GIF")), ("webp", picture("WEBP")), ("heic", heic()), ("heif", heic()),
    ("docx", ooxml()), ("xlsx", ooxml("spreadsheetml.sheet", "xl/workbook.xml")),
    ("pptx", ooxml("presentationml.presentation", "ppt/presentation.xml")),
    # Embedded spreadsheets of charts are documents too, not programs.
    ("docx", ooxml(
        "wordprocessingml.document", "word/document.xml",
        ("word/embeddings/Microsoft_Excel_Worksheet.xlsx", b"PK"),
    )),
    ("odt", odf()), ("ods", odf("spreadsheet")), ("odp", odf("presentation")),
    ("txt", "Acta de la reunión\n".encode()), ("csv", b"piso,cuota\n1A,30\n"),
    ("txt", "Texto".encode("utf-16")), ("mp4", mp4()), ("m4v", mp4()),
    ("mov", mp4(brand=b"qt  ")), ("mov", box(b"moov", b"\0" * 8) + box(b"mdat", b"q" * 9)),
])
def test_accepted_files_match_their_extension(tmp_path, extension, content):
    check(tmp_path, extension, content)


@pytest.mark.parametrize(("extension", "content", "code"), [
    ("pdf", picture(), "document_type_mismatch"),
    ("pdf", b"%PDF-1.7\nno end", "document_type_mismatch"),
    ("png", pdf(), "document_type_mismatch"),
    ("jpg", picture(), "document_type_mismatch"),
    ("heic", mp4(), "document_type_mismatch"),
    ("docx", odf(), "document_type_mismatch"),
    ("xlsx", ooxml(), "document_type_mismatch"),
    ("docx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64, "document_type_mismatch"),
    ("odt", ooxml(), "document_type_mismatch"),
    ("ods", odf(), "document_type_mismatch"),
    ("txt", b"MZ\x90\x00\x03\x00\x00\x00", "document_type_mismatch"),
    ("csv", b"a,b\n\x00\x01", "document_type_mismatch"),
    ("mp4", mp4()[:-10], "document_type_mismatch"),
    ("mp4", box(b"ftyp", b"isom\0\0\0\0isom") + box(b"mdat", b"v"), "document_type_mismatch"),
    ("mp4", heic(), "document_type_mismatch"),
    ("mov", picture(), "document_type_mismatch"),
    ("docx", ooxml(
        "wordprocessingml.document", "word/document.xml", ("word/vbaProject.bin", b"vba"),
    ), "document_macros_unsupported"),
    ("xlsx", ooxml("spreadsheetml.sheet", "xl/workbook.xml", declared=(
        '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>'
        "</Types>"
    )), "document_macros_unsupported"),
    ("pptx", ooxml(
        "presentationml.presentation", "ppt/presentation.xml",
        ("ppt/activeX/activeX1.xml", b"<ax/>"),
    ), "document_macros_unsupported"),
    ("docx", ooxml(
        "wordprocessingml.document", "word/document.xml",
        ("word/embeddings/oleObject1.bin", b"\xd0\xcf\x11\xe0"),
    ), "document_macros_unsupported"),
    ("xlsx", ooxml(
        "spreadsheetml.sheet", "xl/workbook.xml", ("xl/macrosheets/sheet1.xml", b"<xm/>"),
    ), "document_macros_unsupported"),
    ("odt", odf("text", ("Basic/Standard/Module1.xml", b"<script/>")),
     "document_macros_unsupported"),
    ("ods", odf("spreadsheet", ("Scripts/python/macro.py", b"print()")),
     "document_macros_unsupported"),
])
def test_refused_files_explain_why(tmp_path, extension, content, code):
    with pytest.raises(AppError) as error:
        check(tmp_path, extension, content)
    assert (error.value.code, error.value.status) == (code, 415)


def test_archives_with_too_many_entries_are_refused_before_they_are_read(tmp_path):
    entries = [("[Content_Types].xml", OOXML_MAIN.format("wordprocessingml.document").encode())]
    content = zipped(entries + [(f"word/media/{index}.xml", b"") for index in range(10_001)])
    with pytest.raises(AppError) as error:
        check(tmp_path, "docx", content)
    assert error.value.code == "document_type_mismatch"


def test_names_work_on_every_system():
    assert upload_name("C:\\fakepath\\Acta junta.PDF") == ("Acta junta.PDF", "pdf")
    assert upload_name("../../etc/Presupuesto: 2026?.xlsx") == ("Presupuesto_ 2026_.xlsx", "xlsx")
    assert upload_name("con.pdf") == ("_con.pdf", "pdf")
    assert upload_name("  .pdf") == ("document.pdf", "pdf")
    assert upload_name("IMG_0042.HEIC ") == ("IMG_0042.HEIC", "heic")
    assert upload_name("x" * 300 + ".mov") == ("x" * 196 + ".mov", "mov")
    # A right-to-left override cannot disguise a program as a PDF.
    for name in (
        "factura\u202efdp.exe", "minutes", "page.html", "drawing.svg", "photos.zip",
        "macro.docm", "old.doc", "script.js", "setup.msi", "notes.pdf.exe",
    ):
        with pytest.raises(AppError) as error:
            upload_name(name)
        assert (error.value.code, error.value.status) == ("document_type_unsupported", 415)
    assert checked_name("  Actas \t de\n2026. ") == "Actas de 2026"
    for name in ("", " . ", "..", "a/b", "a\\b", "what?", "AUX", "com1.txt", "x" * 201):
        with pytest.raises(AppError) as error:
            checked_name(name)
        assert (error.value.code, error.value.fields) == (
            "document_name_invalid", {"name": "document_name_invalid"},
        )
    assert document_name("Nueva acta", "pdf") == "Nueva acta.pdf"
    assert document_name("Nueva acta.PDF", "pdf") == "Nueva acta.PDF"
    assert document_name("acta.docx", "pdf") == "acta.docx.pdf"
    with pytest.raises(AppError):
        document_name(" .pdf", "pdf")
    assert numbered("Report.pdf", 2, "pdf") == "Report (2).pdf"
    assert numbered("Photos", 3, None) == "Photos (3)"
    assert numbered("x" * 200, 10, None) == "x" * 195 + " (10)"
    assert reader_route("/documents") and reader_route("/documents/folders/12")
    assert not reader_route("/documents/folders/0") and not reader_route("/documents/files/1")


def test_the_administrator_sets_the_limits_of_documents(admin, config, monkeypatch):
    path = "/api/admin/settings/documents"
    # Available while Documents is off, with the defaults of a new installation.
    assert admin.get(path).json() == {"manage_policy": "creator", **LIMITS}
    # Only what is sent changes; the extremes are accepted.
    changed = {**LIMITS, "max_file_mb": 1, "community_quota_mb": DOCUMENT_QUOTA_LIMIT_MB}
    assert set_limits(admin, max_file_mb=1, community_quota_mb=DOCUMENT_QUOTA_LIMIT_MB) == {
        "manage_policy": "creator", **changed,
    }
    assert set_limits(admin, max_video_mb=DOCUMENT_SIZE_LIMIT_MB, user_quota_mb=1) == {
        "manage_policy": "creator", **changed, "max_video_mb": DOCUMENT_SIZE_LIMIT_MB,
        "user_quota_mb": 1,
    }
    # A single file or video fits in a ZIP download.
    assert DOCUMENT_SIZE_LIMIT_MB * MIB == community_documents.ARCHIVE_MAX_BYTES
    saved = admin.get(path).json()
    for invalid in (
        {}, {"max_file_mb": None}, {"max_file_mb": 0}, {"max_file_mb": DOCUMENT_SIZE_LIMIT_MB + 1},
        {"max_video_mb": -1}, {"user_quota_mb": 0},
        {"community_quota_mb": DOCUMENT_QUOTA_LIMIT_MB + 1}, {"max_file_mb": 1.5},
        {"max_file_mb": "50"}, {"max_file_mb": True}, {"quota_mb": 5},
    ):
        refused(admin.patch(path, json=invalid), 422, "invalid_request")
    assert admin.get(path).json() == saved
    with visitor(config) as anonymous:
        refused(anonymous.get(path), 401, "authentication_required")
        refused(anonymous.patch(path, json={"max_file_mb": 5}), 401, "authentication_required")
    # The environment no longer sets them: leftover variables are ignored.
    monkeypatch.setenv("DOCUMENT_MAX_FILE_MB", "0")
    local = {
        "database_url": "sqlite+aiosqlite:///:memory:", "admin_username": "admin",
        "admin_password": "a-long-synthetic-password", "auth_secret": "s" * 32,
        "auth_cookie_secure": False,
    }
    assert not hasattr(Settings(_env_file=None, **local), "document_max_file_mb")


def test_documents_are_off_by_default_and_need_a_session(admin, config):
    assert admin.get("/api/features").json()["documents"] is False
    refused(admin.get("/api/documents/browse"), 404, "documents_disabled")
    # Bodies are refused before they are received, like those of Actions and Events.
    refused(admin.post("/api/documents/folders", json={"name": "Actas"}), 404, "documents_disabled")
    refused(admin.put(
        f"/api/documents/uploads/{uuid4()}/content", params={"offset": 0}, content=b"x",
    ), 404, "documents_disabled")
    # The administration keeps working while the section is off.
    assert admin.get("/api/admin/documents/deleted").json()["items"] == []
    assert admin.get("/api/admin/settings/documents").json() == {
        "manage_policy": "creator", **LIMITS,
    }
    set_flag(admin, "documents", True)
    with visitor(config) as anonymous:
        refused(anonymous.get("/api/documents/browse"), 401, "authentication_required")
        refused(anonymous.post("/api/documents/folders", json={"name": "Actas"}), 401,
                "authentication_required")
    root = browse(admin)
    assert (root["folder"], root["path"], root["folders"], root["files"], root["policy"]) == (
        None, [], [], [], "creator",
    )
    assert root["limits"] == {
        "extensions": sorted([
            "csv", "docx", "gif", "heic", "heif", "jpeg", "jpg", "m4v", "mov", "mp4", "odp",
            "ods", "odt", "pdf", "png", "pptx", "txt", "webp", "xlsx",
        ]),
        "video_extensions": ["mp4", "m4v", "mov"], "max_file_bytes": 50 * MIB,
        "max_video_bytes": 1024 * MIB, "chunk_bytes": 4 * MIB, "max_folder_items": 1000,
        "max_depth": 10, "archive_max_items": 100, "archive_max_files": 5000,
        "archive_max_bytes": 10 * 1024 * MIB,
    }
    assert body_limit(f"/api/documents/uploads/{uuid4()}/content", "PUT") == 4 * MIB
    refused(admin.put(
        f"/api/documents/uploads/{uuid4()}/content", params={"offset": 0},
        content=b"x" * (4 * MIB + 1),
    ), 413, "request_too_large")


def test_uploads_arrive_in_chunks_resume_and_complete_once(enabled, config):
    content = pdf(size=2_500)
    upload_id, response = start(enabled, "Acta 2026.pdf", content)
    assert response.status_code == 201, response.text
    assert response.json()["received"] == 0
    # Starting again with the same ID finds the same upload; other details are a conflict.
    assert start(enabled, "Acta 2026.pdf", content, upload_id)[1].json() == response.json()
    refused(start(enabled, "Acta 2026.pdf", content + b" ", upload_id)[1], 409,
            "document_upload_conflict")
    send(enabled, upload_id, content[:1000], chunk=1000)
    refused(enabled.put(
        f"/api/documents/uploads/{upload_id}/content", params={"offset": 0}, content=b"%",
    ), 409, "document_upload_offset")
    refused(enabled.post(f"/api/documents/uploads/{upload_id}/complete"), 409,
            "document_upload_incomplete")
    status = enabled.get(f"/api/documents/uploads/{upload_id}").json()
    assert (status["received"], status["size"], status["name"]) == (1000, 2500, "Acta 2026.pdf")
    refused(enabled.put(
        f"/api/documents/uploads/{upload_id}/content", params={"offset": 1000},
        content=b" " * 1501,
    ), 422, "document_upload_size")
    send(enabled, upload_id, content, offset=1000, chunk=1000)
    assert [name.split(".")[1] for name in stored(config)] == ["part"]
    document = enabled.post(f"/api/documents/uploads/{upload_id}/complete").json()
    assert document["name"] == "Acta 2026.pdf"
    assert (document["kind"], document["previewable"], document["version_count"]) == (
        "pdf", True, 1,
    )
    assert document["author"] == {
        "kind": "administrator", "user_id": None, "name": "Technical administrator",
    }
    current = document["current"]
    assert (current["id"], current["number"], current["size"], current["media_type"]) == (
        upload_id, 1, 2500, "application/pdf",
    )
    assert current["sha256"] == hashlib.sha256(content).hexdigest()
    # A completion repeated after a lost answer gets the same document.
    assert enabled.post(f"/api/documents/uploads/{upload_id}/complete").json() == document
    refused(enabled.get(f"/api/documents/uploads/{upload_id}"), 404, "document_upload_not_found")
    # Stored under a name the server chose, never the uploaded one.
    [name] = stored(config)
    assert name.endswith(".pdf") and upload_id not in name and "Acta" not in name
    download = enabled.get(f"/api/documents/versions/{upload_id}/download")
    assert download.content == content
    assert download.headers["content-type"] == "application/pdf"
    assert download.headers["content-disposition"] == (
        "attachment; filename*=utf-8''Acta%202026.pdf"
    )
    assert download.headers["x-content-type-options"] == "nosniff"
    assert download.headers["cache-control"] == "no-store"
    preview = enabled.get(f"/api/documents/versions/{upload_id}/preview")
    assert preview.headers["content-disposition"].startswith("inline;")
    # Videos must be seekable in the browser: ranges are served.
    part = enabled.get(
        f"/api/documents/versions/{upload_id}/preview", headers={"range": "bytes=0-7"},
    )
    assert (part.status_code, part.content) == (206, content[:8])
    assert browse(enabled)["files"] == [document]
    assert [entry["kind"] for entry in history(enabled, document)] == ["created"]
    assert history(enabled, document)[0] | {"id": 0, "created_at": ""} == {
        "id": 0, "kind": "created", "created_at": "", "author": document["author"],
        "name": "Acta 2026.pdf", "previous_name": None, "location": [],
        "previous_location": None, "number": 1, "size": 2500, "folder": None,
    }


def test_uploads_can_be_cancelled_and_are_discarded_when_refused_or_abandoned(enabled, config):
    upload_id, _ = start(enabled, "Notas.txt", b"Synthetic notes\n")
    assert enabled.request("DELETE", f"/api/documents/uploads/{upload_id}").status_code == 204
    assert enabled.request("DELETE", f"/api/documents/uploads/{upload_id}").status_code == 204
    refused(enabled.get(f"/api/documents/uploads/{upload_id}"), 404, "document_upload_not_found")
    assert stored(config) == []
    # A file whose content does not match its name is refused and its upload discarded.
    disguised = picture()
    upload_id, _ = start(enabled, "Factura.pdf", disguised)
    send(enabled, upload_id, disguised)
    refused(enabled.post(f"/api/documents/uploads/{upload_id}/complete"), 415,
            "document_type_mismatch")
    refused(enabled.get(f"/api/documents/uploads/{upload_id}"), 404, "document_upload_not_found")
    assert stored(config) == []
    # Each person keeps at most four uploads open: a fifth discards the least recently used.
    first = [start(enabled, f"Video {index}.mp4", mp4())[0] for index in range(5)]
    assert enabled.get(f"/api/documents/uploads/{first[0]}").status_code == 404
    assert all(
        enabled.get(f"/api/documents/uploads/{value}").status_code == 200 for value in first[1:]
    )
    assert len(stored(config, ".part")) == 4
    # Uploads expire a day after their last chunk; the next start discards them, and a restart
    # also removes partial files no upload refers to.
    execute(config, "UPDATE document_uploads SET expires_at = :past",
            past=datetime.now(timezone.utc) - timedelta(minutes=1))
    (config.upload_dir / "documents" / f"{uuid4()}.part").write_bytes(b"orphan")
    with visitor(config):
        pass
    assert stored(config) == []
    target = folder(enabled, "Temporal")
    upload_id, _ = start(enabled, "Plano.pdf", pdf(), folder_id=target["id"])
    send(enabled, upload_id, pdf())
    assert remove(enabled, target, "folders").status_code == 204
    refused(enabled.post(f"/api/documents/uploads/{upload_id}/complete"), 409,
            "document_folder_deleted")
    assert stored(config) == []


def test_type_size_and_storage_limits(actors, enabled, config, monkeypatch):
    a, b, first, _ = actors
    refused(start(a, "programa.exe", b"MZ")[1], 415, "document_type_unsupported")
    refused(start(a, "vacio.txt", b"")[1], 422, "document_file_empty")
    # The administrator's limits apply at once, and residents see them when browsing.
    set_limits(enabled, max_file_mb=1, max_video_mb=2)
    assert {key: browse(a)["limits"][key] for key in ("max_file_bytes", "max_video_bytes")} == {
        "max_file_bytes": MIB, "max_video_bytes": 2 * MIB,
    }
    refused(start(a, "grande.pdf", pdf(size=MIB + 1))[1], 413, "document_too_large")
    assert start(a, "video.mov", mp4(payload=MIB + 100))[1].status_code == 201
    refused(start(a, "largo.mp4", mp4(payload=2 * MIB))[1], 413, "document_too_large")
    set_limits(enabled, user_quota_mb=1)
    uploaded(a, "uno.pdf", pdf(size=600_000))
    refused(start(a, "dos.pdf", pdf(size=600_000))[1], 409, "document_storage_user_quota")
    # The binding check happens on completion, when the bytes become a version.
    upload_id, response = start(b, "dos.pdf", pdf(size=600_000))
    assert response.status_code == 201
    send(b, upload_id, pdf(size=600_000))
    set_limits(enabled, community_quota_mb=1)
    refused(b.post(f"/api/documents/uploads/{upload_id}/complete"), 409,
            "document_storage_community_quota")
    summary = enabled.get("/api/admin/storage").json()["documents"]
    assert (summary["quota_bytes"], summary["resident_quota_bytes"]) == (MIB, MIB)
    set_limits(enabled, community_quota_mb=20480)
    assert b.post(f"/api/documents/uploads/{upload_id}/complete").status_code == 200
    free_space(monkeypatch, config, 1024 * MIB)
    refused(start(b, "tres.pdf", pdf())[1], 507, "storage_low_space")


def test_folders_names_moves_and_history(enabled):
    minutes = folder(enabled, "Actas")
    year = folder(enabled, "2026", minutes["id"])
    assert year["author"]["name"] == "Technical administrator"
    refused(enabled.post("/api/documents/folders", json={"name": "ACTAS"}), 409,
            "document_name_taken")
    response = enabled.post("/api/documents/folders", json={"name": "a/b"})
    assert (response.status_code, response.json()) == (422, {
        "code": "document_name_invalid", "fields": {"name": "document_name_invalid"},
    })
    refused(enabled.post("/api/documents/folders", json={"name": "x", "parent_id": 999}), 404,
            "document_folder_not_found")
    agenda = uploaded(enabled, "Orden del día.pdf", pdf(), folder_id=year["id"])
    second = uploaded(enabled, "orden del día.pdf", pdf("other"), folder_id=year["id"])
    assert second["name"] == "orden del día (2).pdf"
    root = browse(enabled)
    assert [(item["name"], item["file_count"], item["folder_count"]) for item in root["folders"]] == [
        ("Actas", 2, 1),
    ]
    assert root["folders"][0]["size"] == len(pdf()) + len(pdf("other"))
    inner = browse(enabled, year["id"])
    assert [item["name"] for item in inner["path"]] == ["Actas", "2026"]
    # Sorted ignoring case: the space of " (2)" comes before the dot of ".pdf".
    assert [item["name"] for item in inner["files"]] == [
        "orden del día (2).pdf", "Orden del día.pdf",
    ]
    renamed = edit(enabled, year, "folders", name="Año 2026")
    assert renamed.status_code == 200, renamed.text
    refused(edit(enabled, year, "folders", name="Otro"), 409, "document_stale")
    year = renamed.json()
    moved = edit(enabled, year, "folders", folder_id=None).json()
    assert (moved["parent_id"], moved["version"]) == (None, 3)
    assert [
        (entry["kind"], entry["previous_name"], entry["name"], entry["previous_location"],
         entry["location"]) for entry in history(enabled, year, "folders")
    ] == [
        ("moved", None, "Año 2026", ["Actas"], []),
        ("renamed", "2026", "Año 2026", None, None),
        ("created", None, "2026", None, ["Actas"]),
    ]
    minutes = edit(enabled, minutes, "folders", folder_id=moved["id"]).json()
    refused(edit(enabled, moved, "folders", folder_id=minutes["id"]), 409,
            "document_move_into_itself")
    renamed_file = edit(enabled, second, name="Convocatoria")
    assert renamed_file.json()["name"] == "Convocatoria.pdf"
    refused(edit(enabled, renamed_file.json(), name="ORDEN DEL DÍA.pdf"), 409, "document_name_taken")
    moved_file = edit(enabled, renamed_file.json(), folder_id=minutes["id"]).json()
    assert [(entry["kind"], entry["previous_location"], entry["location"]) for entry in history(
        enabled, moved_file,
    )][:1] == [("moved", ["Año 2026"], ["Año 2026", "Actas"])]
    assert [item["name"] for item in browse(enabled, minutes["id"])["path"]] == [
        "Año 2026", "Actas",
    ]
    assert enabled.get("/api/documents/folders").json() == [
        {"id": minutes["id"], "parent_id": moved["id"], "name": "Actas"},
        {"id": moved["id"], "parent_id": None, "name": "Año 2026"},
    ]
    assert agenda["folder_id"] == year["id"]
    parent = None
    for depth in range(10):
        parent = folder(enabled, f"Nivel {depth}", parent and parent["id"])
    refused(enabled.post("/api/documents/folders", json={
        "name": "Demasiado", "parent_id": parent["id"],
    }), 409, "document_depth_limit")
    refused(edit(enabled, moved, "folders", folder_id=parent["id"]), 409, "document_depth_limit")


def test_who_manages_items_follows_the_administrators_policy(actors, enabled):
    a, b, first, second = actors
    shared = folder(a, "Comunidad")
    own = uploaded(a, "Mio.pdf", pdf(), folder_id=shared["id"])
    other = uploaded(b, "Suyo.pdf", pdf("other"), folder_id=shared["id"])
    seen_by_b = browse(b, shared["id"])
    assert seen_by_b["folder"]["can_manage"] is False
    assert {item["name"]: item["can_manage"] for item in seen_by_b["files"]} == {
        "Mio.pdf": False, "Suyo.pdf": True,
    }
    refused(edit(b, own, name="Robado"), 403, "document_permission_required")
    refused(remove(b, own), 403, "document_permission_required")
    refused(start(b, "Mio.pdf", pdf(), document_id=own["id"])[1], 403,
            "document_permission_required")
    assert edit(b, other, name="Suyo renombrado").status_code == 200
    seen_by_a = browse(a)["folders"][0]
    assert (seen_by_a["can_manage"], seen_by_a["can_delete"]) == (True, False)
    refused(remove(a, shared, "folders"), 403, "document_folder_not_owned")
    response = b.patch("/api/admin/settings/documents", json={"manage_policy": "everyone"})
    assert response.status_code == 401
    assert enabled.patch("/api/admin/settings/documents", json={
        "manage_policy": "administrator",
    }).json() == {"manage_policy": "administrator", **LIMITS}
    assert browse(a, shared["id"])["policy"] == "administrator"
    refused(edit(a, own, name="Propio"), 403, "document_permission_required")
    assert not any(item["can_manage"] for item in browse(a, shared["id"])["files"])
    # Anyone can still add files and folders.
    uploaded(a, "Nuevo.pdf", pdf("new"), folder_id=shared["id"])
    own = enabled.get(f"/api/documents/files/{own['id']}").json()
    assert own["can_manage"] is True
    own = edit(enabled, own, name="Renombrado por la administración").json()
    refused(enabled.patch("/api/admin/settings/documents", json={"manage_policy": "nobody"}), 422,
            "invalid_request")
    enabled.patch("/api/admin/settings/documents", json={"manage_policy": "everyone"})
    shared = browse(b)["folders"][0]
    assert (shared["can_manage"], shared["can_delete"]) == (True, True)
    assert remove(b, shared, "folders").status_code == 204
    assert browse(a)["folders"] == []
    assert deletions(enabled)[0]["author"]["user_id"] == second["id"]
    assert first["id"] != second["id"]


def test_deleting_hides_items_until_the_administrator_restores_or_purges_them(
    actors, enabled, config,
):
    a, b, first, _ = actors
    shared = folder(a, "Seguros")
    inner = folder(a, "Pólizas", shared["id"])
    policy = uploaded(a, "Póliza.pdf", pdf(size=3000), folder_id=inner["id"])
    receipt = uploaded(a, "Recibo.pdf", pdf("receipt"), folder_id=shared["id"])
    assert remove(a, receipt).status_code == 204
    shared = browse(a)["folders"][0]
    assert remove(a, shared, "folders").status_code == 204
    for client in (a, b):
        assert browse(client)["folders"] == []
        refused(client.get(f"/api/documents/folders/{inner['id']}"), 404,
                "document_folder_not_found")
        refused(client.get(f"/api/documents/files/{policy['id']}"), 404, "document_not_found")
        refused(client.get(f"/api/documents/files/{policy['id']}/history"), 404,
                "document_not_found")
        refused(client.get(f"/api/documents/versions/{policy['current']['id']}/download"), 404,
                "document_not_found")
        refused(client.get("/api/admin/documents/deleted"), 401, "authentication_required")
    listed = deletions(enabled)
    assert [(item["name"], item["location"], item["file_count"], item["folder_count"],
             item["file_kind"], item["author"]["user_id"]) for item in listed] == [
        ("Seguros", [], 1, 1, None, first["id"]),
        ("Recibo.pdf", ["Seguros"], 1, 0, "pdf", first["id"]),
    ]
    assert listed[0]["stored_bytes"] == 3000
    info = enabled.get(f"/api/admin/documents/files/{policy['id']}").json()
    assert info["deleted_by"]["user_id"] == first["id"] and info["deleted_at"]
    assert [item["name"] for item in info["location"]] == ["Seguros", "Pólizas"]
    assert enabled.get(
        f"/api/admin/documents/versions/{policy['current']['id']}/download",
    ).content == pdf(size=3000)
    assert [entry["kind"] for entry in enabled.get(
        f"/api/admin/documents/folders/{inner['id']}/history",
    ).json()["items"]] == ["deleted", "created"]
    assert enabled.get(
        f"/api/admin/documents/folders/{inner['id']}/history",
    ).json()["items"][0]["folder"] == "Seguros"
    # The receipt's folder is still deleted, so it comes back at the top level.
    restore = enabled.post(f"/api/admin/documents/deletions/{listed[1]['id']}/restore")
    assert restore.status_code == 204
    assert [item["name"] for item in browse(b)["files"]] == ["Recibo.pdf"]
    folder(b, "Seguros")
    assert enabled.post(
        f"/api/admin/documents/deletions/{listed[0]['id']}/restore",
    ).status_code == 204
    names = [item["name"] for item in browse(b)["folders"]]
    assert names == ["Seguros", "Seguros (2)"]
    restored = browse(b)["folders"][1]
    assert (restored["file_count"], restored["folder_count"]) == (1, 1)
    assert history(b, restored, "folders")[0] | {"id": 0, "created_at": ""} == {
        "id": 0, "created_at": "", "kind": "restored",
        "author": {"kind": "administrator", "user_id": None, "name": "Technical administrator"},
        "name": "Seguros (2)", "previous_name": "Seguros", "location": [],
        "previous_location": None, "number": None, "size": None, "folder": None,
    }
    refused(enabled.post(f"/api/admin/documents/deletions/{listed[0]['id']}/restore"), 409,
            "document_deletion_closed")
    assert remove(a, restored, "folders").status_code == 204
    again = deletions(enabled)[0]
    assert len(stored(config, ".pdf")) == 2
    assert enabled.post(f"/api/admin/documents/deletions/{again['id']}/purge").status_code == 204
    assert len(stored(config, ".pdf")) == 1
    refused(enabled.get(f"/api/admin/documents/versions/{policy['current']['id']}/download"), 410,
            "document_version_purged")
    assert deletions(enabled) == []
    assert enabled.post(f"/api/admin/documents/deletions/{again['id']}/purge").status_code == 204
    refused(enabled.post(f"/api/admin/documents/deletions/{again['id']}/restore"), 409,
            "document_deletion_closed")
    purged = enabled.get(f"/api/admin/documents/files/{policy['id']}").json()
    assert purged["purged_at"] and purged["versions"][0]["purged_at"]
    refused(enabled.post(f"/api/admin/documents/deletions/{uuid4()}/purge"), 404,
            "document_deletion_not_found")
    assert enabled.get("/api/admin/storage").json()["documents"]["stored_bytes"] == len(
        pdf("receipt"),
    )


def test_new_versions_keep_the_earlier_ones_until_purged(actors, enabled, config):
    a, b, first, _ = actors
    budget = uploaded(a, "Presupuesto.xlsx", ooxml("spreadsheetml.sheet", "xl/workbook.xml"))
    original = budget["current"]
    refused(start(a, "Presupuesto.pdf", pdf(), document_id=budget["id"])[1], 422,
            "document_version_extension")
    newer = ooxml("spreadsheetml.sheet", "xl/workbook.xml", ("xl/sharedStrings.xml", b"<s/>"))
    updated = uploaded(a, "otro nombre.XLSX", newer, document_id=budget["id"])
    assert (updated["name"], updated["version_count"], updated["current"]["number"]) == (
        "Presupuesto.xlsx", 2, 2,
    )
    info = a.get(f"/api/documents/files/{budget['id']}").json()
    assert [version["number"] for version in info["versions"]] == [2, 1]
    earlier = a.get(f"/api/documents/versions/{original['id']}/download")
    assert earlier.headers["content-disposition"] == (
        "attachment; filename*=utf-8''Presupuesto%20%28version%201%29.xlsx"
    )
    refused(a.get(f"/api/documents/versions/{original['id']}/preview"), 415,
            "document_preview_unavailable")
    assert [entry["kind"] for entry in history(a, budget)] == ["version_added", "created"]
    rules = uploaded(b, "Normas.pdf", pdf("Normas v1"))
    uploaded(b, "Normas.pdf", pdf("Normas v2"), document_id=rules["id"])
    previous = enabled.get("/api/admin/storage/document-versions").json()
    # The latest uploaded first; the browser shows PDFs, not spreadsheets.
    assert [
        (item["id"], item["document_name"], item["previewable"]) for item in previous["items"]
    ] == [(rules["current"]["id"], "Normas.pdf", True), (original["id"], "Presupuesto.xlsx", False)]
    found = enabled.get("/api/admin/storage/document-versions", params={"q": "presupuésto"}).json()
    assert ([item["id"] for item in found["items"]], found["total"]) == ([original["id"]], 1)
    assert enabled.get("/api/admin/storage/document-versions?page=0").status_code == 422
    set_flag(enabled, "documents", False)
    refused(a.get(f"/api/documents/versions/{rules['current']['id']}/preview"), 404,
            "documents_disabled")
    preview = enabled.get(f"/api/admin/documents/versions/{rules['current']['id']}/preview")
    assert (preview.status_code, preview.content) == (200, pdf("Normas v1"))
    assert preview.headers["content-type"] == "application/pdf"
    assert preview.headers["content-disposition"] == (
        "inline; filename*=utf-8''Normas%20%28version%201%29.pdf"
    )
    refused(enabled.get(f"/api/admin/documents/versions/{original['id']}/preview"), 415,
            "document_preview_unavailable")
    set_flag(enabled, "documents", True)
    assert enabled.post(
        f"/api/admin/storage/document-versions/{rules['current']['id']}/purge",
    ).status_code == 200
    refused(enabled.get(f"/api/admin/documents/versions/{rules['current']['id']}/preview"), 410,
            "document_version_purged")
    refused(enabled.post(
        f"/api/admin/storage/document-versions/{updated['current']['id']}/purge",
    ), 409, "document_version_current")
    purged = enabled.post(f"/api/admin/storage/document-versions/{original['id']}/purge")
    assert purged.status_code == 200 and purged.json()["purged_at"]
    assert enabled.post(
        f"/api/admin/storage/document-versions/{original['id']}/purge",
    ).json() == purged.json()
    refused(a.get(f"/api/documents/versions/{original['id']}/download"), 410,
            "document_version_purged")
    assert history(a, budget)[0]["kind"] == "version_purged"
    assert enabled.get("/api/admin/storage/document-versions").json()["items"] == []
    assert len(stored(config, ".xlsx")) == 1


def test_text_and_csv_files_are_previewed_as_plain_text(enabled):
    # The viewer reads the encoding itself: spreadsheets save CSV files in Windows-1252 too.
    for name, content in (
        ("Normas.txt", "Silencio de 22:00 a 8:00\n".encode()),
        ("Cuotas.csv", "vivienda;cuota\n1º A;45,00\n".encode("cp1252")),
    ):
        document = uploaded(enabled, name, content)
        assert (document["kind"], document["previewable"]) == ("text", True)
        path = f"/api/documents/versions/{document['current']['id']}/preview"
        preview = enabled.get(path)
        assert (preview.status_code, preview.content) == (200, content)
        assert preview.headers["content-type"].startswith("text/plain")
        assert preview.headers["content-disposition"].startswith("inline;")
        part = enabled.get(path, headers={"range": "bytes=0-4"})
        assert (part.status_code, part.content) == (206, content[:5])


def framing(response):
    return (
        response.headers["x-frame-options"],
        response.headers["content-security-policy"].split("frame-ancestors ")[1].split(";")[0],
    )


def test_only_pdfs_shown_inline_may_be_framed_and_only_by_the_portal(enabled):
    # The portal's viewer shows PDFs in a frame of its own: new tabs lose the session in some
    # embedded browsers. Nothing else may be framed, and no other site may frame a PDF.
    minutes = uploaded(enabled, "Acta.pdf", pdf())["current"]["id"]
    notes = uploaded(enabled, "Notas.txt", b"Synthetic notes\n")["current"]["id"]
    preview = enabled.get(f"/api/documents/versions/{minutes}/preview")
    assert (preview.status_code, framing(preview)) == (200, ("SAMEORIGIN", "'self'"))
    assert framing(enabled.get(f"/api/documents/versions/{minutes}/preview", headers={
        "range": "bytes=0-3",
    })) == ("SAMEORIGIN", "'self'")
    assert framing(enabled.get(f"/api/admin/documents/versions/{minutes}/preview")) == (
        "SAMEORIGIN", "'self'",
    )
    for path in (
        f"/api/documents/versions/{minutes}/download",
        f"/api/documents/versions/{notes}/preview", "/api/documents/browse", "/",
    ):
        assert framing(enabled.get(path)) == ("DENY", "'none'"), path
    refused(enabled.get(f"/api/documents/versions/{uuid4()}/preview"), 404,
            "document_version_not_found")
    assert framing(enabled.get(f"/api/documents/versions/{uuid4()}/preview")) == (
        "DENY", "'none'",
    )


def search(client, q, **params):
    response = client.get("/api/documents/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()


def names_of(found):
    return [item["name"] for item in found["folders"]], [item["name"] for item in found["files"]]


def without_location(item):
    return {key: value for key, value in item.items() if key != "location"}


def test_search_finds_folders_and_files_anywhere_by_name(actors, enabled, monkeypatch):
    a, b, _, _ = actors
    minutes = folder(a, "Actas")
    year = folder(a, "Año 2026", minutes["id"])
    march = uploaded(a, "Acta de marzo.pdf", pdf(size=3000), folder_id=year["id"])
    uploaded(b, "Notas del ACTA.txt", b"Synthetic notes\n")
    uploaded(b, "Presupuesto anual.pdf", pdf("budget"), folder_id=minutes["id"])
    hidden = folder(a, "Actas antiguas", minutes["id"])
    uploaded(a, "Acta de 2019.pdf", pdf("old"), folder_id=hidden["id"])
    assert remove(a, hidden, "folders").status_code == 204
    # Ignoring case and accents, wherever they are; deleted items stay hidden. Folders come first.
    found = search(b, " ÁCTA ")
    assert names_of(found) == (["Actas"], ["Acta de marzo.pdf", "Notas del ACTA.txt"])
    assert (found["total"], found["page"], found["pages"]) == (3, 1, 1)
    # Each match is described as in its own folder, with what the person searching may do, and
    # where it is.
    assert without_location(found["folders"][0]) == browse(b)["folders"][0]
    assert found["folders"][0]["location"] == []
    assert without_location(found["files"][0]) == browse(b, year["id"])["files"][0]
    assert found["files"][0]["can_manage"] is False
    assert found["files"][0]["location"] == [
        {"id": minutes["id"], "name": "Actas"}, {"id": year["id"], "name": "Año 2026"},
    ]
    assert found["files"][1]["location"] == []
    assert names_of(search(b, "año")) == (["Año 2026"], [])
    assert search(b, "factura") == {"total": 0, "page": 1, "pages": 1, "folders": [], "files": []}
    assert search(b, "   ")["total"] == 0
    # The latest change first, or the largest; then by name.
    assert edit(a, march, name="Acta de marzo firmada").status_code == 200
    files = ["Acta de marzo firmada.pdf", "Presupuesto anual.pdf", "Notas del ACTA.txt"]
    assert names_of(search(a, "a", sort="modified")) == (["Año 2026", "Actas"], files)
    assert names_of(search(a, "a", sort="size")) == (["Actas", "Año 2026"], files)
    # Pages hold folders and files alike.
    monkeypatch.setattr(community_documents, "PAGE_SIZE", 2)
    pages = [search(a, "a", page=number) for number in (1, 2, 3, 4)]
    assert [names_of(page) for page in pages] == [
        (["Actas", "Año 2026"], []), ([], ["Acta de marzo firmada.pdf", "Notas del ACTA.txt"]),
        ([], ["Presupuesto anual.pdf"]), ([], []),
    ]
    assert {(page["total"], page["pages"]) for page in pages} == {(5, 3)}
    for params in (
        {"q": ""}, {"q": "x" * 201}, {"q": "acta", "sort": "type"}, {"q": "acta", "page": 0}, {},
    ):
        refused(a.get("/api/documents/search", params=params), 422, "invalid_request")


def test_search_needs_documents_turned_on_and_a_session(admin, config):
    refused(admin.get("/api/documents/search", params={"q": "acta"}), 404, "documents_disabled")
    set_flag(admin, "documents", True)
    with visitor(config) as anonymous:
        refused(anonymous.get("/api/documents/search", params={"q": "acta"}), 401,
                "authentication_required")
    assert search(admin, "acta")["total"] == 0


def test_archives_keep_the_folder_structure(enabled, config):
    shared = folder(enabled, "Comunidad")
    inner = folder(enabled, "Planos", shared["id"])
    folder(enabled, "Vacía", shared["id"])
    first = uploaded(enabled, "Estatutos.pdf", pdf(), folder_id=shared["id"])
    plan = uploaded(enabled, "Planta.png", picture(), folder_id=inner["id"])
    loose = uploaded(enabled, "Normas.txt", b"Synthetic rules\n")
    response = enabled.get("/api/documents/archive", params={"folder": shared["id"]})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="Comunidad.zip"'
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.testzip() is None
    assert archive.namelist() == [
        "Comunidad/", "Comunidad/Estatutos.pdf", "Comunidad/Planos/",
        "Comunidad/Planos/Planta.png", "Comunidad/Vacía/",
    ]
    assert archive.read("Comunidad/Planos/Planta.png") == picture()
    # Accented names are flagged as UTF-8 for every unzip tool, folders included.
    assert all(info.flag_bits & 0x800 for info in archive.infolist() if not info.filename.isascii())
    # Items inside a chosen folder are not repeated; the name follows the chosen items' folder.
    response = enabled.get("/api/documents/archive", params={
        "folder": [shared["id"]], "file": [first["id"], loose["id"]],
    })
    assert response.headers["content-disposition"] == 'attachment; filename="Documents.zip"'
    assert zipfile.ZipFile(io.BytesIO(response.content)).namelist()[-1] == "Normas.txt"
    response = enabled.get("/api/documents/archive", params={"file": [first["id"]]})
    assert response.headers["content-disposition"] == 'attachment; filename="Comunidad.zip"'
    assert zipfile.ZipFile(io.BytesIO(response.content)).namelist() == ["Estatutos.pdf"]
    refused(enabled.get("/api/documents/archive"), 422, "document_archive_items")
    refused(enabled.get("/api/documents/archive", params={"file": [0]}), 422,
            "document_archive_items")
    refused(enabled.get("/api/documents/archive", params={"file": [9999]}), 404,
            "document_not_found")
    refused(enabled.get("/api/documents/archive", params={"folder": [9999]}), 404,
            "document_folder_not_found")
    community_documents.ARCHIVE_MAX_FILES, limit = 1, community_documents.ARCHIVE_MAX_FILES
    try:
        refused(enabled.get("/api/documents/archive", params={"folder": shared["id"]}), 422,
                "document_archive_too_large")
    finally:
        community_documents.ARCHIVE_MAX_FILES = limit
    enabled.app.state.document_archives = 4
    refused(enabled.get("/api/documents/archive", params={"file": [plan["id"]]}), 503,
            "document_archive_busy")
    enabled.app.state.document_archives = 0
    enabled.get("/api/documents/archive", params={"file": [plan["id"]]})
    assert enabled.app.state.document_archives == 0


def test_storage_summary_reports_documents(actors, enabled, config):
    a, b, first, second = actors
    uploaded(a, "a.pdf", pdf(size=1000))
    versioned = uploaded(b, "b.txt", b"one\n")
    uploaded(b, "b.txt", b"second\n", document_id=versioned["id"])
    gone = uploaded(enabled, "c.pdf", pdf(size=500))
    assert remove(enabled, gone).status_code == 204
    upload_id, _ = start(a, "d.pdf", pdf(size=900))
    send(a, upload_id, pdf(size=900)[:300])
    current = current_user(enabled, second["id"])
    assert enabled.request("DELETE", f"/api/admin/users/{second['id']}", json={
        "version": current["version"], "email": current["email"],
    }).status_code == 204
    documents = enabled.get("/api/admin/storage").json()["documents"]
    assert documents == {
        "quota_bytes": 20480 * MIB, "resident_quota_bytes": 2048 * MIB,
        "stored_bytes": 1000 + 4 + 7 + 500, "current_bytes": 1007, "previous_bytes": 4,
        "deleted_bytes": 500, "files": 2, "previous_versions": 1, "deleted_files": 1,
        "administrator_bytes": 500, "upload_bytes": 300, "uploads": 1,
        "residents": [
            {"user_id": first["id"], "name": first["name"], "account_deleted": False,
             "stored_bytes": 1000, "versions": 1},
            {"user_id": second["id"], "name": second["name"], "account_deleted": True,
             "stored_bytes": 11, "versions": 2},
        ],
    }


def test_downgrade_refuses_to_destroy_documents(enabled, config):
    shared = folder(enabled, "Conservada")
    result = migrate(config, "downgrade", "0021", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove shared documents" in result.stderr
    assert browse(enabled)["folders"][0]["id"] == shared["id"]
    execute(config, "DELETE FROM document_events")
    execute(config, "DELETE FROM document_folders")
    result = migrate(config, "downgrade", "0021", check=False)
    assert result.returncode != 0
    assert "Disable Documents before downgrading" in result.stderr
    set_flag(enabled, "documents", False)
    migrate(config, "downgrade", "0021")
    migrate(config, "upgrade", "head")
    set_flag(enabled, "documents", True)
    assert browse(enabled)["folders"] == []
