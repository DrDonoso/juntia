"""Keep coefficients optional while the ownership-coefficient feature is disabled."""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("dwellings") as batch:
        batch.alter_column(
            "coefficient", existing_type=sa.Numeric(5, 2),
            existing_nullable=False, nullable=True,
        )


def downgrade():
    missing = op.get_bind().execute(
        sa.text("SELECT id FROM dwellings WHERE coefficient IS NULL LIMIT 1")
    ).first()
    if missing:
        raise RuntimeError("Assign missing dwelling coefficients before downgrading this migration")
    with op.batch_alter_table("dwellings") as batch:
        batch.alter_column(
            "coefficient", existing_type=sa.Numeric(5, 2),
            existing_nullable=True, nullable=False,
        )
