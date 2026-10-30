"""Add the community's display name without changing bank-account identity."""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "state",
        sa.Column(
            "community_name", sa.String(150), nullable=False, server_default="Comunidad de vecinos"
        ),
    )


def downgrade():
    op.drop_column("state", "community_name")
