import json
from datetime import date
from io import BytesIO
from urllib.error import URLError

import pytest

from scripts import audit_dependencies as audit

WAIVED = audit.Package("npm", "source-map-js", "1.2.2")
WAIVER = audit.Waiver(WAIVED, "GHSA-synthetic", date(2030, 1, 10), "Synthetic reason.")


def inventory(root, *, npm_host="registry.npmjs.org"):
    (root / "uv.lock").write_text(
        '[[package]]\nname = "local-project"\nversion = "0.1.0"\nsource = { editable = "." }\n'
        '[[package]]\nname = "pdfminer-six"\nversion = "20260107"\n'
        'source = { registry = "https://pypi.org/simple" }\n',
        encoding="utf-8",
    )
    (root / "frontend").mkdir()
    (root / "frontend" / "package-lock.json").write_text(json.dumps({"packages": {
        "": {"name": "private-project", "version": "0.1.0"},
        "node_modules/source-map-js": {
            "version": "1.2.2", "dev": True,
            "resolved": f"https://{npm_host}/source-map-js/-/source-map-js-1.2.2.tgz",
        },
    }}), encoding="utf-8")


def test_inventory_includes_dev_packages_without_local_project_names(tmp_path):
    inventory(tmp_path)
    assert audit.locked_packages(tmp_path) == [
        audit.Package("PyPI", "pdfminer.six", "20260107"),
        audit.Package("npm", "source-map-js", "1.2.2"),
    ]


def test_private_or_unrecognized_registries_are_not_sent(tmp_path, monkeypatch, capsys):
    inventory(tmp_path, npm_host="private.example")
    monkeypatch.setattr(audit, "ROOT", tmp_path)
    monkeypatch.setattr(audit, "urlopen", lambda *args, **kwargs: pytest.fail("Must not send inventory"))
    assert audit.main() == 2
    output = capsys.readouterr()
    assert "private.example" not in output.err
    assert "could not complete" in output.err


def test_advisory_payload_and_failure_exit_code(tmp_path, monkeypatch, capsys):
    inventory(tmp_path)
    monkeypatch.setattr(audit, "ROOT", tmp_path)

    def respond(request, timeout):
        assert request.full_url == audit.OSV_URL
        assert timeout == 30
        body = request.data.decode()
        assert "private-project" not in body and "local-project" not in body and "resolved" not in body
        assert json.loads(body)["queries"][1] == {
            "package": {"name": "source-map-js", "ecosystem": "npm"}, "version": "1.2.2",
        }
        return BytesIO(json.dumps({"results": [{}, {"vulns": [{"id": "GHSA-synthetic"}]}]}).encode())

    monkeypatch.setattr(audit, "urlopen", respond)
    assert audit.main() == 1
    assert "GHSA-synthetic" in capsys.readouterr().out


@pytest.mark.parametrize(("finding", "today", "fails", "reported"), [
    ((WAIVED, "GHSA-synthetic"), date(2030, 1, 9), False,
     "(waived; the waiver expires on 2030-01-10, UTC). Synthetic reason."),
    ((WAIVED, "GHSA-synthetic"), date(2030, 1, 10), True, "(its waiver expired on 2030-01-10, UTC)"),
    ((WAIVED, "GHSA-other"), date(2030, 1, 9), True, "no longer matches a finding: remove it."),
    ((audit.Package("npm", "source-map-js", "1.2.3"), "GHSA-synthetic"), date(2030, 1, 9), True,
     "no longer matches a finding: remove it."),
])
def test_a_waiver_accepts_only_its_advisory_for_its_version_until_it_expires(
    monkeypatch, capsys, finding, today, fails, reported,
):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    assert audit.report([finding], (WAIVER,), today) is fails
    package, advisory = finding
    output = capsys.readouterr().out
    url = f"https://osv.dev/vulnerability/{advisory}"
    assert output.startswith(f"npm {package.name} {package.version}: {url}")
    assert reported in output


def test_waived_advisories_are_single_line_warnings_in_github_actions(monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    waiver = audit.Waiver(WAIVED, "GHSA-synthetic", date(2030, 1, 10), "One.\nTwo, 100%.")
    assert audit.report([(WAIVED, "GHSA-synthetic")], (waiver,), date(2030, 1, 9)) is False
    assert capsys.readouterr().out == (
        "::warning::npm source-map-js 1.2.2: https://osv.dev/vulnerability/GHSA-synthetic"
        " (waived; the waiver expires on 2030-01-10, UTC). One.%0ATwo, 100%25.\n"
    )


@pytest.mark.parametrize("payload", [
    {"results": []}, {"results": [None]}, {"results": [{"next_page_token": "more"}]},
    {"results": [{"vulns": "invalid"}]}, {"results": [{"vulns": [{}]}]},
    {"results": [{"error": "Invalid query"}]}, {"results": [{"vulns": [{"id": "\ninvalid"}]}]},
])
def test_partial_or_malformed_advisory_responses_cannot_report_success(monkeypatch, payload):
    monkeypatch.setattr(
        audit, "urlopen", lambda *args, **kwargs: BytesIO(json.dumps(payload).encode()),
    )
    with pytest.raises(ValueError):
        audit.audit([audit.Package("npm", "source-map-js", "1.2.2")])


def test_unavailable_advisory_service_fails_explicitly(tmp_path, monkeypatch, capsys):
    inventory(tmp_path)
    monkeypatch.setattr(audit, "ROOT", tmp_path)

    def unavailable(*args, **kwargs):
        raise URLError("synthetic connectivity failure")

    monkeypatch.setattr(audit, "urlopen", unavailable)
    assert audit.main() == 2
    assert "could not complete" in capsys.readouterr().err
