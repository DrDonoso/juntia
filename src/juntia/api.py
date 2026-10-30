import hashlib
import logging
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, UploadFile
from pydantic import Field
from sqlalchemy import Select, select, update
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse

from . import ai, imports, queries
from .auth import DB, Admin, reader_session, settings
from .contracts import (
    AccountConfirmation,
    AccountOut,
    CatalogIn,
    CatalogOut,
    ConfirmIn,
    Contract,
    DeleteImpact,
    DwellingLayoutOut,
    DwellingNeighborsOut,
    EditTransaction,
    Enrichment,
    FeatureFlagIn,
    FeatureFlagsOut,
    GeneralSettings,
    ImportOut,
    ParsedRow,
    PreviewOut,
    RevisionIn,
    RuleImpact,
    RuleIn,
    RuleOut,
    SummaryOut,
    TransactionOut,
    TransactionPage,
    tag_name_key,
)
from .db import Account, Category, ImportRun, Rule, State, Tag, Transaction, lock_state
from .errors import AppError
from .identity import normalize_iban
from .parser import MAX_BYTES, parse_file_bounded
from .rules import apply_rules, matches, rule_metadata, validate_patterns
from .storage import ensure_free_space, out_of_space
from .texts import ServerLanguage

log = logging.getLogger(__name__)
reader = APIRouter(prefix="/api", tags=["Finance"], dependencies=[Depends(reader_session)])
public_router = APIRouter(prefix="/api", tags=["Branding"])
admin_router = APIRouter(prefix="/api/admin", tags=["Administration"])
Kind = Literal["categories", "tags"]


@public_router.get("/features", response_model=FeatureFlagsOut, tags=["Features"])
async def feature_flags(request: Request, db: DB) -> FeatureFlagsOut:
    flags = await queries.feature_flags(db)
    return FeatureFlagsOut(
        coefficient=flags.coefficient, actions=flags.actions, events=flags.events,
        google_login=settings(request).google_enabled,
    )


@admin_router.patch("/settings/features/{feature}", response_model=FeatureFlagsOut, tags=["Features"])
async def update_feature_flag(
    feature: Literal["coefficient", "actions", "events"],
    body: FeatureFlagIn,
    request: Request,
    db: DB,
    admin: Admin,
) -> FeatureFlagsOut:
    column = {
        "coefficient": State.feature_coefficient,
        "actions": State.feature_actions,
        "events": State.feature_events,
    }[feature]
    changed = await db.scalar(
        update(State).where(State.id == 1).values({column: body.enabled}).returning(State.id)
    )
    if changed is None:
        raise RuntimeError("Missing application state")
    await db.commit()
    return await feature_flags(request, db)


@reader.get("/neighbors", response_model=list[DwellingNeighborsOut], tags=["Neighbors"])
async def neighbors(db: DB) -> list[DwellingNeighborsOut]:
    return await queries.neighbor_directory(db)


@reader.get("/neighbors/layout", response_model=DwellingLayoutOut, tags=["Neighbors"])
async def read_dwelling_layout(db: DB) -> DwellingLayoutOut:
    return await queries.dwelling_layout(db)


@public_router.get("/settings/general", response_model=GeneralSettings)
async def read_general_settings(db: DB) -> GeneralSettings:
    return await queries.general_settings(db)


@admin_router.patch("/settings/general", response_model=GeneralSettings)
async def update_general_settings(body: GeneralSettings, db: DB, admin: Admin) -> GeneralSettings:
    state = await lock_state(db)
    state.community_name = body.community_name
    await db.commit()
    return await queries.general_settings(db)


class AccountName(Contract):
    name: str = Field(min_length=1, max_length=150)


@admin_router.patch("/account", response_model=AccountOut)
async def rename_account(body: AccountName, db: DB, admin: Admin) -> AccountOut:
    state = await lock_state(db)
    value = await db.get(Account, 1)
    if value is None:
        raise AppError("account_confirmation_required", 409)
    if not body.name.strip():
        raise AppError("invalid_request")
    value.name = body.name.strip()
    state.revision += 1
    await db.commit()
    return AccountOut.model_validate(value)


async def filtered(
    db: DB,
    start: date | None = None,
    end: date | None = None,
    q: str = "",
    category: int | None = None,
    tag: Annotated[list[int] | None, Query()] = None,
    flow: Literal["", "income", "expense"] = "",
    merchant: str = "",
    minimum: Decimal | None = None,
    maximum: Decimal | None = None,
    uncategorized: bool = False,
    merchant_exact: str | None = None,
) -> Select[Transaction]:
    return queries.transactions(
        db,
        start,
        end,
        q,
        category,
        tag,
        flow,
        merchant,
        minimum,
        maximum,
        uncategorized,
        merchant_exact,
    )


FilteredTransactions = Annotated[Select[Transaction], Depends(filtered)]


@reader.get("/account", response_model=AccountOut | None)
async def account(db: DB) -> AccountOut | None:
    value = await db.get(Account, 1)
    return AccountOut.model_validate(value) if value else None


@reader.get("/transactions", response_model=TransactionPage)
async def transaction_list(
    query: FilteredTransactions,
    db: DB,
    page: Annotated[int, Query(ge=1)] = 1,
    sort: Literal[
        "date", "description", "category", "amount", "balance",
        "newest", "oldest",
    ] = "date",
    direction: Literal["asc", "desc"] | None = None,
) -> TransactionPage:
    return await queries.transaction_page(db, query, page, sort, direction)


@reader.get("/summary", response_model=SummaryOut)
async def summary(query: FilteredTransactions, db: DB, language: ServerLanguage) -> SummaryOut:
    return await queries.summary(db, query, language)


@reader.get("/catalog/{kind}", response_model=list[CatalogOut])
async def catalog(kind: Kind, db: DB) -> list[CatalogOut]:
    if kind == "tags":
        return await queries.tag_catalog(db)
    return [
        CatalogOut.model_validate(row)
        for row in (await db.scalars(select(Category).order_by(Category.name))).all()
    ]


@admin_router.get("/statements", response_model=list[ImportOut])
async def statements(db: DB, admin: Admin) -> list[ImportOut]:
    records = (await db.scalars(select(ImportRun).order_by(ImportRun.created_at.desc()))).all()
    return [await imports.import_out(db, record) for record in records]


@admin_router.get("/statements/{import_id}/original", response_class=FileResponse)
async def original(import_id: UUID, db: DB, request: Request, admin: Admin) -> FileResponse:
    record = await db.get(ImportRun, str(import_id))
    if record is None:
        raise AppError("import_not_found", 404)
    path = settings(request).upload_dir / f"{record.id}.pdf"
    if not path.is_file():
        log.error("A retained statement source is missing")
        raise AppError("source_missing", 503)
    return FileResponse(path, media_type="application/pdf", filename=record.filename)


@admin_router.post("/imports/preview", response_model=PreviewOut)
async def upload(file: UploadFile, request: Request, db: DB, admin: Admin) -> PreviewOut:
    config = settings(request)
    await imports.clean_expired(db, config.upload_dir)
    if file.size is not None and file.size > MAX_BYTES:
        raise AppError("upload_too_large", 413)
    await run_in_threadpool(
        ensure_free_space, config.upload_dir,
        MAX_BYTES if file.size is None else file.size, config.min_free_disk_mb,
    )
    content = bytearray()
    while chunk := await file.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > MAX_BYTES:
            raise AppError("upload_too_large", 413)
    preview_id = str(uuid4())
    path = config.upload_dir / f"{preview_id}.pdf"
    filename = re.sub(r"[\x00-\x1f\x7f]", "", Path(file.filename or "statement.pdf").name)[:255]
    try:
        try:
            await run_in_threadpool(path.write_bytes, bytes(content))
        except OSError as error:
            if out_of_space(error):
                log.error("A statement upload did not fit on the upload volume")
                raise AppError("storage_low_space", 507) from None
            raise
        statement = await run_in_threadpool(parse_file_bounded, path)
        preview = await imports.stage(
            db,
            config,
            admin,
            preview_id,
            filename,
            hashlib.sha256(content).hexdigest(),
            statement,
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return await imports.preview_out(db, preview, config)


@admin_router.get("/imports/{preview_id}", response_model=PreviewOut)
async def preview(preview_id: UUID, request: Request, db: DB, admin: Admin) -> PreviewOut:
    value = await imports.get_preview(db, str(preview_id), admin)
    return await imports.preview_out(db, value, settings(request))


@admin_router.post("/imports/{preview_id}/account", response_model=PreviewOut)
async def confirm_account(
    preview_id: UUID,
    body: AccountConfirmation,
    request: Request,
    db: DB,
    admin: Admin,
) -> PreviewOut:
    state = await lock_state(db)
    value = await imports.get_preview(db, str(preview_id), admin)
    imports.check_version(value, body.version, state)
    imports.ensure_ai_idle(value)
    if value.committed_import_id:
        raise AppError("import_already_confirmed", 409)
    if value.iban != normalize_iban(body.iban):
        raise AppError("account_mismatch", 409)
    value.account_confirmed = True
    rows = apply_rules(imports.preview_rows(value), await imports.rules_list(db), value.iban)
    value.payload = {"rows": [row.model_dump(mode="json") for row in rows]}
    value.version += 1
    await db.commit()
    return await imports.preview_out(db, value, settings(request))


@admin_router.post("/imports/{preview_id}/ai", response_model=PreviewOut)
async def enrich(
    preview_id: UUID,
    body: ai.AIRequest,
    request: Request,
    db: DB,
    admin: Admin,
) -> PreviewOut:
    value = await imports.suggest(db, settings(request), admin, str(preview_id), body)
    return await imports.preview_out(db, value, settings(request))


@admin_router.post("/imports/{preview_id}/confirm", response_model=ImportOut)
async def confirm_import(
    preview_id: UUID,
    body: ConfirmIn,
    request: Request,
    db: DB,
    admin: Admin,
    language: ServerLanguage,
) -> ImportOut:
    record = await imports.confirm(db, admin, str(preview_id), body, language=language)
    result = await imports.import_out(db, record)
    if record.id != str(preview_id):
        (settings(request).upload_dir / f"{preview_id}.pdf").unlink(missing_ok=True)
        result = result.model_copy(update={"inserted": 0, "duplicates": result.count})
    return result


@admin_router.get("/statements/{import_id}/removal", response_model=DeleteImpact)
async def removal(import_id: UUID, db: DB, admin: Admin) -> DeleteImpact:
    impact, _ = await imports.removal_impact(db, str(import_id))
    return impact


@admin_router.delete("/statements/{import_id}", status_code=204)
async def delete_import(
    import_id: UUID,
    body: RevisionIn,
    request: Request,
    db: DB,
    admin: Admin,
) -> None:
    await imports.remove_import(db, str(import_id), body.revision)
    try:
        (settings(request).upload_dir / f"{import_id}.pdf").unlink(missing_ok=True)
    except OSError:
        log.exception("Removed statement could not be cleaned up from private storage")
        raise AppError("source_cleanup_failed", 500) from None


@admin_router.patch("/transactions/{transaction_id}", response_model=TransactionOut)
async def edit_transaction(
    transaction_id: int,
    body: EditTransaction,
    db: DB,
    admin: Admin,
) -> TransactionOut:
    state = await lock_state(db)
    value = await db.get(Transaction, transaction_id)
    if value is None:
        raise AppError("transaction_not_found", 404)
    if value.version != body.version:
        raise AppError("preview_stale", 409)
    await imports.validate_enrichment(db, [body])
    metadata = await imports.resolve_enrichment(db, body)
    value.category_id, value.merchant, value.tags = (
        metadata.category_id, metadata.merchant, metadata.tags,
    )
    value.classification_source = "manual"
    value.version += 1
    state.revision += 1
    await db.commit()
    return TransactionOut.model_validate(value)


@admin_router.post("/catalog/{kind}", response_model=CatalogOut, status_code=201)
async def create_catalog(kind: Kind, body: CatalogIn, db: DB, admin: Admin) -> CatalogOut:
    state = await lock_state(db)
    model = Category if kind == "categories" else Tag
    names = (await db.scalars(select(model.name))).all()
    name_key = tag_name_key if kind == "tags" else str.casefold
    if name_key(body.name) in {name_key(name) for name in names}:
        raise AppError("name_exists", 409)
    value = model(**body.model_dump())
    db.add(value)
    state.revision += 1
    await db.commit()
    return CatalogOut.model_validate(value)


@admin_router.patch("/catalog/{kind}/{item_id}", response_model=CatalogOut)
async def edit_catalog(
    kind: Kind,
    item_id: int,
    body: CatalogIn,
    db: DB,
    admin: Admin,
) -> CatalogOut:
    state = await lock_state(db)
    model = Category if kind == "categories" else Tag
    value = await db.get(model, item_id)
    if value is None:
        raise AppError("item_not_found", 404)
    other = (await db.scalars(select(model).where(model.id != item_id))).all()
    name_key = tag_name_key if kind == "tags" else str.casefold
    if any(name_key(item.name) == name_key(body.name) for item in other):
        raise AppError("name_exists", 409)
    value.name, value.color = body.name, body.color
    state.revision += 1
    await db.commit()
    return CatalogOut.model_validate(value)


@admin_router.delete("/catalog/{kind}/{item_id}", status_code=204)
async def delete_catalog(kind: Kind, item_id: int, db: DB, admin: Admin) -> None:
    state = await lock_state(db)
    model = Category if kind == "categories" else Tag
    value = await db.get(model, item_id)
    if value is None:
        raise AppError("item_not_found", 404)
    rows = (await db.scalars(select(Transaction))).all()
    rules = await imports.rules_list(db)
    used = (
        (
            any(row.category_id == item_id for row in rows)
            or any(rule.set_category == item_id for rule in rules)
        )
        if kind == "categories"
        else (
            any(item_id in row.tags for row in rows)
            or any(item_id in rule.add_tags for rule in rules)
        )
    )
    if used:
        raise AppError("item_in_use", 409)
    await db.delete(value)
    state.revision += 1
    await db.commit()


@admin_router.get("/rules", response_model=list[RuleOut])
async def list_rules(db: DB, admin: Admin) -> list[RuleOut]:
    return await imports.rules_list(db)


async def validate_rule(db: DB, body: RuleIn) -> None:
    validate_patterns(body)
    await imports.validate_enrichment(
        db, [Enrichment(category_id=body.set_category, tags=body.add_tags)]
    )
    if body.account_ref:
        body.account_ref = normalize_iban(body.account_ref)


@admin_router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleIn, db: DB, admin: Admin) -> RuleOut:
    state = await lock_state(db)
    await validate_rule(db, body)
    value = Rule(data=body.model_dump(mode="json"))
    db.add(value)
    state.revision += 1
    await db.commit()
    return RuleOut(id=value.id, **body.model_dump())


@admin_router.put("/rules/{rule_id}", response_model=RuleOut)
async def update_rule(rule_id: int, body: RuleIn, db: DB, admin: Admin) -> RuleOut:
    state = await lock_state(db)
    await validate_rule(db, body)
    value = await db.get(Rule, rule_id)
    if value is None:
        raise AppError("rule_not_found", 404)
    value.data = body.model_dump(mode="json")
    state.revision += 1
    await db.commit()
    return RuleOut(id=value.id, **body.model_dump())


@admin_router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: int, db: DB, admin: Admin) -> None:
    state = await lock_state(db)
    value = await db.get(Rule, rule_id)
    if value is None:
        raise AppError("rule_not_found", 404)
    await db.delete(value)
    state.revision += 1
    await db.commit()


class ApplyRule(RevisionIn):
    rule: RuleIn


async def matching_transactions(db: DB, body: RuleIn) -> list[Transaction]:
    await validate_rule(db, body)
    account_value = await db.get(Account, 1)
    if account_value is None:
        return []
    query = select(Transaction)
    if body.amount_sign == "positive":
        query = query.where(Transaction.amount > 0)
    elif body.amount_sign == "negative":
        query = query.where(Transaction.amount < 0)
    return [
        row
        for row in (await db.scalars(query)).all()
        if matches(
            body,
            ParsedRow(
                booking_date=row.booking_date,
                value_date=row.value_date,
                description=row.description,
                amount=row.amount,
                balance_after=row.balance_after,
                page=1,
                ordinal=0,
            ),
            account_value.iban,
        )
    ]


@admin_router.post("/rules/preview", response_model=RuleImpact)
async def preview_rule(body: RuleIn, db: DB, admin: Admin) -> RuleImpact:
    state = await lock_state(db)
    matches_list = await matching_transactions(db, body)
    return RuleImpact(
        revision=state.revision,
        count=len(matches_list),
        sample=[TransactionOut.model_validate(row) for row in matches_list[:10]],
    )


@admin_router.post("/rules/apply", response_model=RuleImpact)
async def apply_rule(body: ApplyRule, db: DB, admin: Admin) -> RuleImpact:
    state = await lock_state(db)
    if state.revision != body.revision:
        raise AppError("preview_stale", 409)
    rows = await matching_transactions(db, body.rule)
    for row in rows:
        metadata = rule_metadata(
            body.rule,
            Enrichment(
                category_id=row.category_id,
                tags=row.tags,
                merchant=row.merchant,
            ),
        )
        row.category_id, row.tags, row.merchant = (
            metadata.category_id,
            metadata.tags,
            metadata.merchant,
        )
        row.classification_source = "rule"
        row.version += 1
    state.revision += 1
    await db.commit()
    return RuleImpact(
        revision=state.revision,
        count=len(rows),
        sample=[TransactionOut.model_validate(row) for row in rows[:10]],
    )
