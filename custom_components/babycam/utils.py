"""Minimal helpers for the Babycam signaling proxy and frontend resource.

Derived from the webrtc (AlexxIT) fork, stripped to the signed-path validation
and Lovelace registration Babycam uses. Domain and API paths are deliberately
distinct from both the
`webrtc` custom integration (/api/webrtc/*) and HA's built-in go2rtc
integration, so all three can coexist.
"""

import hashlib
import logging

import jwt
from aiohttp import web
from homeassistant.components.http.auth import DATA_SIGN_SECRET, SIGN_QUERY_PARAM

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)


def validate_signed_request(request: web.Request) -> bool:
    """Validate the path signature used by the proven legacy WebRTC proxy."""
    try:
        hass = request.app["hass"]
        secret = hass.data.get(DATA_SIGN_SECRET)
        signature = request.query.get(SIGN_QUERY_PARAM)
        claims = jwt.decode(signature, secret, algorithms=["HS256"])
        return claims["path"] == request.path
    except Exception:  # noqa: BLE001 - invalid/missing signatures are rejected
        return False


def card_etag(version: str | None, card: bytes) -> str:
    """Version the backend/frontend contract as an HTTP ETag.

    Combines the running backend's release with a digest of the card bytes it
    captured at startup, so the validator moves exactly when the contract
    does — at a restart that changed either side — and never when a pending
    update merely lands on disk. Returned unquoted; the view quotes it when
    emitting the header and compares against aiohttp's parsed validators.
    """
    digest = hashlib.sha256(card).hexdigest()[:12]
    return f"{version or '0'}-{digest}"


async def async_init_resource(hass: HomeAssistant, url: str) -> bool:
    """Ensure a module entry for ``url`` in the Lovelace resource registry.

    The card is served with ``Cache-Control: no-cache`` and a contract ETag
    (see ``card_etag``), so the URL needs no version query: browsers
    revalidate on every dashboard load (cheap 304s) and fetch fresh code
    after the restart that activated a new backend. Storage-mode dashboards
    only: in YAML mode the resource list is user-managed, so log the line to
    add instead.
    """
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)

    if resources is None:
        _LOGGER.warning("Lovelace resources are unavailable; add '%s' as a module", url)
        return False

    if not hasattr(resources, "async_create_item"):
        _LOGGER.warning(
            "Lovelace is in YAML mode; add '%s' to your resources as a module", url
        )
        return False

    # Loading is lazy. async_get_info() is the collection's public load guard.
    await resources.async_get_info()

    for item in resources.async_items():
        if item.get("url", "").split("?", 1)[0] != url:
            continue
        if item["url"] == url:
            return False
        # Normalize a versioned ``?v=`` entry left by an earlier release.
        await resources.async_update_item(
            item["id"], {"res_type": "module", "url": url}
        )
        _LOGGER.info("Updated lovelace resource to %s", url)
        return True

    await resources.async_create_item({"res_type": "module", "url": url})
    _LOGGER.info("Registered lovelace resource %s", url)
    return True
