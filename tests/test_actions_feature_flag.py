from uuid import uuid4

from juntia import community_actions
from tests.test_action_pdfs import quote_pdf, upload
from tests.test_community_actions import actors as actors
from tests.test_community_actions import create_item, item_path
from tests.test_feature_flags import set_flag
from tests.test_users import mailbox as mailbox
from tests.test_users import visitor


def test_disabling_actions_blocks_every_api_but_retains_data_and_sessions(actors, admin, config):
    first, _, _, _ = actors
    item = create_item(first, labels=["Retained"])
    path = item_path(item)
    comment = first.post(path + "/comments", json={"body": "Keep this comment"}).json()
    content = quote_pdf()
    attachment = upload(first, item, content).json()
    history = first.get(path + "/history").json()
    current = first.get(path).json()
    comments = first.get(path + "/comments").json()
    attachments = first.get(path + "/attachments").json()
    comment_path = path + f"/comments/{comment['id']}"
    attachment_path = path + f"/attachments/{attachment['id']}"
    set_flag(admin, "actions", False)
    reads = [
        "/api/actions/items", "/api/actions/board", "/api/actions/labels",
        path, path + "/comments", comment_path, path + "/attachments",
        path + "/history", attachment_path, attachment_path + "/download",
        attachment_path + "/preview",
    ]
    mutations = [
        ("POST", "/api/actions/items", {"title": "Rejected"}),
        ("PATCH", path, {"version": item["version"], "title": "Rejected"}),
        ("POST", path + "/comments", {"body": "Rejected"}),
        ("PATCH", comment_path, {"version": comment["version"], "body": "Rejected"}),
        ("DELETE", comment_path, {"version": comment["version"]}),
        ("PATCH", attachment_path, {"version": attachment["version"], "filename": "Rejected.pdf"}),
        ("DELETE", attachment_path, {"version": attachment["version"]}),
    ]
    with visitor(config) as operator, visitor(config) as resident:
        assert resident.get("/api/features").json() == {
            "coefficient": True, "google_login": False, "actions": False, "events": False,
        }
        assert resident.get(path).status_code == 401
        operator.cookies.update(admin.cookies)
        resident.cookies.update(first.cookies)
        for client in (operator, resident):
            for endpoint in reads:
                response = client.get(endpoint)
                assert response.status_code == 404, (endpoint, response.text)
                assert response.json() == {"code": "actions_disabled"}
            for method, endpoint, body in mutations:
                response = client.request(method, endpoint, json=body)
                assert response.status_code == 404, (endpoint, response.text)
                assert response.json() == {"code": "actions_disabled"}
            response = client.post(path + "/attachments", files={
                "file": ("quote.pdf", content, "application/pdf"),
            }, data={"upload_id": str(uuid4())})
            assert response.status_code == 404
            assert response.json() == {"code": "actions_disabled"}
            assert client.get("/api/summary").status_code == 200
            assert client.get("/api/neighbors").status_code == 200
            assert client.get("/api/auth/session").json()["authenticated"] is True
        assert operator.get("/api/admin/users").status_code == 200
        assert resident.get("/api/admin/users").status_code == 401
    set_flag(admin, "actions", True)
    assert first.get("/api/features").json()["actions"] is True
    assert first.get(path).json() == current
    assert first.get(path + "/history").json() == history
    assert first.get(path + "/comments").json() == comments
    assert first.get(path + "/attachments").json() == attachments
    assert first.get(attachment_path + "/download").content == content
    assert first.get(attachment_path + "/preview").content == content
    assert first.post(path + "/comments", json={"body": "Enabled again"}).status_code == 201


def test_flag_is_rechecked_after_staging_an_upload(admin, config, monkeypatch):
    item = create_item(admin)
    stage = community_actions.stage_pdf

    def disable_after_staging(*args):
        result = stage(*args)
        with visitor(config) as operator:
            operator.cookies.update(admin.cookies)
            set_flag(operator, "actions", False)
        return result

    monkeypatch.setattr(community_actions, "stage_pdf", disable_after_staging)
    response = upload(admin, item)
    assert response.status_code == 404
    assert response.json() == {"code": "actions_disabled"}
    assert not list((config.upload_dir / "actions").iterdir())
    set_flag(admin, "actions", True)
    assert admin.get(item_path(item) + "/history").json()["total"] == 1
    assert admin.get(item_path(item) + "/attachments").json()["total"] == 0
