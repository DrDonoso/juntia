"""Store the images pasted into the Markdown of community actions, comments and events."""

import sqlalchemy as sa

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "community_images",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("scope", sa.String(10), nullable=False),
        sa.Column("storage_key", sa.String(36), nullable=False, unique=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("media_type", sa.String(20), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("purged_at", sa.DateTime(timezone=True)),
        sa.Column("author_user_id", sa.Integer()),
        sa.Column("author_kind", sa.String(20), nullable=False),
        sa.Column("author_name", sa.String(150), nullable=False),
        sa.CheckConstraint(
            "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
            "(author_kind = 'administrator' AND author_user_id IS NULL)",
            name="community_image_author",
        ),
        sa.CheckConstraint("scope IN ('actions', 'events')", name="community_image_scope"),
        sa.CheckConstraint(
            "media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')",
            name="community_image_media_type",
        ),
        sa.CheckConstraint("size > 0 AND size <= 10485760", name="community_image_size"),
        sa.CheckConstraint("width > 0 AND height > 0", name="community_image_dimensions"),
    )
    op.create_index(
        "ix_community_images_created", "community_images", ["created_at", "id"],
    )


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT id FROM community_images LIMIT 1")).first():
        raise RuntimeError(
            "Back up and explicitly remove community images and their files before downgrading"
        )
    op.drop_index("ix_community_images_created", table_name="community_images")
    op.drop_table("community_images")
