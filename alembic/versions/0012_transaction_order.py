"""Materialize canonical bank order without changing financial facts."""

import sqlalchemy as sa

from alembic import op
from juntia.bank_order import rebuild_bank_order

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "transaction_order",
        sa.Column(
            "transaction_id", sa.Integer(),
            sa.ForeignKey("transactions.id", ondelete="CASCADE"), primary_key=True,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("is_root", sa.Boolean(), nullable=False),
        sa.CheckConstraint("position >= 0", name="transaction_order_position"),
    )
    op.create_index("ix_transaction_order_position", "transaction_order", ["position"], unique=True)
    rebuild_bank_order(op.get_bind())


def downgrade():
    op.drop_table("transaction_order")
