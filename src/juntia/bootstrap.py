import asyncio
import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from juntia.config import Language, LanguageSettings
from juntia.db import Category, State, Tag
from juntia.texts import texts

# One color per default category, in the order of Texts.categories.
CATEGORY_COLORS = (
    "#1a4d8f", "#7755ad", "#007c91", "#b7791f", "#08735a", "#21639f", "#b43c32",
    "#6b568e", "#94673d", "#9f477b", "#696c38", "#64748b", "#525d6d",
)


async def seed(db: AsyncSession, language: Language) -> None:
    # Only a new installation gets defaults; existing data is never renamed or translated.
    if await db.get(State, 1) is None:
        defaults = texts(language)
        db.add(State(
            id=1, revision=0, login_attempts=[], community_name=defaults.community_name,
        ))
        db.add_all(
            Category(name=name, color=color)
            for name, color in zip(defaults.categories, CATEGORY_COLORS, strict=True)
        )
        db.add_all(Tag(name=name, color="#64748b") for name in defaults.tags)
    await db.commit()


async def main() -> None:
    language = LanguageSettings().app_language
    engine = create_async_engine(os.environ["DATABASE_URL"], hide_parameters=True)
    async with async_sessionmaker(engine)() as db:
        await seed(db, language)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
