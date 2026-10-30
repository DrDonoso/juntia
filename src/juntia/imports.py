from collections import Counter, defaultdict
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import ai
from .bank_order import rebuild_bank_order
from .config import Language, Settings
from .contracts import (
    CatalogOut,
    ConfirmIn,
    DeleteImpact,
    Enrichment,
    EnrichmentIn,
    ImportOut,
    ParsedRow,
    PreviewOut,
    PreviewRow,
    RuleOut,
    Statement,
    tag_name_key,
)
from .db import (
    Account,
    Category,
    ImportRow,
    ImportRun,
    Preview,
    Rule,
    State,
    Tag,
    Transaction,
    aware,
    lock_state,
    utcnow,
)
from .errors import AppError
from .identity import digest, source_key
from .rules import apply_rules
from .texts import texts


async def check_account(db: AsyncSession, iban: str) -> Account | None:
    account = await db.get(Account, 1)
    if account and account.iban != iban:
        raise AppError("account_mismatch", 409)
    return account


async def rules_list(db: AsyncSession) -> list[RuleOut]:
    return [
        RuleOut.model_validate({**rule.data, "id": rule.id})
        for rule in (await db.scalars(select(Rule).order_by(Rule.id))).all()
    ]


async def validate_enrichment(db: AsyncSession, values: Sequence[Enrichment]) -> None:
    categories = set((await db.scalars(select(Category.id))).all())
    tags = set((await db.scalars(select(Tag.id))).all())
    if any(
        value.category_id is not None
        and value.category_id not in categories
        or not set(value.tags) <= tags
        for value in values
    ):
        raise AppError("unknown_classification", 409)


async def resolve_enrichment(db: AsyncSession, value: EnrichmentIn) -> Enrichment:
    ids = set(value.tags)
    if value.new_tags:
        # Callers hold the finance state lock, including concurrent catalog writes.
        available: dict[str, Tag] = {}
        for existing in (await db.scalars(select(Tag).order_by(Tag.id))).all():
            available.setdefault(tag_name_key(existing.name), existing)
        for draft in value.new_tags:
            key = tag_name_key(draft.name)
            tag = available.get(key)
            if tag is None:
                tag = Tag(name=draft.name, color=draft.color)
                db.add(tag)
                await db.flush()
                available[key] = tag
            ids.add(tag.id)
    return Enrichment(category_id=value.category_id, merchant=value.merchant, tags=sorted(ids))


async def match_rows(db: AsyncSession, rows: list[ParsedRow]) -> list[PreviewRow]:
    keys = [source_key(row) for row in rows]
    weak_keys = [source_key(row, include_balance=False) for row in rows]
    stored = (
        await db.scalars(
            select(Transaction).where(
                or_(Transaction.source_key.in_(keys), Transaction.weak_key.in_(weak_keys))
            )
        )
    ).all()
    by_key: dict[str, list[Transaction]] = defaultdict(list)
    by_weak: dict[str, list[Transaction]] = defaultdict(list)
    for transaction in stored:
        by_key[transaction.source_key].append(transaction)
        by_weak[transaction.weak_key].append(transaction)
    counts = Counter(keys)
    result = []
    for row, key, weak in zip(rows, keys, weak_keys, strict=True):
        candidates = by_key[key]
        if len(candidates) == 1 and counts[key] == 1:
            current = candidates[0]
            result.append(
                PreviewRow(
                    **row.model_dump(),
                    status="duplicate",
                    candidates=[current.id],
                    category_id=current.category_id,
                    merchant=current.merchant,
                    tags=current.tags,
                    classification_source=current.classification_source,
                )
            )
        else:
            result.append(
                PreviewRow(
                    **row.model_dump(),
                    status="review" if candidates or counts[key] > 1 or by_weak[weak] else "new",
                    candidates=[item.id for item in candidates],
                )
            )
    return result


async def stage(
    db: AsyncSession,
    config: Settings,
    owner: str,
    preview_id: str,
    filename: str,
    file_hash: str,
    statement: Statement,
) -> Preview:
    state = await lock_state(db)
    account = await check_account(db, statement.iban)
    rows = await match_rows(db, statement.rows)
    known_file = await db.scalar(select(ImportRun).where(ImportRun.file_hash == file_hash))
    if known_file:
        links = (
            await db.scalars(select(ImportRow).where(ImportRow.import_id == known_file.id))
        ).all()
        by_ordinal = {link.ordinal: link.transaction_id for link in links}
        if set(by_ordinal) != {row.ordinal for row in rows}:
            raise AppError("source_mapping_mismatch", 409)
        for row in rows:
            target = await db.get(Transaction, by_ordinal[row.ordinal])
            if target is None or source_key(row) != target.source_key:
                raise AppError("source_mapping_mismatch", 409)
            row.status, row.candidates = "duplicate", [target.id]
            row.category_id, row.merchant, row.tags = (
                target.category_id,
                target.merchant,
                target.tags,
            )
            row.classification_source = target.classification_source
    if account:
        rows = apply_rules(rows, await rules_list(db), statement.iban)
    preview = Preview(
        id=preview_id,
        owner=owner,
        expires_at=utcnow() + timedelta(hours=config.preview_hours),
        revision=state.revision,
        version=1,
        filename=filename,
        file_hash=file_hash,
        iban=statement.iban,
        account_confirmed=account is not None,
        payload={"rows": [row.model_dump(mode="json") for row in rows]},
    )
    db.add(preview)
    await db.commit()
    return preview


def preview_rows(preview: Preview) -> list[PreviewRow]:
    return [PreviewRow.model_validate(row) for row in preview.payload["rows"]]


async def get_preview(db: AsyncSession, preview_id: str, owner: str) -> Preview:
    preview = await db.get(Preview, preview_id)
    if preview is None or preview.owner != owner:
        raise AppError("preview_not_found", 404)
    if not preview.committed_import_id and aware(preview.expires_at) <= utcnow():
        raise AppError("preview_expired", 410)
    await check_account(db, preview.iban)
    return preview


def check_version(preview: Preview, version: int, state: State) -> None:
    if preview.version != version or preview.revision != state.revision:
        raise AppError("preview_stale", 409)


def ai_in_progress(preview: Preview) -> bool:
    claim = preview.payload.get("ai_request")
    return bool(claim and claim["expires_at"] > utcnow().timestamp())


def ensure_ai_idle(preview: Preview) -> None:
    if ai_in_progress(preview):
        raise AppError("ai_in_progress", 409)


async def preview_out(db: AsyncSession, preview: Preview, config: Settings) -> PreviewOut:
    return PreviewOut(
        id=preview.id,
        filename=preview.filename,
        iban=preview.iban,
        account_confirmed=preview.account_confirmed,
        initial_account=await db.get(Account, 1) is None,
        expires_at=preview.expires_at,
        version=preview.version,
        rows=preview_rows(preview),
        ai_enabled=config.ai_enabled,
        ai_in_progress=ai_in_progress(preview),
        committed_import_id=preview.committed_import_id,
    )


async def suggest(
    db: AsyncSession,
    config: Settings,
    owner: str,
    preview_id: str,
    body: ai.AIRequest,
) -> Preview:
    state = await lock_state(db)
    value = await get_preview(db, preview_id, owner)
    check_version(value, body.version, state)
    ensure_ai_idle(value)
    if value.committed_import_id:
        raise AppError("import_already_confirmed", 409)
    if not value.account_confirmed:
        raise AppError("account_confirmation_required", 409)
    if not config.ai_enabled:
        raise AppError("ai_disabled", 409)
    rows = preview_rows(value)
    excluded = set(body.exclude_ordinals)
    if not excluded <= {row.ordinal for row in rows}:
        raise AppError("invalid_decision")
    batch = [
        row
        for row in rows
        if row.status != "duplicate"
        and not row.skip_ai
        and not row.ai_reviewed
        and row.ordinal not in excluded
    ][:30]
    if not batch:
        return value
    texts = [ai.AIText(ordinal=row.ordinal, text=ai.sanitize(row.description)) for row in batch]
    categories = [
        CatalogOut.model_validate(item)
        for item in (await db.scalars(select(Category).order_by(Category.id))).all()
    ]
    tags = [
        CatalogOut.model_validate(item)
        for item in (await db.scalars(select(Tag).order_by(Tag.id))).all()
    ]
    claim_id = str(uuid4())
    value.payload = {
        **value.payload,
        "ai_request": {"id": claim_id, "expires_at": (utcnow() + timedelta(minutes=2)).timestamp()},
    }
    # Release the database lock before the provider call; the lease blocks overlapping requests.
    await db.commit()
    released = False
    try:
        proposals = await ai.classify(config, texts, categories, tags)
        db.expire_all()
        state = await lock_state(db)
        value = await get_preview(db, preview_id, owner)
        check_version(value, body.version, state)
        claim = value.payload.get("ai_request")
        if value.committed_import_id or not claim or claim["id"] != claim_id:
            raise AppError("preview_stale", 409)
        await validate_enrichment(db, proposals.rows)
        by_ordinal = {row.ordinal: row for row in proposals.rows}
        for row in rows:
            if row.ordinal in by_ordinal:
                pick = by_ordinal[row.ordinal]
                row.category_id, row.merchant, row.tags = pick.category_id, pick.merchant, pick.tags
                row.classification_source = "ai"
                row.ai_reviewed = True
        rows = apply_rules(rows, await rules_list(db), value.iban)
        value.payload = {"rows": [row.model_dump(mode="json") for row in rows]}
        value.version += 1
        await db.commit()
        released = True
        return value
    finally:
        if not released:
            await db.rollback()
            await lock_state(db)
            current = await db.get(Preview, preview_id, populate_existing=True)
            claim = current.payload.get("ai_request") if current else None
            if current and claim and claim["id"] == claim_id:
                current.payload = {**current.payload, "ai_request": None}
                await db.commit()


async def import_out(db: AsyncSession, record: ImportRun) -> ImportOut:
    count = await db.scalar(
        select(func.count()).select_from(ImportRow).where(ImportRow.import_id == record.id)
    )
    return ImportOut(
        id=record.id,
        filename=record.filename,
        created_at=record.created_at,
        start_date=record.start_date,
        end_date=record.end_date,
        opening_balance=record.opening_balance,
        closing_balance=record.closing_balance,
        inserted=record.inserted,
        duplicates=record.duplicates,
        count=count or 0,
    )


async def confirm(
    db: AsyncSession,
    owner: str,
    preview_id: str,
    body: ConfirmIn,
    *,
    language: Language,
) -> ImportRun:
    state = await lock_state(db)
    preview = await get_preview(db, preview_id, owner)
    if preview.committed_import_id:
        existing = await db.get(ImportRun, preview.committed_import_id)
        if existing is None:
            raise AppError("import_removed", 410)
        return existing
    check_version(preview, body.version, state)
    ensure_ai_idle(preview)
    if not preview.account_confirmed:
        raise AppError("account_confirmation_required", 409)
    existing = await db.scalar(select(ImportRun).where(ImportRun.file_hash == preview.file_hash))
    if existing:
        preview.committed_import_id = existing.id
        await db.commit()
        return existing
    rows = preview_rows(preview)
    decisions = {decision.ordinal: decision for decision in body.decisions}
    if len(decisions) != len(body.decisions) or not set(decisions) <= {r.ordinal for r in rows}:
        raise AppError("invalid_decision")
    await validate_enrichment(
        db,
        [decision.enrichment for decision in body.decisions if decision.enrichment is not None]
        + [Enrichment(category_id=r.category_id, merchant=r.merchant, tags=r.tags) for r in rows],
    )
    if await check_account(db, preview.iban) is None:
        db.add(Account(id=1, iban=preview.iban, name=texts(language).account_name))
    record = ImportRun(
        id=preview.id,
        filename=preview.filename,
        file_hash=preview.file_hash,
        start_date=min(row.booking_date for row in rows),
        end_date=max(row.booking_date for row in rows),
        opening_balance=rows[-1].balance_after - rows[-1].amount,
        closing_balance=rows[0].balance_after,
        inserted=0,
        duplicates=0,
    )
    db.add(record)
    await db.flush()
    used_ids: set[int] = set()
    created_keys: set[str] = set()
    for row in rows:
        decision = decisions.get(row.ordinal)
        existing_id: int | None = None
        if row.status == "duplicate":
            if decision and (decision.create_new or decision.enrichment):
                raise AppError("invalid_decision")
            existing_id = row.candidates[0]
        elif row.status == "review":
            if decision is None or bool(decision.existing_id) == decision.create_new:
                raise AppError("review_required", 409)
            if decision.existing_id and decision.existing_id not in row.candidates:
                raise AppError("invalid_decision")
            existing_id = decision.existing_id
        elif decision and decision.existing_id:
            raise AppError("invalid_decision")
        if existing_id:
            if existing_id in used_ids:
                raise AppError("duplicate_mapping", 409)
            used_ids.add(existing_id)
            record.duplicates += 1
            transaction_id = existing_id
        else:
            key = source_key(row)
            metadata = (
                await resolve_enrichment(db, decision.enrichment)
                if decision and decision.enrichment
                else Enrichment(
                    category_id=row.category_id,
                    merchant=row.merchant,
                    tags=row.tags,
                )
            )
            transaction = Transaction(
                source_key=key,
                weak_key=source_key(row, include_balance=False),
                identity_key=digest(key + ":" + str(uuid4()))
                if row.candidates or key in created_keys
                else key,
                booking_date=row.booking_date,
                value_date=row.value_date,
                description=row.description,
                amount=row.amount,
                balance_after=row.balance_after,
                **metadata.model_dump(),
                classification_source="manual"
                if decision and decision.enrichment
                else row.classification_source,
            )
            db.add(transaction)
            await db.flush()
            transaction_id = transaction.id
            created_keys.add(key)
            used_ids.add(transaction_id)
            record.inserted += 1
        db.add(
            ImportRow(
                import_id=record.id,
                ordinal=row.ordinal,
                page=row.page,
                source=row.model_dump(mode="json", include=set(ParsedRow.model_fields)),
                transaction_id=transaction_id,
            )
        )
    await db.flush()
    await db.run_sync(lambda session: rebuild_bank_order(session.connection()))
    preview.committed_import_id = record.id
    state.revision += 1
    await db.commit()
    return record


async def removal_impact(db: AsyncSession, import_id: str) -> tuple[DeleteImpact, list[int]]:
    if await db.get(ImportRun, import_id) is None:
        raise AppError("import_not_found", 404)
    own = set(
        (
            await db.scalars(
                select(ImportRow.transaction_id).where(ImportRow.import_id == import_id)
            )
        ).all()
    )
    shared = set(
        (
            await db.scalars(
                select(ImportRow.transaction_id).where(
                    ImportRow.transaction_id.in_(own),
                    ImportRow.import_id != import_id,
                )
            )
        ).all()
    )
    state = await db.get(State, 1)
    if state is None:
        raise RuntimeError("Missing application state")
    orphan_ids = sorted(own - shared)
    return DeleteImpact(
        revision=state.revision,
        removed_transactions=len(orphan_ids),
        retained_transactions=len(shared),
    ), orphan_ids


async def remove_import(db: AsyncSession, import_id: str, revision: int) -> None:
    state = await lock_state(db)
    if state.revision != revision:
        raise AppError("preview_stale", 409)
    _, orphan_ids = await removal_impact(db, import_id)
    await db.execute(delete(ImportRow).where(ImportRow.import_id == import_id))
    await db.execute(delete(Transaction).where(Transaction.id.in_(orphan_ids)))
    await db.execute(delete(ImportRun).where(ImportRun.id == import_id))
    await db.run_sync(lambda session: rebuild_bank_order(session.connection()))
    state.revision += 1
    await db.commit()


async def clean_expired(db: AsyncSession, directory: Path) -> None:
    expired = (await db.scalars(select(Preview).where(Preview.expires_at < utcnow()))).all()
    for preview in expired:
        retained = await db.get(ImportRun, preview.id)
        if retained is None:
            (directory / f"{preview.id}.pdf").unlink(missing_ok=True)
        await db.delete(preview)
    await db.commit()
