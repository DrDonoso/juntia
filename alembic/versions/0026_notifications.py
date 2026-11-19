"""Notifications: the alerts under the bell at the top of the portal (``notifications``), the
devices that receive them as push notifications (``push_subscriptions``), those waiting to reach
each device (``push_deliveries``) and the kinds each account turned off
(``users.notifications_muted``)."""

import sqlalchemy as sa

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", name="notification_user", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("link", sa.String(300), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True)),
        sa.Column("dismissed_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "key", name="one_notification_per_key"),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", name="push_subscription_user", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("session_hash", sa.String(64), nullable=False),
        sa.Column("endpoint", sa.String(2048), nullable=False, unique=True),
        sa.Column("p256dh", sa.String(100), nullable=False),
        sa.Column("auth", sa.String(40), nullable=False),
        sa.Column("origin", sa.String(255), nullable=False),
        sa.Column("locale", sa.String(2), nullable=False),
        sa.Column("failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("locale IN ('en', 'es')", name="push_subscription_locale"),
    )
    op.create_index("ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"])
    op.create_index("ix_push_subscriptions_session_hash", "push_subscriptions", ["session_hash"])
    op.create_table(
        "push_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "notification_id",
            sa.Integer(),
            sa.ForeignKey(
                "notifications.id", name="push_delivery_notification", ondelete="CASCADE"
            ),
            nullable=False,
        ),
        sa.Column(
            "subscription_id",
            sa.Integer(),
            sa.ForeignKey(
                "push_subscriptions.id", name="push_delivery_subscription", ondelete="CASCADE"
            ),
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("not_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("notification_id", "subscription_id", name="one_push_delivery"),
    )
    op.create_index("ix_push_deliveries_subscription_id", "push_deliveries", ["subscription_id"])
    op.create_index("ix_push_deliveries_not_before", "push_deliveries", ["not_before"])
    # A nullable column without a default: SQLite adds it in place. NULL: every kind is on.
    op.add_column("users", sa.Column("notifications_muted", sa.JSON(), nullable=True))


def downgrade():
    # SQLite drops the column in place too (3.35+), keeping AUTOINCREMENT and its counter.
    op.drop_column("users", "notifications_muted")
    op.drop_table("push_deliveries")
    op.drop_table("push_subscriptions")
    op.drop_table("notifications")
