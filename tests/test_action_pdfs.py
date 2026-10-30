import hashlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Barrier
from uuid import uuid4

import pytest
from reportlab.pdfgen import canvas
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from juntia import community_actions
from juntia.community_action_files import MAX_ACTIVE_PDFS
from juntia.db import User
from juntia.errors import AppError
from juntia.parser import MAX_BYTES
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_users import activate, current_user, database, invite, login, visitor
from tests.test_users import mailbox as mailbox


def quote_pdf():
    output = BytesIO()
    pdf = canvas.Canvas(output)
    pdf.drawString(50, 750, "Synthetic repair quote. Not a bank statement.")
    pdf.save()
    return output.getvalue()


def upload(client, value, content=None, filename="quote.pdf", upload_id=None):
    return client.post(item_path(value) + "/attachments", files={
        "file": (filename, quote_pdf() if content is None else content, "application/pdf"),
    }, data={"upload_id": str(upload_id or uuid4())})


def test_pdf_ownership_retirement_downloads_and_history(actors, admin, config):
    a, b, first, _ = actors
    value = create_item(a)
    path = item_path(value)
    content = quote_pdf()
    response = upload(a, value, content, "../../presupuesto.pdf")
    assert response.status_code == 201, response.text
    attachment = response.json()
    assert attachment["filename"] == "presupuesto.pdf"
    assert attachment["size"] == len(content)
    assert attachment["sha256"] == hashlib.sha256(content).hexdigest()
    assert attachment["author"]["user_id"] == first["id"]
    assert "storage_key" not in attachment
    endpoint = path + f"/attachments/{attachment['id']}"
    download = b.get(endpoint + "/download")
    assert download.content == content
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["cache-control"] == "no-store"
    assert download.headers["x-content-type-options"] == "nosniff"
    preview = b.get(endpoint + "/preview")
    assert preview.content == content
    assert preview.headers["content-type"] == "application/pdf"
    assert preview.headers["content-disposition"].startswith("inline;")
    assert preview.headers["cache-control"] == "no-store"
    assert preview.headers["x-content-type-options"] == "nosniff"
    assert b.get(endpoint).json() == attachment
    assert b.request("DELETE", endpoint, json={"version": 1}).status_code == 403
    other = create_item(b)
    assert b.get(item_path(other) + f"/attachments/{attachment['id']}/download").status_code == 404
    assert b.get(item_path(other) + f"/attachments/{attachment['id']}/preview").status_code == 404
    assert b.get(item_path(other) + f"/attachments/{attachment['id']}").status_code == 404
    assert a.request("DELETE", endpoint, json={"version": 1}).status_code == 204
    assert b.get(path + "/attachments").json()["items"] == []
    retired = b.get(path + "/attachments?include_withdrawn=true").json()["items"]
    assert retired[0]["withdrawn_at"]
    assert b.get(endpoint + "/download").content == content
    assert b.get(endpoint + "/preview").content == content
    assert a.get(path).json()["version"] == 1
    assert a.get(path).json()["attachment_count"] == 0
    history = b.get(path + "/history").json()["items"]
    assert history[0]["kind"] == "attachment_withdrawn"
    assert history[0]["attachment_id"] == attachment["id"]
    assert history[1]["kind"] == "attachment_added"
    assert history[1]["changes"][0]["after"] == "presupuesto.pdf"
    with visitor(config) as anonymous:
        assert anonymous.get(endpoint + "/download").status_code == 401
        assert anonymous.get(endpoint + "/preview").status_code == 401
        assert anonymous.get(endpoint).status_code == 401
        assert anonymous.patch(endpoint, json={"version": 1, "filename": "blocked.pdf"}).status_code == 401
        assert upload(anonymous, value).status_code == 401
    current = current_user(admin, first["id"])
    assert admin.patch(f"/api/admin/users/{first['id']}/status", json={
        "version": current["version"], "disabled": True,
    }).status_code == 200
    assert a.get(endpoint + "/download").status_code == 401
    assert a.get(endpoint + "/preview").status_code == 401
    assert a.patch(endpoint, json={"version": 1, "filename": "blocked.pdf"}).status_code == 401
    assert upload(a, value).status_code == 401
    assert b.get(endpoint + "/download").content == content


def test_pdf_rename_preserves_bytes_upload_identity_and_audits_names(actors, admin, config):
    first, second, _, _ = actors
    value = create_item(first)
    path = item_path(value)
    content, upload_id = quote_pdf(), uuid4()
    attachment = upload(first, value, content, upload_id=upload_id).json()
    endpoint = path + f"/attachments/{upload_id}"
    original_paths = list((config.upload_dir / "actions").glob("*.pdf"))
    assert second.patch(endpoint, json={"version": 1, "filename": "Not mine"}).status_code == 403
    renamed = first.patch(endpoint, json={"version": 1, "filename": "  Revised quote.PDF  "})
    assert renamed.status_code == 200, renamed.text
    current = renamed.json()
    assert current == {**attachment, "filename": "Revised quote.pdf", "version": 2}
    assert second.get(endpoint).json() == current
    assert second.get(path + "/attachments").json()["items"] == [current]
    assert first.get(path).json()["version"] == value["version"]
    history = second.get(path + "/history").json()
    assert history["total"] == 3
    event = history["items"][0]
    assert event["kind"] == "attachment_renamed"
    assert event["attachment_id"] == str(upload_id)
    assert event["author"] == attachment["author"]
    assert event["changes"] == [
        {"field": "filename", "before": "quote.pdf", "after": "Revised quote.pdf"},
    ]
    assert upload(first, value, content, upload_id=upload_id).json() == current
    assert upload(first, value, content, "other.pdf", upload_id).status_code == 409
    assert first.patch(endpoint, json={"version": 2, "filename": current["filename"]}).json() == current
    assert first.get(path + "/history").json() == history
    assert first.patch(endpoint, json={"version": 1, "filename": "Stale.pdf"}).status_code == 409
    assert first.request("DELETE", endpoint, json={"version": 1}).status_code == 409
    another = create_item(second)
    assert first.patch(item_path(another) + f"/attachments/{upload_id}", json={
        "version": 2, "filename": "Wrong action.pdf",
    }).status_code == 404
    current = admin.patch(endpoint, json={"version": 2, "filename": "Approved quote"}).json()
    assert current["filename"] == "Approved quote.pdf"
    assert current["version"] == 3
    for action, disposition in (("download", "attachment"), ("preview", "inline")):
        response = second.get(endpoint + "/" + action)
        assert response.content == content
        assert response.headers["content-disposition"] == f"{disposition}; filename*=utf-8''Approved%20quote.pdf"
    assert list((config.upload_dir / "actions").glob("*.pdf")) == original_paths
    assert first.request("DELETE", endpoint, json={"version": 3}).status_code == 204
    assert first.patch(endpoint, json={"version": 4, "filename": "Withdrawn.pdf"}).json()["code"] == "action_content_withdrawn"
    assert second.get(endpoint + "/preview").content == content
    retired = second.get(path + "/history").json()["items"][0]
    assert retired["changes"] == [
        {"field": "filename", "before": "Approved quote.pdf", "after": None},
    ]


def test_pdf_rename_validates_names_without_changing_the_attachment(admin):
    value = create_item(admin)
    attachment = upload(admin, value).json()
    endpoint = item_path(value) + f"/attachments/{attachment['id']}"
    for filename in (
        "", " ", ".pdf", " .PDF ", "...pdf", "a" * 252, "a" * 252 + ".pdf",
        "../outside.pdf", r"..\outside.pdf", "line\nbreak.pdf", "tab\tname.pdf",
        "control\x00.pdf", "hidden\u202e.pdf",
    ):
        response = admin.patch(endpoint, json={"version": 1, "filename": filename})
        assert response.status_code == 422, (filename, response.text)
    assert admin.get(endpoint).json() == attachment
    assert admin.get(item_path(value) + "/history").json()["total"] == 2
    for body in ({}, {"filename": "test.pdf"}, {"version": 0, "filename": "test.pdf"}):
        assert admin.patch(endpoint, json=body).status_code == 422
    response = admin.patch(endpoint, json={"version": 1, "filename": "a" * 251})
    assert response.status_code == 200, response.text
    assert response.json()["filename"] == "a" * 251 + ".pdf"


def test_pdf_rename_is_atomic_and_requires_same_origin(admin, monkeypatch):
    value = create_item(admin)
    attachment = upload(admin, value).json()
    endpoint = item_path(value) + f"/attachments/{attachment['id']}"
    body = {"version": 1, "filename": "new.pdf"}
    assert admin.patch(endpoint, json=body, headers={"origin": "https://untrusted.example"}).status_code == 403

    def fail(*args, **kwargs):
        raise AppError("action_storage_error", 503)

    with monkeypatch.context() as patch:
        patch.setattr(community_actions, "add_event", fail)
        assert admin.patch(endpoint, json=body).status_code == 503
    assert admin.get(endpoint).json() == attachment
    assert admin.get(item_path(value) + "/history").json()["total"] == 2


def test_pdf_size_boundary_format_validation_and_no_partial_files(admin, config):
    value = create_item(admin)
    base = quote_pdf()
    content = base + b" " * (MAX_BYTES - len(base) - 7) + b"\n%%EOF\n"
    assert len(content) == MAX_BYTES
    response = upload(admin, value, content)
    assert response.status_code == 201, response.text
    assert response.json()["size"] == MAX_BYTES
    assert upload(admin, value, content + b" ").status_code == 413
    for filename, content in [
        ("quote.pdf", b"<html>Not a PDF</html>"),
        ("quote.png", base), ("quote.pdf", b""), ("quote.pdf", b"%PDF-1.7\ntruncated"),
        ("file.exe", base),
    ]:
        assert upload(admin, value, content, filename).status_code == 415
    assert admin.get(item_path(value) + "/attachments").json()["total"] == 1
    assert admin.get(item_path(value) + "/history").json()["total"] == 2
    assert len(list((config.upload_dir / "actions").glob("*.pdf"))) == 1
    assert not list((config.upload_dir / "actions").glob("*.tmp"))


def test_deleting_contributor_preserves_history_without_transferring_ownership(
    actors, admin, mailbox,
):
    first, second, resident, _ = actors
    value = create_item(first)
    path = item_path(value)
    comment = first.post(path + "/comments", json={"body": "Retained contribution"}).json()
    content = quote_pdf()
    attachment = upload(first, value, content).json()
    before = second.get(path + "/history").json()
    current = current_user(admin, resident["id"])
    assert admin.request("DELETE", f"/api/admin/users/{resident['id']}", json={
        "version": current["version"], "email": current["email"],
    }).status_code == 204
    assert first.get(path).status_code == 401
    assert second.get(path).json()["author"] == value["author"]
    assert second.get(path + "/history").json() == before
    download = path + f"/attachments/{attachment['id']}/download"
    assert second.get(download).content == content
    replacement, token = invite(admin, mailbox, current["email"], current["dwelling_id"])
    assert replacement["id"] > resident["id"]
    activate(first, token)
    assert login(first, current["email"]).status_code == 200
    assert first.patch(path + f"/comments/{comment['id']}", json={
        "version": comment["version"], "body": "Not the original author",
    }).status_code == 403
    assert first.request("DELETE", path + f"/attachments/{attachment['id']}", json={
        "version": attachment["version"],
    }).status_code == 403
    assert first.patch(path + f"/attachments/{attachment['id']}", json={
        "version": attachment["version"], "filename": "Not the original author.pdf",
    }).status_code == 403


def test_pdf_quota_idempotent_retry_and_released_slots(admin):
    value = create_item(admin)
    path = item_path(value)
    ids = [uuid4() for _ in range(MAX_ACTIVE_PDFS)]
    attachments = []
    content = quote_pdf()
    for upload_id in ids:
        response = upload(admin, value, content, upload_id=upload_id)
        assert response.status_code == 201, response.text
        attachments.append(response.json())
    assert upload(admin, value).json()["code"] == "action_attachment_limit"
    assert admin.get(path + "/attachments").json()["total"] == 20
    assert upload(admin, value, content, upload_id=ids[0]).json() == attachments[0]
    assert admin.get(path + "/history").json()["total"] == 21
    assert upload(admin, value, content, "other.pdf", ids[0]).status_code == 409
    endpoint = path + f"/attachments/{ids[0]}"
    assert admin.request("DELETE", endpoint, json={"version": 1}).status_code == 204
    assert upload(admin, value, content, upload_id=ids[0]).status_code == 409
    assert upload(admin, value, content).status_code == 201
    assert admin.get(path + "/attachments").json()["total"] == 20
    assert admin.get(path + "/attachments?include_withdrawn=true").json()["total"] == 21
    assert len(admin.get(path + "/attachments?include_withdrawn=true&page=2").json()["items"]) == 1
    assert admin.get(endpoint + "/download").content == content


def test_failed_attachment_transaction_cleans_staging(admin, config, monkeypatch):
    value = create_item(admin)

    def fail(*args, **kwargs):
        raise AppError("action_storage_error", 503)

    monkeypatch.setattr(community_actions, "add_event", fail)
    assert upload(admin, value).status_code == 503
    assert admin.get(item_path(value) + "/attachments").json()["total"] == 0
    assert admin.get(item_path(value) + "/history").json()["total"] == 1
    assert not list((config.upload_dir / "actions").iterdir())


def test_ambiguous_commit_does_not_delete_a_persisted_pdf(admin, monkeypatch):
    value = create_item(admin)
    content = quote_pdf()
    upload_id = uuid4()
    original = AsyncSession.commit

    async def ambiguous_commit(db):
        await original(db)
        raise AppError("action_storage_error", 503)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "commit", ambiguous_commit)
        assert upload(admin, value, content, upload_id=upload_id).status_code == 503
    retried = upload(admin, value, content, upload_id=upload_id)
    assert retried.status_code == 201
    path = item_path(value)
    assert admin.get(path + f"/attachments/{upload_id}/download").content == content
    assert admin.get(path + "/attachments").json()["total"] == 1
    assert admin.get(path + "/history").json()["total"] == 2


def test_session_is_rechecked_after_staging_a_pdf(actors, config, monkeypatch):
    a, b, first, _ = actors
    value = create_item(a)
    original = community_actions.stage_pdf

    def stage_and_disable(*args):
        staged = original(*args)

        async def disable(db):
            await db.execute(update(User).where(User.id == first["id"]).values(disabled=True))

        database(config, disable)
        return staged

    monkeypatch.setattr(community_actions, "stage_pdf", stage_and_disable)
    assert upload(a, value).status_code == 401
    assert b.get(item_path(value) + "/attachments").json()["total"] == 0
    assert not list((config.upload_dir / "actions").iterdir())


def test_missing_pdf_is_explicit_and_restart_preserves_other_files(admin, config):
    value = create_item(admin)
    content = quote_pdf()
    attachment = upload(admin, value, content).json()
    endpoint = item_path(value) + f"/attachments/{attachment['id']}/download"
    with visitor(config) as restarted:
        restarted.cookies.update(admin.cookies)
        assert restarted.get(endpoint).content == content
        assert restarted.get(item_path(value) + "/history").json()["total"] == 2
    stored = next((config.upload_dir / "actions").glob("*.pdf"))
    stored.unlink()
    assert admin.get(endpoint).status_code == 503
    assert admin.get(endpoint).json()["code"] == "action_source_missing"
    assert admin.get(endpoint.removesuffix("/download") + "/preview").json()["code"] == "action_source_missing"


def test_simultaneous_uploads_cannot_exceed_quota(actors, config):
    if not config.database_url.startswith("postgresql"):
        pytest.skip("Requires the disposable juntia_test PostgreSQL database")
    a, b, _, _ = actors
    value = create_item(a)
    for _ in range(MAX_ACTIVE_PDFS - 1):
        assert upload(a, value).status_code == 201
    barrier = Barrier(2)

    def add(client):
        barrier.wait(timeout=10)
        return upload(client, value).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(add, a)
        second = workers.submit(add, b)
        assert sorted([first.result(), second.result()]) == [201, 409]
    assert a.get(item_path(value) + "/attachments").json()["total"] == MAX_ACTIVE_PDFS
