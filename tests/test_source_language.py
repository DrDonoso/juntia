"""Production code stays in English: Spanish text lives only in the Spanish server texts."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPANISH = re.compile(r"[áéíóúüñÁÉÍÓÚÜÑ¿¡]")
# Emails, first-run defaults and fallback labels for APP_LANGUAGE=es.
SPANISH_TEXTS = ROOT / "src" / "juntia" / "texts.py"


def production_sources() -> list[Path]:
    return sorted(
        path
        for path in [
            *(ROOT / "src").rglob("*.py"),
            *(ROOT / "alembic").rglob("*.py"),
            *(ROOT / "scripts").glob("*.py"),
            *(ROOT / ".github").rglob("*.yml"),
            *ROOT.glob("docker-compose*.yml"),
            ROOT / "seed.py",
            ROOT / "alembic.ini",
            ROOT / "pyproject.toml",
            ROOT / "Dockerfile",
            ROOT / "docker-entrypoint.sh",
            ROOT / ".env.example",
        ]
        if path != SPANISH_TEXTS
    )


def test_production_sources_contain_no_spanish_text():
    sources = production_sources()
    assert len(sources) > 40
    findings = [
        f"{path.relative_to(ROOT)}:{number}: {line.strip()}"
        for path in sources
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if SPANISH.search(line)
    ]
    assert findings == []


def test_spanish_server_texts_stay_in_the_texts_module():
    assert SPANISH.search(SPANISH_TEXTS.read_text(encoding="utf-8"))
