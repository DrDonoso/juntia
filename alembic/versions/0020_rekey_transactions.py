"""Re-key stored transactions for the current statement reader version.

Transaction keys recognize statements that are imported again. They include the version of the
statement reader, which changed, so every stored transaction gets the keys the current version
computes. Identity keys are opaque, unique identifiers and stay as they are.
"""

import sqlalchemy as sa

from alembic import context, op
from juntia.identity import PARSER_VERSION, transaction_key

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

transactions = sa.table(
    "transactions",
    sa.column("id", sa.Integer()),
    sa.column("source_key", sa.String(64)),
    sa.column("weak_key", sa.String(64)),
    sa.column("booking_date", sa.Date()),
    sa.column("value_date", sa.Date()),
    sa.column("description", sa.Text()),
    sa.column("amount", sa.Numeric(14, 2)),
    sa.column("balance_after", sa.Numeric(14, 2)),
)
import_runs = sa.table("import_runs", sa.column("parser_version", sa.String(30)))
# `alembic -x keep_new_transaction_keys=true downgrade ...` downgrades even though earlier versions
# do not recognize the stored keys: only for a database that is upgraded again right away.
KEEP_KEYS = "keep_new_transaction_keys"


def upgrade():
    connection = op.get_bind()
    rows = connection.execute(sa.select(
        transactions.c.id, transactions.c.booking_date, transactions.c.value_date,
        transactions.c.description, transactions.c.amount, transactions.c.balance_after,
    )).all()
    keys = [
        {
            "row_id": row.id,
            "new_source_key": transaction_key(
                row.booking_date, row.value_date, row.description, row.amount, row.balance_after,
            ),
            "new_weak_key": transaction_key(
                row.booking_date, row.value_date, row.description, row.amount, row.balance_after,
                include_balance=False,
            ),
        }
        for row in rows
    ]
    if keys:
        connection.execute(
            transactions.update()
            .where(transactions.c.id == sa.bindparam("row_id"))
            .values(
                source_key=sa.bindparam("new_source_key"), weak_key=sa.bindparam("new_weak_key"),
            ),
            keys,
        )
    connection.execute(import_runs.update().values(parser_version=PARSER_VERSION))


def downgrade():
    if context.get_x_argument(as_dictionary=True).get(KEEP_KEYS) == "true":
        return
    if op.get_bind().execute(sa.select(transactions.c.id).limit(1)).first():
        raise RuntimeError(
            "Earlier versions do not recognize the stored transaction keys, so statements imported "
            "again would not be detected as duplicates. Restore the backup taken before upgrading "
            f"(or pass -x {KEEP_KEYS}=true only to upgrade again right away)."
        )
