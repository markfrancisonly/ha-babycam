"""Minimal helpers for the babycam signaling proxy.

Derived from the webrtc (AlexxIT) fork, stripped to what babycam actually
uses: Lovelace registration of the bundled card. Domain and API paths are
deliberately distinct from both the
`webrtc` custom integration (/api/webrtc/*) and HA's built-in go2rtc
integration, so all three can coexist.
"""

import logging

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)


async def async_init_resource(hass: HomeAssistant, url: str) -> bool:
    """Ensure a module entry for ``url`` in the Lovelace resource registry.

    The card is served with ``Cache-Control: no-cache`` and validators, so
    the URL needs no version query: browsers revalidate on every dashboard
    load and a plain reload picks up replaced code (304 when unchanged).
    Storage-mode dashboards only: in YAML mode the resource list is
    user-managed, so log the line to add instead.
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
