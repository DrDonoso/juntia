import os
import subprocess
import sys
from datetime import date
from decimal import Decimal

from sqlalchemy import column, delete, func, select, table, text, update

from juntia.db import (
    Account,
    ActionAttachment,
    ActionComment,
    ActionEvent,
    ActionLabel,
    ActionLabelLink,
    CommunityAction,
    Dwelling,
    State,
    Transaction,
    User,
)
from tests.support import iban
from tests.test_action_pdfs import quote_pdf, upload
from tests.test_community_actions import create_item, item_path
from tests.test_users import database

# Before 0024 every account lives in a dwelling, and upgrading to it makes nobody an
# administrator. As an operator would, migrate() moves the administrators without a dwelling into
# this one to downgrade past it, and gives them the role back, without it, once upgraded again.
WAITING_ROOM = "Administrators waiting for the upgrade"


async def revision(db):
    return await db.scalar(text("SELECT version_num FROM alembic_version"))


async def park_administrators(db):
    homeless = list(await db.scalars(select(User).where(
        User.administrator.is_(True), User.dwelling_id.is_(None),
    )))
    if homeless:
        room = Dwelling(label=WAITING_ROOM, coefficient=Decimal("0"))
        db.add(room)
        await db.flush()
        for user in homeless:
            user.dwelling_id = room.id


async def restore_administrators(db):
    room = await db.scalar(select(Dwelling.id).where(Dwelling.label == WAITING_ROOM))
    if room is not None:
        await db.execute(update(User).where(User.dwelling_id == room).values(administrator=True))
        await db.execute(update(User).where(User.dwelling_id == room).values(dwelling_id=None))
        await db.execute(delete(Dwelling).where(Dwelling.id == room))


def migrate(config, command, revision_id, check=True, options=()):
    crossing = command == "downgrade" and revision_id < "0024" <= database(config, revision)
    if crossing:
        database(config, park_administrators)
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *options, command, revision_id],
        env={**os.environ, "DATABASE_URL": config.database_url},
        check=check, capture_output=True, text=True,
    )
    if crossing and result.returncode or command == "upgrade" and (
        revision_id == "head" or revision_id >= "0024"
    ):
        database(config, restore_administrators)
    return result


def test_action_migration_preserves_existing_finances_and_residents(config):
    migrate(config, "downgrade", "0007")

    async def legacy(db):
        await db.execute(text(
            "UPDATE state SET revision = 37, community_name = 'Legacy community' WHERE id = 1"
        ))
        unit = Dwelling(label="Legacy 1 A", coefficient=Decimal("12.34"))
        db.add(unit)
        await db.flush()
        # Users as before 0024, without the columns that later revisions add to the current model.
        users = table("users", *(column(name) for name in (
            "email", "name", "phone", "dwelling_id", "activated", "disabled", "auth_version",
            "version", "google_subject", "invitation_delivery", "id",
        )))
        resident_id = await db.scalar(users.insert().values(
            email="legacy@example.org", name="Legacy Resident", phone="+12025550101",
            dwelling_id=unit.id, activated=True, disabled=False, auth_version=4, version=9,
            google_subject="synthetic-legacy-google", invitation_delivery="none",
        ).returning(users.c.id))
        db.add(Account(id=1, iban=iban(), name="Legacy account"))
        transaction = Transaction(
            source_key="a" * 64, weak_key="b" * 64, identity_key="c" * 64,
            booking_date=date(2026, 1, 1), value_date=date(2026, 1, 1),
            description="Synthetic legacy movement", amount=Decimal("-12.34"),
            balance_after=Decimal("1000.00"), version=3,
        )
        db.add(transaction)
        await db.flush()
        return resident_id, unit.id, transaction.id

    user_id, unit_id, transaction_id = database(config, legacy)
    migrate(config, "upgrade", "head")

    async def verify(db):
        state = await db.get(State, 1)
        assert (state.revision, state.community_name) == (37, "Legacy community")
        resident = await db.get(User, user_id)
        assert (resident.dwelling_id, resident.auth_version, resident.version) == (unit_id, 4, 9)
        assert resident.google_subject == "synthetic-legacy-google"
        assert resident.phone == "+12025550101"
        transaction = await db.get(Transaction, transaction_id)
        assert transaction.amount == Decimal("-12.34")
        assert transaction.balance_after == Decimal("1000.00")
        assert transaction.version == 3
        assert (await db.get(Account, 1)).iban == iban()
        for model in (CommunityAction, ActionLabel, ActionLabelLink, ActionComment, ActionAttachment, ActionEvent):
            assert await db.scalar(select(func.count()).select_from(model)) == 0

    database(config, verify)


def test_downgrade_refuses_to_destroy_a_backlog(admin, config):
    value = create_item(admin, labels=["Preserved"])
    response = migrate(config, "downgrade", "0007", check=False)
    assert response.returncode != 0
    assert "Back up and explicitly remove community actions" in response.stderr
    assert admin.get(item_path(value)).json() == value
    assert admin.get(item_path(value) + "/history").json()["total"] == 1


def test_pdf_name_migration_preserves_existing_attachments_and_history(admin, config):
    value = create_item(admin)
    content = quote_pdf()
    attachment = upload(admin, value, content).json()
    path = item_path(value)
    history = admin.get(path + "/history").json()
    migrate(config, "downgrade", "0013")
    migrate(config, "upgrade", "head")
    endpoint = path + f"/attachments/{attachment['id']}"
    assert admin.get(endpoint).json() == attachment
    assert admin.get(endpoint + "/preview").content == content
    assert admin.get(path + "/history").json() == history
    renamed = admin.patch(endpoint, json={"version": 1, "filename": "Preserved rename.pdf"})
    assert renamed.status_code == 200, renamed.text
    retained = admin.get(path + "/history").json()
    response = migrate(config, "downgrade", "0013", check=False)
    assert response.returncode != 0
    assert "Back up and explicitly remove PDF renames" in response.stderr
    assert admin.get(endpoint).json() == renamed.json()
    assert admin.get(path + "/history").json() == retained
    assert admin.get(endpoint + "/download").content == content
