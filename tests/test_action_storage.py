import asyncio
import errno
import secrets
import time
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import DateTime, bindparam, func, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from juntia import community_actions, storage
from juntia.community_action_files import MAX_ACTIVE_PDFS
from juntia.config import MAX_STORAGE_MB, Settings
from juntia.db import Preview
from juntia.errors import AppError
from tests.support import statement_pdf
from tests.test_action_migration import migrate
from tests.test_action_pdfs import quote_pdf, upload
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_users import current_user, database, login, visitor
from tests.test_users import mailbox as mailbox

MIB = 1024 * 1024
GIB = 1024 * MIB
STORAGE_FIELDS = (
    "ACTION_STORAGE_USER_QUOTA_MB", "ACTION_STORAGE_COMMUNITY_QUOTA_MB", "MIN_FREE_DISK_MB",
)
Usage = namedtuple("Usage", "total used free")


def sized_pdf(size):
    base = quote_pdf()
    content = base + b" " * (size - len(base) - 7) + b"\n%%EOF\n"
    assert len(content) == size
    return content


def stored_files(config):
    directory = config.upload_dir / "actions"
    return sorted(path.name for path in directory.iterdir()) if directory.exists() else []


def purge(client, attachment_id, version):
    return client.post(
        f"/api/admin/storage/attachments/{attachment_id}/purge", json={"version": version},
    )


def withdraw(client, value, attachment):
    response = client.request(
        "DELETE", item_path(value) + f"/attachments/{attachment['id']}",
        json={"version": attachment["version"]},
    )
    assert response.status_code == 204, response.text


def created(response):
    assert response.status_code == 201, response.text
    return response.json()


def refused(response, status, code):
    assert (response.status_code, response.json()) == (status, {"code": code})


def free_space(monkeypatch, config, free):
    def usage(directory):
        assert Path(directory) == config.upload_dir
        return Usage(total=free + GIB, used=GIB, free=free)

    monkeypatch.setattr(storage, "disk_usage", usage)


def execute(config, statement, **parameters):
    # Typed timestamps: SQLite's implicit datetime adapter is deprecated.
    query = text(statement).bindparams(*(
        bindparam(name, type_=DateTime(timezone=True))
        for name, value in parameters.items() if isinstance(value, datetime)
    ))

    async def run():
        engine = create_async_engine(config.database_url)
        try:
            async with engine.begin() as connection:
                await connection.execute(query, parameters)
        finally:
            await engine.dispose()

    asyncio.run(run())


@pytest.fixture
def local_settings(monkeypatch):
    for name in STORAGE_FIELDS:
        monkeypatch.delenv(name, raising=False)
    return {
        "database_url": "sqlite+aiosqlite:///:memory:", "admin_username": "admin",
        "admin_password": "admin", "auth_secret": secrets.token_urlsafe(32),
        "public_origin": "http://localhost:7778", "auth_cookie_secure": False,
        "allow_insecure_local_admin": True,
    }


def test_storage_settings_have_documented_defaults_and_accept_whole_mebibytes(
    local_settings, monkeypatch,
):
    settings = Settings(_env_file=None, **local_settings)
    assert (
        settings.action_storage_user_quota_mb, settings.action_storage_community_quota_mb,
        settings.min_free_disk_mb,
    ) == (250, 2048, 1024)
    for name, value in zip(STORAGE_FIELDS, ("1", "300", str(MAX_STORAGE_MB)), strict=True):
        monkeypatch.setenv(name, value)
    settings = Settings(_env_file=None, **local_settings)
    assert (
        settings.action_storage_user_quota_mb, settings.action_storage_community_quota_mb,
        settings.min_free_disk_mb,
    ) == (1, 300, MAX_STORAGE_MB)


@pytest.mark.parametrize("field", STORAGE_FIELDS)
@pytest.mark.parametrize("invalid", ["0", "-1", str(MAX_STORAGE_MB + 1), "1.5", "plenty", ""])
def test_invalid_storage_settings_fail_configuration(local_settings, monkeypatch, field, invalid):
    monkeypatch.setenv(field, invalid)
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, **local_settings)
    assert field.lower() in str(error.value).lower()


def test_withdrawn_pdfs_keep_counting_against_the_resident_until_purged(actors, admin, config):
    a, b, first, second = actors
    config.action_storage_user_quota_mb = 1
    value = create_item(a)
    path = item_path(value)
    kept = created(upload(a, value, sized_pdf(600_000)))
    files, history = stored_files(config), a.get(path + "/history").json()
    refused(upload(a, value, sized_pdf(MIB - 600_000 + 1)), 409, "action_storage_user_quota")
    # A refused upload leaves no file, staging copy, attachment or history event behind.
    assert stored_files(config) == files
    assert a.get(path + "/attachments?include_withdrawn=true").json()["total"] == 1
    assert a.get(path + "/history").json() == history
    created(upload(a, value, sized_pdf(MIB - 600_000)))
    refused(upload(a, value), 409, "action_storage_user_quota")
    withdraw(a, value, kept)
    refused(upload(a, value), 409, "action_storage_user_quota")
    refused(upload(a, create_item(a)), 409, "action_storage_user_quota")
    # Budgets follow the uploader, not the action owner.
    contribution = created(upload(b, value, sized_pdf(600_000)))
    assert contribution["author"]["user_id"] == second["id"]
    usage = {row["user_id"]: row for row in admin.get("/api/admin/storage").json()["residents"]}
    assert (usage[first["id"]]["stored_bytes"], usage[first["id"]]["withdrawn_bytes"]) == (
        MIB, 600_000,
    )
    assert usage[second["id"]]["stored_bytes"] == 600_000
    assert purge(admin, kept["id"], 2).status_code == 200
    other = create_item(a)
    created(upload(a, other, sized_pdf(600_000)))
    refused(upload(a, other), 409, "action_storage_user_quota")


def test_community_quota_counts_every_author_after_the_resident_quota(actors, admin, config):
    a, b, _, _ = actors
    config.action_storage_community_quota_mb = 1
    shared = create_item(admin)
    created(upload(admin, shared, sized_pdf(400_000)))
    value = create_item(a)
    files = stored_files(config)
    refused(upload(a, value, sized_pdf(MIB - 400_000 + 1)), 409, "action_storage_community_quota")
    assert stored_files(config) == files
    assert a.get(item_path(value) + "/history").json()["total"] == 1
    created(upload(a, value, sized_pdf(MIB - 400_000)))
    refused(upload(admin, shared), 409, "action_storage_community_quota")
    refused(upload(b, create_item(b)), 409, "action_storage_community_quota")
    config.action_storage_user_quota_mb = 1
    refused(upload(a, value, sized_pdf(500_000)), 409, "action_storage_user_quota")
    # The technical administrator only has the community budget.
    config.action_storage_community_quota_mb = 10
    for _ in range(2):
        created(upload(admin, shared, sized_pdf(MIB)))


def test_retried_uploads_are_counted_once_and_keep_their_ownership(actors, admin, config):
    a, b, _, _ = actors
    config.action_storage_user_quota_mb = 1
    value = create_item(a)
    content, upload_id = sized_pdf(MIB), uuid4()
    stored = created(upload(a, value, content, upload_id=upload_id))
    for _ in range(2):
        retry = upload(a, value, content, upload_id=upload_id)
        assert (retry.status_code, retry.json()) == (201, stored)
    refused(upload(a, value), 409, "action_storage_user_quota")
    refused(upload(a, value, upload_id=upload_id), 409, "action_upload_conflict")
    refused(upload(b, value, content, upload_id=upload_id), 409, "action_upload_conflict")
    assert a.get(item_path(value) + "/history").json()["total"] == 2
    assert len(stored_files(config)) == 1
    summary = admin.get("/api/admin/storage").json()
    assert (summary["community"]["stored_bytes"], summary["community"]["active_files"]) == (MIB, 1)


@pytest.mark.parametrize("budget", ["community", "resident"])
def test_simultaneous_uploads_to_different_actions_cannot_exceed_a_budget(
    actors, admin, config, monkeypatch, budget,
):
    if not config.database_url.startswith("postgresql"):
        pytest.skip("Requires the disposable juntia_test PostgreSQL database")
    a, b, _, _ = actors
    if budget == "community":
        config.action_storage_community_quota_mb = 1
    else:
        config.action_storage_user_quota_mb = 1
    publish = community_actions.publish_pdf

    def slow_publish(staged):
        # Widens the window between the budget check and the commit.
        time.sleep(0.5)
        publish(staged)

    monkeypatch.setattr(community_actions, "publish_pdf", slow_publish)
    with visitor(config) as again:
        assert login(again).status_code == 200
        clients = (a, b if budget == "community" else again)
        actions = [create_item(client) for client in clients]
        barrier = Barrier(2)

        def add(client, value):
            barrier.wait(timeout=10)
            return upload(client, value, sized_pdf(600_000))

        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = list(workers.map(add, clients, actions))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert [response.json()["code"] for response in responses if response.status_code == 409] == [
        f"action_storage_{'community' if budget == 'community' else 'user'}_quota",
    ]
    assert admin.get("/api/admin/storage").json()["community"]["stored_bytes"] == 600_000
    assert len(stored_files(config)) == 1


def test_disk_reserve_refuses_action_pdfs_before_staging(actors, config, monkeypatch):
    a, b, _, _ = actors
    config.min_free_disk_mb = 2
    value = create_item(a)
    content = quote_pdf()
    staged = []
    stage = community_actions.stage_pdf

    def tracked_stage(*args):
        staged.append(args)
        return stage(*args)

    monkeypatch.setattr(community_actions, "stage_pdf", tracked_stage)
    free_space(monkeypatch, config, 2 * MIB + len(content) - 1)
    refused(upload(a, value, content), 507, "storage_low_space")
    assert staged == []
    assert stored_files(config) == []
    assert a.get(item_path(value) + "/history").json()["total"] == 1
    free_space(monkeypatch, config, 2 * MIB + len(content))
    upload_id = uuid4()
    stored = created(upload(a, value, content, upload_id=upload_id))
    # A retry of a stored upload still succeeds, without keeping another copy.
    free_space(monkeypatch, config, 0)
    retry = upload(a, value, content, upload_id=upload_id)
    assert (retry.status_code, retry.json()) == (201, stored)
    assert len(stored_files(config)) == 1
    refused(upload(a, value, content), 507, "storage_low_space")
    refused(upload(a, create_item(a), content, upload_id=upload_id), 507, "storage_low_space")
    # Only the author's own retry is exempt: another reader reusing a visible upload id is
    # refused before anything is written.
    staged.clear()
    refused(upload(b, value, content, upload_id=upload_id), 507, "storage_low_space")
    assert staged == []
    assert len(stored_files(config)) == 1

    def unreadable(directory):
        raise OSError("synthetic unavailable volume")

    monkeypatch.setattr(storage, "disk_usage", unreadable)
    refused(upload(a, value, content), 507, "storage_low_space")
    assert a.get(item_path(value) + "/history").json()["total"] == 2


def test_disk_reserve_refuses_statement_imports_without_writing(admin, config, monkeypatch):
    config.min_free_disk_mb = 2
    content = statement_pdf()

    def preview():
        return admin.post("/api/admin/imports/preview", files={
            "file": ("statement.pdf", content, "application/pdf"),
        })

    async def previews(db):
        return await db.scalar(select(func.count()).select_from(Preview))

    free_space(monkeypatch, config, 2 * MIB + len(content) - 1)
    refused(preview(), 507, "storage_low_space")
    assert list(config.upload_dir.iterdir()) == []
    assert database(config, previews) == 0
    free_space(monkeypatch, config, 2 * MIB + len(content))
    assert preview().status_code == 200
    assert len(list(config.upload_dir.glob("*.pdf"))) == 1
    assert database(config, previews) == 1


class FullVolume:
    """A file whose volume fills up after the first kilobyte."""

    def __init__(self, handle):
        self.handle = handle

    def __enter__(self):
        return self

    def __exit__(self, *details):
        self.handle.close()

    def write(self, data):
        self.handle.write(data[:1024])
        raise OSError(errno.ENOSPC, "No space left on device")


def test_a_volume_that_fills_up_leaves_no_partial_upload(admin, config, monkeypatch):
    value = create_item(admin)
    opener = Path.open

    def open_on_full_volume(self, mode="r", *args, **kwargs):
        handle = opener(self, mode, *args, **kwargs)
        return FullVolume(handle) if "x" in mode else handle

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", open_on_full_volume)
        refused(upload(admin, value), 507, "storage_low_space")
    assert stored_files(config) == []
    assert admin.get(item_path(value) + "/history").json()["total"] == 1
    write_bytes = Path.write_bytes

    def write_until_full(self, data):
        write_bytes(self, data[:1024])
        raise OSError(errno.ENOSPC, "No space left on device")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "write_bytes", write_until_full)
        refused(admin.post("/api/admin/imports/preview", files={
            "file": ("statement.pdf", statement_pdf(), "application/pdf"),
        }), 507, "storage_low_space")
    assert list(config.upload_dir.glob("*.pdf")) == []


def test_storage_administration_requires_an_administrator_and_same_origin(actors, admin, config):
    a, _, _, _ = actors
    value = create_item(a)
    attachment = created(upload(a, value))
    withdraw(a, value, attachment)
    endpoint = f"/api/admin/storage/attachments/{attachment['id']}/purge"
    with visitor(config) as anonymous:
        for client in (anonymous, a):
            for route in ("/api/admin/storage", "/api/admin/storage/withdrawn"):
                refused(client.get(route), 401, "authentication_required")
            refused(purge(client, attachment["id"], 2), 401, "authentication_required")
    for headers in ({"origin": "https://untrusted.example"}, {"x-juntia-request": "0"}):
        refused(admin.post(endpoint, json={"version": 2}, headers=headers), 403, "invalid_origin")
    current = a.get(item_path(value) + f"/attachments/{attachment['id']}").json()
    assert (current["purged_at"], current["version"]) == (None, 2)
    assert len(stored_files(config)) == 1
    assert purge(admin, attachment["id"], 2).status_code == 200


def test_purge_deletes_the_file_and_keeps_the_record_and_its_history(actors, admin, config):
    a, b, _, _ = actors
    value = create_item(a)
    path = item_path(value)
    content = quote_pdf()
    attachment = created(upload(a, value, content, "Quote.pdf"))
    endpoint = path + f"/attachments/{attachment['id']}"
    refused(purge(admin, attachment["id"], 1), 409, "action_attachment_active")
    renamed = a.patch(endpoint, json={"version": 1, "filename": "Final quote.pdf"}).json()
    withdraw(a, value, renamed)
    withdrawn = b.get(endpoint).json()
    refused(purge(admin, attachment["id"], 2), 409, "action_stale")
    refused(purge(admin, uuid4(), 1), 404, "action_attachment_not_found")
    assert admin.post("/api/admin/storage/attachments/not-an-id/purge", json={
        "version": 1,
    }).status_code == 422
    before = b.get(path).json()
    assert len(stored_files(config)) == 1
    response = purge(admin, attachment["id"], 3)
    assert response.status_code == 200, response.text
    purged = response.json()
    assert purged["purged_at"]
    assert purged == {**withdrawn, "version": 4, "purged_at": purged["purged_at"]}
    assert stored_files(config) == []
    assert b.get(endpoint).json() == purged
    assert b.get(path + "/attachments?include_withdrawn=true").json()["items"] == [purged]
    assert b.get(path + "/attachments").json()["total"] == 0
    for client in (a, b, admin):
        for action in ("download", "preview"):
            refused(client.get(endpoint + "/" + action), 410, "action_attachment_purged")
    history = b.get(path + "/history").json()
    assert history["total"] == 5
    event = history["items"][0]
    assert event["kind"] == "attachment_purged"
    assert event["attachment_id"] == attachment["id"]
    assert event["author"] == {
        "kind": "administrator", "user_id": None, "name": "Technical administrator",
    }
    assert event["changes"] == [
        {"field": "filename", "before": "Final quote.pdf", "after": None},
        {"field": "size", "before": str(len(content)), "after": None},
        {"field": "sha256", "before": attachment["sha256"], "after": None},
    ]
    after = b.get(path).json()
    assert (after["version"], after["attachment_count"]) == (before["version"], 0)
    again = purge(admin, attachment["id"], 3)
    assert (again.status_code, again.json()) == (200, purged)
    assert b.get(path + "/history").json() == history
    refused(a.patch(endpoint, json={"version": 4, "filename": "Back.pdf"}), 409,
            "action_content_withdrawn")
    refused(a.request("DELETE", endpoint, json={"version": 4}), 409, "action_content_withdrawn")
    refused(upload(a, value, content, upload_id=attachment["id"]), 409, "action_upload_conflict")


def test_purge_works_while_actions_are_hidden(admin, config):
    value = create_item(admin)
    attachment = created(upload(admin, value))
    withdraw(admin, value, attachment)
    assert admin.patch("/api/admin/settings/features/actions", json={
        "enabled": False,
    }).status_code == 200
    assert admin.get("/api/admin/storage/withdrawn").json()["total"] == 1
    assert purge(admin, attachment["id"], 2).json()["purged_at"]
    assert admin.get("/api/admin/storage").json()["community"]["stored_bytes"] == 0
    assert stored_files(config) == []


def test_failed_deletion_leaves_the_pdf_withdrawn_downloadable_and_counted(
    admin, config, monkeypatch,
):
    value = create_item(admin)
    path = item_path(value)
    content = quote_pdf()
    attachment = created(upload(admin, value, content))
    withdraw(admin, value, attachment)
    endpoint = path + f"/attachments/{attachment['id']}"
    withdrawn, history = admin.get(endpoint).json(), admin.get(path + "/history").json()
    unlink = Path.unlink

    def locked(self, missing_ok=False):
        if self.parent.name == "actions":
            raise PermissionError("synthetic file in use")
        unlink(self, missing_ok=missing_ok)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", locked)
        refused(purge(admin, attachment["id"], 2), 503, "action_storage_error")
    assert admin.get(endpoint).json() == withdrawn
    assert admin.get(path + "/history").json() == history
    assert admin.get(endpoint + "/download").content == content
    assert admin.get("/api/admin/storage").json()["community"]["withdrawn_bytes"] == len(content)
    assert purge(admin, attachment["id"], 2).status_code == 200
    assert stored_files(config) == []


def test_interrupted_purge_commit_is_completed_by_a_retry(admin, config, monkeypatch):
    value = create_item(admin)
    path = item_path(value)
    content = quote_pdf()
    attachment = created(upload(admin, value, content))
    withdraw(admin, value, attachment)
    endpoint = path + f"/attachments/{attachment['id']}"

    async def failed_commit(db):
        raise AppError("action_storage_error", 503)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "commit", failed_commit)
        refused(purge(admin, attachment["id"], 2), 503, "action_storage_error")
    # The file is already gone, but it is never reported as purged while it might exist.
    assert stored_files(config) == []
    assert admin.get(endpoint).json()["purged_at"] is None
    refused(admin.get(endpoint + "/download"), 503, "action_source_missing")
    assert admin.get("/api/admin/storage").json()["community"]["stored_bytes"] == len(content)
    assert purge(admin, attachment["id"], 2).json()["purged_at"]
    assert admin.get(path + "/history").json()["items"][0]["kind"] == "attachment_purged"
    assert admin.get("/api/admin/storage").json()["community"]["stored_bytes"] == 0


def test_storage_summary_reports_usage_quotas_and_free_space(
    actors, admin, config, monkeypatch,
):
    a, b, first, second = actors
    free_space(monkeypatch, config, 40 * GIB)
    resident_action, shared = create_item(a), create_item(admin)
    created(upload(a, resident_action, sized_pdf(300_000)))
    withdraw(a, resident_action, created(upload(a, resident_action, sized_pdf(200_000))))
    created(upload(b, shared, sized_pdf(100_000)))

    def rename(name):
        profile = b.get("/api/auth/profile").json()
        assert b.patch("/api/auth/profile", json={
            "name": name, "phone": profile["phone"], "version": profile["version"],
        }).status_code == 200

    rename("Renamed Neighbor")
    created(upload(b, shared, sized_pdf(50_000)))
    rename("Current Neighbor")
    retired = created(upload(admin, shared, sized_pdf(100_000)))
    withdraw(admin, shared, retired)
    summary = admin.get("/api/admin/storage").json()
    resident_quota = 250 * MIB
    assert summary == {
        "community": {
            "stored_bytes": 750_000, "active_bytes": 450_000, "withdrawn_bytes": 300_000,
            "active_files": 3, "withdrawn_files": 2, "quota_bytes": 2048 * MIB,
        },
        "administrator": {
            "stored_bytes": 100_000, "active_bytes": 0, "withdrawn_bytes": 100_000,
            "active_files": 0, "withdrawn_files": 1,
        },
        "residents": [
            {
                "user_id": first["id"], "name": first["name"], "account_deleted": False,
                "quota_bytes": resident_quota, "stored_bytes": 500_000, "active_bytes": 300_000,
                "withdrawn_bytes": 200_000, "active_files": 1, "withdrawn_files": 1,
            },
            {
                "user_id": second["id"], "name": "Current Neighbor", "account_deleted": False,
                "quota_bytes": resident_quota, "stored_bytes": 150_000, "active_bytes": 150_000,
                "withdrawn_bytes": 0, "active_files": 2, "withdrawn_files": 0,
            },
        ],
        "resident_quota_bytes": resident_quota,
        "disk": {"total_bytes": 41 * GIB, "free_bytes": 40 * GIB, "reserve_bytes": 1024 * MIB},
    }
    assert purge(admin, retired["id"], 2).status_code == 200
    current = current_user(admin, second["id"])
    assert admin.request("DELETE", f"/api/admin/users/{second['id']}", json={
        "version": current["version"], "email": current["email"],
    }).status_code == 204

    def unreadable(directory):
        raise OSError("synthetic unavailable volume")

    monkeypatch.setattr(storage, "disk_usage", unreadable)
    summary = admin.get("/api/admin/storage").json()
    assert summary["community"] == {
        "stored_bytes": 650_000, "active_bytes": 450_000, "withdrawn_bytes": 200_000,
        "active_files": 3, "withdrawn_files": 1, "quota_bytes": 2048 * MIB,
    }
    assert summary["administrator"]["stored_bytes"] == 0
    former = summary["residents"][1]
    assert (former["user_id"], former["name"], former["account_deleted"]) == (
        second["id"], "Renamed Neighbor", True,
    )
    assert former["stored_bytes"] == 150_000
    assert summary["disk"] == {"total_bytes": None, "free_bytes": None, "reserve_bytes": 1024 * MIB}


def test_withdrawn_pdfs_are_listed_for_purging(actors, admin, config):
    a, b, first, second = actors
    shared = create_item(admin, title="Roof repair")
    garden = create_item(a, title="Garden lights")
    for index in range(MAX_ACTIVE_PDFS):
        withdraw(admin, shared, created(upload(admin, shared, sized_pdf(10_000 + index * 1_000))))
    largest = created(upload(a, garden, sized_pdf(50_000)))
    withdraw(a, garden, largest)
    created(upload(a, garden, sized_pdf(60_000)))
    purged = created(upload(b, garden, sized_pdf(70_000)))
    withdraw(b, garden, purged)
    assert purge(admin, purged["id"], 2).status_code == 200
    first_page = admin.get("/api/admin/storage/withdrawn").json()
    second_page = admin.get("/api/admin/storage/withdrawn?page=2").json()
    assert (first_page["total"], first_page["page"], first_page["pages"]) == (21, 1, 2)
    assert len(first_page["items"]) == 20
    rows = first_page["items"] + second_page["items"]
    assert [row["size"] for row in rows] == [50_000, *range(29_000, 9_000, -1_000)]
    top = rows[0]
    assert (top["id"], top["action_id"], top["action_title"]) == (
        largest["id"], garden["id"], "Garden lights",
    )
    assert top["author"] == largest["author"]
    assert (top["version"], top["purged_at"]) == (2, None)
    assert top["withdrawn_at"]
    oldest = admin.get("/api/admin/storage/withdrawn?sort=oldest").json()["items"]
    assert [row["size"] for row in oldest] == list(range(10_000, 30_000, 1_000))
    assert all(row["action_title"] == "Roof repair" for row in oldest)
    mine = admin.get(f"/api/admin/storage/withdrawn?user_id={first['id']}").json()
    assert [row["id"] for row in mine["items"]] == [largest["id"]]
    assert admin.get(f"/api/admin/storage/withdrawn?user_id={second['id']}").json() == {
        "items": [], "total": 0, "page": 1, "pages": 1,
    }
    for query in ("sort=newest", "user_id=0", "page=0", "user_id=abc"):
        assert admin.get("/api/admin/storage/withdrawn?" + query).status_code == 422


def test_purge_migration_round_trip_and_guarded_downgrade(admin, config):
    value = create_item(admin)
    path = item_path(value)
    kept = created(upload(admin, value))
    retired = created(upload(admin, value, filename="retired.pdf"))
    withdraw(admin, value, retired)
    attachments = admin.get(path + "/attachments?include_withdrawn=true").json()
    history = admin.get(path + "/history").json()
    migrate(config, "downgrade", "0017")

    async def columns(db):
        connection = await db.connection()
        return await connection.run_sync(lambda sync: {
            column["name"] for column in inspect(sync).get_columns("action_attachments")
        })

    assert "purged_at" not in database(config, columns)
    now = datetime.now(timezone.utc)
    purged_event = (
        "INSERT INTO action_events (action_id, kind, created_at, changes, author_kind, "
        "author_name) VALUES (:action, 'attachment_purged', :now, '[]', 'administrator', "
        "'Technical administrator')"
    )
    with pytest.raises(IntegrityError):
        execute(config, purged_event, action=value["id"], now=now)
    migrate(config, "upgrade", "head")
    assert "purged_at" in database(config, columns)
    assert admin.get(path + "/attachments?include_withdrawn=true").json() == attachments
    assert admin.get(path + "/history").json() == history
    with pytest.raises(IntegrityError):
        execute(
            config, "UPDATE action_attachments SET purged_at = :now WHERE id = :id",
            now=now, id=kept["id"],
        )
    assert purge(admin, retired["id"], 2).status_code == 200
    result = migrate(config, "downgrade", "0017", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove purged PDF records" in result.stderr
    assert admin.get(path + "/history").json()["items"][0]["kind"] == "attachment_purged"
    assert admin.get(path + f"/attachments/{retired['id']}").json()["purged_at"]
    assert admin.get(path + f"/attachments/{kept['id']}/download").status_code == 200
