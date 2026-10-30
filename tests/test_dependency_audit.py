import json
from io import BytesIO
from urllib.error import URLError

import pytest

from scripts import audit_dependencies as audit


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
