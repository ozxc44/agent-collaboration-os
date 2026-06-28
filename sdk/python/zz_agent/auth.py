from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from .models import TokenResponse


class TokenManager:
    """Manages authentication tokens for the zz-agent API.

    Handles token acquisition, caching, and automatic refresh.
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._http_client = http_client or httpx.Client()
        self._token: Optional[TokenResponse] = None

    @property
    def token(self) -> Optional[TokenResponse]:
        return self._token

    def login(
        self,
        api_key: str | None = None,
        *,
        email: str | None = None,
        password: str | None = None,
    ) -> TokenResponse:
        """Log in through the token endpoint.

        ``email``/``password`` is the recommended user flow and is supported by
        current backends. ``api_key`` is a legacy parameter that may not be
        accepted by all backend versions.
        """
        body = {"email": email, "password": password} if email and password else {"api_key": api_key}
        response = self._http_client.post(
            f"{self._base_url}/v1/auth/token",
            json=body,
        )
        response.raise_for_status()
        data = response.json()
        self._token = TokenResponse(**data)
        self._api_key = api_key
        return self._token

    def get_headers(self) -> dict[str, str]:
        """Return authorization headers for API requests.

        Raises RuntimeError if no token or API key is available.
        """
        if self._token:
            expires_ts = self._token.expires_at.timestamp()
            if time.time() < expires_ts - 60:
                return {"Authorization": f"Bearer {self._token.access_token}"}

        if self._api_key:
            if self._api_key.startswith("zzk_"):
                return {"X-API-Key": self._api_key}
            return {"Authorization": f"Bearer {self._api_key}"}

        raise RuntimeError(
            "No authentication credentials available. "
            "Call client.auth.login(email=..., password=...) or pass a JWT/API key."
        )

    def is_authenticated(self) -> bool:
        """Check if we have a valid (non-expired) token."""
        if self._token:
            expires_ts = self._token.expires_at.timestamp()
            if time.time() < expires_ts:
                return True
            self._token = None
        return bool(self._api_key)
