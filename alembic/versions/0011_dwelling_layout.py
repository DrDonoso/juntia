"""Store the shared dwelling layout independently of financial revisions."""

import sqlalchemy as sa

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("state", sa.Column("dwelling_layout", sa.JSON(none_as_null=True)))
    op.add_column(
        "state",
        sa.Column("dwelling_layout_version", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    state = sa.table("state", sa.column("dwelling_layout", sa.JSON()))
    saved = op.get_bind().execute(sa.select(state.c.dwelling_layout)).scalars().all()
    if any(value is not None for value in saved):
        raise RuntimeError("Back up and explicitly remove the dwelling layout before downgrading")
    op.drop_column("state", "dwelling_layout_version")
    op.drop_column("state", "dwelling_layout")
