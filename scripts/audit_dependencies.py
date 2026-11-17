"""Check exact public lockfile versions without uploading project files or credentials."""

import json
import os
import re
import sys
import tomllib
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OSV_URL = "https://api.osv.dev/v1/querybatch"


@dataclass(frozen=True, order=True)
class Package:
    ecosystem: str
    name: str
    version: str


@dataclass(frozen=True)
class Waiver:
    package: Package
    advisory: str
    # The first day (UTC) on which it no longer applies.
    expires: date
    reason: str


# Temporary waivers, for advisories that have no fixed version yet. Each one accepts a single
# advisory for a single locked version and says why. On its expiry date it stops applying and the
# audit fails again, until the dependency is fixed or the waiver is reviewed and renewed. Every run
# lists the findings it waives and the waivers that no longer match one, to be removed.
WAIVERS = (
    Waiver(
        Package("npm", "picomatch", "4.0.7"), "GHSA-fc5q-39xc-vjpf", date(2026, 12, 17),
        "ReDoS through crafted glob patterns, with no fixed version yet. Only Vite and Vitest use"
        " it, with the project's own patterns, to build and test the frontend: it is not in the"
        " image.",
    ),
)


def public_url(value: str, host: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https" and parsed.hostname == host
        and parsed.username is None and parsed.password is None
    )


def locked_packages(root: Path) -> list[Package]:
    packages: set[Package] = set()
    python = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    for item in python["package"]:
        source = item["source"]
        if source.get("editable") == ".":
            continue
        if not public_url(source.get("registry", ""), "pypi.org"):
            raise ValueError("Only public PyPI dependencies may be sent to the advisory service")
        name = "pdfminer.six" if item["name"] == "pdfminer-six" else item["name"]
        packages.add(Package("PyPI", name, item["version"]))
    frontend = json.loads((root / "frontend" / "package-lock.json").read_text(encoding="utf-8"))
    for path, item in frontend["packages"].items():
        if not path:
            continue
        if not public_url(item.get("resolved", ""), "registry.npmjs.org"):
            raise ValueError("Only public npm dependencies may be sent to the advisory service")
        packages.add(Package("npm", item.get("name") or path.rsplit("node_modules/", 1)[-1], item["version"]))
    if not packages or any(not value.name or not value.version for value in packages):
        raise ValueError("The dependency inventory is incomplete")
    return sorted(packages)


def audit(packages: list[Package]) -> list[tuple[Package, str]]:
    findings = []
    for offset in range(0, len(packages), 1000):
        batch = packages[offset:offset + 1000]
        request = Request(OSV_URL, data=json.dumps({"queries": [
            {"package": {"name": item.name, "ecosystem": item.ecosystem}, "version": item.version}
            for item in batch
        ]}).encode(), headers={"Content-Type": "application/json", "Accept": "application/json"})
        with urlopen(request, timeout=30) as response:
            content = response.read(5 * 1024 * 1024 + 1)
        if len(content) > 5 * 1024 * 1024:
            raise ValueError("Advisory response exceeds its size limit")
        results = json.loads(content)["results"]
        if not isinstance(results, list) or len(results) != len(batch):
            raise ValueError("Advisory response does not cover every dependency")
        for item, result in zip(batch, results, strict=True):
            if (
                not isinstance(result, dict) or result.get("next_page_token")
                or result.keys() - {"vulns", "next_page_token"}
            ):
                raise ValueError("Advisory response is incomplete")
            vulnerabilities = result.get("vulns", [])
            if not isinstance(vulnerabilities, list):
                raise ValueError("Malformed advisory response")
            for value in vulnerabilities:
                if (
                    not isinstance(value, dict) or not isinstance(value.get("id"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", value["id"])
                ):
                    raise ValueError("Malformed advisory identifier")
                findings.append((item, value["id"]))
    return findings


def notice(message: str) -> None:
    # In GitHub Actions, also a warning on the run's summary, so that a waiver is never silent.
    if os.environ.get("GITHUB_ACTIONS") == "true":
        escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        message = f"::warning::{escaped}"
    print(message)


def report(findings: list[tuple[Package, str]], waivers: tuple[Waiver, ...], today: date) -> bool:
    """Prints every finding and every unused waiver; returns whether a finding is not waived."""
    by_finding = {(waiver.package, waiver.advisory): waiver for waiver in waivers}
    used: set[Waiver] = set()
    failed = False
    for item, advisory in findings:
        line = f"{item.ecosystem} {item.name} {item.version}: https://osv.dev/vulnerability/{advisory}"
        waiver = by_finding.get((item, advisory))
        if waiver is None:
            failed = True
            print(line)
            continue
        used.add(waiver)
        expiry = waiver.expires.isoformat()
        if today < waiver.expires:
            notice(f"{line} (waived; the waiver expires on {expiry}, UTC). {waiver.reason}")
        else:
            failed = True
            print(f"{line} (its waiver expired on {expiry}, UTC)")
    for waiver in waivers:
        if waiver not in used:
            package = waiver.package
            notice(f"The waiver of {waiver.advisory} for {package.ecosystem} {package.name} "
                   f"{package.version} no longer matches a finding: remove it.")
    return failed


def main() -> int:
    try:
        packages = locked_packages(ROOT)
        findings = audit(packages)
    except (OSError, URLError, ValueError, KeyError, TypeError) as error:
        print(f"Dependency audit could not complete ({type(error).__name__}).", file=sys.stderr)
        return 2
    failed = report(findings, WAIVERS, datetime.now(UTC).date())
    print(f"Audited {len(packages)} locked public package versions, including development dependencies.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
