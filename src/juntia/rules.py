"""Bounded first-match rule semantics."""

import logging

import regex

from .contracts import Enrichment, ParsedRow, PreviewRow, RuleIn, RuleOut
from .errors import AppError

log = logging.getLogger(__name__)


def validate_patterns(rule: RuleIn) -> None:
    for mode, pattern in (
        (rule.description_mode, rule.description_value),
        (rule.detail_mode, rule.detail_value),
    ):
        if mode == "regex" and pattern:
            try:
                regex.compile(pattern, regex.IGNORECASE)
            except regex.error:
                raise AppError("invalid_regex") from None


def text_matches(value: str, mode: str, pattern: str) -> bool:
    if mode == "contains":
        return pattern.casefold() in value.casefold()
    if mode == "starts_with":
        return value.casefold().startswith(pattern.casefold())
    if mode == "exact":
        return value.casefold() == pattern.casefold()
    try:
        return regex.search(pattern, value, flags=regex.IGNORECASE, timeout=0.05) is not None
    except (TimeoutError, regex.error):
        log.warning("Rule regular expression failed or exceeded its execution limit")
        raise AppError("rule_timeout") from None


def matches(rule: RuleIn, row: ParsedRow, iban: str) -> bool:
    if not rule.enabled or rule.account_ref and rule.account_ref != iban:
        return False
    if rule.amount_sign == "positive" and row.amount <= 0:
        return False
    if rule.amount_sign == "negative" and row.amount >= 0:
        return False
    if rule.amount_min is not None and abs(row.amount) < rule.amount_min:
        return False
    if rule.amount_max is not None and abs(row.amount) > rule.amount_max:
        return False
    if not text_matches(row.description, rule.description_mode, rule.description_value):
        return False
    # This bank has one concept column, not a separate detail field.
    if rule.detail_mode and rule.detail_value:
        return text_matches("", rule.detail_mode, rule.detail_value)
    return True


def rule_metadata(rule: RuleIn, current: Enrichment) -> Enrichment:
    return Enrichment(
        category_id=rule.set_category if rule.set_category is not None else current.category_id,
        merchant=rule.set_merchant if rule.set_merchant is not None else current.merchant,
        tags=sorted(set(current.tags) | set(rule.add_tags)),
    )


def apply_rules(rows: list[PreviewRow], rules: list[RuleOut], iban: str) -> list[PreviewRow]:
    result = []
    for row in rows:
        updated = row.model_copy(deep=True)
        if row.status != "duplicate":
            for rule in sorted(rules, key=lambda item: (item.priority, item.id)):
                if matches(rule, row, iban):
                    metadata = rule_metadata(
                        rule,
                        Enrichment(
                            category_id=row.category_id, merchant=row.merchant, tags=row.tags
                        ),
                    )
                    updated = updated.model_copy(
                        update={
                            **metadata.model_dump(),
                            "matched_rule": rule.name,
                            "classification_source": "rule",
                            "skip_ai": rule.skip_ai,
                        }
                    )
                    break
        result.append(updated)
    return result
