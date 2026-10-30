import smtplib
import ssl
from email.message import EmailMessage

import pytest
from pydantic import SecretStr, ValidationError

from juntia import mail
from juntia.config import Settings
from juntia.errors import AppError


@pytest.mark.parametrize("security", ["starttls", "tls"])
def test_smtp_uses_verified_tls_authentication_and_bounded_timeouts(config, monkeypatch, security):
    events = []
    config.smtp_host = "smtp.example.org"
    config.smtp_from = "sender@example.org"
    config.smtp_username = "synthetic-smtp-user"
    config.smtp_password = SecretStr("synthetic-smtp-password")
    config.smtp_security = security

    class Connection:
        def __init__(self, host, port, *, timeout, context=None):
            assert host == config.smtp_host
            assert port == config.smtp_port
            assert timeout == 10
            if security == "tls":
                assert context.check_hostname
                assert context.verify_mode == ssl.CERT_REQUIRED
            events.append("connect")

        def starttls(self, *, context):
            assert context.check_hostname
            assert context.verify_mode == ssl.CERT_REQUIRED
            events.append("starttls")

        def login(self, username, password):
            assert username == config.smtp_username
            assert password == config.smtp_password.get_secret_value()
            events.append("login")

        def send_message(self, message):
            assert message["To"] == "resident@example.org"
            events.append("send")
            return {}

        def close(self):
            events.append("close")

    monkeypatch.setattr(smtplib, "SMTP", Connection)
    monkeypatch.setattr(smtplib, "SMTP_SSL", Connection)
    message = EmailMessage()
    message["To"] = "resident@example.org"
    mail.deliver(config, message)
    assert events == (
        ["connect", "starttls", "login", "send", "close"]
        if security == "starttls" else ["connect", "login", "send", "close"]
    )


async def test_delivery_errors_do_not_log_sensitive_exception_details(config, monkeypatch, caplog):
    config.smtp_host = "smtp.example.org"
    config.smtp_from = "sender@example.org"
    token = "a" * 64

    def fail(config, message):
        raise smtplib.SMTPRecipientsRefused({"resident@example.org": (550, token)})

    monkeypatch.setattr(mail, "deliver", fail)
    with pytest.raises(AppError) as error:
        await mail.send_link(
            config, "resident@example.org", "Resident", token, "invitation",
            community_name="Test community",
        )
    assert error.value.code == "smtp_failed"
    assert "SMTPRecipientsRefused" in caplog.text
    assert "resident@example.org" not in caplog.text
    assert token not in caplog.text


async def test_missing_smtp_is_explicit_and_does_not_attempt_network(config, monkeypatch):
    def unexpected(*args):
        pytest.fail("SMTP must not be contacted when it is not configured")
    monkeypatch.setattr(mail, "deliver", unexpected)
    with pytest.raises(AppError) as error:
        await mail.send_link(
            config, "resident@example.org", "Resident", "a" * 64, "recovery",
            community_name="Test community",
        )
    assert error.value.code == "smtp_not_configured"


@pytest.mark.parametrize("purpose", ["invitation", "recovery"])
async def test_email_links_use_the_first_normalized_origin(config, monkeypatch, purpose):
    settings = Settings(_env_file=None, **{
        **config.model_dump(),
        "public_origin": " https://FINANCES.example.org:443/,https://internal.example.org:8443 ",
        "auth_cookie_secure": True,
        "smtp_host": "smtp.example.org",
        "smtp_from": "sender@example.org",
    })
    messages = []
    monkeypatch.setattr(mail, "deliver", lambda config, message: messages.append(message))
    token = "a" * 64
    await mail.send_link(
        settings, "resident@example.org", "Resident", token, purpose,
        community_name="Test community",
    )
    route = "activate" if purpose == "invitation" else "reset-password"
    body = messages[0].get_content()
    assert f"https://finances.example.org/{route}#token={token}" in body
    assert "internal.example.org" not in body
    assert "https://FINANCES" not in body


EMAILS = {
    ("en", "invitation"): (
        "Your invitation to Juntia",
        "Hello Resident,\n\n"
        "You have been invited to join Test community. "
        "Activate your account with {method} using this link:\n\n{link}\n\n"
        "This link can only be used once and expires in 72 hours.\n"
        "If you were not expecting this message, ignore it or contact the administrator.\n"
        "We will never ask you to send your password by email.\n",
    ),
    ("en", "recovery"): (
        "Reset your Juntia password",
        "Hello Resident,\n\n"
        "We received a request to create or reset your password. "
        "Choose a password using this link:\n\n{link}\n\n"
        "This link can only be used once and expires in 1 hour.\n"
        "If you were not expecting this message, ignore it or contact the administrator.\n"
        "We will never ask you to send your password by email.\n",
    ),
    ("es", "invitation"): (
        "Tu invitación a Juntia",
        "Hola, Resident:\n\n"
        "Te han invitado a la comunidad Test community. "
        "Activa tu cuenta con {method} en este enlace:\n\n{link}\n\n"
        "El enlace es de un solo uso y caduca en 72 horas.\n"
        "Si no esperabas este mensaje, ignóralo o contacta con la administración.\n"
        "Nunca te pediremos que envíes tu contraseña por correo.\n",
    ),
    ("es", "recovery"): (
        "Recuperar tu contraseña de Juntia",
        "Hola, Resident:\n\n"
        "Se ha solicitado crear o restablecer tu contraseña. Elige una en este enlace:\n\n"
        "{link}\n\n"
        "El enlace es de un solo uso y caduca en 1 hora.\n"
        "Si no esperabas este mensaje, ignóralo o contacta con la administración.\n"
        "Nunca te pediremos que envíes tu contraseña por correo.\n",
    ),
}
METHODS = {
    ("en", False): "a password", ("en", True): "Google or a password",
    ("es", False): "una contraseña", ("es", True): "Google o con una contraseña",
}


@pytest.mark.parametrize("language", ["en", "es"])
@pytest.mark.parametrize(("purpose", "google"), [
    ("invitation", False), ("invitation", True), ("recovery", False), ("recovery", True),
])
async def test_email_texts_follow_the_configured_language(
    config, monkeypatch, language, purpose, google,
):
    config.smtp_host = "smtp.example.org"
    config.smtp_from = "sender@example.org"
    if google:
        config.google_client_id = "synthetic-client.apps.googleusercontent.com"
        config.google_client_secret = SecretStr("synthetic-google-secret")
    messages = []
    monkeypatch.setattr(mail, "deliver", lambda config, message: messages.append(message))
    token = "b" * 64
    await mail.send_link(
        config, "resident@example.org", "Resident", token, purpose,
        community_name="Test community",
    )
    route = "activate" if purpose == "invitation" else "reset-password"
    subject, body = EMAILS[language, purpose]
    [message] = messages
    assert message["Subject"] == subject
    assert message["Content-Language"] == language
    assert message.get_content() == body.format(
        method=METHODS[language, google], link=f"http://testserver/{route}#token={token}",
    )


def test_plaintext_smtp_requires_every_origin_to_be_local_http(config):
    values = {
        **config.model_dump(), "smtp_host": "127.0.0.1", "smtp_from": "sender@example.org",
        "smtp_security": "none", "auth_cookie_secure": False,
        "public_origin": "http://localhost:7778,http://127.0.0.1:7889",
    }
    assert Settings(_env_file=None, **values).smtp_enabled
    for origin in [
        "http://localhost:7778,https://localhost:7889",
        "http://localhost:7778,http://remote.example.org",
    ]:
        with pytest.raises(ValidationError, match="Plaintext SMTP"):
            Settings(_env_file=None, **{**values, "public_origin": origin})
