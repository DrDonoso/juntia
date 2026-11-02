import hashlib
import io
import struct
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select

from juntia.community_images import MAX_IMAGE_BYTES, image_filename, image_format
from juntia.db import CommunityImage
from juntia.errors import AppError
from juntia.event_calendar import exported_text
from juntia.middleware import BODY_CHUNK_BYTES, body_limit
from tests.test_action_migration import migrate
from tests.test_action_pdfs import upload as upload_pdf
from tests.test_action_storage import (
    GIB,
    MIB,
    created,
    execute,
    free_space,
    refused,
    sized_pdf,
)
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item
from tests.test_community_events import create_event
from tests.test_feature_flags import set_flag
from tests.test_users import current_user, database, visitor
from tests.test_users import mailbox as mailbox


def picture(kind="PNG", size=(32, 24), **options):
    output = io.BytesIO()
    Image.new("RGB", size, (40, 120, 200)).save(output, kind, **options)
    return output.getvalue()


def padded(content, size):
    # The server reads headers only: trailing bytes make an image of an exact size.
    assert len(content) <= size
    return content + b"\0" * (size - len(content))


def png_header(width, height):
    return (
        b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR"
        + struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0) + b"\0" * 4
    )


def gif(screen=(1, 1), frame=(0, 0, 1, 1), before=b""):
    """A GIF89a with a 2-colour table, optional blocks before its first image, and that image."""
    return (
        b"GIF89a" + struct.pack("<HHBBB", *screen, 0x80, 0, 0) + b"\0\0\0\xff\xff\xff" + before
        + b"\x2c" + struct.pack("<HHHHB", *frame, 0) + b"\x02\x02\x44\x01\x00\x3b"
    )


def jpeg(*segments):
    """SOI, the given segments, then a 640×480 frame header."""
    return b"\xff\xd8" + b"".join(segments) + b"\xff\xc0\x00\x11\x08\x01\xe0\x02\x80\x03" + b"\0" * 9


def upload(client, content=None, filename="image.png", scope="actions", upload_id=None):
    return client.post(f"/api/{scope}/images", files={
        "file": (filename, picture() if content is None else content, "image/png"),
    }, data={"upload_id": str(upload_id or uuid4())})


def stored_images(config):
    directory = config.upload_dir / "images"
    return sorted(path.name for path in directory.iterdir()) if directory.exists() else []


def purge(client, image_id):
    return client.post(f"/api/admin/storage/images/{image_id}/purge")


def detected(content):
    found = image_format(io.BytesIO(content))
    return found.media_type, found.width, found.height


def test_formats_and_sizes_come_from_the_bytes():
    exif = Image.Exif()
    exif[0x0110] = "Synthetic camera " * 200
    assert detected(picture("PNG", (300, 200))) == ("image/png", 300, 200)
    assert detected(picture("GIF", (17, 9))) == ("image/gif", 17, 9)
    assert detected(picture("JPEG", (640, 480))) == ("image/jpeg", 640, 480)
    # Metadata segments come before the frame header, and progressive frames are SOF2.
    assert detected(picture("JPEG", (64, 48), exif=exif.tobytes())) == ("image/jpeg", 64, 48)
    assert detected(picture("JPEG", (64, 48), progressive=True)) == ("image/jpeg", 64, 48)
    assert detected(picture("WEBP", (321, 123))) == ("image/webp", 321, 123)
    assert detected(picture("WEBP", (321, 123), lossless=True)) == ("image/webp", 321, 123)
    assert detected(picture("WEBP", (99, 77), exif=exif.tobytes())) == ("image/webp", 99, 77)
    for content in (
        b"", b"<svg xmlns='http://www.w3.org/2000/svg'/>", sized_pdf(2_000),
        b"\x89PNG\r\n\x1a\n", png_header(10, 10)[:20], b"\xff\xd8\xff\xd9",
        b"\xff\xd8\xff\xda\x00\x08" + b"\0" * 10, b"GIF89a\x01",
        b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\0" * 20,
        b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\0" * 20,
        b"\x00\x00\x00\x18ftypheic" + b"\0" * 20, png_header(0, 10), png_header(10, 0),
    ):
        with pytest.raises(AppError) as error:
            detected(content)
        assert (error.value.code, error.value.status) == ("image_invalid", 415), content[:12]
    assert detected(png_header(16384, 2441)) == ("image/png", 16384, 2441)
    for width, height in ((16385, 1), (1, 16385), (6400, 6400)):
        with pytest.raises(AppError) as error:
            detected(png_header(width, height))
        assert (error.value.code, error.value.status) == ("image_dimensions_too_large", 422)


def test_gif_sizes_include_the_first_frame_that_browsers_make_room_for():
    comment = b"\x21\xfe\x05hello\x00"
    control = b"\x21\xf9\x04\x00\x00\x00\x00\x00"
    assert detected(gif((10, 8), (0, 0, 10, 8), control + comment)) == ("image/gif", 10, 8)
    assert detected(gif((10, 8), (5, 6, 20, 4))) == ("image/gif", 25, 10)
    with pytest.raises(AppError) as error:
        # A 1×1 screen whose 1×1 frame sits at (30000, 30000): browsers allocate 30001×30001.
        detected(gif((1, 1), (30000, 30000, 1, 1)))
    assert error.value.code == "image_dimensions_too_large"
    for content in (
        b"GIF89a" + struct.pack("<HHBBB", 1, 1, 0, 0, 0) + b"\x3b",
        gif()[:20], gif(before=b"\x21\xfe\xff"),
    ):
        with pytest.raises(AppError) as error:
            detected(content)
        assert error.value.code == "image_invalid", content


def test_header_scans_are_bounded():
    restart = b"\xff\xd0"
    assert detected(jpeg(restart * 9_000)) == ("image/jpeg", 640, 480)
    assert detected(jpeg(b"\xff" * 500_000 + b"\xe1\x00\x02")) == ("image/jpeg", 640, 480)
    application = b"\xff\xe1\xff\xff" + b"\0" * 65533
    assert detected(jpeg(application * 15)) == ("image/jpeg", 640, 480)
    for content in (
        jpeg(restart * 10_001),
        jpeg(application * 17),
        b"\xff\xd8" + b"\xff" * MAX_IMAGE_BYTES,
        gif(before=b"\x21\xfe" + b"\x01\x00" * 20_000 + b"\x00"),
    ):
        with pytest.raises(AppError) as error:
            detected(content)
        assert error.value.code == "image_invalid"


def test_names_lose_folders_and_control_characters_and_follow_the_format():
    assert image_filename("../../Foto del portal.HEIC", "image/jpeg") == "Foto del portal.jpg"
    assert image_filename("C:\\Users\\x\\captura\u202e.png", "image/png") == "captura.png"
    assert image_filename("plano", "image/webp") == "plano.webp"
    assert image_filename(" .png", "image/gif") == "image.gif"
    assert image_filename(None, "image/png") == "image.png"
    assert image_filename("x" * 400 + ".png", "image/png") == "x" * 250 + ".png"


def test_members_upload_and_read_images_inline(actors, admin, config):
    a, b, first, _ = actors
    content = picture("JPEG", (640, 480))
    upload_id = uuid4()
    response = upload(a, content, "../../Foto del portal.HEIC", upload_id=upload_id)
    assert response.status_code == 201, response.text
    image = response.json()
    assert image == {
        "id": str(upload_id), "url": f"/api/actions/images/{upload_id}",
        "filename": "Foto del portal.jpg", "media_type": "image/jpeg", "size": len(content),
        "width": 640, "height": 480, "created_at": image["created_at"],
    }
    for reader in (b, admin):
        served = reader.get(image["url"])
        assert served.status_code == 200
        assert served.content == content
        assert served.headers["content-type"] == "image/jpeg"
        assert served.headers["content-disposition"].startswith("inline;")
        assert "Foto%20del%20portal.jpg" in served.headers["content-disposition"]
        assert served.headers["cache-control"] == "no-store"
        assert served.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'self'" in served.headers["content-security-policy"]
    assert len(stored_images(config)) == 1 and stored_images(config)[0].endswith(".jpg")
    assert a.get(f"/api/actions/images/{image['id'].upper()}").content == content
    assert a.get(f"/api/actions/images/{uuid4()}").json() == {"code": "image_not_found"}
    assert a.get("/api/actions/images/not-an-id").status_code == 422
    with visitor(config) as anonymous:
        refused(anonymous.get(image["url"]), 401, "authentication_required")
        refused(upload(anonymous), 401, "authentication_required")
    current = current_user(admin, first["id"])
    assert admin.patch(f"/api/admin/users/{first['id']}/status", json={
        "version": current["version"], "disabled": True,
    }).status_code == 200
    refused(a.get(image["url"]), 401, "authentication_required")
    refused(upload(a), 401, "authentication_required")
    assert b.get(image["url"]).content == content


def test_each_section_serves_its_own_images_under_its_switch(actors, admin, config):
    a, b, _, _ = actors
    action_image = created(upload(a, picture()))
    refused(upload(a, scope="events"), 404, "events_disabled")
    set_flag(admin, "events", True)
    event_image = created(upload(b, picture("WEBP", (40, 30)), "plano.webp", scope="events"))
    assert event_image["url"] == f"/api/events/images/{event_image['id']}"
    assert a.get(event_image["url"]).headers["content-type"] == "image/webp"
    refused(a.get(f"/api/events/images/{action_image['id']}"), 404, "image_not_found")
    refused(a.get(f"/api/actions/images/{event_image['id']}"), 404, "image_not_found")
    set_flag(admin, "actions", False)
    refused(a.get(action_image["url"]), 404, "actions_disabled")
    refused(upload(a), 404, "actions_disabled")
    assert a.get(event_image["url"]).status_code == 200
    set_flag(admin, "events", False)
    refused(a.get(event_image["url"]), 404, "events_disabled")
    set_flag(admin, "actions", True)
    assert a.get(action_image["url"]).status_code == 200


def test_invalid_and_oversized_images_leave_nothing_stored(actors, admin, config):
    a, _, _, _ = actors
    for content, filename in (
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "logo.svg"),
        (sized_pdf(3_000), "quote.png"),
        (b"", "empty.png"),
    ):
        refused(upload(a, content, filename), 415, "image_invalid")
    refused(upload(a, png_header(20_000, 10)), 422, "image_dimensions_too_large")
    refused(upload(a, padded(picture(), MAX_IMAGE_BYTES + 1)), 413, "image_too_large")
    assert created(upload(a, padded(picture(), MAX_IMAGE_BYTES)))["size"] == MAX_IMAGE_BYTES
    assert len(stored_images(config)) == 1
    assert not [name for name in stored_images(config) if name.endswith(".tmp")]
    assert admin.get("/api/admin/storage").json()["community"]["image_files"] == 1


def test_image_bodies_have_their_own_limit():
    for path in ("/api/actions/images", "/api/events/images"):
        assert body_limit(path, "POST") == MAX_IMAGE_BYTES + BODY_CHUNK_BYTES
    assert body_limit("/api/actions/images/x", "POST") < MAX_IMAGE_BYTES


def test_retries_are_answered_once_and_keep_their_owner(actors, admin, config):
    a, b, _, _ = actors
    set_flag(admin, "events", True)
    content, upload_id = picture(), uuid4()
    first = created(upload(a, content, upload_id=upload_id))
    assert created(upload(a, content, upload_id=upload_id)) == first
    for client, retry, filename, scope in (
        (a, picture("PNG", (5, 5)), "image.png", "actions"),
        (a, content, "other.png", "actions"),
        (a, content, "image.png", "events"),
        (b, content, "image.png", "actions"),
        (admin, content, "image.png", "actions"),
    ):
        refused(upload(client, retry, filename, scope, upload_id), 409, "image_upload_conflict")
    assert len(stored_images(config)) == 1
    assert admin.get("/api/admin/storage").json()["community"]["image_files"] == 1
    assert purge(admin, upload_id).status_code == 200
    refused(upload(a, content, upload_id=upload_id), 409, "image_upload_conflict")


def test_images_and_pdfs_share_the_byte_quotas(actors, admin, config):
    a, b, first, _ = actors
    config.action_storage_user_quota_mb = 1
    value = create_item(a)
    created(upload(a, padded(picture(), 600_000)))
    refused(upload(a, padded(picture(), 500_000)), 409, "action_storage_user_quota")
    refused(upload_pdf(a, value, sized_pdf(500_000)), 409, "action_storage_user_quota")
    created(upload_pdf(a, value, sized_pdf(400_000)))
    created(upload(b, padded(picture(), 500_000)))
    config.action_storage_user_quota_mb = 10
    config.action_storage_community_quota_mb = 2
    created(upload(admin, padded(picture(), 500_000)))
    refused(upload(b, padded(picture(), 200_000)), 409, "action_storage_community_quota")
    summary = admin.get("/api/admin/storage").json()
    assert summary["community"]["stored_bytes"] == 2_000_000
    assert summary["community"]["image_bytes"] == 1_600_000
    resident = next(row for row in summary["residents"] if row["user_id"] == first["id"])
    assert (resident["stored_bytes"], resident["image_bytes"], resident["image_files"]) == (
        1_000_000, 600_000, 1,
    )


def test_disk_reserve_refuses_images_before_staging(actors, config, monkeypatch):
    a, b, _, _ = actors
    content, upload_id = picture(), uuid4()
    original = created(upload(a, content, upload_id=upload_id))
    config.min_free_disk_mb = 2
    free_space(monkeypatch, config, 2 * MIB)
    refused(upload(a), 507, "storage_low_space")
    refused(upload(b, content, upload_id=upload_id), 507, "storage_low_space")
    # The requester's own retry is still answered from the stored record.
    assert created(upload(a, content, upload_id=upload_id)) == original
    assert len(stored_images(config)) == 1


def test_missing_files_are_reported(actors, config):
    a, _, _, _ = actors
    image = created(upload(a))
    for path in (config.upload_dir / "images").iterdir():
        path.unlink()
    refused(a.get(image["url"]), 503, "image_source_missing")


def test_the_administrator_lists_views_and_purges_images(actors, admin, config, monkeypatch):
    a, b, first, second = actors
    free_space(monkeypatch, config, 40 * GIB)
    set_flag(admin, "events", True)
    small = created(upload(a, padded(picture(), 1_000), "small.png"))
    large = created(upload(b, padded(picture("GIF", (8, 8)), 9_000), "large.gif", scope="events"))
    mine = created(upload(admin, padded(picture("JPEG"), 4_000), "admin.jpg"))
    for index, image in enumerate((small, large, mine)):
        execute(
            config, "UPDATE community_images SET created_at = :at WHERE id = :id",
            at=datetime(2026, 10, 1 + index, 12, tzinfo=timezone.utc), id=image["id"],
        )
    page = admin.get("/api/admin/storage/images").json()
    assert (page["total"], page["page"], page["pages"]) == (3, 1, 1)
    assert [row["id"] for row in page["items"]] == [mine["id"], large["id"], small["id"]]
    newest = page["items"][0]
    assert newest == {
        **mine, "scope": "actions", "created_at": newest["created_at"],
        "sha256": hashlib.sha256(padded(picture("JPEG"), 4_000)).hexdigest(),
        "author": {"kind": "administrator", "user_id": None, "name": "Technical administrator"},
        "purged_at": None,
    }
    assert newest["created_at"].startswith("2026-10-03T12:00:00")
    assert page["items"][1]["scope"] == "events"
    assert page["items"][1]["author"] == {
        "kind": "resident", "user_id": second["id"], "name": second["name"],
    }
    largest = admin.get("/api/admin/storage/images?sort=largest").json()["items"]
    assert [row["size"] for row in largest] == [9_000, 4_000, 1_000]
    filtered = admin.get(f"/api/admin/storage/images?user_id={first['id']}").json()
    assert [row["id"] for row in filtered["items"]] == [small["id"]]
    for query in ("sort=oldest", "user_id=0", "page=0"):
        assert admin.get("/api/admin/storage/images?" + query).status_code == 422
    summary = admin.get("/api/admin/storage").json()
    assert (summary["community"]["image_bytes"], summary["community"]["image_files"]) == (
        14_000, 3,
    )
    assert (summary["administrator"]["image_bytes"], summary["administrator"]["stored_bytes"]) == (
        4_000, 4_000,
    )
    set_flag(admin, "actions", False)
    preview = admin.get(f"/api/admin/storage/images/{small['id']}/file")
    assert preview.content == padded(picture(), 1_000)
    assert preview.headers["content-type"] == "image/png"
    set_flag(admin, "actions", True)
    for client in (a, b):
        refused(client.get("/api/admin/storage/images"), 401, "authentication_required")
        refused(purge(client, small["id"]), 401, "authentication_required")
    with visitor(config) as anonymous:
        refused(anonymous.get(f"/api/admin/storage/images/{small['id']}/file"), 401,
                "authentication_required")
    purged = purge(admin, large["id"])
    assert purged.status_code == 200, purged.text
    assert purged.json()["purged_at"]
    assert purge(admin, large["id"]).json() == purged.json()
    refused(b.get(large["url"]), 410, "image_purged")
    refused(admin.get(f"/api/admin/storage/images/{large['id']}/file"), 410, "image_purged")
    assert len(stored_images(config)) == 2
    assert admin.get("/api/admin/storage/images").json()["total"] == 2
    assert admin.get("/api/admin/storage").json()["community"]["image_bytes"] == 5_000
    refused(purge(admin, uuid4()), 404, "image_not_found")
    current = current_user(admin, first["id"])
    assert admin.request("DELETE", f"/api/admin/users/{first['id']}", json={
        "version": current["version"], "email": current["email"],
    }).status_code == 204
    former = next(
        row for row in admin.get("/api/admin/storage").json()["residents"]
        if row["user_id"] == first["id"]
    )
    assert (former["name"], former["account_deleted"], former["image_files"]) == (
        first["name"], True, 1,
    )


def test_a_failed_deletion_keeps_the_image(actors, admin, config, monkeypatch):
    a, _, _, _ = actors
    image = created(upload(a))

    def failing(path):
        raise AppError("image_storage_error", 503)

    monkeypatch.setattr("juntia.storage_admin.remove_image_file", failing)
    refused(purge(admin, image["id"]), 503, "image_storage_error")
    assert a.get(image["url"]).status_code == 200
    assert admin.get("/api/admin/storage/images").json()["total"] == 1


def test_calendar_exports_show_absolute_image_addresses(admin, config):
    set_flag(admin, "events", True)
    image = created(upload(admin, scope="events"))
    other = "/api/actions/images/" + str(uuid4())
    description = f"Plano:\n![Plano del portal]({image['url']})\n[Enlace]({other})"
    value = create_event(admin, description=description)
    origin = config.public_origins[0]
    expected = (
        f"Plano:\n![Plano del portal]({origin}{image['url']})\n[Enlace]({origin}{other})"
    )
    assert exported_text(description, origin) == expected
    google = admin.get(f"/api/events/{value['id']}/calendar").json()["google_url"]
    assert (origin + image["url"]).replace("/", "%2F").replace(":", "%3A") in google
    ics = admin.get(f"/api/events/{value['id']}/calendar.ics").text.replace("\r\n ", "")
    assert f"{origin}{image['url']}" in ics
    assert exported_text("![x](https://example.org/a.png)", origin) == (
        "![x](https://example.org/a.png)"
    )


def test_image_migration_round_trip_and_guarded_downgrade(admin, config):
    migrate(config, "downgrade", "0020")
    migrate(config, "upgrade", "head")
    image = created(upload(admin))
    result = migrate(config, "downgrade", "0020", check=False)
    assert result.returncode != 0
    assert "Back up and explicitly remove community images" in result.stderr
    assert admin.get(image["url"]).status_code == 200

    async def count(db):
        return await db.scalar(select(func.count()).select_from(CommunityImage))

    assert database(config, count) == 1
