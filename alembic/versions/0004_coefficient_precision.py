"""Round existing dwelling coefficients and restrict storage to two decimal places."""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text(
        "UPDATE dwellings SET coefficient = ROUND(coefficient, 2), version = version + 1 "
        "WHERE coefficient <> ROUND(coefficient, 2)"
    ))
    with op.batch_alter_table("dwellings") as batch:
        batch.alter_column(
            "coefficient", existing_type=sa.Numeric(9, 6),
            type_=sa.Numeric(5, 2), existing_nullable=False,
        )


def downgrade():
    with op.batch_alter_table("dwellings") as batch:
        batch.alter_column(
            "coefficient", existing_type=sa.Numeric(5, 2),
            type_=sa.Numeric(9, 6), existing_nullable=False,
        )
