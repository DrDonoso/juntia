"""Persist community feature flags instead of reading them from the environment."""

import sqlalchemy as sa

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade():
    for name in ("feature_coefficient", "feature_actions"):
        op.add_column(
            "state", sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade():
    state = sa.table(
        "state",
        sa.column("feature_coefficient", sa.Boolean()),
        sa.column("feature_actions", sa.Boolean()),
    )
    disabled = op.get_bind().scalar(sa.select(sa.func.count()).select_from(state).where(
        sa.or_(state.c.feature_coefficient.is_(False), state.c.feature_actions.is_(False)),
    ))
    if disabled:
        raise RuntimeError("Enable both feature flags before downgrading")
    op.drop_column("state", "feature_actions")
    op.drop_column("state", "feature_coefficient")
