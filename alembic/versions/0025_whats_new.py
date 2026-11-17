"""What's new: the notes each account has read (``users.whats_new_seen``).

NULL means the interface never recorded any, as for a new account: it then marks every current note
as read without showing them. Accounts that have signed in before get an empty list instead, so the
next time they open the portal they read the notes that come with this version."""

import sqlalchemy as sa

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade():
    # A nullable column without a default: SQLite adds it in place.
    op.add_column("users", sa.Column("whats_new_seen", sa.JSON(), nullable=True))
    users = sa.table(
        "users",
        sa.column("whats_new_seen", sa.JSON()),
        sa.column("last_login_at", sa.DateTime(timezone=True)),
    )
    op.execute(
        users.update().where(users.c.last_login_at.is_not(None)).values(whats_new_seen=[])
    )


def downgrade():
    # SQLite drops the column in place too (3.35+), keeping AUTOINCREMENT and its counter.
    op.drop_column("users", "whats_new_seen")
