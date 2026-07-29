"""Config flow for the Babycam integration."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse, urlunparse

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_URL
from homeassistant.core import callback

from .const import CONF_DEV_MODE, CONF_ICE_SERVERS, DEFAULT_ICE_SERVERS, DOMAIN


def _schema(default: str | None = None) -> vol.Schema:
    """Build the server URL form schema."""
    marker = (
        vol.Required(CONF_URL)
        if default is None
        else vol.Required(CONF_URL, default=default)
    )
    return vol.Schema({marker: str})


def normalize_server_url(value: str) -> str | None:
    """Validate and normalize a go2rtc websocket server base URL."""
    value = value.strip()
    try:
        parsed = urlparse(value)
        # Accessing port also validates that it is numeric and in range.
        _ = parsed.port
    except ValueError:
        return None

    if parsed.scheme.lower() not in ("ws", "wss") or not parsed.hostname:
        return None
    if parsed.params or parsed.query or parsed.fragment:
        return None

    path = parsed.path.rstrip("/")
    if path.endswith("/api/ws"):
        path = path.removesuffix("/api/ws")

    return urlunparse((parsed.scheme.lower(), parsed.netloc, path, "", "", ""))


def normalize_ice_servers(value: str) -> list | None:
    """Validate the optional STUN/TURN configuration JSON.

    Empty is valid (cards keep their built-in default). Otherwise an
    RTCIceServer object or list of them: each a dict whose ``urls`` is a
    stun/stuns/turn/turns URL string or non-empty list of them. Returns the
    parsed list, or None when invalid.
    """
    value = value.strip()
    if not value:
        return []
    try:
        servers = json.loads(value)
    except ValueError:
        return None

    if isinstance(servers, dict):
        servers = [servers]
    if not isinstance(servers, list) or not servers:
        return None

    for server in servers:
        if not isinstance(server, dict):
            return None
        urls = server.get("urls")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list) or not urls:
            return None
        for url in urls:
            if not isinstance(url, str) or not url.split(":", 1)[0].lower() in (
                "stun",
                "stuns",
                "turn",
                "turns",
            ):
                return None

    return servers


class FlowHandler(ConfigFlow, domain=DOMAIN):
    """Handle the Babycam config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Create the single Babycam config entry."""
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=_schema())

        url = normalize_server_url(user_input[CONF_URL])
        if url is None:
            return self.async_show_form(
                step_id="user",
                data_schema=_schema(user_input[CONF_URL]),
                errors={CONF_URL: "invalid_url"},
            )

        return self.async_create_entry(title=url, data={CONF_URL: url})

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlowHandler:
        """Return the Babycam options flow."""
        return OptionsFlowHandler(config_entry)


class OptionsFlowHandler(OptionsFlow):
    """Allow the go2rtc URL and the card dev-mode hatch to be changed."""

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the options flow."""
        self.entry = entry

    def _options_schema(
        self, url: str, ice_servers: str, dev_mode: bool
    ) -> vol.Schema:
        return vol.Schema(
            {
                vol.Required(CONF_URL, default=url): str,
                vol.Optional(CONF_ICE_SERVERS, default=ice_servers): str,
                vol.Required(CONF_DEV_MODE, default=dev_mode): bool,
            }
        )

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Update the go2rtc server URL, STUN/TURN servers, and serving mode."""
        if user_input is not None:
            url = normalize_server_url(user_input[CONF_URL])
            ice_servers = normalize_ice_servers(user_input.get(CONF_ICE_SERVERS, ""))
            if url is None or ice_servers is None:
                return self.async_show_form(
                    step_id="init",
                    data_schema=self._options_schema(
                        user_input[CONF_URL],
                        user_input.get(CONF_ICE_SERVERS, ""),
                        user_input[CONF_DEV_MODE],
                    ),
                    errors={
                        CONF_URL: "invalid_url"
                    }
                    if url is None
                    else {CONF_ICE_SERVERS: "invalid_ice_servers"},
                )

            # Title tracks the URL, but only refreshed when the URL actually
            # changes — an options save that leaves the URL alone (or a manual
            # rename) is preserved.
            old_url = self.entry.data[CONF_URL]
            title = url if url != old_url else self.entry.title
            self.hass.config_entries.async_update_entry(
                self.entry,
                title=title,
                data={**self.entry.data, CONF_URL: url, CONF_ICE_SERVERS: ice_servers},
            )
            return self.async_create_entry(
                title="", data={CONF_DEV_MODE: user_input[CONF_DEV_MODE]}
            )

        current = self.entry.data.get(CONF_ICE_SERVERS) or DEFAULT_ICE_SERVERS
        return self.async_show_form(
            step_id="init",
            data_schema=self._options_schema(
                self.entry.data[CONF_URL],
                json.dumps(current),
                self.entry.options.get(CONF_DEV_MODE, False),
            ),
        )
