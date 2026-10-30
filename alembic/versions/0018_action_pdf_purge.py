"""Let the administrator purge withdrawn action PDFs while keeping their rows and history."""

import sqlalchemy as sa

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

OLD_KINDS = (
    "'created', 'updated', 'comment_added', 'comment_edited', 'comment_withdrawn', "
    "'attachment_added', 'attachment_renamed', 'attachment_withdrawn'"
)


def upgrade():
    with op.batch_alter_table("action_attachments") as batch:
        batch.add_column(sa.Column("purged_at", sa.DateTime(timezone=True)))
        batch.create_check_constraint(
            "action_attachment_purge", "purged_at IS NULL OR withdrawn_at IS NOT NULL",
        )
    with op.batch_alter_table("action_events") as batch:
        batch.drop_constraint("action_event_kind", type_="check")
        batch.create_check_constraint(
            "action_event_kind", f"kind IN ({OLD_KINDS}, 'attachment_purged')",
        )


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text(
        "SELECT id FROM action_attachments WHERE purged_at IS NOT NULL LIMIT 1"
    )).first() or connection.execute(sa.text(
        "SELECT id FROM action_events WHERE kind = 'attachment_purged' LIMIT 1"
    )).first():
        raise RuntimeError("Back up and explicitly remove purged PDF records before downgrading")
    with op.batch_alter_table("action_events") as batch:
        batch.drop_constraint("action_event_kind", type_="check")
        batch.create_check_constraint("action_event_kind", f"kind IN ({OLD_KINDS})")
    with op.batch_alter_table("action_attachments") as batch:
        batch.drop_constraint("action_attachment_purge", type_="check")
        batch.drop_column("purged_at")
