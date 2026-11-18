"""Administrators from the server's command line, with the application's settings:

    docker compose exec api python -m juntia.admins list
    docker compose exec api python -m juntia.admins grant EMAIL
    docker compose exec api python -m juntia.admins revoke EMAIL
    docker compose exec api python -m juntia.admins invite EMAIL --name NAME
    docker compose exec api python -m juntia.admins password-link EMAIL

Links are printed once for every PUBLIC_ORIGIN and work once. Nothing is sent by email.
"""

import argparse
import asyncio
import sys
from collections.abc import Awaitable, Callable

from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import Settings
from .contracts import EmailIn, display_name
from .db import Dwelling, State, User, utcnow
from .errors import AppError
from .users import active_administrator, issue_token, require_administrator_remains


class CommandError(Exception):
    """A refusal, reported on standard error with exit status 1."""


Command = Callable[[AsyncSession, Settings, argparse.Namespace], Awaitable[None]]


def normalized_email(value: str) -> str:
    try:
        return EmailIn(email=value).email
    except ValidationError:
        raise CommandError(f"Not a valid email address: {value}") from None


def status(user: User) -> str:
    return "disabled" if user.disabled else "active" if user.activated else "pending"


async def account(db: AsyncSession, email: str) -> User:
    address = normalized_email(email)
    user = await db.scalar(
        select(User).where(User.email == address).with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise CommandError(f"No account uses {address}.")
    return user


def print_links(config: Settings, route: str, token: str) -> None:
    for origin in config.public_origins:
        print(f"{origin}/{route}#token={token}")


async def list_administrators(
    db: AsyncSession, config: Settings, args: argparse.Namespace,
) -> None:
    rows = (await db.execute(
        select(User, Dwelling.label).outerjoin(Dwelling, Dwelling.id == User.dwelling_id)
        .where(User.administrator.is_(True)).order_by(User.email)
    )).all()
    if not rows:
        print("No account is an administrator.")
    for user, dwelling in rows:
        print(f"{user.email}\t{user.name}\t{status(user)}\t{dwelling or 'no dwelling'}")


async def grant(db: AsyncSession, config: Settings, args: argparse.Namespace) -> None:
    user = await account(db, args.email)
    if user.disabled or not user.activated:
        raise CommandError(
            f"{user.email} is {status(user)}: only an active account becomes an administrator."
        )
    if user.administrator:
        print(f"{user.email} is already an administrator.")
        return
    user.administrator = True
    user.version += 1
    await db.commit()
    print(f"{user.email} is now an administrator: Administration is in their user menu.")


async def revoke(db: AsyncSession, config: Settings, args: argparse.Namespace) -> None:
    user = await account(db, args.email)
    if not user.administrator:
        print(f"{user.email} is not an administrator.")
        return
    if user.dwelling_id is None:
        raise CommandError(
            f"{user.email} has no dwelling, which every resident needs: assign one in "
            "Administration, Settings > Users, first."
        )
    was_administrator = active_administrator(user)
    user.administrator = False
    user.version += 1
    if was_administrator:
        try:
            await require_administrator_remains(db)
        except AppError:
            raise CommandError(
                f"{user.email} is the last active administrator: grant the role to someone "
                "else first."
            ) from None
    await db.commit()
    print(f"{user.email} is no longer an administrator.")


async def invite(db: AsyncSession, config: Settings, args: argparse.Namespace) -> None:
    email = normalized_email(args.email)
    try:
        name = display_name(args.name)
    except ValueError:
        raise CommandError("Give a name with visible characters.") from None
    if len(name) > 150:
        raise CommandError("Give a name of at most 150 characters.")
    if await db.scalar(select(User.id).where(User.email == email)) is not None:
        raise CommandError(f"{email} already has an account: use grant or password-link.")
    user = User(email=email, name=name, administrator=True)
    db.add(user)
    await db.flush()
    token = await issue_token(db, config, user, "invitation")
    user.invitation_delivery = "sent"
    user.invitation_sent_at = utcnow()
    # An installation with accounts never offers the first-run setup again.
    await db.execute(update(State).where(State.id == 1).values(setup_open=False))
    await db.commit()
    print(
        f"{email} is invited as an administrator. Open this link to choose a password (or sign "
        "in with Google, when configured); it works once, within 72 hours:"
    )
    print_links(config, "activate", token)


async def password_link(db: AsyncSession, config: Settings, args: argparse.Namespace) -> None:
    user = await account(db, args.email)
    if user.disabled:
        raise CommandError(f"{user.email} is disabled: reactivate it in Administration, Settings > Users, first.")
    if user.activated:
        token = await issue_token(db, config, user, "recovery")
        route, lifetime = "reset-password", "1 hour"
    else:
        # A pending account gets a new activation link instead.
        token = await issue_token(db, config, user, "invitation")
        user.invitation_delivery = "sent"
        user.invitation_sent_at = utcnow()
        user.version += 1
        route, lifetime = "activate", "72 hours"
    await db.commit()
    print(f"Open this link to choose a password for {user.email}; it works once, within {lifetime}:")
    print_links(config, route, token)


COMMANDS: dict[str, Command] = {
    "list": list_administrators,
    "grant": grant,
    "revoke": revoke,
    "invite": invite,
    "password-link": password_link,
}


async def run(config: Settings, command: Command, args: argparse.Namespace) -> None:
    engine = create_async_engine(config.database_url, hide_parameters=True)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            if await db.get(State, 1) is None:
                raise CommandError("Run the migrations and seed.py first.")
            await command(db, config, args)
    finally:
        await engine.dispose()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="python -m juntia.admins",
        description="Manage Juntia's administrators with the application's settings.",
    )
    commands = result.add_subparsers(dest="command", required=True, metavar="COMMAND")
    commands.add_parser("list", help="show the accounts with the administrator role")
    for name, text in (
        ("grant", "make an existing active account an administrator"),
        ("revoke", "take the role away, never from the last active administrator"),
        ("password-link", "print a one-time link to choose a new password"),
    ):
        commands.add_parser(name, help=text).add_argument("email")
    invitation = commands.add_parser(
        "invite", help="create a pending administrator and print its activation link",
    )
    invitation.add_argument("email")
    invitation.add_argument("--name", required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = Settings()
    except ValidationError as error:
        print(f"Invalid settings:\n{error}", file=sys.stderr)
        return 2
    try:
        asyncio.run(run(config, COMMANDS[args.command], args))
    except CommandError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
