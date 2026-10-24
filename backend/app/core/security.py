"""Minimal JWT auth with three roles: viewer < operator < admin.

Reads stay open; every mutating endpoint depends on `require_operator` / `require_admin`.
When `auth.enabled` is false (local dev), requests run as an anonymous admin.
"""

import hmac
import jwt
from app.core.config import settings
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

ROLE_RANK = {"viewer": 1, "operator": 2, "admin": 3}
ALGORITHM = "HS256"

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    username: str
    role: str


def authenticate(username: str, password: str) -> Principal | None:
    for user in settings.auth.users:
        # Compare both fields in constant time; don't reveal which one was wrong.
        user_ok = hmac.compare_digest(user.username, username)
        pass_ok = hmac.compare_digest(user.password, password)
        if user_ok and pass_ok and user.role in ROLE_RANK:
            return Principal(user.username, user.role)
    return None


def create_token(principal: Principal) -> tuple[str, int]:
    """Returns (token, expires_in_seconds)."""
    expires = timedelta(minutes=settings.auth.token_minutes)
    payload = {
        "sub": principal.username,
        "role": principal.role,
        "exp": datetime.now(UTC) + expires,
    }
    return jwt.encode(payload, settings.auth.secret, algorithm=ALGORITHM), int(
        expires.total_seconds()
    )


def decode_token(token: str) -> Principal:
    payload = jwt.decode(token, settings.auth.secret, algorithms=[ALGORITHM])
    role = payload.get("role")
    if role not in ROLE_RANK or not payload.get("sub"):
        raise jwt.InvalidTokenError("bad claims")
    return Principal(payload["sub"], role)


def get_principal(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> Principal:
    if not settings.auth.enabled:
        return Principal("anonymous", "admin")
    if creds is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None


def require_role(minimum: str):
    def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if ROLE_RANK[principal.role] < ROLE_RANK[minimum]:
            raise HTTPException(status_code=403, detail=f"Requires role '{minimum}' or higher")
        return principal

    return dependency


require_operator = require_role("operator")
require_admin = require_role("admin")
