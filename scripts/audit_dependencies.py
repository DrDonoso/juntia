"""Check exact public lockfile versions without uploading project files or credentials."""

import json
import re
import sys
import tomllib
from dataclasses import dataclass
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


def main() -> int:
    try:
        packages = locked_packages(ROOT)
        findings = audit(packages)
    except (OSError, URLError, ValueError, KeyError, TypeError) as error:
        print(f"Dependency audit could not complete ({type(error).__name__}).", file=sys.stderr)
        return 2
    for item, advisory in findings:
        print(f"{item.ecosystem} {item.name} {item.version}: https://osv.dev/vulnerability/{advisory}")
    print(f"Audited {len(packages)} locked public package versions, including development dependencies.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
