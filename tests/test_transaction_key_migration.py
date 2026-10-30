from sqlalchemy import select, text, update

from juntia.db import ImportRun, Transaction
from juntia.identity import PARSER_VERSION, transaction_key
from tests.support import statement_pdf
from tests.test_action_migration import migrate
from tests.test_api import commit, preview
from tests.test_users import database

KEEP_KEYS = ("-x", "keep_new_transaction_keys=true")


async def transactions(db):
    return (await db.scalars(select(Transaction).order_by(Transaction.id))).all()


async def revision(db):
    return await db.scalar(text("SELECT version_num FROM alembic_version"))


def expected_keys(transaction):
    values = (
        transaction.booking_date, transaction.value_date, transaction.description,
        transaction.amount, transaction.balance_after,
    )
    return transaction_key(*values), transaction_key(*values, include_balance=False)


def test_upgrade_rekeys_stored_transactions_so_imports_still_find_duplicates(admin, config):
    assert commit(admin, preview(admin)).status_code == 200
    identities = [item.identity_key for item in database(config, transactions)]

    async def outdated(db):
        await db.execute(update(Transaction).values(source_key="0" * 64, weak_key="1" * 64))
        await db.execute(update(ImportRun).values(parser_version="legacy-v0"))

    database(config, outdated)
    migrate(config, "downgrade", "0019", options=KEEP_KEYS)
    migrate(config, "upgrade", "head")
    rekeyed = database(config, transactions)
    assert [(item.source_key, item.weak_key) for item in rekeyed] == [
        expected_keys(item) for item in rekeyed
    ]
    assert [item.identity_key for item in rekeyed] == identities

    async def versions(db):
        return set((await db.scalars(select(ImportRun.parser_version))).all())

    assert database(config, versions) == {PARSER_VERSION}
    # The same file and a reprinted copy of the same statement are both recognized.
    for content in (statement_pdf(), statement_pdf(shifted=False)):
        again = preview(admin, content)
        assert [row["status"] for row in again["rows"]] == ["duplicate"] * 3


def test_downgrade_refuses_while_transactions_exist(admin, config):
    migrate(config, "downgrade", "0019")
    migrate(config, "upgrade", "head")
    assert commit(admin, preview(admin)).status_code == 200
    refused = migrate(config, "downgrade", "0019", check=False)
    assert refused.returncode != 0
    assert "Restore the backup taken before upgrading" in refused.stderr
    assert database(config, revision) == "0020"
    assert admin.get("/api/transactions").json()["total"] == 3
