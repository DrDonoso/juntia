"""Administrators are accounts: an administrator flag on users replaces the technical administrator.

Residents keep a dwelling; an administrator may have none. The technical administrator's sessions
go with its credentials (ADMIN_USERNAME and ADMIN_PASSWORD are no longer read), while what it wrote
keeps its fixed label. Upgrading makes nobody an administrator: the operator grants the role with
``python -m juntia.admins``. Only a new installation offers its first visitor to create the
administration account: seeding opens that, and an upgraded installation stays closed."""

from collections.abc import Iterator
from contextlib import contextmanager

import sqlalchemy as sa

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


@contextmanager
def keeping_sqlite_counter(table: str) -> Iterator[None]:
    """Keep the AUTOINCREMENT counter of a table SQLite rebuilds: the copy would restart it at
    its highest remaining id and hand the ids of deleted accounts out again."""
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        yield
        return
    query = "SELECT seq FROM sqlite_sequence WHERE name = :name"
    counter = bind.execute(sa.text(query), {"name": table}).scalar()
    yield
    if counter is not None:
        bind.execute(sa.text("DELETE FROM sqlite_sequence WHERE name = :name"), {"name": table})
        bind.execute(
            sa.text("INSERT INTO sqlite_sequence (name, seq) VALUES (:name, :seq)"),
            {"name": table, "seq": counter},
        )


def upgrade():
    # SQLite rebuilds the table to relax the column; reflection misses AUTOINCREMENT.
    with (
        keeping_sqlite_counter("users"),
        op.batch_alter_table("users", table_kwargs={"sqlite_autoincrement": True}) as batch,
    ):
        batch.add_column(sa.Column(
            "administrator", sa.Boolean(), nullable=False, server_default=sa.false(),
        ))
        batch.alter_column("dwelling_id", existing_type=sa.Integer(), nullable=True)
        batch.create_check_constraint("user_dwelling", "administrator OR dwelling_id IS NOT NULL")
    op.add_column(
        "state", sa.Column("setup_open", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.drop_table("sessions")


def downgrade():
    users = sa.table("users", sa.column("dwelling_id", sa.Integer()))
    if op.get_bind().scalar(
        sa.select(sa.func.count()).select_from(users).where(users.c.dwelling_id.is_(None))
    ):
        raise RuntimeError(
            "Assign a dwelling to every account, or delete the accounts without one, "
            "before downgrading"
        )
    # The technical administrator signs in again with ADMIN_USERNAME and ADMIN_PASSWORD.
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("credential_version", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    with op.batch_alter_table("state") as batch:
        batch.drop_column("setup_open")
    with (
        keeping_sqlite_counter("users"),
        op.batch_alter_table("users", table_kwargs={"sqlite_autoincrement": True}) as batch,
    ):
        batch.drop_constraint("user_dwelling", type_="check")
        batch.alter_column("dwelling_id", existing_type=sa.Integer(), nullable=False)
        batch.drop_column("administrator")
