"""Tests for Babycam backend helpers."""

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from homeassistant.components.http import KEY_HASS
from homeassistant.const import CONF_URL
from homeassistant.exceptions import HomeAssistantError

import custom_components.babycam as babycam
from custom_components.babycam import (
    CardView,
    async_setup_entry,
    async_unload_entry,
    signaling_url,
    ws_config,
)
from custom_components.babycam.const import (
    CONF_DEV_MODE,
    CONF_ICE_SERVERS,
    DEFAULT_ICE_SERVERS,
    DOMAIN,
    EVENT_OPEN,
)
from custom_components.babycam.utils import card_etag


async def _run_in_loop(func: Callable, *args: Any) -> Any:
    """Stand in for hass.async_add_executor_job in tests."""
    return func(*args)


def _request(
    etags: tuple[str, ...] = (), hass: Any | None = None
) -> SimpleNamespace:
    """Build a minimal aiohttp request for CardView.

    ``etags`` mimics aiohttp's parsed ``if_none_match`` (ETag.value strings,
    already unquoted / weak-prefix-stripped).
    """
    return SimpleNamespace(
        if_none_match=tuple(SimpleNamespace(value=v) for v in etags),
        app={KEY_HASS: hass or SimpleNamespace(data={})},
    )


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
        self.options: dict[str, Any] = {}
        self.listener: Callable | None = None
        self.unload_callbacks: list[Callable] = []

    def add_update_listener(self, listener: Callable) -> Callable[[], None]:
        self.listener = listener
        return lambda: None

    def async_on_unload(self, callback: Callable) -> None:
        self.unload_callbacks.append(callback)


def test_card_etag_moves_with_backend_version_and_card_bytes() -> None:
    assert card_etag("2026.7.21", b"a") == card_etag("2026.7.21", b"a")
    assert card_etag("2026.7.21", b"a") != card_etag("2026.7.22", b"a")
    assert card_etag("2026.7.21", b"a") != card_etag("2026.7.21", b"b")


@pytest.mark.asyncio
async def test_card_view_serves_startup_snapshot() -> None:
    card = b"const CARD_VERSION = 'test';"
    view = CardView(card, card_etag("2026.7.21", card))

    response = await view.get(_request())

    assert response.status == 200
    assert response.body == card
    assert response.headers["Cache-Control"] == "no-cache"
    assert response.headers["ETag"] == f'"{card_etag("2026.7.21", card)}"'


@pytest.mark.asyncio
async def test_card_view_revalidates_matching_etag_to_304() -> None:
    etag = card_etag("2026.7.21", b"card")
    view = CardView(b"card", etag)

    assert (await view.get(_request((etag,)))).status == 304

    # Lists and weak validators arrive as parsed values; '*' matches anything.
    assert (await view.get(_request(("other", etag)))).status == 304
    assert (await view.get(_request(("*",)))).status == 304

    stale = _request((card_etag("2026.7.20", b"card"),))
    assert (await view.get(stale)).status == 200


@pytest.mark.asyncio
async def test_card_view_dev_mode_serves_live_file(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    card_file = tmp_path / "webrtc-babycam.js"
    card_file.write_bytes(b"v1")
    monkeypatch.setattr(babycam, "CARD_PATH", card_file)

    snapshot = b"snapshot"
    view = CardView(snapshot, card_etag("2026.7.21", snapshot))
    dev_hass = SimpleNamespace(
        data={DOMAIN: {CONF_DEV_MODE: True}},
        async_add_executor_job=_run_in_loop,
    )

    # Dev mode bypasses the snapshot and tracks the file on disk.
    assert (await view.get(_request(hass=dev_hass))).body == b"v1"
    card_file.write_bytes(b"v2")
    assert (await view.get(_request(hass=dev_hass))).body == b"v2"
    etag = card_etag("dev", b"v2")
    assert (await view.get(_request((etag,), dev_hass))).status == 304

    # Production (no dev flag) still serves the startup snapshot.
    prod_hass = SimpleNamespace(data={DOMAIN: {CONF_DEV_MODE: False}})
    assert (await view.get(_request(hass=prod_hass))).body == snapshot


def test_signaling_url_encodes_stream_name() -> None:
    hass = SimpleNamespace(data={DOMAIN: {CONF_URL: "ws://go2rtc:1984"}})

    assert signaling_url(hass, "nursery camera/main") == (
        "ws://go2rtc:1984/api/ws?src=nursery+camera%2Fmain"
    )


def test_ws_config_returns_ice_servers() -> None:
    sent = {}
    connection = SimpleNamespace(
        send_result=lambda msg_id, result: sent.update({msg_id: result})
    )
    servers = [{"urls": "turns:turn.example.com:443?transport=tcp"}]

    ws_config(
        SimpleNamespace(data={DOMAIN: {CONF_ICE_SERVERS: servers}}),
        connection,
        {"id": 1, "type": "babycam/config"},
    )
    assert sent[1] == {"ice_servers": servers}

    # Unconfigured and empty both report None so cards keep their default.
    ws_config(SimpleNamespace(data={}), connection, {"id": 2, "type": "babycam/config"})
    ws_config(
        SimpleNamespace(data={DOMAIN: {CONF_ICE_SERVERS: []}}),
        connection,
        {"id": 3, "type": "babycam/config"},
    )
    assert sent[2] == sent[3] == {"ice_servers": None}


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
    # No configured value -> the default STUN entry is advertised to cards.
    assert hass.data[DOMAIN][CONF_ICE_SERVERS] == DEFAULT_ICE_SERVERS
    assert entry.listener is not None
    assert len(entry.unload_callbacks) == 1

    await services.handlers[(DOMAIN, "open")](
        SimpleNamespace(data={"entity": "nursery"})
    )
    assert events == [(EVENT_OPEN, {"entity": "nursery"})]

    assert await async_unload_entry(hass, entry) is True
    assert DOMAIN not in hass.data
    assert services.handlers == {}
