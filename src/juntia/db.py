from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
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


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (CheckConstraint("id = 1", name="single_account"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    iban: Mapped[str] = mapped_column(String(24), unique=True)
    name: Mapped[str] = mapped_column(String(150))


class Session(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    credential_version: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


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
    __table_args__ = {"sqlite_autoincrement": True}
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(150))
    phone: Mapped[str] = mapped_column(String(16), default="", server_default="")
    dwelling_id: Mapped[int] = mapped_column(ForeignKey("dwellings.id"), index=True)
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
    # Historical identity snapshots survive account deletion; resident IDs are never reused.
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


async def lock_state(db: AsyncSession) -> State:
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE; acquire its write lock before reading the revision.
        await db.execute(update(State).where(State.id == 1).values(revision=State.revision))
    state = await db.get(State, 1, with_for_update=True, populate_existing=True)
    if state is None:
        raise RuntimeError("Database is not initialized; run migrations and seed")
    return state
