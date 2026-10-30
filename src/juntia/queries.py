import logging
import math
import re
from datetime import date
from decimal import Decimal
from typing import Literal

from sqlalchemy import BigInteger, Select, String, and_, case, cast, false, func, select, true
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from .config import Language
from .contracts import (
    CatalogOut,
    CategoryBreakdown,
    DailyTotal,
    DwellingLayout,
    DwellingLayoutOut,
    DwellingNeighborsOut,
    FeatureFlags,
    GeneralSettings,
    MerchantBreakdown,
    MonthlyTotal,
    NeighborOut,
    PresidencyOut,
    PresidentOut,
    SummaryOut,
    TransactionOut,
    TransactionPage,
)
from .db import Category, Dwelling, State, Tag, Transaction, TransactionOrder, User
from .errors import AppError
from .query_sql import binary_text, casefold_sql, contains_text, fold_text
from .texts import texts

log = logging.getLogger(__name__)


async def tag_catalog(db: AsyncSession) -> list[CatalogOut]:
    values = (
        func.json_array_elements_text(Transaction.tags)
        if db.get_bind().dialect.name == "postgresql" else func.json_each(Transaction.tags)
    ).table_valued("value")
    tag_id = cast(values.c.value, BigInteger)
    usage = (
        select(tag_id.label("tag_id"), func.count(func.distinct(Transaction.id)).label("uses"))
        .select_from(Transaction).join(values, true()).group_by(tag_id).subquery()
    )
    rows = (await db.scalars(
        select(Tag).outerjoin(usage, usage.c.tag_id == Tag.id)
        .order_by(func.coalesce(usage.c.uses, 0).desc(), casefold_sql(db, Tag.name), Tag.id)
    )).all()
    return [CatalogOut.model_validate(row) for row in rows]


async def general_settings(db: AsyncSession) -> GeneralSettings:
    state = await db.get(State, 1)
    if state is None:
        raise RuntimeError("Missing application state")
    return GeneralSettings(community_name=state.community_name)


async def feature_flags(db: AsyncSession) -> FeatureFlags:
    row = (await db.execute(select(
        State.feature_coefficient.label("coefficient"),
        State.feature_actions.label("actions"),
        State.feature_events.label("events"),
    ).where(State.id == 1))).one_or_none()
    if row is None:
        raise RuntimeError("Missing application state")
    return FeatureFlags.model_validate(row)


async def dwelling_layout(db: AsyncSession) -> DwellingLayoutOut:
    state = await db.get(State, 1)
    if state is None:
        raise RuntimeError("Missing application state")
    return DwellingLayoutOut(
        version=state.dwelling_layout_version,
        layout=(
            DwellingLayout.model_validate(state.dwelling_layout)
            if state.dwelling_layout is not None else None
        ),
    )


def _natural_parts(value: str) -> tuple[tuple[int, int, str], ...]:
    return tuple(
        (0, int(part), "") if part.isdigit() else (1, 0, part.strip())
        for part in re.split(r"([0-9]+)", value) if part.strip()
    )


def dwelling_sort_key(label: str) -> tuple[int, int, tuple[tuple[int, int, str], ...], str]:
    text = fold_text(label.translate(str.maketrans("", "", "ºª°")))
    text = re.sub(r"[.,/]+", " ", text).strip()
    floor = re.fullmatch(r"(?:(?:piso|planta)\s*)?(-?[0-9]+)\s*[- ]*(.*)", text)
    if floor:
        return 0, int(floor[1]) * 2, _natural_parts(floor[2]), text
    ground = re.fullmatch(r"(?:bajos?|pb|planta baja)(?:\s+(.*))?", text)
    if ground:
        return 0, 0, _natural_parts(ground[1] or ""), text
    mezzanine = re.fullmatch(r"entresuelo(?:\s+(.*))?", text)
    if mezzanine:
        # Numbered floors are doubled so the mezzanine fits between zero and one.
        return 0, 1, _natural_parts(mezzanine[1] or ""), text
    attic = re.fullmatch(r"atico(?:\s+(.*))?", text)
    if attic:
        return 1, 0, _natural_parts(attic[1] or ""), text
    return 2, 0, _natural_parts(text), text


async def neighbor_directory(db: AsyncSession) -> list[DwellingNeighborsOut]:
    president = select(State.president_user_id).where(State.id == 1).scalar_subquery()
    rows = (await db.execute(
        select(Dwelling, User, president).outerjoin(User, and_(
            User.dwelling_id == Dwelling.id, User.disabled.is_(False),
            User.activated.is_(True),
        ))
    )).all()
    grouped: dict[int, DwellingNeighborsOut] = {}
    for dwelling, user, president_user_id in rows:
        group = grouped.setdefault(dwelling.id, DwellingNeighborsOut(
            id=dwelling.id, label=dwelling.label, neighbors=[],
        ))
        if user is not None:
            group.neighbors.append(NeighborOut(
                id=user.id, name=user.name, email=user.email, phone=user.phone,
                is_president=user.id == president_user_id,
            ))
    for group in grouped.values():
        group.neighbors.sort(key=lambda person: (fold_text(person.name), person.id))
    return sorted(grouped.values(), key=lambda group: dwelling_sort_key(group.label))


async def presidency(db: AsyncSession) -> PresidencyOut:
    row = (await db.execute(
        select(State, User, Dwelling)
        .outerjoin(User, State.president_user_id == User.id)
        .outerjoin(Dwelling, User.dwelling_id == Dwelling.id)
        .where(State.id == 1).execution_options(populate_existing=True)
    )).one_or_none()
    if row is None:
        raise RuntimeError("Missing application state")
    state, user, dwelling = row
    if state.president_user_id is not None and (user is None or dwelling is None):
        raise RuntimeError("Missing presidency holder")
    return PresidencyOut(
        version=state.presidency_version,
        president=PresidentOut(
            id=user.id, name=user.name, dwelling_id=dwelling.id, dwelling_label=dwelling.label,
        ) if user is not None and dwelling is not None else None,
    )


def transactions(
    db: AsyncSession,
    start: date | None = None,
    end: date | None = None,
    q: str = "",
    category: int | None = None,
    tag: list[int] | None = None,
    flow: str = "",
    merchant: str = "",
    minimum: Decimal | None = None,
    maximum: Decimal | None = None,
    uncategorized: bool = False,
    merchant_exact: str | None = None,
) -> Select[Transaction]:
    if (
        start
        and end
        and start > end
        or minimum is not None
        and maximum is not None
        and minimum > maximum
    ):
        raise AppError("invalid_range")
    query = select(Transaction).outerjoin(TransactionOrder)
    if start:
        query = query.where(Transaction.booking_date >= start)
    if end:
        query = query.where(Transaction.booking_date <= end)
    if category:
        query = query.where(Transaction.category_id == category)
    if uncategorized:
        query = query.where(Transaction.category_id.is_(None))
    if merchant_exact is not None:
        query = query.where(Transaction.merchant == merchant_exact)
    if flow == "income":
        query = query.where(Transaction.amount > 0)
    elif flow == "expense":
        query = query.where(Transaction.amount < 0)
    if minimum is not None:
        query = query.where(Transaction.amount >= minimum)
    if maximum is not None:
        query = query.where(Transaction.amount <= maximum)
    if q:
        query = query.where(contains_text(db, casefold_sql(db, Transaction.description), q.casefold()))
    if merchant:
        query = query.where(contains_text(db, casefold_sql(db, Transaction.merchant), merchant.casefold()))
    tags = sorted(set(tag or []))
    if len(tags) > 30 or any(key < 1 or key > 2147483647 for key in tags):
        query = query.where(false())
    elif tags:
        if db.get_bind().dialect.name == "postgresql":
            query = query.where(cast(Transaction.tags, JSONB).contains(tags))
        else:
            values = func.json_each(Transaction.tags).table_valued("value")
            for key in tags:
                query = query.where(
                    select(1).select_from(values).where(values.c.value == key).exists()
                )
    return query


def require_bank_order(total: int, indexed: int) -> None:
    if total != indexed:
        log.error("The bank order index does not cover the selected financial records")
        raise AppError("bank_order_missing", 503)


async def transaction_page(
    db: AsyncSession, query: Select[Transaction], page: int,
    sort: Literal[
        "date", "description", "category", "amount", "balance",
        "newest", "oldest",
    ],
    direction: Literal["asc", "desc"] | None,
) -> TransactionPage:
    total, indexed = (await db.execute(query.with_only_columns(
        func.count(Transaction.id), func.count(TransactionOrder.transaction_id),
    ))).one()
    require_bank_order(total, indexed)
    pages = max(1, math.ceil(total / 50))
    if page > pages or not total:
        return TransactionPage(items=[], total=total, page=page, pages=pages)
    if sort in {"newest", "oldest"}:
        direction = "desc" if sort == "newest" else "asc"
        sort = "date"
    elif direction is None:
        direction = "desc" if sort == "date" else "asc"
    if sort == "date":
        query = query.order_by(
            TransactionOrder.position.desc() if direction == "asc" else TransactionOrder.position,
        )
    elif sort == "category":
        category = binary_text(db, casefold_sql(db, Category.name))
        query = query.outerjoin(Category).order_by(
            Transaction.category_id.is_(None).asc(),
            category.asc() if direction == "asc" else category.desc(),
            TransactionOrder.position,
        )
    else:
        column = (
            binary_text(db, casefold_sql(db, Transaction.description))
            if sort == "description"
            else Transaction.amount if sort == "amount"
            else Transaction.balance_after
        )
        query = query.order_by(
            column.asc() if direction == "asc" else column.desc(),
            TransactionOrder.position,
        )
    rows = (await db.scalars(query.offset((page - 1) * 50).limit(50))).all()
    return TransactionPage(
        items=[TransactionOut.model_validate(row) for row in rows],
        total=total, page=page, pages=pages,
    )


def money(cents: int | Decimal | None) -> Decimal:
    return (Decimal(cents or 0) / 100).quantize(Decimal("0.01"))


def signed_totals(cents: ColumnElement[int]) -> tuple[ColumnElement[int], ColumnElement[int]]:
    return (
        func.coalesce(func.sum(case((cents > 0, cents), else_=0)), 0),
        func.coalesce(func.sum(case((cents < 0, -cents), else_=0)), 0),
    )


async def summary(db: AsyncSession, query: Select[Transaction], language: Language) -> SummaryOut:
    facts = query.with_only_columns(
        Transaction.booking_date, Transaction.amount, Transaction.category_id,
        Transaction.merchant, TransactionOrder.position,
    ).subquery()
    # Integer cents avoid SQLite's floating-point SUM changing financial totals.
    cents = cast(func.round(facts.c.amount * 100), BigInteger)
    income_total, expense_total = signed_totals(cents)
    incoming, outgoing, count, indexed = (await db.execute(
        select(income_total, expense_total, func.count(), func.count(facts.c.position))
    )).one()
    require_bank_order(count, indexed)
    income, expense = money(incoming), money(outgoing)

    month = func.substr(cast(facts.c.booking_date, String), 1, 7)
    monthly = (await db.execute(
        select(month, income_total, expense_total).group_by(month).order_by(month)
    )).all()
    categories = (
        select(
            facts.c.category_id, func.sum(-cents).label("amount"),
            func.min(facts.c.position).label("first_position"),
        ).where(cents < 0).group_by(facts.c.category_id).subquery()
    )
    category_rows = (await db.execute(
        select(categories.c.category_id, categories.c.amount, Category.name, Category.color)
        .outerjoin(Category, Category.id == categories.c.category_id)
        .order_by(categories.c.amount.desc(), categories.c.first_position)
    )).all()
    merchant = binary_text(db, facts.c.merchant)
    merchant_rows = (await db.execute(
        select(merchant, func.sum(-cents).label("amount"))
        .where(cents < 0).group_by(merchant)
        .order_by(func.sum(-cents).desc(), func.min(facts.c.position)).limit(10)
    )).all()
    daily = (await db.execute(
        select(facts.c.booking_date, func.sum(-cents)).where(cents < 0)
        .group_by(facts.c.booking_date).order_by(facts.c.booking_date)
    )).all()
    first_date, latest_date = (
        await db.execute(
            select(func.min(Transaction.booking_date), func.max(Transaction.booking_date))
        )
    ).one()
    balance = case((TransactionOrder.is_root.is_(True), Transaction.balance_after))
    low, high, latest_count, latest_indexed = (await db.execute(
        select(
            func.min(balance), func.max(balance), func.count(Transaction.id),
            func.count(TransactionOrder.transaction_id),
        ).select_from(Transaction).outerjoin(TransactionOrder)
        .where(Transaction.booking_date == latest_date)
    )).one()
    require_bank_order(latest_count, latest_indexed)
    labels = texts(language)
    return SummaryOut(
        income=income,
        expense=expense,
        net=income - expense,
        count=count,
        balance=low if low == high else None,
        balance_date=latest_date,
        coverage_start=first_date,
        coverage_end=latest_date,
        monthly=[
            MonthlyTotal(month=month, income=money(positive), expense=money(negative),
                         net=money(positive) - money(negative))
            for month, positive, negative in monthly
        ],
        categories=[
            CategoryBreakdown(
                category_id=key,
                name=name if name is not None else labels.uncategorized,
                color=color if color is not None else "#64748b",
                amount=money(amount),
            )
            for key, amount, name, color in category_rows
        ],
        merchants=[
            MerchantBreakdown(
                name=name or labels.no_merchant, merchant=name, color="#21639f",
                amount=money(amount),
            )
            for name, amount in merchant_rows
        ],
        daily=[DailyTotal(day=day, amount=money(amount)) for day, amount in daily],
    )
