"""Tests for Babycam backend helpers."""

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from homeassistant.const import CONF_URL
from homeassistant.exceptions import HomeAssistantError

from custom_components.babycam import (
    async_setup_entry,
    async_unload_entry,
    signaling_url,
)
from custom_components.babycam.const import DOMAIN, EVENT_OPEN


class FakeServices:
    """Minimal Home Assistant service registry."""

    def __init__(self) -> None:
        self.handlers: dict[tuple[str, str], Callable] = {}

    def async_register(
        self,
        domain: str,
        service: str,
        handler: Callable,
        _schema: Any,
    ) -> None:
        self.handlers[(domain, service)] = handler

    def async_remove(self, domain: str, service: str) -> None:
        self.handlers.pop((domain, service))


class FakeConfigEntry:
    """Minimal config entry with update-listener lifecycle support."""

    entry_id = "entry-id"

    def __init__(self) -> None:
        self.data = {CONF_URL: "ws://go2rtc:1984"}
        self.listener: Callable | None = None
        self.unload_callbacks: list[Callable] = []

    def add_update_listener(self, listener: Callable) -> Callable[[], None]:
        self.listener = listener
        return lambda: None

    def async_on_unload(self, callback: Callable) -> None:
        self.unload_callbacks.append(callback)


def test_signaling_url_encodes_stream_name() -> None:
    hass = SimpleNamespace(data={DOMAIN: {CONF_URL: "ws://go2rtc:1984"}})

    assert signaling_url(hass, "nursery camera/main") == (
        "ws://go2rtc:1984/api/ws?src=nursery+camera%2Fmain"
    )


def test_signaling_url_requires_config_entry() -> None:
    hass = SimpleNamespace(data={})

    with pytest.raises(HomeAssistantError, match="not configured"):
        signaling_url(hass, "nursery")


def test_signaling_url_requires_stream_name() -> None:
    hass = SimpleNamespace(data={DOMAIN: {CONF_URL: "ws://go2rtc:1984"}})

    with pytest.raises(ValueError, match="stream name"):
        signaling_url(hass, "")


@pytest.mark.asyncio
async def test_config_entry_owns_services_and_runtime_data() -> None:
    events = []
    services = FakeServices()
    hass = SimpleNamespace(
        data={},
        services=services,
        bus=SimpleNamespace(
            async_fire=lambda event_type, data: events.append((event_type, data))
        ),
    )
    entry = FakeConfigEntry()

    assert await async_setup_entry(hass, entry) is True
    assert hass.data[DOMAIN][CONF_URL] == "ws://go2rtc:1984"
    assert entry.listener is not None
    assert len(entry.unload_callbacks) == 1

    await services.handlers[(DOMAIN, "open")](
        SimpleNamespace(data={"entity": "nursery"})
    )
    assert events == [(EVENT_OPEN, {"entity": "nursery"})]

    assert await async_unload_entry(hass, entry) is True
    assert DOMAIN not in hass.data
    assert services.handlers == {}
