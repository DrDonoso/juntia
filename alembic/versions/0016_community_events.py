"""Add community events, retained history and an opt-in runtime flag."""

import sqlalchemy as sa

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def author_columns():
    return (
        sa.Column("author_user_id", sa.Integer()),
        sa.Column("author_kind", sa.String(20), nullable=False),
        sa.Column("author_name", sa.String(150), nullable=False),
    )


def author_constraint(name):
    return sa.CheckConstraint(
        "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
        "(author_kind = 'administrator' AND author_user_id IS NULL)", name=name,
    )


def upgrade():
    op.add_column(
        "state", sa.Column("feature_events", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "community_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("calendar_uid", sa.String(36), nullable=False, unique=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("location", sa.String(200), nullable=False),
        sa.Column("all_day", sa.Boolean(), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True)),
        sa.Column("ends_at", sa.DateTime(timezone=True)),
        sa.Column("starts_on", sa.Date()),
        sa.Column("ends_on", sa.Date()),
        sa.Column("action_id", sa.Integer(), sa.ForeignKey("community_actions.id")),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        *author_columns(),
        author_constraint("community_event_author"),
        sa.CheckConstraint("version >= 1", name="community_event_version"),
        sa.CheckConstraint(
            "(all_day AND starts_on IS NOT NULL AND ends_on IS NOT NULL "
            "AND ends_on > starts_on AND starts_at IS NULL AND ends_at IS NULL) OR "
            "(NOT all_day AND starts_at IS NOT NULL AND ends_at IS NOT NULL "
            "AND ends_at > starts_at AND starts_on IS NULL AND ends_on IS NULL)",
            name="community_event_interval",
        ),
    )
    op.create_index(
        "ix_community_events_schedule", "community_events",
        ["deleted_at", "starts_at", "starts_on", "id"],
    )
    op.create_index("ix_community_events_action_id", "community_events", ["action_id"])
    op.create_table(
        "community_event_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("community_events.id"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *author_columns(),
        sa.Column("before", sa.JSON()),
        sa.Column("after", sa.JSON()),
        author_constraint("community_event_history_author"),
        sa.CheckConstraint("kind IN ('created', 'updated', 'deleted')", name="community_event_kind"),
    )
    op.create_index(
        "ix_community_event_history_event", "community_event_history", ["event_id", "id"],
    )


def downgrade():
    connection = op.get_bind()
    for table in ("community_events", "community_event_history"):
        if connection.execute(sa.text(f"SELECT id FROM {table} LIMIT 1")).first():
            raise RuntimeError("Back up and explicitly remove event history before downgrading")
    if connection.execute(sa.text("SELECT id FROM state WHERE feature_events")).first():
        raise RuntimeError("Disable Events before downgrading")
    op.drop_table("community_event_history")
    op.drop_table("community_events")
    op.drop_column("state", "feature_events")
