"""What's new: which notes about the portal's changes each account has already read.

The notes ship with the interface (``frontend/src/whats-new/notes/``, one JSON file per note named
``YYYY-MM-DD-slug``) and the server never reads them: it only keeps the ids each account has read
(``users.whats_new_seen``). NULL means the interface never recorded any, as for a new account: it
then marks every current note as read without showing them, so only later changes are announced."""

from fastapi import APIRouter, Request
from sqlalchemy import select, update

from .auth import DB, CurrentUser, mutation_session
from .contracts import WhatsNewOut, WhatsNewSeenIn
from .db import User
from .errors import AppError

router = APIRouter(prefix="/api", tags=["What's new"])

# The newest ids kept per account: far more notes than will ever ship, and a bound on what an
# account can make the server store.
MAX_SEEN = 1000


def seen_out(seen: object) -> WhatsNewOut:
    return WhatsNewOut(seen=seen if isinstance(seen, list) else None)


@router.get("/whats-new", response_model=WhatsNewOut)
async def whats_new(user_id: CurrentUser, db: DB) -> WhatsNewOut:
    return seen_out(await db.scalar(select(User.whats_new_seen).where(User.id == user_id)))


@router.post("/whats-new/seen", response_model=WhatsNewOut)
async def mark_seen(body: WhatsNewSeenIn, request: Request, db: DB) -> WhatsNewOut:
    """Add ``ids`` to the notes the account has read (ids already there change nothing)."""
    # The account's row stays locked until the commit, so two tabs saving at once both add theirs.
    identity = await mutation_session(request, db)
    if identity.user_id is None:
        raise AppError("authentication_required", 401)
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE; acquire its write lock before reading the list again.
        await db.execute(
            update(User).where(User.id == identity.user_id)
            .values(whats_new_seen=User.whats_new_seen)
        )
    account = await db.get(User, identity.user_id, with_for_update=True, populate_existing=True)
    if account is None:
        raise AppError("authentication_required", 401)
    read = account.whats_new_seen if isinstance(account.whats_new_seen, list) else []
    # Ids start with their date: sorted, the newest are the last.
    account.whats_new_seen = sorted({*read, *body.ids})[-MAX_SEEN:]
    await db.commit()
    return seen_out(account.whats_new_seen)
