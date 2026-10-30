"""Prevent deleted resident IDs from being reused in SQLite previews."""

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    # PostgreSQL already allocates resident IDs through a sequence.
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(
            "users", recreate="always", table_kwargs={"sqlite_autoincrement": True}
        ):
            pass


def downgrade():
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(
            "users", recreate="always", table_kwargs={"sqlite_autoincrement": False}
        ):
            pass
