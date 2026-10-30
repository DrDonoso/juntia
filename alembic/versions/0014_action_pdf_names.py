"""Allow audited PDF renaming while preserving original upload identities."""

import sqlalchemy as sa

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

OLD_KINDS = (
    "'created', 'updated', 'comment_added', 'comment_edited', 'comment_withdrawn', "
    "'attachment_added', 'attachment_withdrawn'"
)


def upgrade():
    op.add_column("action_attachments", sa.Column("display_filename", sa.String(255)))
    with op.batch_alter_table("action_events") as batch:
        batch.drop_constraint("action_event_kind", type_="check")
        batch.create_check_constraint(
            "action_event_kind", f"kind IN ({OLD_KINDS}, 'attachment_renamed')",
        )


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text(
        "SELECT id FROM action_events WHERE kind = 'attachment_renamed' LIMIT 1"
    )).first() or connection.execute(sa.text(
        "SELECT id FROM action_attachments WHERE display_filename IS NOT NULL LIMIT 1"
    )).first():
        raise RuntimeError("Back up and explicitly remove PDF renames before downgrading")
    with op.batch_alter_table("action_events") as batch:
        batch.drop_constraint("action_event_kind", type_="check")
        batch.create_check_constraint("action_event_kind", f"kind IN ({OLD_KINDS})")
    with op.batch_alter_table("action_attachments") as batch:
        batch.drop_column("display_filename")
