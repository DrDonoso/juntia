import asyncio
import base64
import hashlib
import logging
import re
import secrets
import time
from datetime import timedelta
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Request, Response
from pydantic import Field, ValidationError, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import RedirectResponse

from .auth import (
    DB,
    GOOGLE_COOKIE,
    USER_COOKIE,
    Resident,
    access_hash,
    administrator,
    issue_resident_session,
    revoke_user,
    settings,
    throttle,
    verify_current_password,
)
from .config import Settings, normalize_origin
from .contracts import CurrentPasswordIn, EmailIn, GoogleStartIn, GoogleStartOut, display_name
from .db import GoogleAuthFlow, User, UserSession, UserToken, aware, utcnow
from .errors import AppError
from .users import clear_resident_cookie, current_profile_user, locked_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth/google", tags=["Google sign-in"])
AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
CALLBACK_PATH = "/api/auth/google/callback"
FLOW_SECONDS = 600


class GoogleIdentity(EmailIn):
    subject: str = Field(min_length=1, max_length=255)
    name: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def optional_profile_name(cls, value: object) -> str | None:
        if value is None:
            return None
        try:
            if not isinstance(value, str) or len(value) > 150:
                raise ValueError("Invalid profile name")
            return display_name(value)
        except ValueError:
            log.warning("Ignoring invalid Google profile name")
            return None

    @classmethod
    def profile_name(cls, name: object, given_name: object, family_name: object) -> str | None:
        given = cls.optional_profile_name(given_name)
        family = cls.optional_profile_name(family_name)
        if given is not None and family is not None:
            combined = cls.optional_profile_name(f"{given} {family}")
            if combined is not None:
                return combined
        return cls.optional_profile_name(name)


def require_google(config: Settings) -> None:
    if not config.google_enabled:
        raise AppError("google_disabled", 503)


def pkce_verifier(config: Settings, state: str) -> str:
    return access_hash(config, "google-pkce", state)


def flow_nonce(config: Settings, state: str) -> str:
    return access_hash(config, "google-nonce", state)


def authorization_url(config: Settings, state: str, origin: str) -> str:
    verifier = pkce_verifier(config, state)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return AUTHORIZATION_URL + "?" + urlencode({
        "client_id": config.google_client_id,
        "redirect_uri": origin + CALLBACK_PATH,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": flow_nonce(config, state),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
        "access_type": "online",
    })


class GoogleProvider:
    def __init__(self, config: Settings):
        self.config = config
        self.client = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.keys: dict[str, jwt.PyJWK] = {}
        self.keys_expire = 0.0
        self.key_lock = asyncio.Lock()

    async def close(self) -> None:
        await self.client.aclose()

    async def signing_key(self, kid: str) -> jwt.PyJWK:
        async with self.key_lock:
            if time.monotonic() < self.keys_expire and kid in self.keys:
                return self.keys[kid]
            response = await self.client.get(JWKS_URL)
            response.raise_for_status()
            if len(response.content) > 65536:
                raise AppError("google_unavailable", 503)
            data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("keys"), list):
                raise AppError("google_unavailable", 503)
            keys = {}
            for item in data["keys"]:
                if (
                    isinstance(item, dict) and item.get("kty") == "RSA"
                    and item.get("alg") == "RS256" and item.get("use") == "sig"
                    and isinstance(item.get("kid"), str)
                ):
                    keys[item["kid"]] = jwt.PyJWK.from_dict(item, algorithm="RS256")
            if not keys:
                raise AppError("google_unavailable", 503)
            max_age = re.search(r"(?:^|,)\s*max-age=([0-9]+)", response.headers.get("cache-control", ""))
            ttl = min(int(max_age[1]), 3600) if max_age else 300
            self.keys, self.keys_expire = keys, time.monotonic() + ttl
            if kid not in keys:
                raise AppError("google_invalid_identity", 400)
            return keys[kid]

    async def exchange(self, code: str, state: str, origin: str) -> GoogleIdentity:
        config = self.config
        try:
            async with asyncio.timeout(20):
                response = await self.client.post(TOKEN_URL, data={
                    "code": code,
                    "client_id": config.google_client_id,
                    "client_secret": config.google_client_secret.get_secret_value(),
                    "redirect_uri": origin + CALLBACK_PATH,
                    "grant_type": "authorization_code",
                    "code_verifier": pkce_verifier(config, state),
                })
                if response.status_code == 400:
                    raise AppError("google_invalid_identity", 400)
                response.raise_for_status()
                if len(response.content) > 65536:
                    raise AppError("google_invalid_identity", 400)
                data = response.json()
                token = data.get("id_token") if isinstance(data, dict) else None
                if not isinstance(token, str) or len(token) > 16384:
                    raise AppError("google_invalid_identity", 400)
                header = jwt.get_unverified_header(token)
                kid = header.get("kid")
                if header.get("alg") != "RS256" or not isinstance(kid, str) or not 1 <= len(kid) <= 200:
                    raise AppError("google_invalid_identity", 400)
                key = await self.signing_key(kid)
                claims = jwt.decode(
                    token, key.key, algorithms=["RS256"], audience=config.google_client_id,
                    issuer=["https://accounts.google.com", "accounts.google.com"],
                    leeway=30,
                    options={"require": ["iss", "aud", "exp", "iat", "sub", "nonce", "email", "email_verified"]},
                )
                nonce = claims.get("nonce")
                audience, authorized_party = claims["aud"], claims.get("azp")
                if (
                    claims["email_verified"] is not True
                    or not isinstance(nonce, str)
                    or not secrets.compare_digest(nonce, flow_nonce(config, state))
                    or (authorized_party is not None and authorized_party != config.google_client_id)
                    or (isinstance(audience, list) and len(audience) > 1 and authorized_party is None)
                    or not isinstance(claims["sub"], str)
                    or not claims["sub"].isascii()
                ):
                    raise AppError("google_invalid_identity", 400)
                return GoogleIdentity(
                    subject=claims["sub"], email=claims["email"],
                    name=GoogleIdentity.profile_name(
                        claims.get("name"), claims.get("given_name"), claims.get("family_name"),
                    ),
                )
        except (httpx.HTTPError, TimeoutError) as error:
            log.warning("Google provider unavailable (%s)", type(error).__name__)
            raise AppError("google_unavailable", 503) from None
        except (jwt.PyJWTError, ValueError, TypeError) as error:
            log.warning("Google identity validation failed (%s)", type(error).__name__)
            raise AppError("google_invalid_identity", 400) from None


async def create_flow(
    db: AsyncSession, request: Request, response: Response, body: GoogleStartIn,
    *, user: User | None = None, linking: bool = False,
) -> GoogleStartOut:
    config = settings(request)
    origin = normalize_origin(request.headers["origin"])
    state, browser = secrets.token_hex(32), secrets.token_hex(32)
    now = utcnow()
    previous = request.cookies.get(GOOGLE_COOKIE)
    await db.execute(delete(GoogleAuthFlow).where(GoogleAuthFlow.expires_at <= now))
    if previous:
        await db.execute(delete(GoogleAuthFlow).where(
            GoogleAuthFlow.browser_hash == access_hash(config, "google-browser", previous)
        ))
    previous_session = request.cookies.get(USER_COOKIE, "")
    session_hash = access_hash(config, "session", previous_session) if len(previous_session) == 64 else None
    flow = GoogleAuthFlow(
        state_hash=access_hash(config, "google-state", state),
        browser_hash=access_hash(config, "google-browser", browser),
        origin=origin, return_path="/profile" if linking else body.return_path,
        purpose="link" if linking else "invitation" if body.invitation_token else "login",
        user_id=user.id if user else None, auth_version=user.auth_version if user else None,
        invitation_hash=(
            access_hash(config, "invitation", body.invitation_token) if body.invitation_token else None
        ),
        session_hash=session_hash, expires_at=now + timedelta(seconds=FLOW_SECONDS),
    )
    db.add(flow)
    await db.commit()
    response.set_cookie(
        GOOGLE_COOKIE, browser, max_age=FLOW_SECONDS, httponly=True,
        secure=config.auth_cookie_secure, samesite="lax", path="/api/auth",
    )
    return GoogleStartOut(authorization_url=authorization_url(config, state, origin))


@router.post("/start", response_model=GoogleStartOut)
async def start(body: GoogleStartIn, request: Request, response: Response, db: DB) -> GoogleStartOut:
    config = settings(request)
    require_google(config)
    await throttle(
        db, request, "google-start", request.client.host if request.client else "unknown",
        limit=20, ip_limit=30,
    )
    try:
        await administrator(request, db)
    except AppError as error:
        if error.status != 401:
            raise
    else:
        raise AppError("google_admin_session", 403)
    user = None
    if body.invitation_token:
        token = await db.get(UserToken, access_hash(config, "invitation", body.invitation_token))
        if token is None or token.purpose != "invitation" or aware(token.expires_at) <= utcnow():
            raise AppError("invalid_account_link", 400)
        user = await locked_user(db, token.user_id)
        if user.disabled or user.activated or user.auth_version != token.auth_version:
            raise AppError("invalid_account_link", 400)
    return await create_flow(db, request, response, body, user=user)


@router.post("/link", response_model=GoogleStartOut)
async def link(
    body: CurrentPasswordIn, user_id: Resident, request: Request, response: Response, db: DB
) -> GoogleStartOut:
    require_google(settings(request))
    password_hash, version = await verify_current_password(db, user_id, body.current_password, request)
    user = await current_profile_user(request, db, user_id)
    if user.auth_version != version or user.password_hash != password_hash:
        raise AppError("authentication_required", 401)
    if user.google_subject is not None:
        raise AppError("google_already_linked", 409)
    return await create_flow(db, request, response, GoogleStartIn(), user=user, linking=True)


@router.delete("/link", status_code=204)
async def unlink(
    body: CurrentPasswordIn, user_id: Resident, request: Request, response: Response, db: DB
) -> None:
    password_hash, version = await verify_current_password(db, user_id, body.current_password, request)
    user = await current_profile_user(request, db, user_id)
    if user.auth_version != version or user.password_hash != password_hash:
        raise AppError("authentication_required", 401)
    if user.google_subject is None:
        raise AppError("google_not_linked", 409)
    user.google_subject = None
    user.version += 1
    await revoke_user(db, user)
    await db.commit()
    clear_resident_cookie(request, response)


async def consume_flow(request: Request, db: AsyncSession, state: str) -> GoogleAuthFlow:
    config = settings(request)
    binding = request.cookies.get(GOOGLE_COOKIE, "")
    if not re.fullmatch(r"[0-9a-f]{64}", state) or not re.fullmatch(r"[0-9a-f]{64}", binding):
        raise AppError("google_invalid_flow", 400)
    hashed = access_hash(config, "google-state", state)
    flow = await db.get(GoogleAuthFlow, hashed)
    if (
        flow is None or aware(flow.expires_at) <= utcnow()
        or flow.origin not in config.public_origins
        or flow.origin != normalize_origin(str(request.base_url))
        or not secrets.compare_digest(
            flow.browser_hash, access_hash(config, "google-browser", binding)
        )
    ):
        raise AppError("google_invalid_flow", 400)
    consumed = await db.scalar(delete(GoogleAuthFlow).where(
        GoogleAuthFlow.state_hash == hashed, GoogleAuthFlow.expires_at > utcnow()
    ).returning(GoogleAuthFlow.state_hash).execution_options(synchronize_session="fetch"))
    if consumed is None:
        raise AppError("google_invalid_flow", 400)
    await db.commit()
    return flow


async def authenticate_identity(
    identity: GoogleIdentity, flow: GoogleAuthFlow, request: Request, db: AsyncSession,
    response: Response,
) -> None:
    if flow.purpose == "login":
        user = await db.scalar(
            select(User).where(User.google_subject == identity.subject).with_for_update()
            .execution_options(populate_existing=True)
        )
    else:
        user = await locked_user(db, flow.user_id) if flow.user_id is not None else None
    if (
        user is None or user.disabled or user.email != identity.email
        or (flow.auth_version is not None and flow.auth_version != user.auth_version)
    ):
        raise AppError("google_access_denied", 403)
    if flow.purpose == "invitation":
        if user.activated:
            raise AppError("invalid_account_link", 400)
        consumed = await db.scalar(delete(UserToken).where(
            UserToken.token_hash == flow.invitation_hash, UserToken.user_id == user.id,
            UserToken.purpose == "invitation", UserToken.auth_version == user.auth_version,
            UserToken.expires_at > utcnow(),
        ).returning(UserToken.user_id))
        if consumed is None:
            raise AppError("invalid_account_link", 400)
        user.activated = True
        user.google_subject = identity.subject
        if identity.name is not None:
            user.name = identity.name
        user.version += 1
        user.invitation_token_hash = None
        user.invitation_delivery = "none"
        user.invitation_expires_at = None
        user.invitation_sent_at = None
        await revoke_user(db, user)
    elif flow.purpose == "link":
        session = await db.get(UserSession, flow.session_hash) if flow.session_hash else None
        if (
            not user.activated or user.google_subject is not None or session is None
            or session.user_id != user.id or session.auth_version != user.auth_version
            or aware(session.expires_at) <= utcnow()
        ):
            raise AppError("google_access_denied", 403)
        user.google_subject = identity.subject
        user.version += 1
        await db.commit()
        return
    elif not user.activated:
        raise AppError("google_access_denied", 403)
    if flow.session_hash:
        # Strict session cookies are absent on Google's cross-site callback.
        await db.execute(delete(UserSession).where(UserSession.token_hash == flow.session_hash))
    await issue_resident_session(db, request, response, user)


def callback_response(path: str, request: Request) -> RedirectResponse:
    response = RedirectResponse(path, status_code=303)
    response.delete_cookie(
        GOOGLE_COOKIE, path="/api/auth", httponly=True,
        secure=settings(request).auth_cookie_secure, samesite="lax",
    )
    return response


@router.get("/callback", response_class=RedirectResponse, include_in_schema=False)
async def callback(request: Request, db: DB) -> RedirectResponse:
    flow = None
    try:
        require_google(settings(request))
        params = request.query_params
        if len(params.getlist("state")) != 1:
            raise AppError("google_invalid_flow", 400)
        state = params["state"]
        flow = await consume_flow(request, db, state)
        if params.get("error"):
            raise AppError("google_cancelled", 400)
        codes = params.getlist("code")
        if len(codes) != 1 or not 1 <= len(codes[0]) <= 4096:
            raise AppError("google_invalid_identity", 400)
        identity = await request.app.state.google_provider.exchange(codes[0], state, flow.origin)
        target = "/profile?google=linked" if flow.purpose == "link" else flow.return_path
        response = callback_response(target, request)
        await authenticate_identity(identity, flow, request, db, response)
        return response
    except IntegrityError:
        await db.rollback()
        code = "google_access_denied"
        log.warning("Google account association conflicted with an existing identity")
    except AppError as error:
        await db.rollback()
        code = error.code
        log.info("Google sign-in stopped (%s)", code)
    except (ValueError, ValidationError):
        await db.rollback()
        code = "google_invalid_flow"
        log.warning("Google callback origin or state was invalid")
    path = "/profile" if flow and flow.purpose == "link" else "/login"
    query = {"google_error": code}
    if flow and flow.purpose == "invitation":
        query["invitation"] = "retry"
    return callback_response(path + "?" + urlencode(query), request)
