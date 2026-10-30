"""Store a single community president independently of access permissions."""

import sqlalchemy as sa

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("state") as batch:
        batch.add_column(sa.Column("president_user_id", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("presidency_version", sa.Integer(), nullable=False, server_default="0")
        )
        batch.create_foreign_key(
            "state_president_user", "users", ["president_user_id"], ["id"], ondelete="SET NULL"
        )


def downgrade():
    state = sa.table("state", sa.column("president_user_id", sa.Integer()))
    if op.get_bind().scalar(sa.select(state.c.president_user_id)) is not None:
        raise RuntimeError("Explicitly clear the community presidency before downgrading")
    with op.batch_alter_table("state") as batch:
        batch.drop_constraint("state_president_user", type_="foreignkey")
        batch.drop_column("president_user_id")
        batch.drop_column("presidency_version")
