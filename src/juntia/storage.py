"""Storage budgets for retained uploads: the free-disk reserve and the byte quotas shared by the
action PDFs and the images pasted into actions, comments and events."""

import errno
import logging
from dataclasses import dataclass
from pathlib import Path
from shutil import disk_usage

from sqlalchemy import BigInteger, func, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from .config import Settings
from .contracts import ActionActorOut
from .db import ActionAttachment, CommunityImage, State
from .errors import AppError

log = logging.getLogger(__name__)
MIB = 1024 * 1024
# Application-wide key for pg_advisory_xact_lock ("juntiaPD"); nothing else uses it.
STORAGE_LOCK = 0x6A756E7469615044
OUT_OF_SPACE = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


@dataclass(frozen=True)
class DiskSpace:
    total: int
    free: int


def disk_space(directory: Path) -> DiskSpace | None:
    try:
        usage = disk_usage(directory)
    except OSError:
        log.error("Free space on the upload volume could not be checked")
        return None
    return DiskSpace(total=usage.total, free=usage.free)


def ensure_free_space(directory: Path, incoming: int, reserve_mb: int) -> None:
    """Refuse a write that would leave less than MIN_FREE_DISK_MB free on the upload volume."""
    space = disk_space(directory)
    if space is None or space.free - incoming < reserve_mb * MIB:
        log.warning("An upload was refused to keep the free-disk reserve")
        raise AppError("storage_low_space", 507)


def out_of_space(error: OSError) -> bool:
    return error.errno in OUT_OF_SPACE


async def lock_attachment_storage(db: AsyncSession) -> None:
    """Serialize stored-byte checks across all uploads until the transaction ends."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        await db.execute(select(func.pg_advisory_xact_lock(literal(STORAGE_LOCK, BigInteger()))))
    elif dialect == "sqlite":
        # SQLite has a single writer: a no-op write takes its lock before the sums are read.
        await db.execute(update(State).where(State.id == 1).values(revision=State.revision))
    else:
        raise RuntimeError("Unsupported storage database")


async def stored_bytes(db: AsyncSession, user_id: int | None = None) -> int:
    """Bytes still on disk, of one resident when `user_id` is set: active and withdrawn PDFs
    and images, until the administrator purges them."""
    total = 0
    for table in (ActionAttachment, CommunityImage):
        where: list[ColumnElement[bool]] = [table.purged_at.is_(None)]
        if user_id is not None:
            where += [table.author_kind == "resident", table.author_user_id == user_id]
        total += await db.scalar(
            select(func.coalesce(func.sum(table.size), 0)).where(*where)
        ) or 0
    return total


async def check_attachment_quota(
    db: AsyncSession, config: Settings, actor: ActionActorOut, size: int,
) -> None:
    """Check both byte budgets for a new PDF or image; callers hold lock_attachment_storage()."""
    if actor.kind == "resident" and actor.user_id is not None:
        used = await stored_bytes(db, actor.user_id)
        if used + size > config.action_storage_user_quota_mb * MIB:
            raise AppError("action_storage_user_quota", 409)
    used = await stored_bytes(db)
    if used + size > config.action_storage_community_quota_mb * MIB:
        log.warning("An upload was refused by the community storage quota")
        raise AppError("action_storage_community_quota", 409)
