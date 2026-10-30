import asyncio
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from juntia import auth, users
from juntia.db import GoogleAuthFlow, State, User, UserSession, UserToken, utcnow
from juntia.errors import AppError
from tests.test_api import commit, preview
from tests.test_google_auth import finish, start
from tests.test_google_auth import google as google
from tests.test_users import (
    PASSWORD,
    activate,
    current_user,
    database,
    invite,
    login,
    token_from,
    visitor,
)
from tests.test_users import mailbox as mailbox


def remove(admin, user, **changes):
    return admin.request("DELETE", f"/api/admin/users/{user['id']}", json={
        "email": user["email"], "version": user["version"], **changes,
    })


def test_deletion_requires_admin_matching_email_version_and_origin(admin, mailbox, config):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        assert remove(reader, user).status_code == 401
        activate(reader, token)
        assert login(reader).status_code == 200
        user = current_user(admin, user["id"])
        assert remove(reader, user).status_code == 401
        assert remove(admin, user, email="someone-else@example.org").status_code == 422
        assert remove(admin, user, version=user["version"] + 1).status_code == 409
        path = f"/api/admin/users/{user['id']}"
        for body in [{}, {"version": user["version"]}, {"email": user["email"]}]:
            assert admin.request("DELETE", path, json=body).status_code == 422
        assert admin.request("DELETE", path, json={
            "email": user["email"], "version": user["version"],
        }, headers={"origin": "https://attacker.invalid"}).status_code == 403
        assert current_user(admin, user["id"])["status"] == "active"
        assert reader.get("/api/auth/profile").status_code == 200
        assert admin.request("DELETE", "/api/admin/users/999999", json={
            "email": user["email"], "version": user["version"],
        }).status_code == 404


@pytest.mark.parametrize("status", ["pending", "active", "disabled"])
def test_delete_any_resident_state_preserves_dwelling_and_financial_data(
    admin, mailbox, config, status
):
    imported = commit(admin, preview(admin))
    assert imported.status_code == 200
    summary = admin.get("/api/summary").json()
    transactions = admin.get("/api/transactions").json()
    statements = admin.get("/api/admin/statements").json()
    user, token = invite(admin, mailbox)
    other, _ = invite(admin, mailbox, "other@example.org", user["dwelling_id"])
    if status != "pending":
        activate(admin, token)
        user = current_user(admin, user["id"])
    if status == "disabled":
        user = admin.patch(f"/api/admin/users/{user['id']}/status", json={
            "disabled": True, "version": user["version"],
        }).json()
    unit = admin.get("/api/admin/dwellings").json()[0]
    async def revision(db):
        return (await db.get(State, 1)).revision
    previous_revision = database(config, revision)
    assert remove(admin, user).status_code == 204
    assert admin.get("/api/admin/users").json() == [other]
    assert admin.get("/api/admin/dwellings").json()[0] == {**unit, "user_count": 1}
    assert admin.get("/api/summary").json() == summary
    assert admin.get("/api/transactions").json() == transactions
    assert admin.get("/api/admin/statements").json() == statements
    assert database(config, revision) == previous_revision
    assert admin.get("/api/admin/auth/session").json()["authenticated"] is True
    assert remove(admin, user).status_code == 404
    assert admin.post("/api/auth/activate", json={"token": token, "password": PASSWORD}).status_code == 400


def test_deleted_access_is_removed_atomically_and_same_email_can_be_reinvited(
    google, admin, mailbox, config
):
    user, invitation = invite(admin, mailbox)
    with visitor(config) as reader, visitor(config) as second:
        activate(reader, invitation)
        assert login(reader).status_code == 200
        assert login(second).status_code == 200
        reader.post("/api/auth/forgot-password", json={"email": user["email"]})
        recovery = token_from(mailbox[-1])
        linked = reader.post("/api/auth/google/link", json={"current_password": PASSWORD}).json()
        flow = parse_qs(urlsplit(linked["authorization_url"]).query)
        user = current_user(admin, user["id"])
        assert remove(admin, user, email=user["email"].upper()).status_code == 204
        async def remaining(db):
            assert await db.get(User, user["id"]) is None
            for model in (UserSession, UserToken, GoogleAuthFlow):
                assert (await db.scalars(select(model).where(model.user_id == user["id"]))).all() == []
        database(config, remaining)
        assert reader.get("/api/summary").status_code == 401
        assert second.get("/api/summary").status_code == 401
        assert "google_error=" in finish(reader, flow).headers["location"]
        assert reader.post("/api/auth/reset-password", json={
            "token": recovery, "password": PASSWORD,
        }).status_code == 400
        assert login(reader).status_code == 401
        new, fresh_token = invite(admin, mailbox, user["email"], user["dwelling_id"])
        assert new["id"] > user["id"]
        assert new["status"] == "pending"
        assert new["last_login_at"] is None
        assert remove(admin, user).status_code == 404
        assert reader.post("/api/auth/activate", json={
            "token": invitation, "password": PASSWORD,
        }).status_code == 400
        assert finish(reader, start(reader, fresh_token)).headers["location"] == "/"
        assert reader.get("/api/auth/session").json()["user_id"] == new["id"]


def test_google_subject_can_be_bound_again_only_after_a_new_invitation(google, admin, mailbox, config):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        finish(reader, start(reader, token))
        user = current_user(admin, user["id"])
        assert user["google_linked"] is True
        assert remove(admin, user).status_code == 204
        assert reader.get("/api/neighbors").status_code == 401
        assert "google_error=" in finish(reader, start(reader)).headers["location"]
        fresh, token = invite(admin, mailbox, user["email"], user["dwelling_id"])
        assert fresh["id"] > user["id"]
        assert fresh["google_linked"] is False
        assert "google_error=" in finish(reader, start(reader)).headers["location"]
        assert finish(reader, start(reader, token)).headers["location"] == "/"
        assert current_user(admin, fresh["id"])["google_linked"] is True


def test_pending_google_activation_cannot_follow_a_deleted_email_to_a_new_account(
    google, admin, mailbox, config
):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        old_flow = start(reader, token)
        assert remove(admin, user).status_code == 204
        replacement, fresh_token = invite(admin, mailbox, user["email"], user["dwelling_id"])
        assert "google_invalid_flow" in finish(reader, old_flow).headers["location"]
        assert google["calls"] == []
        assert current_user(admin, replacement["id"])["status"] == "pending"
        assert finish(reader, start(reader, fresh_token)).headers["location"] == "/"
        assert reader.get("/api/auth/session").json()["user_id"] == replacement["id"]


def test_deleting_a_user_does_not_invalidate_an_administrator_import_preview(admin, mailbox):
    staged = preview(admin)
    user, _ = invite(admin, mailbox)
    assert remove(admin, user).status_code == 204
    assert commit(admin, staged).status_code == 200


def test_failed_delete_rolls_back_access_revocation(admin, mailbox, config, monkeypatch):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
        assert login(reader).status_code == 200
        user = current_user(admin, user["id"])
        original = users.revoke_user_access
        async def fail_after_revocation(db, user_id):
            await original(db, user_id)
            raise AppError("synthetic_delete_failure", 503)
        with monkeypatch.context() as patch:
            patch.setattr(users, "revoke_user_access", fail_after_revocation)
            assert remove(admin, user).status_code == 503
        assert current_user(admin, user["id"])["status"] == "active"
        assert reader.get("/api/auth/profile").status_code == 200


def test_in_flight_password_login_cannot_restore_a_deleted_account(admin, mailbox, config, monkeypatch):
    user, token = invite(admin, mailbox)
    with visitor(config) as reader:
        activate(reader, token)
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
                pending = pool.submit(login, reader)
                try:
                    assert entered.wait(15)
                    assert remove(admin, user).status_code == 204
                    replacement, _ = invite(admin, mailbox, user["email"], user["dwelling_id"])
                    assert replacement["id"] > user["id"]
                finally:
                    release.set()
                assert pending.result(timeout=15).status_code == 401
        assert reader.get("/api/summary").status_code == 401
        assert current_user(admin, replacement["id"])["last_login_at"] is None


def test_sqlite_identity_migration_keeps_existing_accounts_and_access(config):
    if not config.database_url.startswith("sqlite"):
        pytest.skip("PostgreSQL already uses sequences")
    env = {**os.environ, "DATABASE_URL": config.database_url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "0007"],
        env=env, check=True, capture_output=True,
    )
    async def legacy_data():
        engine = create_async_engine(config.database_url)
        async with engine.begin() as db:
            await db.execute(text(
                "INSERT INTO dwellings (id,label,coefficient,version) VALUES (1,'1 A',12.50,1)"
            ))
            await db.execute(text(
                "INSERT INTO users (id,name,email,dwelling_id,password_hash,activated,disabled,"
                "auth_version,version,invitation_delivery) VALUES "
                "(7,'Existing','existing@example.org',1,'synthetic',true,false,2,3,'none')"
            ))
            await db.execute(UserSession.__table__.insert().values(
                token_hash="a" * 64, user_id=7, auth_version=2,
                expires_at=utcnow() + timedelta(hours=1),
            ))
        await engine.dispose()
    asyncio.run(legacy_data())
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        env=env, check=True, capture_output=True,
    )
    async def verify(db):
        account = await db.get(User, 7)
        assert account.email == "existing@example.org" and account.version == 3
        assert (await db.get(UserSession, "a" * 64)).user_id == 7
        ddl = await db.scalar(text("SELECT sql FROM sqlite_master WHERE name='users'"))
        assert "AUTOINCREMENT" in ddl
    database(config, verify)
