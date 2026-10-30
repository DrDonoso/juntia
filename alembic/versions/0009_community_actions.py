"""Add collaborative community actions and retained activity history."""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def authorship(name):
    return (
        sa.Column("author_user_id", sa.Integer()),
        sa.Column("author_kind", sa.String(20), nullable=False),
        sa.Column("author_name", sa.String(150), nullable=False),
        sa.CheckConstraint(
            "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
            "(author_kind = 'administrator' AND author_user_id IS NULL)",
            name=name,
        ),
    )


def upgrade():
    op.create_table(
        "community_actions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        *authorship("community_action_author"),
        sa.CheckConstraint(
            "status IN ('detected', 'quoting', 'voting', 'approved', "
            "'ordered', 'in_progress', 'done', 'discarded')",
            name="community_action_status",
        ),
        sa.CheckConstraint("version >= 1", name="community_action_version"),
    )
    op.create_index(
        "ix_community_actions_status_activity", "community_actions", ["status", "updated_at", "id"]
    )
    op.create_index("ix_community_actions_activity", "community_actions", ["updated_at", "id"])
    op.create_table(
        "action_labels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("normalized_name", sa.String(300), nullable=False, unique=True),
    )
    op.create_table(
        "action_label_links",
        sa.Column(
            "action_id", sa.Integer(), sa.ForeignKey("community_actions.id"), primary_key=True
        ),
        sa.Column("label_id", sa.Integer(), sa.ForeignKey("action_labels.id"), primary_key=True),
    )
    op.create_index("ix_action_label_links_label_id", "action_label_links", ["label_id"])
    op.create_table(
        "action_comments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action_id", sa.Integer(), sa.ForeignKey("community_actions.id"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True)),
        *authorship("action_comment_author"),
        sa.CheckConstraint("version >= 1", name="action_comment_version"),
    )
    op.create_index("ix_action_comments_action", "action_comments", ["action_id", "id"])
    op.create_table(
        "action_attachments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("action_id", sa.Integer(), sa.ForeignKey("community_actions.id"), nullable=False),
        sa.Column("storage_key", sa.String(36), nullable=False, unique=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True)),
        *authorship("action_attachment_author"),
        sa.CheckConstraint("size > 0 AND size <= 20971520", name="action_attachment_size"),
        sa.CheckConstraint("version >= 1", name="action_attachment_version"),
    )
    op.create_index(
        "ix_action_attachments_action", "action_attachments", ["action_id", "withdrawn_at"]
    )
    op.create_table(
        "action_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action_id", sa.Integer(), sa.ForeignKey("community_actions.id"), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("comment_id", sa.Integer(), sa.ForeignKey("action_comments.id")),
        sa.Column("attachment_id", sa.String(36), sa.ForeignKey("action_attachments.id")),
        *authorship("action_event_author"),
        sa.CheckConstraint(
            "kind IN ('created', 'updated', 'comment_added', 'comment_edited', "
            "'comment_withdrawn', 'attachment_added', 'attachment_withdrawn')",
            name="action_event_kind",
        ),
    )
    op.create_index("ix_action_events_action", "action_events", ["action_id", "id"])


def downgrade():
    if op.get_bind().execute(sa.text("SELECT id FROM community_actions LIMIT 1")).first():
        raise RuntimeError("Back up and explicitly remove community actions before downgrading")
    for table in (
        "action_events", "action_attachments", "action_comments",
        "action_label_links", "action_labels", "community_actions",
    ):
        op.drop_table(table)
