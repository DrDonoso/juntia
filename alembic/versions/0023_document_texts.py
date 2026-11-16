"""Add the text of shared documents, read in the background for the search, with OCR."""

import sqlalchemy as sa

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade():
    # Starting the application queues the current version of every readable document.
    op.create_table(
        "document_texts",
        sa.Column(
            "version_id", sa.String(36), sa.ForeignKey("document_versions.id"), primary_key=True,
        ),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_key", sa.Text(), nullable=False),
        sa.Column("characters", sa.Integer(), nullable=False),
        sa.Column("ocr_pages", sa.Integer(), nullable=False),
        sa.Column("ocr_language", sa.String(10)),
        sa.Column("needs_ocr", sa.Boolean(), nullable=False),
        sa.Column("partial", sa.Boolean(), nullable=False),
        sa.Column("error", sa.String(20)),
        sa.Column("claim_id", sa.String(36)),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.Column("claimed_until", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('pending', 'ready', 'failed')", name="document_text_status",
        ),
        sa.CheckConstraint(
            "characters >= 0 AND ocr_pages >= 0", name="document_text_counts",
        ),
    )
    op.create_index("ix_document_texts_queue", "document_texts", ["status", "claimed_until"])


def downgrade():
    # Only derived data: the next start of a later version reads the files again.
    op.drop_table("document_texts")
