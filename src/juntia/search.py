"""The search box at the top of every page: actions, events, shared documents, neighbors,
contacts and bank transactions, as members can already read them.

Every word typed must appear in an item, in any order and in any of its fields, ignoring case and
accents; an action is also found by one of its comments or PDFs, and a file by the text inside it.
Titles that start with the search come first, then titles with every word, then items with the
words elsewhere, and files found only by their text last. A few of each kind are listed, so that
no kind hides the others.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Unpack
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import CTE, Select, and_, case, func, null, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement
from starlette.concurrency import run_in_threadpool

from . import document_index, queries
from .auth import DB, reader_session, settings
from .community_events import local_start
from .contracts import (
    ActionHit,
    ContactHit,
    DocumentFolderRef,
    EventHit,
    FileHit,
    FolderHit,
    NeighborHit,
    SearchExcerpt,
    SearchExcerptSource,
    SearchHit,
    SearchOut,
    TransactionHit,
)
from .db import (
    ActionAttachment,
    ActionComment,
    ActionLabel,
    ActionLabelLink,
    CommunityAction,
    CommunityEvent,
    Contact,
    ContactTag,
    ContactTagLink,
    Document,
    DocumentFolder,
    DocumentText,
    DocumentVersion,
    Dwelling,
    State,
    Transaction,
    User,
    aware,
    utcnow,
)
from .query_sql import contains_text, fold_sql, fold_text, starts_text

router = APIRouter(prefix="/api", tags=["Search"], dependencies=[Depends(reader_session)])
MAX_WORDS = 10
PER_KIND = 5
LIMIT = 20
EXCERPT_BEFORE = 40
EXCERPT_AFTER = 100
# Equally good matches are listed in this order of their kinds.
KINDS = ("action", "event", "folder", "file", "neighbor", "contact", "transaction")
SearchText = Annotated[str, Query(min_length=1, max_length=200)]
PDF_NAME = func.coalesce(ActionAttachment.display_filename, ActionAttachment.filename)
# Members write these texts: every pattern runs in linear time. Link texts and addresses stop at
# the next bracket or parenthesis, and emphasis takes at most three marks, so that no match
# attempt rescans what an earlier one already read.
MARKDOWN_IMAGE = re.compile(r"!\[([^\[\]]*)\]\([^()]*\)")
MARKDOWN_LINK = re.compile(r"\[([^\[\]]*)\]\([^()]*\)")
MARKDOWN_LINE = re.compile(
    r"^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?",
    re.MULTILINE,
)
MARKDOWN_MARKS = re.compile(r"\*\*|__|~~|`+")
MARKDOWN_EMPHASIS = re.compile(r"(?<!\w)[*_]{1,3}(?=\w)|(?<=\w)[*_]{1,3}(?!\w)")


@dataclass(frozen=True)
class Found:
    # 0: the title starts with the search; 1: the title has every word; 2: the words are
    # elsewhere; 3: only in the text inside a file.
    rank: int
    hit: SearchHit


# The items found of one kind, best first, and whether there are more.
Kind = tuple[list[Found], bool]


@dataclass(frozen=True)
class Source:
    """A longer text of an item, where an excerpt can show the words that its title lacks."""

    text: str
    name: SearchExcerptSource
    markdown: bool = False


def search_words(q: str) -> list[str]:
    """The distinct words of the search, without case and accents."""
    return list(dict.fromkeys(fold_text(q).split()))[:MAX_WORDS]


def phone_digits(word: str) -> str | None:
    """A word written like a phone number (600-123-456), as phones are kept: digits, maybe a +."""
    digits = re.sub(r"[().-]", "", word)
    return digits if digits != word and re.fullmatch(r"\+?[0-9]+", digits) else None


def keyed(query: Select[Unpack[tuple[Any, ...]]]) -> CTE:
    """Each item's texts without case and accents, folded once for every word: the database
    keeps a materialized CTE instead of folding them again for each comparison."""
    return query.cte().prefix_with("MATERIALIZED")


def every_word(
    db: AsyncSession, value: ColumnElement[str], words: Sequence[str],
    phone: ColumnElement[str] | None = None,
) -> ColumnElement[bool]:
    """Every word is in the text; one written like a phone number may be in the phone instead."""
    conditions = []
    for word in words:
        condition = contains_text(db, value, word)
        digits = phone_digits(word) if phone is not None else None
        if phone is not None and digits:
            condition = or_(condition, contains_text(db, phone, digits))
        conditions.append(condition)
    return and_(*conditions)


def rank(
    db: AsyncSession, title: ColumnElement[str], words: Sequence[str], otherwise: int = 2,
) -> ColumnElement[int]:
    return case(
        (starts_text(db, title, " ".join(words)), 0),
        (every_word(db, title, words), 1),
        else_=otherwise,
    )


def lacking(title: str, words: Sequence[str]) -> list[str]:
    """The words that the title does not show."""
    key = fold_text(title)
    return [word for word in words if word not in key]


def plain_text(markdown: str) -> str:
    """What a Markdown text reads like: its words, without marks or the addresses of links."""
    text = MARKDOWN_LINK.sub(r"\1", MARKDOWN_IMAGE.sub(r"\1", markdown))
    text = MARKDOWN_EMPHASIS.sub("", MARKDOWN_MARKS.sub("", MARKDOWN_LINE.sub("", text)))
    return " ".join(text.split())


def first_excerpt(sources: Sequence[Source], words: Sequence[str]) -> SearchExcerpt | None:
    """The words around the first of them in the first text that has any."""
    if not words:
        return None
    for source in sources:
        text = plain_text(source.text) if source.markdown else " ".join(source.text.split())
        found = document_index.locate(text, words)
        if found is not None:
            part = document_index.surroundings(
                text, *found, before=EXCERPT_BEFORE, after=EXCERPT_AFTER,
            )
            return SearchExcerpt(text=part.before + part.match + part.after, source=source.name)
    return None


async def excerpts(jobs: Sequence[tuple[Sequence[Source], Sequence[str]]]) -> list[
    SearchExcerpt | None
]:
    """Texts can be long, such as the text inside a file: they are read away from the loop."""
    return await run_in_threadpool(lambda: [first_excerpt(*job) for job in jobs])


async def find_actions(db: AsyncSession, words: list[str]) -> Kind:
    labels = (
        select(func.aggregate_strings(ActionLabel.name, "\n"))
        .join(ActionLabelLink, ActionLabelLink.label_id == ActionLabel.id)
        .where(ActionLabelLink.action_id == CommunityAction.id)
        .correlate(CommunityAction).scalar_subquery()
    )
    items = keyed(select(
        CommunityAction.id,
        fold_sql(db, CommunityAction.title).label("title"),
        fold_sql(db, CommunityAction.description + "\n" + func.coalesce(labels, "")).label("rest"),
    ))
    comments = keyed(select(
        ActionComment.action_id, fold_sql(db, ActionComment.body).label("text"),
    ).where(ActionComment.withdrawn_at.is_(None)))
    pdfs = keyed(select(
        ActionAttachment.action_id, fold_sql(db, PDF_NAME).label("text"),
    ).where(ActionAttachment.withdrawn_at.is_(None)))
    in_fields = every_word(db, items.c.title + "\n" + items.c.rest, words)
    order = rank(db, items.c.title, words).label("relevance")
    rows = (await db.execute(
        select(CommunityAction, order, in_fields.label("in_fields"))
        .join(items, items.c.id == CommunityAction.id)
        .where(or_(
            in_fields,
            CommunityAction.id.in_(
                select(comments.c.action_id).where(every_word(db, comments.c.text, words))
            ),
            CommunityAction.id.in_(
                select(pdfs.c.action_id).where(every_word(db, pdfs.c.text, words))
            ),
        ))
        .order_by(order, CommunityAction.updated_at.desc(), CommunityAction.id.desc())
        .limit(PER_KIND + 1)
    )).all()
    shown = rows[:PER_KIND]
    missing = {value.id: lacking(value.title, words) for value, _, _ in shown}
    # Labels show words of actions found by their own fields; the latest comment and PDF name
    # with every word, those of actions found by them.
    own = [value.id for value, _, fields in shown if fields and missing[value.id]]
    other = [value.id for value, _, fields in shown if not fields and missing[value.id]]
    label_names: dict[int, list[str]] = {}
    if own:
        for action_id, name in await db.execute(
            select(ActionLabelLink.action_id, ActionLabel.name)
            .join(ActionLabel, ActionLabel.id == ActionLabelLink.label_id)
            .where(ActionLabelLink.action_id.in_(own)).order_by(ActionLabel.normalized_name)
        ):
            label_names.setdefault(action_id, []).append(name)
    comment_bodies: dict[int, str] = {}
    pdf_names: dict[int, str] = {}
    if other:
        for action_id, body in await db.execute(
            select(ActionComment.action_id, ActionComment.body).where(
                ActionComment.action_id.in_(other), ActionComment.withdrawn_at.is_(None),
                every_word(db, fold_sql(db, ActionComment.body), words),
            ).order_by(ActionComment.id.desc())
        ):
            comment_bodies.setdefault(action_id, body)
        for action_id, name in await db.execute(
            select(ActionAttachment.action_id, PDF_NAME).where(
                ActionAttachment.action_id.in_(other), ActionAttachment.withdrawn_at.is_(None),
                every_word(db, fold_sql(db, PDF_NAME), words),
            ).order_by(ActionAttachment.created_at.desc(), ActionAttachment.id.desc())
        ):
            pdf_names.setdefault(action_id, name)

    def sources(value: CommunityAction, fields: bool) -> list[Source]:
        if fields:
            return [
                Source(value.description, "description", markdown=True),
                Source(", ".join(label_names.get(value.id, [])), "labels"),
            ]
        found = []
        if value.id in comment_bodies:
            found.append(Source(comment_bodies[value.id], "comment", markdown=True))
        if value.id in pdf_names:
            found.append(Source(pdf_names[value.id], "attachment"))
        return found

    texts = await excerpts([
        (sources(value, fields), missing[value.id]) for value, _, fields in shown
    ])
    return [Found(score, ActionHit(
        id=value.id, title=value.title, excerpt=text, status=value.status,
    )) for (value, score, _), text in zip(shown, texts, strict=True)], len(rows) > PER_KIND


async def find_events(db: AsyncSession, words: list[str], zone: str) -> Kind:
    items = keyed(select(
        CommunityEvent.id,
        fold_sql(db, CommunityEvent.title).label("title"),
        fold_sql(db, CommunityEvent.location + "\n" + CommunityEvent.description).label("rest"),
    ).where(CommunityEvent.deleted_at.is_(None)))
    now = utcnow()
    today = now.astimezone(ZoneInfo(zone)).date()
    # The agenda's rule for finished events.
    ended = or_(CommunityEvent.ends_at <= now, CommunityEvent.ends_on <= today)
    start = local_start(db, zone)
    order = rank(db, items.c.title, words).label("relevance")
    rows = (await db.execute(
        select(CommunityEvent, order).join(items, items.c.id == CommunityEvent.id)
        .where(every_word(db, items.c.title + "\n" + items.c.rest, words))
        # Upcoming and ongoing events first, the soonest first; then past ones, the latest first.
        .order_by(
            order, case((ended, 1), else_=0), case((ended, null()), else_=start),
            case((ended, start)).desc(), CommunityEvent.id,
        ).limit(PER_KIND + 1)
    )).all()
    shown = rows[:PER_KIND]
    texts = await excerpts([
        ([Source(value.description, "description", markdown=True)], lacking(value.title, words))
        for value, _ in shown
    ])
    return [Found(score, EventHit(
        id=value.id, title=value.title, excerpt=text, location=value.location,
        all_day=value.all_day, starts_at=aware(value.starts_at) if value.starts_at else None,
        ends_at=aware(value.ends_at) if value.ends_at else None,
        starts_on=value.starts_on, ends_on=value.ends_on,
    )) for (value, score), text in zip(shown, texts, strict=True)], len(rows) > PER_KIND


def folder_path(folders: dict[int, tuple[int | None, str]], folder_id: int | None) -> list[
    DocumentFolderRef
]:
    """The folders from the top level of Documents down to `folder_id`."""
    path: list[DocumentFolderRef] = []
    while folder_id is not None and folder_id in folders and len(path) <= len(folders):
        parent_id, name = folders[folder_id]
        path.append(DocumentFolderRef(id=folder_id, name=name))
        folder_id = parent_id
    return path[::-1]


async def find_documents(db: AsyncSession, words: list[str]) -> list[Kind]:
    """Folders by their name, and files by their name or by the text inside them."""
    folder_keys = keyed(select(
        DocumentFolder.id, fold_sql(db, DocumentFolder.name).label("title"),
    ).where(DocumentFolder.deleted_at.is_(None)))
    order = rank(db, folder_keys.c.title, words).label("relevance")
    folder_rows = (await db.execute(
        select(DocumentFolder.id, DocumentFolder.parent_id, DocumentFolder.name, order)
        .join(folder_keys, folder_keys.c.id == DocumentFolder.id)
        .where(every_word(db, folder_keys.c.title, words))
        .order_by(order, DocumentFolder.name_key, DocumentFolder.id).limit(PER_KIND + 1)
    )).all()
    file_keys = keyed(select(
        Document.id, fold_sql(db, Document.name).label("title"),
    ).where(Document.deleted_at.is_(None)))
    order = rank(db, file_keys.c.title, words, otherwise=3).label("relevance")
    file_rows = (await db.execute(
        select(Document.id, Document.folder_id, Document.name, Document.kind, order)
        .join(file_keys, file_keys.c.id == Document.id)
        .join(DocumentVersion, document_index.current())
        .outerjoin(DocumentText, and_(
            DocumentText.version_id == DocumentVersion.id, DocumentText.characters > 0,
        ))
        .where(or_(
            every_word(db, file_keys.c.title, words),
            every_word(db, DocumentText.content_key.expression, words),
        ))
        .order_by(order, Document.updated_at.desc(), Document.id.desc())
        .limit(PER_KIND + 1)
    )).all()
    folders: dict[int, tuple[int | None, str]] = {}
    if folder_rows or file_rows:
        folders = {
            folder_id: (parent_id, name) for folder_id, parent_id, name in await db.execute(
                select(DocumentFolder.id, DocumentFolder.parent_id, DocumentFolder.name)
                .where(DocumentFolder.deleted_at.is_(None))
            )
        }
    shown = file_rows[:PER_KIND]
    read = [row.id for row in shown if row.relevance == 3]
    contents: dict[int, str] = {
        document_id: content for document_id, content in await db.execute(
            select(Document.id, DocumentText.content)
            .join(DocumentVersion, document_index.current())
            .join(DocumentText, DocumentText.version_id == DocumentVersion.id)
            .where(Document.id.in_(read))
        )
    } if read else {}
    texts = await excerpts([(
        [Source(contents[row.id], "text")] if row.id in contents else [],
        lacking(row.name, words),
    ) for row in shown])
    return [
        ([Found(row.relevance, FolderHit(
            id=row.id, title=row.name, excerpt=None, location=folder_path(folders, row.parent_id),
        )) for row in folder_rows[:PER_KIND]], len(folder_rows) > PER_KIND),
        ([Found(row.relevance, FileHit(
            id=row.id, title=row.name, excerpt=text, document_kind=row.kind,
            folder_id=row.folder_id, location=folder_path(folders, row.folder_id),
        )) for row, text in zip(shown, texts, strict=True)], len(file_rows) > PER_KIND),
    ]


async def find_neighbors(db: AsyncSession, words: list[str]) -> Kind:
    """The accounts the Neighbors directory lists: active ones with a dwelling."""
    items = keyed(select(
        User.id,
        fold_sql(db, User.name).label("title"),
        fold_sql(db, User.email + "\n" + User.phone + "\n" + Dwelling.label).label("rest"),
        User.phone,
    ).join(Dwelling, Dwelling.id == User.dwelling_id).where(
        User.disabled.is_(False), User.activated.is_(True),
    ))
    order = rank(db, items.c.title, words).label("relevance")
    rows = (await db.execute(
        select(User.id, User.name, User.email, User.phone, Dwelling.label, order)
        .join(items, items.c.id == User.id).join(Dwelling, Dwelling.id == User.dwelling_id)
        .where(every_word(db, items.c.title + "\n" + items.c.rest, words, items.c.phone))
        .order_by(order, items.c.title, User.id).limit(PER_KIND + 1)
    )).all()
    president = await db.scalar(select(State.president_user_id).where(State.id == 1))
    return [Found(row.relevance, NeighborHit(
        id=row.id, title=row.name, excerpt=None, email=row.email, phone=row.phone,
        dwelling=row.label, is_president=row.id == president,
    )) for row in rows[:PER_KIND]], len(rows) > PER_KIND


async def find_contacts(db: AsyncSession, words: list[str]) -> Kind:
    tags = (
        select(func.aggregate_strings(ContactTag.name, "\n"))
        .join(ContactTagLink, ContactTagLink.tag_id == ContactTag.id)
        .where(ContactTagLink.contact_id == Contact.id).correlate(Contact).scalar_subquery()
    )
    items = keyed(select(
        Contact.id,
        fold_sql(db, Contact.name).label("title"),
        fold_sql(
            db, Contact.company + "\n" + func.coalesce(Contact.email, "") + "\n" + Contact.phone
            + "\n" + Contact.notes + "\n" + func.coalesce(tags, ""),
        ).label("rest"),
        Contact.phone,
    ).where(Contact.deleted_at.is_(None)))
    order = rank(db, items.c.title, words).label("relevance")
    rows = (await db.execute(
        select(Contact, order).join(items, items.c.id == Contact.id)
        .where(every_word(db, items.c.title + "\n" + items.c.rest, words, items.c.phone))
        .order_by(order, items.c.title, Contact.id).limit(PER_KIND + 1)
    )).all()
    shown = rows[:PER_KIND]
    missing = {value.id: lacking(value.name, words) for value, _ in shown}
    names: dict[int, list[str]] = {}
    if wanted := [key for key, values in missing.items() if values]:
        for contact_id, name in await db.execute(
            select(ContactTagLink.contact_id, ContactTag.name)
            .join(ContactTag, ContactTag.id == ContactTagLink.tag_id)
            .where(ContactTagLink.contact_id.in_(wanted)).order_by(ContactTag.normalized_name)
        ):
            names.setdefault(contact_id, []).append(name)
    texts = await excerpts([(
        [Source(value.notes, "notes"), Source(", ".join(names.get(value.id, [])), "tags")],
        missing[value.id],
    ) for value, _ in shown])
    return [Found(score, ContactHit(
        id=value.id, title=value.name, excerpt=text, company=value.company, email=value.email,
        phone=value.phone,
    )) for (value, score), text in zip(shown, texts, strict=True)], len(rows) > PER_KIND


async def find_transactions(db: AsyncSession, words: list[str]) -> Kind:
    items = keyed(select(
        Transaction.id,
        fold_sql(db, Transaction.description).label("title"),
        fold_sql(db, Transaction.merchant).label("rest"),
    ))
    order = rank(db, items.c.title, words).label("relevance")
    rows = (await db.execute(
        select(
            Transaction.id, Transaction.description, Transaction.merchant,
            Transaction.booking_date, Transaction.amount, order,
        ).join(items, items.c.id == Transaction.id)
        .where(every_word(db, items.c.title + "\n" + items.c.rest, words))
        .order_by(order, Transaction.booking_date.desc(), Transaction.id.desc())
        .limit(PER_KIND + 1)
    )).all()
    return [Found(row.relevance, TransactionHit(
        id=row.id, title=row.description, excerpt=None, booking_date=row.booking_date,
        amount=row.amount, merchant=row.merchant,
    )) for row in rows[:PER_KIND]], len(rows) > PER_KIND


@router.get("/search", response_model=SearchOut)
async def search(q: SearchText, request: Request, db: DB) -> SearchOut:
    """What contains every word of `q`: a few items of each kind, the best matches first."""
    words = search_words(q)
    if not words:
        return SearchOut(items=[], more=False)
    flags = await queries.feature_flags(db)
    kinds: list[Kind] = []
    if flags.actions:
        kinds.append(await find_actions(db, words))
    if flags.events:
        kinds.append(await find_events(db, words, settings(request).tz))
    if flags.documents:
        kinds.extend(await find_documents(db, words))
    kinds.append(await find_neighbors(db, words))
    kinds.append(await find_contacts(db, words))
    kinds.append(await find_transactions(db, words))
    best = sorted(
        ((found, KINDS.index(found.hit.kind), position)
         for items, _ in kinds for position, found in enumerate(items)),
        key=lambda entry: (entry[0].rank, entry[1], entry[2]),
    )
    return SearchOut(
        items=[found.hit for found, _, _ in best[:LIMIT]],
        more=len(best) > LIMIT or any(more for _, more in kinds),
    )
