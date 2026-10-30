"""Persist administrator-selected action label colors and editing versions."""

import sqlalchemy as sa

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("action_labels") as batch:
        batch.add_column(sa.Column("color", sa.String(7), nullable=True))
        batch.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
        batch.create_check_constraint("action_label_version", "version >= 1")


def downgrade():
    if op.get_bind().execute(sa.text(
        "SELECT id FROM action_labels WHERE color IS NOT NULL OR version <> 1 LIMIT 1"
    )).first():
        raise RuntimeError("Back up and explicitly remove action label edits before downgrading")
    with op.batch_alter_table("action_labels") as batch:
        batch.drop_constraint("action_label_version", type_="check")
        batch.drop_column("version")
        batch.drop_column("color")
