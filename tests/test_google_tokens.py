import json
import time
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr

from juntia.errors import AppError
from juntia.google_auth import (
    CALLBACK_PATH,
    JWKS_URL,
    TOKEN_URL,
    GoogleProvider,
    flow_nonce,
    pkce_verifier,
)


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def make_claims(config, state):
    return {
        "iss": "https://accounts.google.com", "aud": config.google_client_id,
        "exp": int(time.time()) + 300, "iat": int(time.time()), "sub": "google-user-123",
        "email": "Resident@Example.org", "email_verified": True,
        "nonce": flow_nonce(config, state),
    }


async def provider_with_transport(config, signing_key, token):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    config.google_client_secret = SecretStr("synthetic-google-client-secret")
    provider = GoogleProvider(config)
    requests = []
    key = {
        **json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key())),
        "kid": "test-key", "use": "sig", "alg": "RS256",
    }
    async def handle(request):
        requests.append(request)
        if str(request.url) == TOKEN_URL:
            return httpx.Response(200, json={"id_token": token, "access_token": "unused-token"})
        assert str(request.url) == JWKS_URL
        return httpx.Response(200, json={"keys": [key]}, headers={"cache-control": "public, max-age=3600"})
    await provider.client.aclose()
    provider.client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return provider, requests


async def test_code_exchange_validates_signed_identity_and_caches_google_keys(config, signing_key):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    state = "a" * 64
    token = jwt.encode(make_claims(config, state), signing_key, algorithm="RS256", headers={"kid": "test-key"})
    provider, requests = await provider_with_transport(config, signing_key, token)
    try:
        first = await provider.exchange("test-code", state, config.public_origin)
        assert first.subject == "google-user-123" and first.email == "resident@example.org"
        assert await provider.exchange("second-code", state, config.public_origin) == first
        assert [str(request.url) for request in requests] == [TOKEN_URL, JWKS_URL, TOKEN_URL]
        posted = parse_qs(requests[0].content.decode())
        assert posted["code_verifier"] == [pkce_verifier(config, state)]
        assert posted["client_secret"] == [config.google_client_secret.get_secret_value()]
        assert posted["redirect_uri"] == [config.public_origin + CALLBACK_PATH]
        assert "unused-token" not in repr(first)
    finally:
        await provider.close()


@pytest.mark.parametrize(("profile", "expected_name"), [
    ({}, None),
    ({"name": None}, None),
    ({"name": "  Mar\u00eda   Garc\u00eda L\u00f3pez  "}, "Mar\u00eda Garc\u00eda L\u00f3pez"),
    ({"name": "A"}, "A"),
    ({"name": "A" * 150}, "A" * 150),
    ({"name": ""}, None),
    ({"name": " \u00a0 "}, None),
    ({"name": "A" * 151}, None),
    ({"name": "Private Google\nProfile"}, None),
    ({"name": "Hidden\x00Name"}, None),
    ({"name": "Hidden\x7fName"}, None),
    ({"name": 42}, None),
    ({"name": True}, None),
    ({"name": []}, None),
    ({"name": {"first": "Private Google Profile"}}, None),
])
async def test_code_exchange_validates_optional_profile_name(
    config, signing_key, caplog, profile, expected_name
):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    state = "a" * 64
    token = jwt.encode(
        {**make_claims(config, state), **profile}, signing_key,
        algorithm="RS256", headers={"kid": "test-key"},
    )
    provider, _ = await provider_with_transport(config, signing_key, token)
    try:
        identity = await provider.exchange("test-code", state, config.public_origin)
        assert identity.subject == "google-user-123"
        assert identity.email == "resident@example.org"
        assert identity.name == expected_name
        if profile.get("name") is not None and expected_name is None:
            assert "Ignoring invalid Google profile name" in caplog.text
        else:
            assert "Ignoring invalid Google profile name" not in caplog.text
        assert "Private Google" not in caplog.text
    finally:
        await provider.close()


@pytest.mark.parametrize(("profile", "expected_name"), [
    ({"given_name": "María", "family_name": "García López"}, "María García López"),
    ({"name": "María", "given_name": "María", "family_name": "García López"},
     "María García López"),
    ({"name": "María García López", "given_name": "María", "family_name": "García López"},
     "María García López"),
    ({"given_name": "  María   José ", "family_name": " García   López "},
     "María José García López"),
    ({"name": "María García López", "given_name": "María"}, "María García López"),
    ({"name": "María García López", "family_name": "García López"}, "María García López"),
    ({"given_name": "María"}, None),
    ({"family_name": "García López"}, None),
    ({"name": "María García", "given_name": "", "family_name": "García"}, "María García"),
    ({"name": "María García", "given_name": "María", "family_name": " \u00a0 "}, "María García"),
    ({"name": "María García", "given_name": 42, "family_name": "García"}, "María García"),
    ({"name": "María García", "given_name": "María", "family_name": []}, "María García"),
    ({"given_name": "Private\nName", "family_name": "García"}, None),
    ({"given_name": "María", "family_name": "Private\x00Name"}, None),
    ({"given_name": "María", "family_name": "Private\x7fName"}, None),
    ({"given_name": "A" * 74, "family_name": "B" * 75}, "A" * 74 + " " + "B" * 75),
    ({"given_name": "A" * 75, "family_name": "B" * 75}, None),
    ({"name": "Fallback", "given_name": "A" * 75, "family_name": "B" * 75}, "Fallback"),
    ({"name": "Fallback", "given_name": "A" * 151, "family_name": "B"}, "Fallback"),
])
async def test_code_exchange_imports_given_and_family_names(
    config, signing_key, caplog, profile, expected_name
):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    state = "a" * 64
    token = jwt.encode(
        {**make_claims(config, state), **profile}, signing_key,
        algorithm="RS256", headers={"kid": "test-key"},
    )
    provider, _ = await provider_with_transport(config, signing_key, token)
    try:
        identity = await provider.exchange("test-code", state, config.public_origin)
        assert identity.name == expected_name
        assert "Private" not in caplog.text
    finally:
        await provider.close()


@pytest.mark.parametrize("changes", [
    {"iss": "https://attacker.invalid"}, {"aud": "other-client"}, {"nonce": "wrong"},
    {"exp": 0}, {"iat": 9999999999}, {"sub": ""}, {"sub": 123},
    {"email": "bad-email"}, {"email_verified": False}, {"email_verified": "true"},
    {"azp": "other-client"}, {"aud": ["synthetic-client.apps.googleusercontent.com", "other-client"]},
])
async def test_invalid_google_claims_cannot_authenticate(config, signing_key, changes):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    state = "a" * 64
    token = jwt.encode(
        {**make_claims(config, state), **changes}, signing_key,
        algorithm="RS256", headers={"kid": "test-key"},
    )
    provider, _ = await provider_with_transport(config, signing_key, token)
    try:
        with pytest.raises(AppError) as error:
            await provider.exchange("test-code", state, config.public_origin)
        assert error.value.code == "google_invalid_identity"
    finally:
        await provider.close()


@pytest.mark.parametrize("kind", ["missing-nonce", "bad-signature", "wrong-algorithm", "missing-key"])
async def test_unsigned_or_incomplete_google_tokens_are_rejected(config, signing_key, kind):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    state = "a" * 64
    claims = make_claims(config, state)
    if kind == "missing-nonce":
        del claims["nonce"]
    if kind == "wrong-algorithm":
        token = jwt.encode(claims, "x" * 64, algorithm="HS256", headers={"kid": "test-key"})
    else:
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048) if kind == "bad-signature" else signing_key
        token = jwt.encode(claims, private, algorithm="RS256", headers={"kid": "unknown" if kind == "missing-key" else "test-key"})
    provider, _ = await provider_with_transport(config, signing_key, token)
    try:
        with pytest.raises(AppError) as error:
            await provider.exchange("test-code", state, config.public_origin)
        assert error.value.code == "google_invalid_identity"
    finally:
        await provider.close()


async def test_provider_failure_is_explicit_and_does_not_log_tokens(config, caplog):
    config.google_client_id = "synthetic-client.apps.googleusercontent.com"
    config.google_client_secret = SecretStr("private-client-secret")
    provider = GoogleProvider(config)
    async def failed(request):
        raise httpx.ReadTimeout("private authorization code and client secret")
    await provider.client.aclose()
    provider.client = httpx.AsyncClient(transport=httpx.MockTransport(failed))
    try:
        with pytest.raises(AppError) as error:
            await provider.exchange("private-code", "a" * 64, config.public_origin)
        assert error.value.code == "google_unavailable"
        assert "ReadTimeout" in caplog.text
        assert "private" not in caplog.text
    finally:
        await provider.close()
