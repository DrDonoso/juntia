"""Add shared contacts, colored tags and retained change history."""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "contacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("company", sa.String(150), nullable=False),
        sa.Column("email", sa.String(254)),
        sa.Column("phone", sa.String(16), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("version >= 1", name="contact_version"),
        sa.CheckConstraint("email IS NOT NULL OR phone <> ''", name="contact_channel"),
    )
    op.create_index("ix_contacts_deleted_at", "contacts", ["deleted_at"])
    op.create_table(
        "contact_tags",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("normalized_name", sa.String(300), nullable=False, unique=True),
        sa.Column("color", sa.String(7), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("version >= 1", name="contact_tag_version"),
    )
    op.create_table(
        "contact_tag_links",
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("contacts.id"), primary_key=True),
        sa.Column("tag_id", sa.Integer(), sa.ForeignKey("contact_tags.id"), primary_key=True),
    )
    op.create_index("ix_contact_tag_links_tag_id", "contact_tag_links", ["tag_id"])
    op.create_table(
        "contact_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("contacts.id")),
        sa.Column("tag_id", sa.Integer(), sa.ForeignKey("contact_tags.id")),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("author_user_id", sa.Integer()),
        sa.Column("author_kind", sa.String(20), nullable=False),
        sa.Column("author_name", sa.String(150), nullable=False),
        sa.Column("before", sa.JSON()),
        sa.Column("after", sa.JSON()),
        sa.CheckConstraint(
            "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
            "(author_kind = 'administrator' AND author_user_id IS NULL)",
            name="contact_event_author",
        ),
        sa.CheckConstraint(
            "(contact_id IS NOT NULL AND tag_id IS NULL) OR "
            "(contact_id IS NULL AND tag_id IS NOT NULL)", name="contact_event_target",
        ),
        sa.CheckConstraint("kind IN ('created', 'updated', 'deleted')", name="contact_event_kind"),
    )
    op.create_index("ix_contact_events_contact", "contact_events", ["contact_id", "id"])


def downgrade():
    connection = op.get_bind()
    for table in ("contacts", "contact_tags", "contact_events"):
        if connection.execute(sa.text(f"SELECT id FROM {table} LIMIT 1")).first():
            raise RuntimeError("Back up and explicitly remove contact history before downgrading")
    for table in ("contact_events", "contact_tag_links", "contact_tags", "contacts"):
        op.drop_table(table)
