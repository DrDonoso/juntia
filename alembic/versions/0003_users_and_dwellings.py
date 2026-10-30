"""Add invitation-only resident accounts without changing financial identities."""

import sqlalchemy as sa

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "dwellings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("label", sa.String(150), nullable=False, unique=True),
        sa.Column("coefficient", sa.Numeric(9, 6), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "coefficient >= 0 AND coefficient <= 100", name="dwelling_coefficient"
        ),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(254), nullable=False, unique=True),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("dwelling_id", sa.Integer(), sa.ForeignKey("dwellings.id"), nullable=False),
        sa.Column("password_hash", sa.String(100)),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("auth_version", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("invitation_delivery", sa.String(20), nullable=False),
        sa.Column("invitation_token_hash", sa.String(64)),
        sa.Column("invitation_expires_at", sa.DateTime(timezone=True)),
        sa.Column("invitation_sent_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_users_dwelling_id", "users", ["dwelling_id"])
    op.create_table(
        "user_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("auth_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_expires_at", "user_sessions", ["expires_at"])
    op.create_table(
        "user_tokens",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("purpose", sa.String(20), nullable=False),
        sa.Column("auth_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "purpose", name="one_user_token_per_purpose"),
        sa.CheckConstraint("purpose IN ('invitation', 'recovery')", name="user_token_purpose"),
    )
    op.create_index("ix_user_tokens_expires_at", "user_tokens", ["expires_at"])
    op.create_table(
        "auth_limits",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_auth_limits_expires_at", "auth_limits", ["expires_at"])


def downgrade():
    op.drop_table("auth_limits")
    op.drop_table("user_tokens")
    op.drop_table("user_sessions")
    op.drop_table("users")
    op.drop_table("dwellings")
