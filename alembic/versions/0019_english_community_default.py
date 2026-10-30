"""Default the community name column to English, the default server language."""

import sqlalchemy as sa

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

# Only rows written without a name use this default: first-run seeding sets the name in
# APP_LANGUAGE, and existing names are never changed.
DEFAULT = "Residential community"
# The default set by migration 0002.
PREVIOUS_DEFAULT = "Comunidad de vecinos"


def set_default(value):
    with op.batch_alter_table("state") as batch:
        batch.alter_column(
            "community_name", existing_type=sa.String(150), existing_nullable=False,
            server_default=value,
        )


def upgrade():
    set_default(DEFAULT)


def downgrade():
    set_default(PREVIOUS_DEFAULT)
