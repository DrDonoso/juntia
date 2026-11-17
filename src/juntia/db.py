from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    false,
    true,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .identity import PARSER_VERSION


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class Base(DeclarativeBase):
    pass


class State(Base):
    __tablename__ = "state"
    __table_args__ = (CheckConstraint("id = 1", name="single_state"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    revision: Mapped[int] = mapped_column(default=0)
    login_attempts: Mapped[list[str]] = mapped_column(JSON, default=list)
    # First-run seeding sets a name in APP_LANGUAGE; this server default (migration 0019) only
    # applies to rows written without a name.
    community_name: Mapped[str] = mapped_column(
        String(150), server_default="Residential community"
    )
    dwelling_layout: Mapped[dict[str, Any] | None] = mapped_column(JSON(none_as_null=True))
    dwelling_layout_version: Mapped[int] = mapped_column(default=0, server_default="0")
    president_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="state_president_user", ondelete="SET NULL")
    )
    presidency_version: Mapped[int] = mapped_column(default=0, server_default="0")
    feature_coefficient: Mapped[bool] = mapped_column(default=True, server_default=true())
    feature_actions: Mapped[bool] = mapped_column(default=True, server_default=true())
    feature_events: Mapped[bool] = mapped_column(default=False, server_default=false())
    feature_documents: Mapped[bool] = mapped_column(default=False, server_default=false())
    # Who may rename, move, replace and delete shared documents: "creator", "administrator" or
    # "everyone". Administrators always may.
    documents_manage_policy: Mapped[str] = mapped_column(
        String(20), default="creator", server_default="creator"
    )
    # Limits of shared documents in whole MiB, set by the administrator in Storage: the largest
    # file (videos excepted) and video, and the byte budgets per resident and for the community.
    documents_max_file_mb: Mapped[int] = mapped_column(default=50, server_default="50")
    documents_max_video_mb: Mapped[int] = mapped_column(default=1024, server_default="1024")
    documents_user_quota_mb: Mapped[int] = mapped_column(default=2048, server_default="2048")
    documents_community_quota_mb: Mapped[int] = mapped_column(
        default=20480, server_default="20480"
    )
    # First run: the login page offers to create the administration account while this is set
    # and no account exists. Only seeding a new installation sets it (migration 0024 leaves
    # upgraded ones closed), and creating that account clears it.
    setup_open: Mapped[bool] = mapped_column(default=False, server_default=false())


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (CheckConstraint("id = 1", name="single_account"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    iban: Mapped[str] = mapped_column(String(24), unique=True)
    name: Mapped[str] = mapped_column(String(150))


class Dwelling(Base):
    __tablename__ = "dwellings"
    __table_args__ = (
        CheckConstraint("coefficient >= 0 AND coefficient <= 100", name="dwelling_coefficient"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(150), unique=True)
    coefficient: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    version: Mapped[int] = mapped_column(default=1)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # Residents live in a dwelling; an administrator may have none.
        CheckConstraint("administrator OR dwelling_id IS NOT NULL", name="user_dwelling"),
        {"sqlite_autoincrement": True},
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(150))
    phone: Mapped[str] = mapped_column(String(16), default="", server_default="")
    dwelling_id: Mapped[int | None] = mapped_column(ForeignKey("dwellings.id"), index=True)
    # Administrators open the administration and may manage what others wrote.
    administrator: Mapped[bool] = mapped_column(default=False, server_default=false())
    password_hash: Mapped[str | None] = mapped_column(String(100))
    activated: Mapped[bool] = mapped_column(default=False, server_default=false())
    google_subject: Mapped[str | None] = mapped_column(String(255), unique=True)
    disabled: Mapped[bool] = mapped_column(default=False)
    auth_version: Mapped[int] = mapped_column(default=1)
    version: Mapped[int] = mapped_column(default=1)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invitation_delivery: Mapped[str] = mapped_column(String(20), default="none")
    invitation_token_hash: Mapped[str | None] = mapped_column(String(64))
    invitation_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invitation_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Ids of the "What's new" notes the account has read (see ``whats_new``); NULL until the
    # interface records them for the first time.
    whats_new_seen: Mapped[list[str] | None] = mapped_column(JSON(none_as_null=True))


class UserSession(Base):
    __tablename__ = "user_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    auth_version: Mapped[int] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class UserToken(Base):
    __tablename__ = "user_tokens"
    __table_args__ = (
        UniqueConstraint("user_id", "purpose", name="one_user_token_per_purpose"),
        CheckConstraint("purpose IN ('invitation', 'recovery')", name="user_token_purpose"),
    )
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    purpose: Mapped[str] = mapped_column(String(20))
    auth_version: Mapped[int] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class AuthLimit(Base):
    __tablename__ = "auth_limits"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    hits: Mapped[int] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class GoogleAuthFlow(Base):
    __tablename__ = "google_auth_flows"
    __table_args__ = (
        CheckConstraint("purpose IN ('login', 'invitation', 'link')", name="google_flow_purpose"),
    )
    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    browser_hash: Mapped[str] = mapped_column(String(64), index=True)
    origin: Mapped[str] = mapped_column(String(2048))
    return_path: Mapped[str] = mapped_column(String(2048))
    purpose: Mapped[str] = mapped_column(String(20))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    auth_version: Mapped[int | None] = mapped_column()
    invitation_hash: Mapped[str | None] = mapped_column(String(64))
    session_hash: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class CatalogItem(Base):
    __abstract__ = True
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    color: Mapped[str] = mapped_column(String(7), default="#21639f")


class Category(CatalogItem):
    __tablename__ = "categories"


class Tag(CatalogItem):
    __tablename__ = "tags"


class Rule(Base):
    __tablename__ = "rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)


class Preview(Base):
    __tablename__ = "previews"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, default=1)
    filename: Mapped[str] = mapped_column(String(255))
    file_hash: Mapped[str] = mapped_column(String(64))
    iban: Mapped[str] = mapped_column(String(24))
    account_confirmed: Mapped[bool] = mapped_column(default=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    committed_import_id: Mapped[str | None] = mapped_column(String(36))


class ImportRun(Base):
    __tablename__ = "import_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    file_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    closing_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    parser_version: Mapped[str] = mapped_column(String(30), default=PARSER_VERSION)
    inserted: Mapped[int] = mapped_column()
    duplicates: Mapped[int] = mapped_column()


class Transaction(Base):
    __tablename__ = "transactions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_key: Mapped[str] = mapped_column(String(64), index=True)
    weak_key: Mapped[str] = mapped_column(String(64), index=True)
    identity_key: Mapped[str] = mapped_column(String(64), unique=True)
    booking_date: Mapped[date] = mapped_column(Date, index=True)
    value_date: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    balance_after: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    merchant: Mapped[str] = mapped_column(String(200), default="")
    tags: Mapped[list[int]] = mapped_column(JSON, default=list)
    classification_source: Mapped[str] = mapped_column(String(20), default="manual")
    version: Mapped[int] = mapped_column(default=1)


class TransactionOrder(Base):
    __tablename__ = "transaction_order"
    __table_args__ = (
        Index("ix_transaction_order_position", "position", unique=True),
        CheckConstraint("position >= 0", name="transaction_order_position"),
    )
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"), primary_key=True,
    )
    position: Mapped[int] = mapped_column()
    is_root: Mapped[bool] = mapped_column()


class ImportRow(Base):
    __tablename__ = "import_rows"
    import_id: Mapped[str] = mapped_column(
        ForeignKey("import_runs.id", ondelete="CASCADE"), primary_key=True
    )
    ordinal: Mapped[int] = mapped_column(primary_key=True)
    page: Mapped[int] = mapped_column()
    source: Mapped[dict[str, Any]] = mapped_column(JSON)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)


class Authorship:
    # Historical identity snapshots survive account deletion; account IDs are never reused.
    # Every account writes as 'resident' with its user ID, administrators included; rows with
    # 'administrator' and no user ID were written by the technical administrator of releases
    # before accounts could administer, and keep showing its fixed label.
    author_user_id: Mapped[int | None] = mapped_column()
    author_kind: Mapped[str] = mapped_column(String(20))
    author_name: Mapped[str] = mapped_column(String(150))


def author_constraint(name: str) -> CheckConstraint:
    return CheckConstraint(
        "(author_kind = 'resident' AND author_user_id IS NOT NULL) OR "
        "(author_kind = 'administrator' AND author_user_id IS NULL)",
        name=name,
    )


class CommunityAction(Authorship, Base):
    __tablename__ = "community_actions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('detected', 'quoting', 'voting', 'approved', "
            "'ordered', 'in_progress', 'done', 'discarded')",
            name="community_action_status",
        ),
        CheckConstraint("version >= 1", name="community_action_version"),
        author_constraint("community_action_author"),
        Index("ix_community_actions_status_activity", "status", "updated_at", "id"),
        Index("ix_community_actions_activity", "updated_at", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="detected")
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CommunityEvent(Authorship, Base):
    __tablename__ = "community_events"
    __table_args__ = (
        author_constraint("community_event_author"),
        CheckConstraint("version >= 1", name="community_event_version"),
        CheckConstraint(
            "(all_day AND starts_on IS NOT NULL AND ends_on IS NOT NULL "
            "AND ends_on > starts_on AND starts_at IS NULL AND ends_at IS NULL) OR "
            "(NOT all_day AND starts_at IS NOT NULL AND ends_at IS NOT NULL "
            "AND ends_at > starts_at AND starts_on IS NULL AND ends_on IS NULL)",
            name="community_event_interval",
        ),
        Index("ix_community_events_schedule", "deleted_at", "starts_at", "starts_on", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    calendar_uid: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid4()))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    location: Mapped[str] = mapped_column(String(200), default="")
    all_day: Mapped[bool] = mapped_column(default=False)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    starts_on: Mapped[date | None] = mapped_column(Date)
    ends_on: Mapped[date | None] = mapped_column(Date)
    action_id: Mapped[int | None] = mapped_column(ForeignKey("community_actions.id"), index=True)
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CommunityEventHistory(Authorship, Base):
    __tablename__ = "community_event_history"
    __table_args__ = (
        author_constraint("community_event_history_author"),
        CheckConstraint("kind IN ('created', 'updated', 'deleted')", name="community_event_kind"),
        Index("ix_community_event_history_event", "event_id", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("community_events.id"))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class ActionLabel(Base):
    __tablename__ = "action_labels"
    __table_args__ = (CheckConstraint("version >= 1", name="action_label_version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    normalized_name: Mapped[str] = mapped_column(String(300), unique=True)
    color: Mapped[str | None] = mapped_column(String(7))
    version: Mapped[int] = mapped_column(default=1)


class ActionLabelLink(Base):
    __tablename__ = "action_label_links"
    action_id: Mapped[int] = mapped_column(ForeignKey("community_actions.id"), primary_key=True)
    label_id: Mapped[int] = mapped_column(
        ForeignKey("action_labels.id"), primary_key=True, index=True
    )


class ActionComment(Authorship, Base):
    __tablename__ = "action_comments"
    __table_args__ = (
        author_constraint("action_comment_author"),
        CheckConstraint("version >= 1", name="action_comment_version"),
        Index("ix_action_comments_action", "action_id", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    action_id: Mapped[int] = mapped_column(ForeignKey("community_actions.id"))
    body: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ActionAttachment(Authorship, Base):
    __tablename__ = "action_attachments"
    __table_args__ = (
        author_constraint("action_attachment_author"),
        CheckConstraint("size > 0 AND size <= 20971520", name="action_attachment_size"),
        CheckConstraint("version >= 1", name="action_attachment_version"),
        CheckConstraint(
            "purged_at IS NULL OR withdrawn_at IS NOT NULL", name="action_attachment_purge",
        ),
        Index("ix_action_attachments_action", "action_id", "withdrawn_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    action_id: Mapped[int] = mapped_column(ForeignKey("community_actions.id"))
    storage_key: Mapped[str] = mapped_column(String(36), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    display_filename: Mapped[str | None] = mapped_column(String(255))
    size: Mapped[int] = mapped_column()
    sha256: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The administrator deleted the withdrawn file; the row and its history remain.
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ActionEvent(Authorship, Base):
    __tablename__ = "action_events"
    __table_args__ = (
        author_constraint("action_event_author"),
        CheckConstraint(
            "kind IN ('created', 'updated', 'comment_added', 'comment_edited', "
            "'comment_withdrawn', 'attachment_added', 'attachment_renamed', "
            "'attachment_withdrawn', 'attachment_purged')",
            name="action_event_kind",
        ),
        Index("ix_action_events_action", "action_id", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    action_id: Mapped[int] = mapped_column(ForeignKey("community_actions.id"))
    kind: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    changes: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    comment_id: Mapped[int | None] = mapped_column(ForeignKey("action_comments.id"))
    attachment_id: Mapped[str | None] = mapped_column(ForeignKey("action_attachments.id"))


class CommunityImage(Authorship, Base):
    """An image pasted into the Markdown of an action, a comment or an event."""

    __tablename__ = "community_images"
    __table_args__ = (
        author_constraint("community_image_author"),
        CheckConstraint("scope IN ('actions', 'events')", name="community_image_scope"),
        CheckConstraint(
            "media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')",
            name="community_image_media_type",
        ),
        CheckConstraint("size > 0 AND size <= 10485760", name="community_image_size"),
        CheckConstraint("width > 0 AND height > 0", name="community_image_dimensions"),
        Index("ix_community_images_created", "created_at", "id"),
    )
    # The upload ID chosen by the browser, so a retried upload is answered from this row.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # The section whose API serves it: its session and feature switch apply.
    scope: Mapped[str] = mapped_column(String(10))
    storage_key: Mapped[str] = mapped_column(String(36), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    media_type: Mapped[str] = mapped_column(String(20))
    size: Mapped[int] = mapped_column()
    sha256: Mapped[str] = mapped_column(String(64))
    width: Mapped[int] = mapped_column()
    height: Mapped[int] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # The administrator deleted the file; the row remains, so its address answers 410.
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        CheckConstraint("version >= 1", name="contact_version"),
        CheckConstraint("email IS NOT NULL OR phone <> ''", name="contact_channel"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150))
    company: Mapped[str] = mapped_column(String(150), default="")
    email: Mapped[str | None] = mapped_column(String(254))
    phone: Mapped[str] = mapped_column(String(16), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class ContactTag(Base):
    __tablename__ = "contact_tags"
    __table_args__ = (CheckConstraint("version >= 1", name="contact_tag_version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    normalized_name: Mapped[str] = mapped_column(String(300), unique=True)
    color: Mapped[str] = mapped_column(String(7))
    version: Mapped[int] = mapped_column(default=1)


class ContactTagLink(Base):
    __tablename__ = "contact_tag_links"
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("contact_tags.id"), primary_key=True, index=True)


class ContactEvent(Authorship, Base):
    __tablename__ = "contact_events"
    __table_args__ = (
        author_constraint("contact_event_author"),
        CheckConstraint(
            "(contact_id IS NOT NULL AND tag_id IS NULL) OR "
            "(contact_id IS NULL AND tag_id IS NOT NULL)", name="contact_event_target",
        ),
        CheckConstraint("kind IN ('created', 'updated', 'deleted')", name="contact_event_kind"),
        Index("ix_contact_events_contact", "contact_id", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    contact_id: Mapped[int | None] = mapped_column(ForeignKey("contacts.id"))
    tag_id: Mapped[int | None] = mapped_column(ForeignKey("contact_tags.id"))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON)


def one_target(name: str) -> CheckConstraint:
    return CheckConstraint(
        "(folder_id IS NOT NULL AND document_id IS NULL) OR "
        "(folder_id IS NULL AND document_id IS NOT NULL)", name=name,
    )


class DocumentFolder(Authorship, Base):
    """A folder of the shared documents; the author is who created it."""

    __tablename__ = "document_folders"
    __table_args__ = (
        author_constraint("document_folder_author"),
        CheckConstraint("version >= 1", name="document_folder_version"),
        CheckConstraint(
            "purged_at IS NULL OR deleted_at IS NOT NULL", name="document_folder_purge",
        ),
        Index("ix_document_folders_parent", "parent_id", "deleted_at"),
        Index("ix_document_folders_deletion", "deletion_id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    # NULL: at the top level of Documents.
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("document_folders.id"))
    name: Mapped[str] = mapped_column(String(200))
    # Names are unique among the active items of a folder, ignoring case and Unicode forms.
    name_key: Mapped[str] = mapped_column(String(600))
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Deleted items are hidden from residents; the administrator can restore or purge them.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The DocumentDeletion that removed it, together with everything deleted at the same time.
    deletion_id: Mapped[str | None] = mapped_column(String(36))
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(Authorship, Base):
    """A shared file; the author uploaded its first version."""

    __tablename__ = "documents"
    __table_args__ = (
        author_constraint("document_author"),
        CheckConstraint("version >= 1", name="document_version"),
        CheckConstraint("current_number >= 1", name="document_current_number"),
        CheckConstraint(
            "kind IN ('pdf', 'image', 'video', 'document', 'spreadsheet', 'presentation', "
            "'text')",
            name="document_kind",
        ),
        CheckConstraint("purged_at IS NULL OR deleted_at IS NOT NULL", name="document_purge"),
        Index("ix_documents_folder", "folder_id", "deleted_at"),
        Index("ix_documents_deletion", "deletion_id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("document_folders.id"))
    name: Mapped[str] = mapped_column(String(200))
    name_key: Mapped[str] = mapped_column(String(600))
    kind: Mapped[str] = mapped_column(String(20))
    # The number of the DocumentVersion shown, downloaded and archived.
    current_number: Mapped[int] = mapped_column(default=1)
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deletion_id: Mapped[str | None] = mapped_column(String(36))
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentVersion(Authorship, Base):
    """One uploaded file of a document; earlier versions stay until the administrator purges."""

    __tablename__ = "document_versions"
    __table_args__ = (
        author_constraint("document_version_author"),
        UniqueConstraint("document_id", "number", name="document_version_number"),
        CheckConstraint("number >= 1", name="document_version_number_positive"),
        CheckConstraint("size > 0", name="document_version_size"),
        Index("ix_document_versions_author", "author_kind", "author_user_id"),
    )
    # The upload ID chosen by the browser, so a retried completion is answered from this row.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    number: Mapped[int] = mapped_column()
    storage_key: Mapped[str] = mapped_column(String(36), unique=True)
    extension: Mapped[str] = mapped_column(String(10))
    media_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentText(Base):
    """The text of a document's current version, which the search finds: read in the background
    from the file itself, with OCR for scanned pages and pictures (document_index.py). Videos and
    HEIC pictures have none. A purge or a newer version removes it."""

    __tablename__ = "document_texts"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'ready', 'failed')", name="document_text_status"),
        CheckConstraint("characters >= 0 AND ocr_pages >= 0", name="document_text_counts"),
        Index("ix_document_texts_queue", "status", "claimed_until"),
    )
    version_id: Mapped[str] = mapped_column(ForeignKey("document_versions.id"), primary_key=True)
    # pending: waiting to be read, or being read; ready: read; failed: could not be read.
    status: Mapped[str] = mapped_column(String(10), default="pending")
    # As read, on one line. Reading it again keeps the earlier text searchable until it ends.
    content: Mapped[str] = mapped_column(Text, default="")
    # The content without case and accents (fold_text), which the search compares.
    content_key: Mapped[str] = mapped_column(Text, default="")
    characters: Mapped[int] = mapped_column(default=0)
    # Pages (or the picture) read with OCR, and the Tesseract model APP_LANGUAGE chose for them.
    ocr_pages: Mapped[int] = mapped_column(default=0)
    ocr_language: Mapped[str | None] = mapped_column(String(10))
    # Scanned pages or a picture went unread because OCR was not available; read again once it is.
    needs_ocr: Mapped[bool] = mapped_column(default=False)
    # Only the beginning was read: the file exceeds the limits of what is read of each file.
    partial: Mapped[bool] = mapped_column(default=False)
    # Why the latest reading failed (encrypted, damaged, too_large, timeout, missing, failed).
    error: Mapped[str | None] = mapped_column(String(20))
    # The reader working on it, which renews its claim while it reads: an abandoned claim expires.
    claim_id: Mapped[str | None] = mapped_column(String(36))
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentDeletion(Authorship, Base):
    """One deletion: a file, or a folder with everything it held. The author deleted it."""

    __tablename__ = "document_deletions"
    __table_args__ = (
        author_constraint("document_deletion_author"),
        one_target("document_deletion_target"),
        CheckConstraint(
            "restored_at IS NULL OR purged_at IS NULL", name="document_deletion_outcome",
        ),
        Index("ix_document_deletions_open", "restored_at", "purged_at", "created_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("document_folders.id"))
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"))
    # Snapshots taken when it was deleted: its name and the names of the folders above it.
    name: Mapped[str] = mapped_column(String(200))
    location: Mapped[list[str]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    restored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentEvent(Authorship, Base):
    __tablename__ = "document_events"
    __table_args__ = (
        author_constraint("document_event_author"),
        one_target("document_event_target"),
        CheckConstraint(
            "kind IN ('created', 'version_added', 'renamed', 'moved', 'deleted', 'restored', "
            "'purged', 'version_purged')",
            name="document_event_kind",
        ),
        Index("ix_document_events_folder", "folder_id", "id"),
        Index("ix_document_events_document", "document_id", "id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("document_folders.id"))
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    details: Mapped[dict[str, Any]] = mapped_column(JSON)


class DocumentUpload(Authorship, Base):
    """A file being received in chunks; it becomes a DocumentVersion when completed."""

    __tablename__ = "document_uploads"
    __table_args__ = (
        author_constraint("document_upload_author"),
        CheckConstraint(
            "size > 0 AND received >= 0 AND received <= size", name="document_upload_progress",
        ),
        Index("ix_document_uploads_expiry", "expires_at"),
        Index("ix_document_uploads_author", "author_kind", "author_user_id", "updated_at"),
    )
    # The upload ID chosen by the browser.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # A new document in this folder (NULL: the top level), or a new version of document_id.
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("document_folders.id"))
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"))
    name: Mapped[str] = mapped_column(String(200))
    extension: Mapped[str] = mapped_column(String(10))
    size: Mapped[int] = mapped_column(BigInteger)
    received: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_key: Mapped[str] = mapped_column(String(36), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


async def lock_state(db: AsyncSession) -> State:
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE; acquire its write lock before reading the revision.
        await db.execute(update(State).where(State.id == 1).values(revision=State.revision))
    state = await db.get(State, 1, with_for_update=True, populate_existing=True)
    if state is None:
        raise RuntimeError("Database is not initialized; run migrations and seed")
    return state
