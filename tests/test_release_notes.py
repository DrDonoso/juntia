"""scripts/release_notes.py: the "What's new" section of each GitHub release, from the notes added
since the previous one."""

import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "release_notes.py"


def load_script():
    spec = importlib.util.spec_from_file_location("release_notes", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release_notes = load_script()


def note(kind, title, audience="everyone"):
    text = {"title": title, "body": f"About {title.lower()}."}
    return {"kind": kind, "audience": audience, "en": text, "es": text}


def write(folder, note_id, content):
    path = folder / f"{note_id}.json"
    path.write_text(json.dumps(content), encoding="utf-8")
    return path


def git(root, *args):
    command = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.org", *args]
    subprocess.run(command, cwd=root, check=True, capture_output=True)


def test_new_things_first_then_improvements_and_fixes(tmp_path):
    paths = [
        write(tmp_path, "2026-12-01-search", note("improved", "Search")),
        write(tmp_path, "2026-12-02-uploads", note("fixed", "Uploads")),
        write(tmp_path, "2026-12-03-storage", note("new", "Storage", "admins")),
        write(tmp_path, "2026-12-04-folders", note("new", "Folders")),
    ]
    assert release_notes.markdown(paths) == (
        "## What's new\n\n"
        "### New\n\n"
        "- **Folders**: About folders.\n"
        "- **Storage** *(administrators)*: About storage.\n\n"
        "### Improved\n\n"
        "- **Search**: About search.\n\n"
        "### Fixed\n\n"
        "- **Uploads**: About uploads.\n\n"
    )
    assert release_notes.markdown([]) == ""


def test_only_the_notes_added_since_the_previous_release(tmp_path):
    folder = tmp_path / release_notes.NOTES
    folder.mkdir(parents=True)
    git(tmp_path, "init", "--quiet")
    write(folder, "2026-11-17-whats-new", note("new", "What's new"))
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "--quiet", "-m", "First release")
    git(tmp_path, "tag", "20261117")
    # Rewording a published note does not announce it again.
    write(folder, "2026-11-17-whats-new", note("new", "What's new, reworded"))
    write(folder, "2026-12-01-search", note("improved", "Search"))
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "--quiet", "-m", "Second release")

    assert release_notes.added_notes(tmp_path, "20261117") == [folder / "2026-12-01-search.json"]
    # The first release: every note.
    assert release_notes.added_notes(tmp_path, "") == [
        folder / "2026-11-17-whats-new.json",
        folder / "2026-12-01-search.json",
    ]


def test_every_note_of_the_app_renders():
    paths = release_notes.added_notes(ROOT, "")
    assert paths
    text = release_notes.markdown(paths)
    assert text.startswith("## What's new\n")
    assert "- **Now we tell you what's new**: When your community's portal gets something new" in text
