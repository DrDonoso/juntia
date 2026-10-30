import pytest
from pydantic import SecretStr, ValidationError

from juntia.contracts import NewPasswordIn
from tests.test_users import activate, current_user, invite, login, token_from, visitor
from tests.test_users import mailbox as mailbox


@pytest.mark.parametrize("password", ["a" * 10, "a" * 14, "a" * 72, "é" * 10, "😀" * 10])
def test_resident_password_accepts_ten_characters_without_changing_input(password):
    assert NewPasswordIn(password=password).password == password


@pytest.mark.parametrize("password", ["", "a" * 9, "😀" * 9, " " * 10, "a" * 73, "é" * 37])
def test_resident_password_rejects_short_blank_or_overlong_input(password):
    with pytest.raises(ValidationError):
        NewPasswordIn(password=password)


def test_ten_character_passwords_work_for_activation_change_and_recovery(admin, mailbox, config):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        assert reader.post("/api/auth/activate", json={
            "token": token, "password": "123456789",
        }).status_code == 422
        assert current_user(admin, user["id"])["status"] == "pending"
        activate(reader, token, password="Clave12345")
        assert login(reader, password="Clave12345").status_code == 200
        assert reader.post("/api/auth/profile/password", json={
            "current_password": "Clave12345", "password": "Nuevo12345",
        }).status_code == 204
        assert login(reader, password="Nuevo12345").status_code == 200
        assert reader.post("/api/auth/forgot-password", json={
            "email": user["email"],
        }).status_code == 202
        recovery = token_from(mailbox[-1])
        assert reader.post("/api/auth/reset-password", json={
            "token": recovery, "password": "123456789",
        }).status_code == 422
        assert reader.post("/api/auth/reset-password", json={
            "token": recovery, "password": "Reset12345",
        }).status_code == 204
        assert login(reader, password="Reset12345").status_code == 200


@pytest.mark.parametrize("google_enabled", [False, True])
def test_invitation_and_resend_use_the_current_community_name(admin, mailbox, config, google_enabled):
    if google_enabled:
        config.google_client_id = "synthetic-client.apps.googleusercontent.com"
        config.google_client_secret = SecretStr("synthetic-google-secret")
    community = "Residencial Jardín"
    assert admin.patch("/api/admin/settings/general", json={
        "community_name": community,
    }).status_code == 200
    user, _ = invite(admin, mailbox)
    method = "Google or a password" if google_enabled else "a password"
    body = mailbox[-1].get_content()
    assert (
        f"You have been invited to join {community}. "
        f"Activate your account with {method} using this link:"
    ) in body
    assert "{" not in body and "}" not in body
    new_name = "Residencial del Parque"
    assert admin.patch("/api/admin/settings/general", json={
        "community_name": new_name,
    }).status_code == 200
    assert admin.post(f"/api/admin/users/{user['id']}/invite", json={
        "version": user["version"],
    }).status_code == 200
    assert f"You have been invited to join {new_name}." in mailbox[-1].get_content()
    assert community not in mailbox[-1].get_content()
