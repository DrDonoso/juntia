import secrets

import pytest
from pydantic import ValidationError

from juntia.config import Settings


@pytest.mark.parametrize("zone", ["Europe/Madrid", "UTC", "America/New_York", "Asia/Kathmandu"])
def test_event_timezone_uses_validated_environment(values, monkeypatch, zone):
    monkeypatch.setenv("TZ", zone)
    assert Settings(_env_file=None, **{**values, "allow_insecure_local_admin": True}).tz == zone


@pytest.mark.parametrize("zone", ["", "Not/AZone", "../Europe/Madrid", "/etc/localtime"])
def test_invalid_event_timezone_fails_configuration(values, monkeypatch, zone):
    monkeypatch.setenv("TZ", zone)
    with pytest.raises(ValidationError, match="TZ must"):
        Settings(_env_file=None, **{**values, "allow_insecure_local_admin": True})


@pytest.fixture
def values():
    return {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "admin_username": "admin",
        "admin_password": "admin",
        "auth_secret": secrets.token_urlsafe(32),
        "public_origin": "http://localhost:7778",
        "auth_cookie_secure": False,
        "allow_insecure_local_admin": False,
    }


@pytest.fixture
def secure_values(values):
    return {
        **values,
        "admin_password": secrets.token_urlsafe(24),
        "public_origin": "https://finances.example.com",
        "auth_cookie_secure": True,
    }


def test_local_default_password_requires_explicit_opt_in(values):
    with pytest.raises(ValidationError, match="ADMIN_PASSWORD"):
        Settings(_env_file=None, **values)


def test_default_origin_matches_application_port(values, monkeypatch):
    monkeypatch.delenv("PUBLIC_ORIGIN", raising=False)
    local = {**values, "allow_insecure_local_admin": True}
    local.pop("public_origin")
    settings = Settings(_env_file=None, **local)
    assert settings.public_origin == "http://localhost:7778"


@pytest.mark.parametrize(
    "origin", ["http://localhost:7778", "http://127.0.0.1:8888", "http://[::1]:7778"]
)
def test_local_default_credentials_work_for_loopback_only(values, origin):
    settings = Settings(
        _env_file=None, **{**values, "allow_insecure_local_admin": True, "public_origin": origin}
    )
    assert settings.admin_username == "admin"
    assert settings.admin_password.get_secret_value() == "admin"


@pytest.mark.parametrize(
    "origin",
    [
        "http://0.0.0.0:7778",
        "http://192.168.1.10:7778",
        "http://localhost.example.com:7778",
        "https://finances.example.com",
        "https://localhost:7778",
    ],
)
def test_local_password_exception_rejects_nonlocal_origins(values, origin):
    with pytest.raises(ValidationError, match="loopback HTTP origin"):
        Settings(
            _env_file=None,
            **{**values, "allow_insecure_local_admin": True, "public_origin": origin},
        )


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("operator", "admin"),
        ("admin", "short"),
        ("admin", " " * 20),
        ("admin", "x" * 73),
        ("admin", "changeme-example-password"),
    ],
)
def test_local_exception_does_not_bypass_other_password_validation(values, username, password):
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            **{
                **values,
                "allow_insecure_local_admin": True,
                "admin_username": username,
                "admin_password": password,
            },
        )


def test_production_keeps_its_password_and_secure_cookie_requirements(values):
    production = {
        **values,
        "public_origin": "https://finances.example.com",
        "auth_cookie_secure": True,
    }
    with pytest.raises(ValidationError, match="ADMIN_PASSWORD"):
        Settings(_env_file=None, **production)
    settings = Settings(
        _env_file=None, **{**production, "admin_password": secrets.token_urlsafe(24)}
    )
    assert not settings.allow_insecure_local_admin
    assert settings.auth_cookie_secure


def test_local_mode_still_requires_a_strong_session_secret(values):
    with pytest.raises(ValidationError, match="AUTH_SECRET"):
        Settings(
            _env_file=None,
            **{**values, "allow_insecure_local_admin": True, "auth_secret": "admin"},
        )


@pytest.mark.parametrize("from_environment", [False, True])
@pytest.mark.parametrize(
    "origin",
    [
        "https://finances.example.com",
        "https://finances.example.com,https://finances.internal.example.com",
    ],
)
def test_public_origins_support_single_urls_and_csv(
    secure_values, monkeypatch, from_environment, origin
):
    configured = {**secure_values, "public_origin": origin}
    if from_environment:
        monkeypatch.setenv("PUBLIC_ORIGIN", configured.pop("public_origin"))
    settings = Settings(_env_file=None, **configured)
    assert settings.public_origin == origin
    assert settings.public_origins == tuple(origin.split(","))


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        (
            " HTTPS://Finances.EXAMPLE.com:443/ , https://internal.example.com/ , "
            "https://finances.example.com, https://FINANCES.example.com:8443/ ",
            (
                "https://finances.example.com",
                "https://internal.example.com",
                "https://finances.example.com:8443",
            ),
        ),
        (
            "http://LOCALHOST:80/,http://localhost,http://[0:0:0:0:0:0:0:1]:80/,"
            "http://[::1]/,http://127.0.0.1:7778",
            ("http://localhost", "http://[::1]", "http://127.0.0.1:7778"),
        ),
        (
            "http://finances.example.com,https://finances.example.com,"
            "http://finances.example.com:443,https://finances.example.com:80",
            (
                "http://finances.example.com",
                "https://finances.example.com",
                "http://finances.example.com:443",
                "https://finances.example.com:80",
            ),
        ),
        ("https://B\u00dcCHER.example:443/", ("https://xn--bcher-kva.example",)),
    ],
)
def test_public_origins_normalize_deduplicate_and_round_trip(secure_values, configured, expected):
    settings = Settings(
        _env_file=None,
        **{**secure_values, "public_origin": configured, "auth_cookie_secure": False},
    )
    assert settings.public_origins == expected
    assert settings.public_origin == ",".join(expected)
    restored = Settings(_env_file=None, **settings.model_dump())
    assert restored.public_origins == expected
    assert restored.public_origin == settings.public_origin
    assert "public_origins" not in settings.model_dump()


def test_public_origins_are_not_cached_across_copies_or_updates(secure_values):
    settings = Settings(_env_file=None, **secure_values)
    assert settings.public_origins == ("https://finances.example.com",)
    copied = settings.model_copy(
        update={"public_origin": " HTTPS://Second.EXAMPLE.com:443/ , https://third.example.com "}
    )
    assert copied.public_origins == ("https://second.example.com", "https://third.example.com")
    assert settings.public_origins == ("https://finances.example.com",)
    settings.public_origin = "https://replacement.example.com/"
    assert settings.public_origins == ("https://replacement.example.com",)


@pytest.mark.parametrize("position", ["only", "first", "last"])
@pytest.mark.parametrize(
    "invalid",
    [
        "",
        " ",
        ",",
        "https://finances.example.com,",
        ",https://finances.example.com",
        "https://finances.example.com,,https://internal.example.com",
        "null",
        "*",
        "https://*.example.com",
        "https://finances.*",
        "ftp://finances.example.com",
        "//finances.example.com",
        "https:finances.example.com",
        "https://",
        "https:///finances.example.com",
        "https://:443",
        "https://@finances.example.com",
        "https://operator@finances.example.com",
        "https://operator:private-origin-password@finances.example.com",
        "https://:private-origin-password@finances.example.com",
        "https://finances.example.com/path",
        "https://finances.example.com//",
        "https://finances.example.com?",
        "https://finances.example.com?secret=private-origin-password",
        "https://finances.example.com#",
        "https://finances.example.com#fragment",
        "https://finances.example.com:",
        "https://finances.example.com:not-a-port",
        "https://finances.example.com:65536",
        "https://finances.example.com:-1",
        "https://finances.example.com:443:8443",
        "https://[::1",
        "https://[not-an-ipv6-address]",
        "https://[::1]suffix",
        "https://[::1%25eth0]",
        "https://256.256.256.256",
        "https://127.0.0.999",
        "https://127.1",
        "https://finances..example.com",
        "https://-finances.example.com",
        "https://finances_.example.com",
        "https://finances.example.com\\@attacker.example",
        "https://finances.example.com\n.attacker.example",
        "https://finances.example.com https://internal.example.com",
    ],
)
def test_invalid_origin_rejects_the_entire_configuration(secure_values, invalid, position):
    valid = "https://valid.example.com"
    configured = (
        invalid
        if position == "only"
        else (f"{invalid},{valid}" if position == "first" else f"{valid},{invalid}")
    )
    with pytest.raises(ValidationError, match="PUBLIC_ORIGIN") as error:
        Settings(_env_file=None, **{**secure_values, "public_origin": configured})
    message = str(error.value)
    assert "private-origin-password" not in message
    assert secure_values["admin_password"] not in message
    assert secure_values["auth_secret"] not in message


def test_invalid_second_origin_from_environment_is_not_ignored(secure_values, monkeypatch):
    configured = secure_values.copy()
    configured.pop("public_origin")
    monkeypatch.setenv(
        "PUBLIC_ORIGIN", "https://finances.example.com,https://invalid.example:65536"
    )
    with pytest.raises(ValidationError, match="PUBLIC_ORIGIN"):
        Settings(_env_file=None, **configured)


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("insecure", ["http://localhost:7778", "http://finances.example.com"])
def test_secure_cookies_require_every_origin_to_be_https(secure_values, insecure, reverse):
    origins = ["https://finances.example.com", insecure]
    with pytest.raises(ValidationError, match="PUBLIC_ORIGIN"):
        Settings(
            _env_file=None,
            **{
                **secure_values,
                "public_origin": ",".join(reversed(origins) if reverse else origins),
            },
        )


def test_local_mode_accepts_a_list_of_loopback_origins(values):
    origins = ("http://localhost:7778", "http://127.0.0.1:7778", "http://[::1]:7778")
    settings = Settings(
        _env_file=None,
        **{**values, "public_origin": ",".join(origins), "allow_insecure_local_admin": True},
    )
    assert settings.public_origins == origins
    assert not settings.auth_cookie_secure
    assert settings.admin_password.get_secret_value() == "admin"


def test_local_mode_cannot_use_secure_cookies(values):
    with pytest.raises(ValidationError, match="loopback HTTP origin"):
        Settings(
            _env_file=None,
            **{
                **values,
                "public_origin": "https://localhost,https://127.0.0.1",
                "allow_insecure_local_admin": True,
                "auth_cookie_secure": True,
            },
        )


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize(
    "invalid",
    [
        "http://finances.example.com",
        "http://localhost.example.com",
        "http://localhost.",
        "http://127.0.0.2:7778",
        "http://0.0.0.0:7778",
        "https://localhost:7778",
        "https://finances.example.com",
    ],
)
def test_local_mode_checks_every_origin(values, invalid, reverse):
    origins = ["http://localhost:7778", invalid]
    with pytest.raises(ValidationError, match="loopback HTTP origin"):
        Settings(
            _env_file=None,
            **{
                **values,
                "allow_insecure_local_admin": True,
                "public_origin": ",".join(reversed(origins) if reverse else origins),
            },
        )


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("admin_username", " "),
        ("admin_password", "admin"),
        ("auth_secret", "short"),
        ("session_hours", 0),
        ("preview_hours", 169),
    ],
)
def test_multiple_origins_preserve_other_configuration_validation(secure_values, field, invalid):
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            **{
                **secure_values,
                "public_origin": "https://finances.example.com,https://internal.example.com",
                field: invalid,
            },
        )
