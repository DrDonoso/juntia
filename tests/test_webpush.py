"""Web Push: messages encrypted as RFC 8291 specifies, signed with the VAPID key derived from
AUTH_SECRET (RFC 8292), sent only to the push services of the major browsers, and what each
answer of a push service means."""

import time
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from juntia import webpush
from juntia.config import Settings
from juntia.webpush import b64decode, b64encode
from tests.push_support import Browser, PushService

# RFC 8291, section 5 and appendix A.
RFC_RECEIVER = (
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
)
RFC_SENDER = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
RFC_SALT = "DGv6ra1nlYgDCS1FRnbzlw"
RFC_BODY = (
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAm"
    "S6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Q"
    "ulcy4a-fN"
)
MESSAGE = {"web_push": 8030, "notification": {"title": "Hello", "navigate": "https://x.org/"}}


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": "sqlite+aiosqlite:///unused.db",
        "auth_secret": "s" * 40,
        "auth_cookie_secure": False,
        "public_origin": "http://testserver",
        "smtp_host": "",
        "smtp_from": "",
        "smtp_username": "",
        "smtp_password": "",
        "google_client_id": "",
        "google_client_secret": "",
    }
    return Settings(_env_file=None, **{**values, **overrides})


def test_messages_are_encrypted_as_rfc_8291_shows() -> None:
    sender = ec.derive_private_key(int.from_bytes(b64decode(RFC_SENDER)), ec.SECP256R1())
    body = webpush.encrypt(
        b"When I grow up, I want to be a watermelon",
        b64decode(RFC_RECEIVER),
        b64decode(RFC_AUTH),
        sender=sender,
        salt=b64decode(RFC_SALT),
    )
    assert b64encode(body) == RFC_BODY
    # Push services take 4096 bytes at most.
    with pytest.raises(ValueError):
        webpush.encrypt(b"x" * 4000, b64decode(RFC_RECEIVER), b64decode(RFC_AUTH))


async def test_a_message_reaches_its_push_service_signed_and_encrypted() -> None:
    browser, service = Browser(), PushService()
    sender = webpush.WebPush(settings(), httpx.MockTransport(service))
    subscription = webpush.Subscription(browser.endpoint, **browser.subscription()["keys"])
    try:
        result = await sender.send(subscription, MESSAGE, ttl=600, urgency="high", topic="test")
    finally:
        await sender.close()
    assert result == "delivered"
    (request,) = service.requests
    assert (request.method, str(request.url)) == ("POST", browser.endpoint)
    headers = ("ttl", "urgency", "topic", "content-encoding")
    assert [request.headers[name] for name in headers] == ["600", "high", "test", "aes128gcm"]
    assert browser.read(request.content) == MESSAGE

    scheme, credentials = request.headers["authorization"].split(" ", 1)
    fields = dict(item.split("=", 1) for item in credentials.split(", "))
    assert scheme == "vapid" and fields["k"] == sender.public_key
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64decode(fields["k"]))
    claims = jwt.decode(
        fields["t"], key, algorithms=["ES256"], audience="https://web.push.apple.com"
    )
    # Push services refuse tokens valid for more than a day.
    assert time.time() < claims["exp"] <= time.time() + 24 * 3600
    assert claims["sub"] == "http://testserver"


def test_the_vapid_key_comes_from_auth_secret() -> None:
    def public_key(secret: str) -> str:
        return b64encode(webpush.public_bytes(webpush.vapid_key(secret)))

    assert public_key("a" * 40) == public_key("a" * 40) != public_key("b" * 40)
    assert webpush.browser_key(public_key("a" * 40))


@pytest.mark.parametrize(
    ("overrides", "subject"),
    [
        (
            {"public_origin": "http://localhost:7778,https://juntia.example.org"},
            "https://juntia.example.org",
        ),
        (
            {"smtp_host": "smtp.example.org", "smtp_from": "juntia@example.org"},
            "mailto:juntia@example.org",
        ),
        ({}, "http://testserver"),
    ],
)
def test_the_vapid_subject(overrides: dict[str, str], subject: str) -> None:
    assert webpush.vapid_subject(settings(**overrides)) == subject


@pytest.mark.parametrize(
    ("endpoint", "service"),
    [
        ("https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH", "fcm.googleapis.com"),
        ("https://web.push.apple.com/QGuQyavXutnMH", "web.push.apple.com"),
        (
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl",
            "updates.push.services.mozilla.com",
        ),
        (
            "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2b",
            "wns2-par02p.notify.windows.com",
        ),
        ("https://WEB.push.apple.com:443/QGuQ", "web.push.apple.com"),
        ("http://fcm.googleapis.com/fcm/send/x", None),
        ("https://fcm.googleapis.com:8443/fcm/send/x", None),
        ("https://evilfcm.googleapis.com/fcm/send/x", None),
        ("https://push.apple.com.example.net/x", None),
        ("https://user:pass@web.push.apple.com/x", None),
        ("https://web.push.apple.com/x#fragment", None),
        ("https://web.push.apple.com/x y", None),
        ("https://127.0.0.1/x", None),
        ("https://localhost/x", None),
        ("https://web.push.apple.com/" + "x" * 2048, None),
        ("not a url", None),
    ],
)
def test_only_the_push_services_of_the_major_browsers(endpoint: str, service: str | None) -> None:
    assert webpush.push_service(endpoint) == service


@pytest.mark.parametrize(
    ("status", "outcome"),
    [
        (201, "delivered"),
        (404, "gone"),
        (410, "gone"),
        (429, "retry"),
        (503, "retry"),
        (None, "retry"),
        (400, "rejected"),
        (403, "rejected"),
        (413, "rejected"),
    ],
)
async def test_what_each_answer_means(
    status: int | None, outcome: str, caplog: pytest.LogCaptureFixture
) -> None:
    browser, service = Browser(), PushService()
    service.status = status
    sender = webpush.WebPush(settings(), httpx.MockTransport(service))
    subscription = webpush.Subscription(browser.endpoint, **browser.subscription()["keys"])
    try:
        assert await sender.send(subscription, MESSAGE, ttl=60) == outcome
    finally:
        await sender.close()
    # The address of a subscription is never logged, only its push service (and its reason).
    assert browser.endpoint not in caplog.text
    if outcome in {"retry", "rejected"}:
        (warning,) = [record for record in caplog.records if record.name == webpush.log.name]
        assert isinstance(warning.args, tuple) and warning.args[0] == "web.push.apple.com"
    if outcome == "rejected":
        assert "TestRefusal" in caplog.text


async def test_nothing_is_sent_to_an_unknown_address_or_with_broken_keys() -> None:
    browser, service = Browser(), PushService()
    sender = webpush.WebPush(settings(), httpx.MockTransport(service))
    keys = browser.subscription()["keys"]
    try:
        unknown = webpush.Subscription("https://push.example.net/x", **keys)
        broken = webpush.Subscription(browser.endpoint, keys["p256dh"], b64encode(b"short"))
        assert await sender.send(unknown, MESSAGE, ttl=60) == "gone"
        assert await sender.send(broken, MESSAGE, ttl=60) == "rejected"
    finally:
        await sender.close()
    assert service.requests == []
