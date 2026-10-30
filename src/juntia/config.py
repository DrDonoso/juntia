import re
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path
from typing import Literal, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    EmailStr,
    Field,
    SecretStr,
    TypeAdapter,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_origin(value: str) -> str:
    try:
        if any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in value
        ) or any(character in value for character in "\\?#"):
            raise ValueError
        origin = urlsplit(value)
        hostname = origin.hostname
        port = origin.port
        if (
            origin.scheme not in {"http", "https"}
            or not hostname
            or origin.username is not None
            or origin.password is not None
            or origin.path not in {"", "/"}
            or not re.fullmatch(r"(?:\[[0-9a-fA-F:.]+\]|[^:@\[\]]+)(?::[0-9]+)?", origin.netloc)
        ):
            raise ValueError
        if ":" in hostname:
            hostname = f"[{IPv6Address(hostname).compressed}]"
        else:
            hostname = hostname.encode("idna").decode("ascii").lower()
            if re.fullmatch(r"[0-9.]+", hostname):
                IPv4Address(hostname)
            if len(hostname.removesuffix(".")) > 253 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in hostname.removesuffix(".").split(".")
            ):
                raise ValueError
        default_port = 443 if origin.scheme == "https" else 80
        authority = hostname if port in {None, default_port} else f"{hostname}:{port}"
        return f"{origin.scheme}://{authority}"
    except ValueError:
        raise ValueError("Expected a valid HTTP(S) origin without credentials or a path") from None


Language = Literal["en", "es"]
# Storage settings are whole MiB (1 MiB = 1,048,576 bytes); the cap keeps byte counts exact in JSON.
MAX_STORAGE_MB = 1024 * 1024 * 1024


class LanguageSettings(BaseSettings):
    """Language of server-generated texts; first-run seeding needs only this setting."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    app_language: Language = "en"

    @field_validator("app_language", mode="before")
    @classmethod
    def valid_language(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip().lower() or "en"
        if value not in get_args(Language):
            raise ValueError("APP_LANGUAGE must be en or es")
        return value


class Settings(LanguageSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: str
    admin_username: str
    admin_password: SecretStr
    allow_insecure_local_admin: bool = False
    auth_secret: SecretStr
    public_origin: str = "http://localhost:7778"
    auth_cookie_secure: bool = True
    session_hours: int = 12
    upload_dir: Path = Path("data/uploads")
    # Byte budgets for community action PDFs, in MiB. Every stored file counts, active or
    # withdrawn, until the administrator purges it: 250 MiB per resident author and 2 GiB for
    # the whole community (residents and the technical administrator, who has no own budget).
    action_storage_user_quota_mb: int = 250
    action_storage_community_quota_mb: int = 2048
    # Free space kept on the upload volume (1 GiB): action PDFs and statement imports that would
    # leave less free space are refused.
    min_free_disk_mb: int = 1024
    preview_hours: int = 24
    openai_api_key: SecretStr = SecretStr("")
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = ""
    image_tag: str = "development"
    build_date: str = ""
    tz: str = "Europe/Madrid"
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] = "starttls"
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""
    smtp_timeout: int = Field(default=10, ge=1, le=60)
    google_client_id: str = ""
    google_client_secret: SecretStr = SecretStr("")

    @field_validator("tz")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("TZ must be an available IANA time zone") from None
        return value

    @model_validator(mode="after")
    def validate_google(self) -> "Settings":
        self.google_client_id = self.google_client_id.strip()
        secret = self.google_client_secret.get_secret_value()
        if bool(self.google_client_id) != bool(secret.strip()):
            raise ValueError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required together")
        if self.google_client_id:
            if not re.fullmatch(r"[a-zA-Z0-9-]+\.apps\.googleusercontent\.com", self.google_client_id):
                raise ValueError("GOOGLE_CLIENT_ID must be a Google web application client ID")
            if any(character.isspace() for character in secret):
                raise ValueError("GOOGLE_CLIENT_SECRET must not contain whitespace")
            for value in self.public_origins:
                origin = urlsplit(value)
                if origin.scheme != "https" and origin.hostname not in {"localhost", "127.0.0.1", "::1"}:
                    raise ValueError("Google sign-in requires HTTPS except on loopback")
        return self

    @model_validator(mode="after")
    def validate_smtp(self) -> "Settings":
        self.smtp_host = self.smtp_host.strip()
        if self.smtp_host or self.smtp_from or self.smtp_username or self.smtp_password:
            if not self.smtp_host or not self.smtp_from:
                raise ValueError("SMTP_HOST and SMTP_FROM are required together")
            self.smtp_from = TypeAdapter(EmailStr).validate_python(self.smtp_from)
            if bool(self.smtp_username) != bool(self.smtp_password.get_secret_value()):
                raise ValueError("SMTP_USERNAME and SMTP_PASSWORD are required together")
            if any(character.isspace() for character in self.smtp_host):
                raise ValueError("SMTP_HOST must be a hostname")
            if self.smtp_security == "none" and (
                self.smtp_host not in {"localhost", "127.0.0.1", "::1"}
                or any(
                    urlsplit(origin).scheme != "http"
                    or urlsplit(origin).hostname not in {"localhost", "127.0.0.1", "::1"}
                    for origin in self.public_origins
                )
                or self.auth_cookie_secure
            ):
                raise ValueError("Plaintext SMTP is allowed only for local development")
        return self

    @field_validator("admin_username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        if not value.strip() or len(value) > 150:
            raise ValueError("ADMIN_USERNAME must contain 1-150 characters")
        return value.strip()

    @field_validator("auth_secret")
    @classmethod
    def valid_secret(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip() or len(value.get_secret_value()) < 32:
            raise ValueError("AUTH_SECRET must contain at least 32 characters")
        return value

    @field_validator("session_hours", "preview_hours")
    @classmethod
    def valid_duration(cls, value: int) -> int:
        if not 1 <= value <= 168:
            raise ValueError("Lifetime must be between 1 and 168 hours")
        return value

    @field_validator(
        "action_storage_user_quota_mb", "action_storage_community_quota_mb", "min_free_disk_mb",
    )
    @classmethod
    def valid_storage_size(cls, value: int, info: ValidationInfo) -> int:
        if not 1 <= value <= MAX_STORAGE_MB:
            raise ValueError(
                f"{(info.field_name or '').upper()} must be a whole number of MiB "
                f"between 1 and {MAX_STORAGE_MB}"
            )
        return value

    @model_validator(mode="after")
    def validate_origin(self) -> "Settings":
        origins = self.public_origins
        self.public_origin = ",".join(origins)
        for value in origins:
            origin = urlsplit(value)
            if self.auth_cookie_secure and origin.scheme != "https":
                raise ValueError("Secure cookies require every PUBLIC_ORIGIN to use HTTPS")
            if self.allow_insecure_local_admin and (
                origin.scheme != "http"
                or origin.hostname not in {"localhost", "127.0.0.1", "::1"}
                or self.auth_cookie_secure
            ):
                raise ValueError(
                    "ALLOW_INSECURE_LOCAL_ADMIN requires every PUBLIC_ORIGIN to be a "
                    "loopback HTTP origin with non-Secure cookies"
                )
        password = self.admin_password.get_secret_value()
        local_defaults = (
            self.allow_insecure_local_admin
            and self.admin_username == "admin"
            and password == "admin"
        )
        if not local_defaults:
            if not password.strip() or len(password) < 15 or len(password.encode("utf-8")) > 72:
                raise ValueError(
                    "ADMIN_PASSWORD must have at least 15 characters and at most 72 bytes"
                )
            if password.lower().startswith(("changeme", "replace-me")):
                raise ValueError("Replace the example administrator password")
        return self

    @property
    def public_origins(self) -> tuple[str, ...]:
        try:
            return tuple(
                dict.fromkeys(
                    normalize_origin(value.strip()) for value in self.public_origin.split(",")
                )
            )
        except ValueError:
            raise ValueError(
                "PUBLIC_ORIGIN must be a comma-separated list of valid HTTP(S) origins "
                "without credentials, paths, queries, fragments, wildcards or empty entries"
            ) from None

    @property
    def ai_enabled(self) -> bool:
        return bool(self.openai_api_key.get_secret_value() and self.openai_model)

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret.get_secret_value())
