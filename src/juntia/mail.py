import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Literal

from starlette.concurrency import run_in_threadpool

from .config import Settings
from .errors import AppError
from .texts import texts

log = logging.getLogger(__name__)
Purpose = Literal["invitation", "recovery"]


def require_smtp(config: Settings) -> None:
    if not config.smtp_enabled:
        raise AppError("smtp_not_configured", 503)


def deliver(config: Settings, message: EmailMessage) -> None:
    context = ssl.create_default_context()
    connection: smtplib.SMTP
    if config.smtp_security == "tls":
        connection = smtplib.SMTP_SSL(
            config.smtp_host, config.smtp_port, timeout=config.smtp_timeout, context=context
        )
    else:
        connection = smtplib.SMTP(
            config.smtp_host, config.smtp_port, timeout=config.smtp_timeout
        )
    try:
        if config.smtp_security == "starttls":
            connection.starttls(context=context)
        if config.smtp_username:
            connection.login(config.smtp_username, config.smtp_password.get_secret_value())
        refused = connection.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
    finally:
        # Acceptance of DATA determines success; a failed QUIT must not undo it.
        connection.close()


async def send_link(
    config: Settings, email: str, name: str, token: str, purpose: Purpose, *, community_name: str
) -> None:
    require_smtp(config)
    invitation = purpose == "invitation"
    route = "activate" if invitation else "reset-password"
    link = f"{config.public_origins[0]}/{route}#token={token}"
    text = texts(config.app_language)
    message = EmailMessage()
    message["From"] = config.smtp_from
    message["To"] = email
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid()
    message["Subject"] = text.invitation_subject if invitation else text.recovery_subject
    if invitation:
        method = text.invitation_method_google if config.google_enabled else text.invitation_method
        action = text.invitation.format(community=community_name, method=method)
    else:
        action = text.recovery
    lifetime = text.invitation_lifetime if invitation else text.recovery_lifetime
    message.set_content(
        f"{text.greeting.format(name=name)}\n\n{action}\n\n{link}\n\n"
        f"{text.single_use.format(lifetime=lifetime)}\n{text.unexpected}\n"
        f"{text.password_notice}\n"
    )
    # set_content() replaces every Content-* header.
    message["Content-Language"] = config.app_language
    try:
        await run_in_threadpool(deliver, config, message)
    except (OSError, smtplib.SMTPException) as error:
        log.error("SMTP delivery failed (%s)", type(error).__name__)
        raise AppError("smtp_failed", 503) from None
