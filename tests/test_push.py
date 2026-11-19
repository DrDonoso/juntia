"""Push notifications: the devices that register, the messages the notifier sends them between
9:00 and 21:00, what happens when a push service fails or refuses them, and when a device stops
receiving them."""

import httpx
import pytest
from sqlalchemy import func, select

from juntia import webpush
from juntia.db import PushDelivery, PushSubscription
from tests.push_support import Browser, PushService
from tests.test_notifications import (
    at,
    bell,
    import_statement,
    neighbor,
    set_administrator,
    stored,
    tick,
)
from tests.test_users import current_user, database, login
from tests.test_users import mailbox as mailbox


@pytest.fixture
def service(admin, config):
    """The push services the notifier of ``admin``'s app sends to."""
    service = PushService()
    notifier = admin.app.state.notifier
    admin.portal.call(notifier.sender.close)
    notifier.sender = webpush.WebPush(config, httpx.MockTransport(service))
    return service


def register(client, browser, **changes):
    response = client.put("/api/push/subscription", json=browser.subscription(**changes))
    assert response.status_code == 204, response.text


def devices(config):
    """(address, account, language, origin, refusals) of every registered device."""
    async def rows(db):
        return [tuple(row) for row in await db.execute(
            select(
                PushSubscription.endpoint, PushSubscription.user_id, PushSubscription.locale,
                PushSubscription.origin, PushSubscription.failures,
            ).order_by(PushSubscription.id)
        )]
    return database(config, rows)


def waiting(config):
    async def count(db):
        return await db.scalar(select(func.count()).select_from(PushDelivery))
    return database(config, count)


def account(client):
    return client.get("/api/auth/session").json()["user_id"]


def test_devices_register_with_the_language_of_their_interface(admin, config):
    key = admin.get("/api/push").json()["public_key"]
    secret = config.auth_secret.get_secret_value()
    assert key == webpush.b64encode(webpush.public_bytes(webpush.vapid_key(secret)))
    browser = Browser()
    register(admin, browser)
    # Registered again when the portal opens, in the language chosen since.
    register(admin, browser, locale="es")
    assert devices(config) == [(browser.endpoint, account(admin), "es", "http://testserver", 0)]
    unknown = admin.put(
        "/api/push/subscription",
        json=Browser(endpoint="https://push.example.net/device").subscription(),
    )
    assert (unknown.status_code, unknown.json()["code"]) == (422, "push_service_unsupported")
    broken = admin.put(
        "/api/push/subscription", json=browser.subscription(keys={"p256dh": "AAAA", "auth": "AAAA"})
    )
    assert (broken.status_code, broken.json()["code"]) == (422, "invalid_request")
    # Only the 20 used most recently are kept.
    for number in range(21):
        register(admin, Browser(endpoint=f"https://fcm.googleapis.com/fcm/send/device-{number}"))
    endpoints = [row[0] for row in devices(config)]
    assert len(endpoints) == 20 and browser.endpoint not in endpoints
    assert admin.post("/api/push/unsubscribe", json={"endpoint": endpoints[0]}).status_code == 204
    assert len(devices(config)) == 19
    assert admin.post("/api/auth/logout").status_code == 204
    assert admin.get("/api/push").status_code == 401


def test_a_missing_statement_reaches_the_administrators_devices(admin, config, service, mailbox):
    english, spanish = Browser(), Browser(endpoint="https://fcm.googleapis.com/fcm/send/es")
    register(admin, english)
    register(admin, spanish, locale="es")
    import_statement(admin)
    with neighbor(config, admin, mailbox) as (reader, _):
        resident = Browser(endpoint="https://updates.push.services.mozilla.com/wpush/v2/neighbor")
        register(reader, resident)
        # The alert appears at midnight, and its push messages wait until nine.
        tick(admin, at(config, 2026, 12, 1, 0, 5))
        assert len(bell(admin)["items"]) == 1 and service.requests == []
        tick(admin, at(config, 2026, 12, 1, 9))
        assert service.messages(english) == [{
            "web_push": 8030,
            "notification": {
                "title": "Missing statement: November 2026",
                "body": "It has not been imported yet: import it in Finances > Import.",
                "lang": "en",
                "dir": "ltr",
                "navigate": "http://testserver/admin",
                "tag": "statement_missing:2026-11",
                "silent": False,
                "icon": "http://testserver/icons/icon-192.png",
                "badge": "http://testserver/icons/badge-96.png",
            },
        }]
        (message,) = service.messages(spanish)
        assert (message["notification"]["title"], message["notification"]["body"]) == (
            "Falta el extracto de noviembre de 2026",
            "Aún no se ha importado: impórtalo en Gastos > Importar.",
        )
        assert service.messages(resident) == []
    # Kept by the push service until 21:00, and sent once.
    assert {request.headers["ttl"] for request in service.requests} == {str(12 * 3600)}
    tick(admin, at(config, 2026, 12, 1, 9, 1))
    assert len(service.requests) == 2 and waiting(config) == 0


def test_failures_are_tried_again_and_refusing_devices_forgotten(admin, config, service):
    browser = Browser()
    register(admin, browser)
    import_statement(admin)
    service.status = None
    tick(admin, at(config, 2026, 12, 1, 9))
    assert len(service.requests) == 1 and waiting(config) == 1
    # Tried again 2 minutes later, then 5 minutes after that.
    tick(admin, at(config, 2026, 12, 1, 9, 1))
    assert len(service.requests) == 1
    service.status = 503
    tick(admin, at(config, 2026, 12, 1, 9, 2))
    tick(admin, at(config, 2026, 12, 1, 9, 6))
    assert len(service.requests) == 2
    service.status = 201
    tick(admin, at(config, 2026, 12, 1, 9, 7))
    assert len(service.requests) == 3 and waiting(config) == 0
    # A device refusing three messages in a row (one a month here) is forgotten.
    service.status = 400
    for month in (1, 2):
        tick(admin, at(config, 2027, month, 1, 9))
    assert [row[-1] for row in devices(config)] == [2]
    tick(admin, at(config, 2027, 3, 1, 9))
    assert devices(config) == [] and len(service.requests) == 6
    # One its push service no longer knows, at once.
    register(admin, browser)
    service.status = 410
    tick(admin, at(config, 2027, 4, 1, 9))
    assert devices(config) == [] and len(service.requests) == 7


def test_messages_no_longer_wanted_are_not_sent(admin, config, service):
    register(admin, Browser())
    import_statement(admin)
    # Read before nine.
    tick(admin, at(config, 2026, 12, 1, 8))
    (alert,) = bell(admin)["items"]
    assert admin.post(f"/api/notifications/{alert['id']}/read").status_code == 200
    tick(admin, at(config, 2026, 12, 1, 9))
    assert service.requests == [] and waiting(config) == 0
    # Of a kind turned off.
    admin.patch("/api/notifications/preferences", json={"kind": "statement_missing", "enabled": False})
    tick(admin, at(config, 2027, 1, 1, 9))
    assert service.requests == [] and waiting(config) == 0
    admin.patch("/api/notifications/preferences", json={"kind": "statement_missing", "enabled": True})
    # Waiting three days.
    tick(admin, at(config, 2027, 2, 1, 21, 30))
    assert waiting(config) == 1
    tick(admin, at(config, 2027, 2, 4, 21, 31))
    assert service.requests == [] and waiting(config) == 0


def test_devices_stop_with_the_session_or_the_account(admin, config, mailbox):
    import_statement(admin)
    with neighbor(config, admin, mailbox) as (reader, user):
        set_administrator(admin, user["id"], True)
        phone = Browser(endpoint="https://web.push.apple.com/phone")
        register(reader, phone)
        # Signing out on the device forgets it.
        assert reader.post("/api/auth/logout").status_code == 204
        assert devices(config) == []
        assert login(reader).status_code == 200
        register(reader, phone)
        tick(admin, at(config, 2026, 12, 1, 8))
        assert waiting(config) == 1
        # Someone else signs in on that phone: it becomes theirs, without the other's message.
        register(admin, phone)
        assert [row[:2] for row in devices(config)] == [(phone.endpoint, account(admin))]
        assert waiting(config) == 0
        # Closing every session forgets every device of the account.
        register(reader, Browser(endpoint="https://web.push.apple.com/tablet"))
        assert reader.delete("/api/auth/profile/sessions").status_code == 204
        assert [row[1] for row in devices(config)] == [account(admin)]
    # Deleting the account forgets its notifications.
    assert stored(config, user["id"]) == 1
    current = current_user(admin, user["id"])
    removed = admin.request(
        "DELETE", f"/api/admin/users/{user['id']}",
        json={"email": current["email"], "version": current["version"]},
    )
    assert removed.status_code == 204, removed.text
    assert stored(config, user["id"]) == 0
