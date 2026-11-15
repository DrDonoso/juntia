import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    NaiveDatetime,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


def reader_route(path: str) -> bool:
    return path in {
        "/", "/transactions", "/neighbors", "/profile", "/actions", "/contacts", "/events",
        "/documents",
    } or bool(
        re.fullmatch(r"/(?:actions|events|documents/folders)/[1-9][0-9]{0,9}", path)
    )


def display_name(value: str) -> str:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("Name must contain visible characters")
    value = " ".join(value.split())
    if not value:
        raise ValueError("Name cannot be blank")
    return value


def tag_name_key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def contact_phone(value: str) -> str:
    if not value.strip():
        return ""
    normalized = re.sub(r"[\s().-]", "", value)
    if not re.fullmatch(r"\+?[0-9]{7,15}", normalized):
        raise ValueError("Phone must contain 7-15 digits and an optional international prefix")
    return normalized


class DwellingIn(Contract):
    label: str = Field(min_length=1, max_length=150)
    coefficient: Decimal | None = Field(
        default=None, ge=0, le=100, max_digits=5, decimal_places=2, allow_inf_nan=False
    )
    _label = field_validator("label")(display_name)

    @field_validator("coefficient")
    @classmethod
    def coefficient_precision(cls, value: Decimal | None) -> Decimal | None:
        return value.quantize(Decimal("0.01")) if value is not None else None


class DwellingEdit(DwellingIn):
    version: int = Field(ge=1)


class DwellingOut(DwellingIn):
    id: int
    version: int
    user_count: int


class DwellingLayoutLimits(Contract):
    zones: Literal[50] = 50
    rows: Literal[100] = 100
    columns: Literal[24] = 24
    cells: Literal[10000] = 10000


LAYOUT_LIMITS = DwellingLayoutLimits()
LayoutId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
LayoutCell = Annotated[int, Field(strict=True, ge=1, le=2147483647)] | None


class DwellingLayoutRow(Contract):
    id: LayoutId
    name: str = Field(max_length=150)
    cells: list[LayoutCell] = Field(min_length=1, max_length=LAYOUT_LIMITS.columns)

    @field_validator("name")
    @classmethod
    def optional_name(cls, value: str) -> str:
        return display_name(value) if value else ""


class DwellingLayoutZone(Contract):
    id: LayoutId
    name: str = Field(min_length=1, max_length=150)
    columns: int = Field(strict=True, ge=1, le=LAYOUT_LIMITS.columns)
    rows: list[DwellingLayoutRow] = Field(min_length=1, max_length=LAYOUT_LIMITS.rows)
    _name = field_validator("name")(display_name)

    @model_validator(mode="after")
    def rectangular(self) -> "DwellingLayoutZone":
        if any(len(row.cells) != self.columns for row in self.rows):
            raise ValueError("Every row must match the zone's column count")
        return self


class DwellingLayout(Contract):
    zones: list[DwellingLayoutZone] = Field(max_length=LAYOUT_LIMITS.zones)
    show_row_names: bool = Field(default=False, strict=True)
    show_column_names: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def unique_positions(self) -> "DwellingLayout":
        zones = [zone.id for zone in self.zones]
        rows = [row.id for zone in self.zones for row in zone.rows]
        cells = [cell for zone in self.zones for row in zone.rows for cell in row.cells]
        dwellings = [cell for cell in cells if cell is not None]
        if len(cells) > LAYOUT_LIMITS.cells:
            raise ValueError("Layout exceeds the total cell limit")
        for ids in (zones, rows, dwellings):
            if len(ids) != len(set(ids)):
                raise ValueError("Zone, row and dwelling IDs must be unique")
        return self


class DwellingLayoutIn(Contract):
    version: int = Field(strict=True, ge=0, le=2147483646)
    layout: DwellingLayout


class DwellingLayoutOut(Contract):
    version: int
    layout: DwellingLayout | None
    limits: DwellingLayoutLimits = Field(default_factory=DwellingLayoutLimits)


class EmailIn(Contract):
    email: EmailStr = Field(max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.lower()


class UserIn(EmailIn):
    name: str = Field(min_length=1, max_length=150)
    phone: str = Field(default="", max_length=30)
    dwelling_id: int = Field(ge=1)
    _name = field_validator("name")(display_name)
    _phone = field_validator("phone")(contact_phone)


class UserEdit(UserIn):
    version: int = Field(ge=1)


class UserDeleteIn(EmailIn):
    version: int = Field(ge=1)


class UserStatusIn(Contract):
    disabled: bool
    version: int = Field(ge=1)


class UserOut(UserIn):
    id: int
    version: int
    status: Literal["pending", "active", "disabled"]
    dwelling_label: str
    coefficient: Decimal | None
    last_login_at: datetime | None
    invitation_status: Literal["none", "sending", "sent", "failed", "expired"]
    invitation_expires_at: datetime | None
    invitation_sent_at: datetime | None
    has_password: bool
    google_linked: bool


class UserLoginIn(EmailIn):
    password: str = Field(max_length=1000)


class UserAuthOut(Contract):
    authenticated: bool
    kind: Literal["resident", "administrator"] | None = None
    name: str | None = None
    email: str | None = None
    user_id: int | None = None
    dwelling_id: int | None = None
    expires_at: datetime | None = None


class NewPasswordIn(Contract):
    password: str = Field(min_length=10, max_length=72)

    @field_validator("password")
    @classmethod
    def password_policy(cls, value: str) -> str:
        if not value.strip() or len(value.encode("utf-8")) > 72:
            raise ValueError("Password must not be blank or exceed 72 UTF-8 bytes")
        return value


class SetPasswordIn(NewPasswordIn):
    token: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")


class CurrentPasswordIn(Contract):
    current_password: str = Field(min_length=1, max_length=1000)


class ChangePasswordIn(NewPasswordIn, CurrentPasswordIn):
    pass


class GoogleStartIn(Contract):
    invitation_token: str | None = Field(
        default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]+$"
    )
    return_path: str = Field(default="/", max_length=2048)

    @field_validator("return_path")
    @classmethod
    def safe_return(cls, value: str) -> str:
        if (
            not value.startswith("/") or value.startswith("//") or "\\" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError("Expected an internal reader route")
        parts = urlsplit(value)
        if parts.scheme or parts.netloc or parts.fragment or not reader_route(parts.path):
            raise ValueError("Expected an internal reader route")
        return value


class GoogleStartOut(Contract):
    authorization_url: str


class ProfileEdit(Contract):
    name: str = Field(min_length=1, max_length=150)
    phone: str = Field(default="", max_length=30)
    version: int = Field(ge=1)
    _name = field_validator("name")(display_name)
    _phone = field_validator("phone")(contact_phone)


class ProfileOut(UserIn):
    id: int
    version: int
    dwelling_label: str
    coefficient: Decimal | None
    last_login_at: datetime | None
    has_password: bool
    google_linked: bool


class NeighborOut(Contract):
    id: int
    name: str
    email: str
    phone: str
    is_president: bool


class DwellingNeighborsOut(Contract):
    id: int
    label: str
    neighbors: list[NeighborOut]


class PresidencyIn(Contract):
    user_id: Annotated[int, Field(strict=True, ge=1, le=2147483647)] | None
    version: int = Field(strict=True, ge=0, le=2147483646)


class PresidentOut(Contract):
    id: int
    name: str
    dwelling_id: int
    dwelling_label: str


class PresidencyOut(Contract):
    president: PresidentOut | None
    version: int


class RecoveryOut(Contract):
    accepted: bool = True


class FeatureFlags(Contract):
    coefficient: bool
    actions: bool
    events: bool
    documents: bool


class FeatureFlagsOut(FeatureFlags):
    google_login: bool


class FeatureFlagIn(Contract):
    enabled: bool = Field(strict=True)


ActionStatus = Literal[
    "detected", "quoting", "voting", "approved", "ordered", "in_progress", "done", "discarded"
]
ACTION_STATUSES: tuple[ActionStatus, ...] = (
    "detected", "quoting", "voting", "approved", "ordered", "in_progress", "done", "discarded",
)
ActionEventKind = Literal[
    "created", "updated", "comment_added", "comment_edited", "comment_withdrawn",
    "attachment_added", "attachment_renamed", "attachment_withdrawn", "attachment_purged",
]


def action_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if any((ord(char) < 32 and char not in "\n\t") or ord(char) == 127 for char in value):
        raise ValueError("Text contains unsupported control characters")
    return value


def action_labels(values: list[str]) -> list[str]:
    labels: dict[str, str] = {}
    for value in values:
        name = display_name(unicodedata.normalize("NFKC", value))
        if len(name) > 100:
            raise ValueError("Label names must not exceed 100 characters")
        labels.setdefault(name.casefold(), name)
    return [labels[key] for key in sorted(labels)]


class ActorOut(Contract):
    kind: Literal["resident", "administrator"]
    user_id: int | None
    name: str


class ActionActorOut(ActorOut):
    pass


class EventConfigOut(Contract):
    timezone: str


class EventIn(Contract):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    location: str = Field(default="", max_length=200)
    timezone: str = Field(min_length=1, max_length=100)
    all_day: bool = Field(strict=True)
    starts_at: NaiveDatetime | None = None
    ends_at: NaiveDatetime | None = None
    starts_on: date | None = None
    ends_on: date | None = None
    action_id: int | None = Field(default=None, ge=1, le=2147483647)
    _title = field_validator("title")(display_name)
    _description = field_validator("description")(action_text)

    @field_validator("location")
    @classmethod
    def valid_location(cls, value: str) -> str:
        return display_name(value) if value.strip() else ""

    @model_validator(mode="after")
    def valid_interval(self) -> "EventIn":
        if self.all_day:
            valid = (
                self.starts_on is not None and self.ends_on is not None
                and self.ends_on > self.starts_on
                and self.starts_at is None and self.ends_at is None
            )
        else:
            valid = (
                self.starts_at is not None and self.ends_at is not None
                and self.ends_at > self.starts_at
                and self.starts_on is None and self.ends_on is None
            )
        if not valid:
            raise PydanticCustomError("event_interval_invalid", "Supply a valid event interval")
        return self


class EventEdit(EventIn):
    version: int = Field(ge=1)


class EventActionOut(Contract):
    id: int
    title: str


class EventSnapshot(Contract):
    title: str
    description: str
    location: str
    all_day: bool
    starts_at: datetime | None
    ends_at: datetime | None
    starts_on: date | None
    ends_on: date | None
    action: EventActionOut | None


class EventOut(EventSnapshot):
    id: int
    version: int
    author: ActorOut
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class EventPage(Contract):
    items: list[EventOut]
    total: int
    page: int
    pages: int


class EventOccurrenceOut(Contract):
    day: date
    is_continuation: bool
    is_last_day: bool
    is_past: bool
    event: EventOut


class EventAgendaPage(Contract):
    items: list[EventOccurrenceOut]
    total: int
    page: int
    pages: int


class EventHistoryOut(Contract):
    id: int
    kind: Literal["created", "updated", "deleted"]
    author: ActorOut
    created_at: datetime
    before: EventSnapshot | None
    after: EventSnapshot | None


class EventHistoryPage(Contract):
    items: list[EventHistoryOut]
    total: int
    page: int
    pages: int


class EventCalendarOut(Contract):
    google_url: str | None
    google_error: Literal["event_calendar_too_long"] | None


class ActionLabelOut(Contract):
    id: int
    name: str
    color: str | None
    version: int


class ActionIn(Contract):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    labels: list[str] = Field(default_factory=list, max_length=20)
    status: ActionStatus = "detected"
    _title = field_validator("title")(display_name)
    _description = field_validator("description")(action_text)
    _labels = field_validator("labels")(action_labels)


class ActionEdit(Contract):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    labels: list[str] | None = Field(default=None, max_length=20)
    status: ActionStatus | None = None

    @model_validator(mode="after")
    def validate_edit(self) -> "ActionEdit":
        fields = self.model_fields_set - {"version"}
        if not fields or any(getattr(self, field) is None for field in fields):
            raise ValueError("Supply at least one non-null field to edit")
        if self.title is not None:
            self.title = display_name(self.title)
        if self.description is not None:
            self.description = action_text(self.description)
        if self.labels is not None:
            self.labels = action_labels(self.labels)
        return self


class ActionSummaryOut(Contract):
    id: int
    title: str
    status: ActionStatus
    labels: list[ActionLabelOut]
    author: ActionActorOut
    version: int
    created_at: datetime
    updated_at: datetime
    comment_count: int
    attachment_count: int


class ActionOut(ActionSummaryOut):
    description: str


class ActionPagination(Contract):
    total: int
    page: int
    pages: int


class ActionPage(ActionPagination):
    items: list[ActionSummaryOut]


class ActionColumnOut(ActionPage):
    status: ActionStatus


class ActionBoardOut(Contract):
    columns: list[ActionColumnOut]


class ActionLabelPage(ActionPagination):
    items: list[ActionLabelOut]


class ActionCommentIn(Contract):
    body: str = Field(min_length=1, max_length=10000)

    @field_validator("body")
    @classmethod
    def content(cls, value: str) -> str:
        value = action_text(value)
        if not value:
            raise ValueError("Comment cannot be blank")
        return value


class ActionCommentEdit(ActionCommentIn):
    version: int = Field(ge=1)


class ActionCommentOut(Contract):
    id: int
    body: str | None
    author: ActionActorOut
    version: int
    created_at: datetime
    updated_at: datetime
    withdrawn_at: datetime | None


class ActionCommentPage(ActionPagination):
    items: list[ActionCommentOut]


class ActionAttachmentOut(Contract):
    id: str
    filename: str
    size: int
    sha256: str
    author: ActionActorOut
    version: int
    created_at: datetime
    withdrawn_at: datetime | None
    # Set when the administrator deleted the withdrawn file; downloads then answer 410.
    purged_at: datetime | None


class ActionAttachmentEdit(Contract):
    version: int = Field(ge=1)
    filename: str = Field(min_length=1, max_length=255)

    @field_validator("filename")
    @classmethod
    def pdf_filename(cls, value: str) -> str:
        if any(
            char in "/\\" or unicodedata.category(char) in {"Cc", "Cf"} for char in value
        ):
            raise ValueError("PDF names cannot contain paths or control characters")
        value = value.strip()
        stem = value[:-4].strip() if value.lower().endswith(".pdf") else value
        if not stem.strip(" .") or len(stem) > 251:
            raise ValueError("Supply a visible PDF name of at most 251 characters")
        return stem + ".pdf"


class ActionAttachmentPage(ActionPagination):
    items: list[ActionAttachmentOut]


class StoredAttachmentOut(ActionAttachmentOut):
    action_id: int
    action_title: str


class StoredAttachmentPage(ActionPagination):
    items: list[StoredAttachmentOut]


ImageMediaType = Literal["image/png", "image/jpeg", "image/gif", "image/webp"]


class CommunityImageOut(Contract):
    id: str
    # Relative address that serves the image; Markdown texts embed it.
    url: str
    filename: str
    media_type: ImageMediaType
    size: int
    width: int
    height: int
    created_at: datetime


class StoredImageOut(CommunityImageOut):
    scope: Literal["actions", "events"]
    sha256: str
    author: ActionActorOut
    # Set when the administrator deleted the file; its address then answers 410.
    purged_at: datetime | None


class StoredImagePage(ActionPagination):
    items: list[StoredImageOut]


class StorageUsageOut(Contract):
    # Files still on disk until the administrator purges them. stored = active PDFs + withdrawn
    # PDFs + images; the byte quotas count every stored byte.
    stored_bytes: int
    active_bytes: int
    withdrawn_bytes: int
    active_files: int
    withdrawn_files: int
    image_bytes: int
    image_files: int


class CommunityStorageOut(StorageUsageOut):
    quota_bytes: int


class ResidentStorageOut(StorageUsageOut):
    user_id: int
    name: str
    account_deleted: bool
    quota_bytes: int


class DiskSpaceOut(Contract):
    # Null when the upload volume could not be inspected.
    total_bytes: int | None
    free_bytes: int | None
    reserve_bytes: int


class DocumentResidentStorageOut(Contract):
    user_id: int
    name: str
    account_deleted: bool
    # Every stored version this resident uploaded, current, earlier or deleted.
    stored_bytes: int
    versions: int


class DocumentStorageOut(Contract):
    """Shared documents, which have their own byte budgets."""

    quota_bytes: int
    resident_quota_bytes: int
    # stored = current + previous + deleted: every version until the administrator purges it.
    stored_bytes: int
    current_bytes: int
    previous_bytes: int
    deleted_bytes: int
    files: int
    previous_versions: int
    deleted_files: int
    administrator_bytes: int
    # Uploads still being received; they are discarded a day after their last chunk.
    upload_bytes: int
    uploads: int
    residents: list[DocumentResidentStorageOut]


class StorageOut(Contract):
    community: CommunityStorageOut
    administrator: StorageUsageOut
    residents: list[ResidentStorageOut]
    resident_quota_bytes: int
    disk: DiskSpaceOut
    documents: DocumentStorageOut


class ActionChange(Contract):
    field: Literal[
        "title", "description", "status", "labels", "label_color", "comment", "filename", "size",
        "sha256",
    ]
    before: str | list[str] | None
    after: str | list[str] | None


class ActionEventOut(Contract):
    id: int
    kind: ActionEventKind
    author: ActionActorOut
    created_at: datetime
    changes: list[ActionChange]
    comment_id: int | None
    attachment_id: str | None


class ActionHistoryPage(ActionPagination):
    items: list[ActionEventOut]


class TagIn(Contract):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#21639f", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        name = display_name(unicodedata.normalize("NFKC", value))
        if len(name) > 100:
            raise ValueError("Label names must not exceed 100 characters")
        return name

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str) -> str:
        return value.lower()


class ActionLabelEdit(TagIn):
    version: int = Field(ge=1)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class ContactTagIn(TagIn):
    pass


class ContactTagEdit(ContactTagIn):
    version: int = Field(ge=1)


class ContactTagOut(ContactTagIn):
    id: int
    version: int


class ContactTagPage(Contract):
    items: list[ContactTagOut]
    total: int
    page: int
    pages: int


class ContactIn(Contract):
    name: str = Field(min_length=1, max_length=150)
    company: str = Field(default="", max_length=150)
    email: EmailStr | None = Field(default=None, max_length=254)
    phone: str = Field(default="", max_length=30)
    notes: str = Field(default="", max_length=20000)
    tags: list[int] = Field(default_factory=list, max_length=30)
    new_tags: list[ContactTagIn] = Field(default_factory=list, max_length=30)
    _name = field_validator("name")(display_name)
    _phone = field_validator("phone")(contact_phone)
    _notes = field_validator("notes")(action_text)

    @field_validator("company")
    @classmethod
    def normalize_company(cls, value: str) -> str:
        return display_name(value) if value.strip() else ""

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.lower() if value else None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, value: list[int]) -> list[int]:
        if any(key < 1 or key > 2147483647 for key in value):
            raise ValueError("Expected contact tag identifiers")
        return sorted(set(value))

    @model_validator(mode="after")
    def require_channel(self) -> "ContactIn":
        if not self.email and not self.phone:
            raise PydanticCustomError("contact_channel_required", "Supply an email or phone")
        names = [tag.name.casefold() for tag in self.new_tags]
        if len(self.tags) + len(self.new_tags) > 30 or len(set(names)) != len(names):
            raise PydanticCustomError("contact_tags_invalid", "Supply at most 30 distinct tags")
        return self


class ContactEdit(ContactIn):
    version: int = Field(ge=1)


class ContactSnapshot(Contract):
    name: str
    company: str
    email: str | None
    phone: str
    notes: str
    tags: list[ContactTagOut]


class ContactOut(ContactSnapshot):
    id: int
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class ContactPage(Contract):
    items: list[ContactOut]
    total: int
    page: int
    pages: int


class ContactEventOut(Contract):
    id: int
    target: Literal["contact", "tag"]
    target_id: int
    name: str
    kind: Literal["created", "updated", "deleted"]
    author: ActorOut
    created_at: datetime
    before: ContactSnapshot | ContactTagIn | None
    after: ContactSnapshot | ContactTagIn | None


class ContactHistoryPage(Contract):
    items: list[ContactEventOut]
    total: int
    page: int
    pages: int


DocumentKind = Literal["pdf", "image", "video", "document", "spreadsheet", "presentation", "text"]
DocumentPolicy = Literal["creator", "administrator", "everyone"]
DocumentEventKind = Literal[
    "created", "version_added", "renamed", "moved", "deleted", "restored", "purged",
    "version_purged",
]
DocumentReference = Annotated[int, Field(ge=1, le=2147483647)]


class DocumentFolderRef(Contract):
    id: int
    name: str


class DocumentFolderOut(Contract):
    id: int
    parent_id: int | None
    name: str
    version: int
    author: ActorOut
    created_at: datetime
    updated_at: datetime
    # Everything active inside it, at any depth: files, their current versions' bytes, folders.
    file_count: int
    folder_count: int
    size: int
    can_manage: bool
    # Under the "creator" policy a resident deletes a folder only if they created all it holds.
    can_delete: bool


class DocumentFolderInfoOut(DocumentFolderOut):
    # The folders above it, from the top level of Documents.
    location: list[DocumentFolderRef]
    deleted_at: datetime | None
    deleted_by: ActorOut | None
    purged_at: datetime | None


class DocumentTreeFolderOut(Contract):
    id: int
    parent_id: int | None
    name: str


class DocumentVersionOut(Contract):
    id: str
    number: int
    extension: str
    media_type: str
    size: int
    sha256: str
    author: ActorOut
    created_at: datetime
    # Set when the administrator deleted the file; downloads then answer 410.
    purged_at: datetime | None


class DocumentOut(Contract):
    id: int
    folder_id: int | None
    name: str
    kind: DocumentKind
    # PDFs, pictures and videos open in a new tab from the eye icon.
    previewable: bool
    version: int
    # Who uploaded the first version.
    author: ActorOut
    created_at: datetime
    updated_at: datetime
    current: DocumentVersionOut
    version_count: int
    can_manage: bool


class DocumentInfoOut(DocumentOut):
    location: list[DocumentFolderRef]
    # Newest first, purged ones included.
    versions: list[DocumentVersionOut]
    deleted_at: datetime | None
    deleted_by: ActorOut | None
    purged_at: datetime | None


class DocumentLimitsOut(Contract):
    extensions: list[str]
    video_extensions: list[str]
    max_file_bytes: int
    max_video_bytes: int
    chunk_bytes: int
    max_folder_items: int
    max_depth: int
    archive_max_items: int
    archive_max_files: int
    archive_max_bytes: int


class DocumentBrowseOut(Contract):
    # Null at the top level of Documents.
    folder: DocumentFolderOut | None
    # From the top level down to the folder itself.
    path: list[DocumentFolderRef]
    folders: list[DocumentFolderOut]
    files: list[DocumentOut]
    policy: DocumentPolicy
    limits: DocumentLimitsOut


class DocumentFolderIn(Contract):
    name: str = Field(min_length=1, max_length=1000)
    # Null: the top level of Documents.
    parent_id: DocumentReference | None = None


class DocumentItemEdit(Contract):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=1000)
    # The folder to move it into; null moves it to the top level, and leaving it out keeps it.
    folder_id: DocumentReference | None = None


class DocumentUploadIn(Contract):
    upload_id: UUID
    # The file's name on the device; its extension decides the type.
    name: str = Field(min_length=1, max_length=1000)
    size: int = Field(ge=0, le=9007199254740991)
    # A new file in this folder (null: the top level), or a new version of document_id.
    folder_id: DocumentReference | None = None
    document_id: DocumentReference | None = None

    @model_validator(mode="after")
    def one_destination(self) -> "DocumentUploadIn":
        if self.folder_id is not None and self.document_id is not None:
            raise ValueError("Upload either into a folder or as a new version of a document")
        return self


class DocumentUploadOut(Contract):
    id: str
    name: str
    size: int
    received: int
    folder_id: int | None
    document_id: int | None
    expires_at: datetime


class DocumentEventOut(Contract):
    id: int
    kind: DocumentEventKind
    author: ActorOut
    created_at: datetime
    # The details that apply to each kind; the others are null.
    name: str | None
    previous_name: str | None
    # Names of the folders above the item, from the top level.
    location: list[str] | None
    previous_location: list[str] | None
    number: int | None
    size: int | None
    # Deleted, restored or purged together with this folder.
    folder: str | None


class DocumentHistoryPage(ActionPagination):
    items: list[DocumentEventOut]


# The administrator sets the limits of shared documents in Storage, in whole MiB (1 MiB =
# 1,048,576 bytes): a file or a video can take up to the 10 GiB of a ZIP download, and the
# quotas can grow to 10 TiB.
DOCUMENT_SIZE_LIMIT_MB = 10 * 1024
DOCUMENT_QUOTA_LIMIT_MB = 10 * 1024 * 1024
DocumentFileLimit = Annotated[int, Field(strict=True, ge=1, le=DOCUMENT_SIZE_LIMIT_MB)]
DocumentQuota = Annotated[int, Field(strict=True, ge=1, le=DOCUMENT_QUOTA_LIMIT_MB)]


class DocumentSettings(Contract):
    manage_policy: DocumentPolicy
    # The largest file, videos excepted, and the largest video.
    max_file_mb: int
    max_video_mb: int
    # Every stored version counts, current, earlier or deleted, until it is purged: towards its
    # uploader's quota (residents only) and the community's.
    user_quota_mb: int
    community_quota_mb: int


class DocumentSettingsEdit(Contract):
    manage_policy: DocumentPolicy | None = None
    max_file_mb: DocumentFileLimit | None = None
    max_video_mb: DocumentFileLimit | None = None
    user_quota_mb: DocumentQuota | None = None
    community_quota_mb: DocumentQuota | None = None

    @model_validator(mode="after")
    def validate_edit(self) -> "DocumentSettingsEdit":
        if not self.model_fields_set or any(
            getattr(self, field) is None for field in self.model_fields_set
        ):
            raise ValueError("Supply at least one non-null setting to change")
        return self


class DocumentDeletionOut(Contract):
    id: str
    folder_id: int | None
    document_id: int | None
    name: str
    location: list[str]
    file_kind: DocumentKind | None
    file_count: int
    folder_count: int
    # Every stored version it holds, until purged.
    stored_bytes: int
    # Who deleted it.
    author: ActorOut
    created_at: datetime


class DocumentDeletionPage(ActionPagination):
    items: list[DocumentDeletionOut]


class StoredDocumentVersionOut(DocumentVersionOut):
    document_id: int
    document_name: str
    location: list[str]
    # Whether the browser can show it (PDFs, pictures and videos), as for current versions.
    previewable: bool


class StoredDocumentVersionPage(ActionPagination):
    items: list[StoredDocumentVersionOut]


class ParsedRow(Contract):
    booking_date: date
    value_date: date
    description: str = Field(min_length=1, max_length=4000)
    amount: Decimal = Field(max_digits=14, decimal_places=2, allow_inf_nan=False)
    balance_after: Decimal = Field(max_digits=14, decimal_places=2, allow_inf_nan=False)
    page: int = Field(ge=1)
    ordinal: int = Field(ge=0)


class Statement(Contract):
    iban: str
    rows: list[ParsedRow] = Field(min_length=1, max_length=10000)


class AccountOut(Contract):
    iban: str
    name: str


class GeneralSettings(Contract):
    community_name: str = Field(min_length=1, max_length=150)

    @field_validator("community_name")
    @classmethod
    def clean_community_name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name or any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise ValueError("Community name must contain visible characters")
        return name


class CatalogIn(Contract):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#21639f", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name:
            raise ValueError("Name cannot be blank")
        return name


class CatalogOut(CatalogIn):
    id: int


class Enrichment(Contract):
    category_id: int | None = None
    merchant: str = Field(default="", max_length=200)
    tags: list[int] = Field(default_factory=list, max_length=30)

    @field_validator("tags")
    @classmethod
    def unique_tags(cls, value: list[int]) -> list[int]:
        return sorted(set(value))


class EnrichmentIn(Enrichment):
    new_tags: list[TagIn] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def distinct_tags(self) -> "EnrichmentIn":
        names = [tag_name_key(tag.name) for tag in self.new_tags]
        if len(self.tags) + len(names) > 30 or len(set(names)) != len(names):
            raise ValueError("Supply at most 30 distinct tags")
        return self


class TransactionOut(Enrichment):
    id: int
    booking_date: date
    value_date: date
    description: str
    amount: Decimal
    balance_after: Decimal
    classification_source: str
    version: int


class TransactionPage(Contract):
    items: list[TransactionOut]
    total: int
    page: int
    pages: int


class EditTransaction(EnrichmentIn):
    version: int = Field(ge=1)


MatchMode = Literal["contains", "starts_with", "exact", "regex"]


class RuleIn(Contract):
    name: str = Field(min_length=1, max_length=100)
    priority: int = Field(default=100, ge=0, le=100000)
    enabled: bool = True
    description_mode: MatchMode = "contains"
    description_value: str = Field(min_length=1, max_length=300)
    detail_mode: MatchMode | None = None
    detail_value: str | None = Field(default=None, max_length=300)
    amount_sign: Literal["positive", "negative"] | None = None
    amount_min: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    amount_max: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    account_ref: str | None = None
    currency: Literal["EUR"] | None = None
    set_category: int | None = None
    set_merchant: str | None = Field(default=None, max_length=200)
    add_tags: list[int] = Field(default_factory=list, max_length=30)
    skip_ai: bool = True

    @model_validator(mode="after")
    def consistent_conditions(self) -> "RuleIn":
        if bool(self.detail_mode) != bool(self.detail_value):
            raise ValueError("Detail mode and value must be supplied together")
        if self.amount_min is not None and self.amount_max is not None:
            if self.amount_min > self.amount_max:
                raise ValueError("Minimum amount cannot exceed maximum")
        return self


class RuleOut(RuleIn):
    id: int


class PreviewRow(ParsedRow, Enrichment):
    status: Literal["new", "duplicate", "review"]
    candidates: list[int] = Field(default_factory=list)
    matched_rule: str | None = None
    classification_source: str = "unclassified"
    skip_ai: bool = False
    ai_reviewed: bool = False


class PreviewOut(Contract):
    id: str
    filename: str
    iban: str
    account_confirmed: bool
    initial_account: bool
    expires_at: datetime
    version: int
    rows: list[PreviewRow]
    ai_enabled: bool
    ai_in_progress: bool = False
    committed_import_id: str | None = None


class AccountConfirmation(Contract):
    iban: str
    version: int = Field(ge=1)


class VersionIn(Contract):
    version: int = Field(ge=1)


class RowDecision(Contract):
    ordinal: int = Field(ge=0)
    existing_id: int | None = Field(default=None, ge=1)
    create_new: bool = False
    enrichment: EnrichmentIn | None = None


class ConfirmIn(VersionIn):
    decisions: list[RowDecision] = Field(default_factory=list, max_length=10000)


class ImportOut(Contract):
    id: str
    filename: str
    created_at: datetime
    start_date: date
    end_date: date
    opening_balance: Decimal
    closing_balance: Decimal
    inserted: int
    duplicates: int
    count: int


class DeleteImpact(Contract):
    revision: int
    removed_transactions: int
    retained_transactions: int


class RevisionIn(Contract):
    revision: int = Field(ge=0)


class RuleImpact(Contract):
    revision: int
    count: int
    sample: list[TransactionOut]


class MonthlyTotal(Contract):
    month: str
    income: Decimal
    expense: Decimal
    net: Decimal


class Breakdown(Contract):
    name: str
    color: str
    amount: Decimal


class CategoryBreakdown(Breakdown):
    category_id: int | None


class MerchantBreakdown(Breakdown):
    merchant: str


class DailyTotal(Contract):
    day: date
    amount: Decimal


class SummaryOut(Contract):
    income: Decimal
    expense: Decimal
    net: Decimal
    count: int
    balance: Decimal | None
    balance_date: date | None
    coverage_start: date | None
    coverage_end: date | None
    monthly: list[MonthlyTotal]
    categories: list[CategoryBreakdown]
    merchants: list[MerchantBreakdown]
    daily: list[DailyTotal]
