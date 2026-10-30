import threading
from concurrent.futures import ThreadPoolExecutor

from juntia import auth
from tests.test_users import (
    PASSWORD,
    activate,
    current_user,
    invite,
    login,
    token_from,
    visitor,
)
from tests.test_users import (
    mailbox as mailbox,
)


def test_profile_requires_a_resident_and_only_exposes_own_data(admin, config, mailbox):
    user, token = invite(admin, mailbox)
    other, _ = invite(admin, mailbox, "other@example.org", user["dwelling_id"])
    assert admin.get("/api/auth/profile").status_code == 403
    with visitor(config) as reader:
        assert reader.get("/api/auth/profile").status_code == 401
        activate(reader, token)
        assert login(reader).status_code == 200
        result = reader.get("/api/auth/profile", params={"user_id": other["id"]})
        assert result.status_code == 200
        profile = result.json()
        assert set(profile) == {
            "id", "email", "name", "phone", "dwelling_id", "dwelling_label", "coefficient",
            "last_login_at", "version", "has_password", "google_linked",
        }
        assert profile["id"] == user["id"]
        assert profile["email"] == user["email"]
        assert profile["dwelling_label"] == "1 A"
        assert profile["coefficient"] == "1.23"
        assert profile["last_login_at"] is not None
        response = reader.patch("/api/auth/profile", json={
            "name": "  New   Name  ", "version": profile["version"],
        })
        assert response.status_code == 200
        saved = response.json()
        assert saved["name"] == "New Name"
        assert saved["version"] == profile["version"] + 1
        assert saved["last_login_at"] == profile["last_login_at"]
        assert reader.get("/api/auth/session").json()["name"] == "New Name"
        assert reader.get("/api/summary").status_code == 200
        assert current_user(admin, user["id"])["name"] == "New Name"
        assert current_user(admin, other["id"])["name"] == other["name"]
        assert reader.patch("/api/auth/profile", json={
            "name": "Stale update", "version": profile["version"],
        }).status_code == 409
        for field, value in [
            ("email", "forged@example.org"), ("dwelling_id", 999), ("coefficient", "99"),
            ("disabled", False), ("id", other["id"]), ("role", "administrator"),
        ]:
            assert reader.patch("/api/auth/profile", json={
                "name": "Invalid change", "version": saved["version"], field: value,
            }).status_code == 422
        assert reader.patch("/api/auth/profile", json={
            "name": " ", "version": saved["version"],
        }).status_code == 422


def test_password_change_verifies_current_password_and_revokes_all_access(
    admin, config, mailbox
):
    user, token = invite(admin, mailbox)
    with visitor(config) as first, visitor(config) as second:
        activate(first, token)
        assert login(first).status_code == 200
        assert login(second).status_code == 200
        before = current_user(admin, user["id"])["last_login_at"]
        for wrong in ["incorrect", "x" * 73]:
            response = first.post("/api/auth/profile/password", json={
                "current_password": wrong, "password": "another synthetic password",
            })
            assert response.status_code == 400
            assert response.json()["code"] == "current_password_invalid"
            assert first.get("/api/auth/profile").status_code == 200
        for invalid in ["short", "x" * 9, " " * 10, "ñ" * 37]:
            assert first.post("/api/auth/profile/password", json={
                "current_password": PASSWORD, "password": invalid,
            }).status_code == 422
        first.post("/api/auth/forgot-password", json={"email": user["email"]})
        recovery = token_from(mailbox[-1])
        new_password = "another synthetic password"
        response = first.post("/api/auth/profile/password", json={
            "current_password": PASSWORD, "password": new_password,
        })
        assert response.status_code == 204
        assert first.cookies.get(auth.USER_COOKIE) is None
        assert first.get("/api/auth/profile").status_code == 401
        assert second.get("/api/summary").status_code == 401
        assert current_user(admin, user["id"])["last_login_at"] == before
        assert first.post("/api/auth/reset-password", json={
            "token": recovery, "password": PASSWORD,
        }).status_code == 400
        assert login(first).status_code == 401
        assert login(first, password=new_password).status_code == 200


def test_closing_sessions_affects_only_the_resident_and_preserves_password(
    admin, config, mailbox
):
    user, token = invite(admin, mailbox)
    other, other_token = invite(admin, mailbox, "other@example.org", user["dwelling_id"])
    with visitor(config) as first, visitor(config) as second, visitor(config) as neighbour:
        activate(first, token)
        activate(neighbour, other_token)
        assert login(first).status_code == 200
        assert login(second).status_code == 200
        assert login(neighbour, other["email"]).status_code == 200
        before = current_user(admin, user["id"])["last_login_at"]
        assert first.delete("/api/auth/profile/sessions").status_code == 204
        assert first.get("/api/summary").status_code == 401
        assert second.get("/api/summary").status_code == 401
        assert neighbour.get("/api/summary").status_code == 200
        assert admin.get("/api/admin/users").status_code == 200
        assert current_user(admin, user["id"])["last_login_at"] == before
        assert login(first).status_code == 200


def test_profile_mutations_keep_csrf_and_technical_admin_boundaries(admin, config, mailbox):
    _, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        profile = reader.get("/api/auth/profile").json()
        cases = [
            ("PATCH", "/api/auth/profile", {"name": "Unsafe", "version": profile["version"]}),
            ("POST", "/api/auth/profile/password", {
                "current_password": PASSWORD, "password": "another synthetic password",
            }),
            ("DELETE", "/api/auth/profile/sessions", None),
        ]
        for method, path, body in cases:
            assert reader.request(method, path, json=body, headers={
                "origin": "https://attacker.invalid",
            }).status_code == 403
            assert admin.request(method, path, json=body).status_code == 403
        assert reader.get("/api/auth/profile").json()["name"] == profile["name"]
        assert reader.get("/api/summary").status_code == 200


def test_password_change_cannot_undo_concurrent_deactivation(admin, config, mailbox, monkeypatch):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        user = current_user(admin, user["id"])
        entered, release = threading.Event(), threading.Event()
        original = auth.bcrypt.checkpw

        def delayed(candidate, hashed):
            result = original(candidate, hashed)
            entered.set()
            assert release.wait(15)
            return result

        with monkeypatch.context() as patch:
            patch.setattr(auth.bcrypt, "checkpw", delayed)
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(reader.post, "/api/auth/profile/password", json={
                    "current_password": PASSWORD, "password": "another synthetic password",
                })
                try:
                    assert entered.wait(15)
                    changed = admin.patch(f"/api/admin/users/{user['id']}/status", json={
                        "disabled": True, "version": user["version"],
                    })
                    assert changed.status_code == 200
                finally:
                    release.set()
                assert future.result(timeout=15).status_code == 401
        disabled = current_user(admin, user["id"])
        admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": False, "version": disabled["version"],
        })
        assert login(reader).status_code == 200
