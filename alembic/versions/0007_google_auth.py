"""Separate invitation activation from password storage and add Google identities."""

import sqlalchemy as sa

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("activated", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("google_subject", sa.String(255), nullable=True))
        batch.create_unique_constraint("uq_users_google_subject", ["google_subject"])
    op.execute("UPDATE users SET activated = true WHERE password_hash IS NOT NULL")
    op.create_table(
        "google_auth_flows",
        sa.Column("state_hash", sa.String(64), primary_key=True),
        sa.Column("browser_hash", sa.String(64), nullable=False),
        sa.Column("origin", sa.String(2048), nullable=False),
        sa.Column("return_path", sa.String(2048), nullable=False),
        sa.Column("purpose", sa.String(20), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("auth_version", sa.Integer()),
        sa.Column("invitation_hash", sa.String(64)),
        sa.Column("session_hash", sa.String(64)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("purpose IN ('login', 'invitation', 'link')", name="google_flow_purpose"),
    )
    for column in ("browser_hash", "user_id", "expires_at"):
        op.create_index(f"ix_google_auth_flows_{column}", "google_auth_flows", [column])


def downgrade():
    if op.get_bind().execute(sa.text(
        "SELECT id FROM users WHERE google_subject IS NOT NULL LIMIT 1"
    )).first():
        raise RuntimeError("Unlink Google accounts with a local password before downgrading")
    op.drop_table("google_auth_flows")
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("uq_users_google_subject", type_="unique")
        batch.drop_column("google_subject")
        batch.drop_column("activated")
