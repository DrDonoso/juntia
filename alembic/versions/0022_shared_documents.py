"""Add shared documents: folders, files with versions, deletions, history and resumable uploads."""

import sqlalchemy as sa

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

TABLES = (
    "document_uploads", "document_events", "document_deletions", "document_versions",
    "documents", "document_folders",
)


def author_columns():
    return (
        sa.Column("author_user_id", sa.Integer()),
        sa.Column("author_kind", sa.String(20), nullable=False),
        sa.Column("author_name", sa.String(150), nullable=False),
    )


def author_constraint(name):
    return sa.CheckConstraint(
        "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
        "(author_kind = 'administrator' AND author_user_id IS NULL)", name=name,
    )


def one_target(name):
    return sa.CheckConstraint(
        "(folder_id IS NOT NULL AND document_id IS NULL) OR "
        "(folder_id IS NULL AND document_id IS NOT NULL)", name=name,
    )


def upgrade():
    with op.batch_alter_table("state") as batch:
        batch.add_column(sa.Column(
            "feature_documents", sa.Boolean(), nullable=False, server_default=sa.false(),
        ))
        batch.add_column(sa.Column(
            "documents_manage_policy", sa.String(20), nullable=False, server_default="creator",
        ))
    op.create_table(
        "document_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("document_folders.id")),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("name_key", sa.String(600), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("deletion_id", sa.String(36)),
        sa.Column("purged_at", sa.DateTime(timezone=True)),
        *author_columns(),
        author_constraint("document_folder_author"),
        sa.CheckConstraint("version >= 1", name="document_folder_version"),
        sa.CheckConstraint(
            "purged_at IS NULL OR deleted_at IS NOT NULL", name="document_folder_purge",
        ),
    )
    op.create_index(
        "ix_document_folders_parent", "document_folders", ["parent_id", "deleted_at"],
    )
    op.create_index("ix_document_folders_deletion", "document_folders", ["deletion_id"])
    op.create_table(
        "documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("document_folders.id")),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("name_key", sa.String(600), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("current_number", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("deletion_id", sa.String(36)),
        sa.Column("purged_at", sa.DateTime(timezone=True)),
        *author_columns(),
        author_constraint("document_author"),
        sa.CheckConstraint("version >= 1", name="document_version"),
        sa.CheckConstraint("current_number >= 1", name="document_current_number"),
        sa.CheckConstraint(
            "kind IN ('pdf', 'image', 'video', 'document', 'spreadsheet', 'presentation', "
            "'text')",
            name="document_kind",
        ),
        sa.CheckConstraint("purged_at IS NULL OR deleted_at IS NOT NULL", name="document_purge"),
    )
    op.create_index("ix_documents_folder", "documents", ["folder_id", "deleted_at"])
    op.create_index("ix_documents_deletion", "documents", ["deletion_id"])
    op.create_table(
        "document_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(36), nullable=False, unique=True),
        sa.Column("extension", sa.String(10), nullable=False),
        sa.Column("media_type", sa.String(100), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("purged_at", sa.DateTime(timezone=True)),
        *author_columns(),
        author_constraint("document_version_author"),
        sa.UniqueConstraint("document_id", "number", name="document_version_number"),
        sa.CheckConstraint("number >= 1", name="document_version_number_positive"),
        sa.CheckConstraint("size > 0", name="document_version_size"),
    )
    op.create_index(
        "ix_document_versions_author", "document_versions", ["author_kind", "author_user_id"],
    )
    op.create_table(
        "document_deletions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("document_folders.id")),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id")),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("location", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("restored_at", sa.DateTime(timezone=True)),
        sa.Column("purged_at", sa.DateTime(timezone=True)),
        *author_columns(),
        author_constraint("document_deletion_author"),
        one_target("document_deletion_target"),
        sa.CheckConstraint(
            "restored_at IS NULL OR purged_at IS NULL", name="document_deletion_outcome",
        ),
    )
    op.create_index(
        "ix_document_deletions_open", "document_deletions",
        ["restored_at", "purged_at", "created_at"],
    )
    op.create_table(
        "document_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("document_folders.id")),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id")),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        *author_columns(),
        author_constraint("document_event_author"),
        one_target("document_event_target"),
        sa.CheckConstraint(
            "kind IN ('created', 'version_added', 'renamed', 'moved', 'deleted', 'restored', "
            "'purged', 'version_purged')",
            name="document_event_kind",
        ),
    )
    op.create_index("ix_document_events_folder", "document_events", ["folder_id", "id"])
    op.create_index("ix_document_events_document", "document_events", ["document_id", "id"])
    op.create_table(
        "document_uploads",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("folder_id", sa.Integer(), sa.ForeignKey("document_folders.id")),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id")),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("extension", sa.String(10), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("received", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.String(36), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        *author_columns(),
        author_constraint("document_upload_author"),
        sa.CheckConstraint(
            "size > 0 AND received >= 0 AND received <= size", name="document_upload_progress",
        ),
    )
    op.create_index("ix_document_uploads_expiry", "document_uploads", ["expires_at"])
    op.create_index(
        "ix_document_uploads_author", "document_uploads",
        ["author_kind", "author_user_id", "updated_at"],
    )


def downgrade():
    connection = op.get_bind()
    for table in TABLES:
        if connection.execute(sa.text(f"SELECT id FROM {table} LIMIT 1")).first():
            raise RuntimeError(
                "Back up and explicitly remove shared documents, their history and their files "
                "before downgrading"
            )
    if connection.execute(sa.text("SELECT id FROM state WHERE feature_documents")).first():
        raise RuntimeError("Disable Documents before downgrading")
    for table in TABLES:
        op.drop_table(table)
    with op.batch_alter_table("state") as batch:
        batch.drop_column("documents_manage_policy")
        batch.drop_column("feature_documents")
