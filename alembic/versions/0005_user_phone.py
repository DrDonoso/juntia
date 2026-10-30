"""Add contact phones without inventing numbers for existing residents."""

import sqlalchemy as sa

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users", sa.Column("phone", sa.String(16), nullable=False, server_default="")
    )


def downgrade():
    with op.batch_alter_table("users") as batch:
        batch.drop_column("phone")
