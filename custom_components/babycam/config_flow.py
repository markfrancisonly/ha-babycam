"""Config flow for the Babycam integration."""

from __future__ import annotations

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

from .const import DOMAIN


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

        return self.async_create_entry(title="Babycam", data={CONF_URL: url})

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlowHandler:
        """Return the Babycam options flow."""
        return OptionsFlowHandler(config_entry)


class OptionsFlowHandler(OptionsFlow):
    """Allow the configured go2rtc URL to be changed."""

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the options flow."""
        self.entry = entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Update the go2rtc websocket server URL."""
        if user_input is not None:
            url = normalize_server_url(user_input[CONF_URL])
            if url is None:
                return self.async_show_form(
                    step_id="init",
                    data_schema=_schema(user_input[CONF_URL]),
                    errors={CONF_URL: "invalid_url"},
                )

            self.hass.config_entries.async_update_entry(
                self.entry,
                data={**self.entry.data, CONF_URL: url},
            )
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="init",
            data_schema=_schema(self.entry.data[CONF_URL]),
        )
