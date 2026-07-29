"""Babycam integration: go2rtc proxy and browser-wide camera overlays."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlencode

import voluptuous as vol
from aiohttp import web
from homeassistant.components import websocket_api
from homeassistant.components.hassio.ingress import _websocket_forward
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.const import CONF_URL
from homeassistant.core import Event, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration
from homeassistant.setup import async_when_setup

from . import utils
from .const import (
    CARD_FILENAME,
    CARD_URL,
    CONF_DEV_MODE,
    CONF_ICE_SERVERS,
    DEFAULT_ICE_SERVERS,
    DOMAIN,
    EVENT_CLOSE,
    EVENT_OPEN,
    SERVICE_CLOSE,
    SERVICE_OPEN,
)

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.helpers.typing import ConfigType

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

CARD_PATH = Path(__file__).parent / "www" / CARD_FILENAME

# Everything passed to babycam.open is forwarded to the card as its config.
OPEN_SCHEMA = vol.Schema(
    {
        vol.Required("entity"): cv.string,
        vol.Optional("image_entity"): cv.string,
    },
    extra=vol.ALLOW_EXTRA,
)
CLOSE_SCHEMA = vol.Schema({}, extra=vol.ALLOW_EXTRA)


@websocket_api.websocket_command({vol.Required("type"): "babycam/subscribe"})
@websocket_api.async_response
async def ws_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe an authenticated frontend to Babycam overlay events."""

    @callback
    def forward(event: Event) -> None:
        connection.send_message(
            websocket_api.event_message(
                msg["id"],
                {"event_type": event.event_type, "data": dict(event.data)},
            )
        )

    unsubs = (
        hass.bus.async_listen(EVENT_OPEN, forward),
        hass.bus.async_listen(EVENT_CLOSE, forward),
    )

    @callback
    def unsub_all() -> None:
        for unsubscribe in unsubs:
            unsubscribe()

    connection.subscriptions[msg["id"]] = unsub_all
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): "babycam/config"})
@callback
def ws_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return integration-level client configuration for the card.

    Cards slot these ICE servers into the advertised-configuration slot,
    below an explicit per-card ``ice_servers``.
    """
    data = hass.data.get(DOMAIN) or {}
    connection.send_result(
        msg["id"], {"ice_servers": data.get(CONF_ICE_SERVERS) or None}
    )


class CardView(HomeAssistantView):
    """Serve the card bytes captured at backend startup.

    The snapshot is the backend/frontend contract: browsers get exactly the
    card that shipped with the RUNNING backend. An update (HACS, manual copy)
    only overwrites the file on disk — the served bytes and ETag hold until
    Home Assistant restarts, when backend code and card flip together, so a
    new card never talks to an old backend or vice versa. ``no-cache`` keeps
    every dashboard reload revalidating: cheap 304s between restarts, one
    full fetch after.

    The ``dev_mode`` option is the development hatch: it serves the file live
    from disk on the same URL, so copying a new card in shows up on a plain
    browser reload — no restart, no contract. Production leaves it off.
    """

    url = CARD_URL
    name = "babycam:card"
    requires_auth = False  # module scripts are fetched without auth headers

    def __init__(self, card: bytes, etag: str) -> None:
        """Hold the card bytes and contract ETag for the backend's lifetime."""
        self.card = card
        self.etag = etag

    @staticmethod
    def _respond(request: web.Request, card: bytes, etag: str) -> web.Response:
        headers = {"Cache-Control": "no-cache", "ETag": f'"{etag}"'}
        # aiohttp parses If-None-Match into ETag objects: lists and W/ weak
        # validators (a compressing proxy may weaken ours) match by value.
        if request.if_none_match and any(
            tag.value in ("*", etag) for tag in request.if_none_match
        ):
            return web.Response(status=304, headers=headers)
        return web.Response(
            body=card,
            content_type="text/javascript",
            charset="utf-8",
            headers=headers,
        )

    async def get(self, request: web.Request) -> web.Response:
        """Return the card source, or 304 when the browser's copy matches."""
        hass = request.app[KEY_HASS]
        data = hass.data.get(DOMAIN)
        if data and data.get(CONF_DEV_MODE):
            card = await hass.async_add_executor_job(CARD_PATH.read_bytes)
            return self._respond(request, card, utils.card_etag("dev", card))
        return self._respond(request, self.card, self.etag)

    async def head(self, request: web.Request) -> web.Response:
        """Answer HEAD probes (aiohttp omits the body automatically)."""
        return await self.get(request)


async def async_setup(hass: HomeAssistant, _config: ConfigType) -> bool:
    """Register integration-wide HTTP, websocket, and frontend resources."""
    integration = await async_get_integration(hass, DOMAIN)
    card = await hass.async_add_executor_job(CARD_PATH.read_bytes)
    hass.http.register_view(
        CardView(card, utils.card_etag(integration.version, card))
    )
    hass.http.register_view(WebSocketView)
    hass.http.register_view(StreamView)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_config)

    async def register_card(hass: HomeAssistant, _component: str) -> None:
        await utils.async_init_resource(hass, CARD_URL)

    async_when_setup(hass, "lovelace", register_card)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the single Babycam config entry."""
    hass.data[DOMAIN] = {
        "entry_id": entry.entry_id,
        CONF_URL: entry.data[CONF_URL],
        CONF_ICE_SERVERS: entry.data.get(CONF_ICE_SERVERS) or DEFAULT_ICE_SERVERS,
        CONF_DEV_MODE: entry.options.get(CONF_DEV_MODE, False),
    }
    if hass.data[DOMAIN][CONF_DEV_MODE]:
        _LOGGER.warning(
            "Babycam dev mode: serving the card live from %s; the "
            "backend/frontend startup contract is suspended",
            CARD_PATH,
        )

    async def handle_open(call: ServiceCall) -> None:
        hass.bus.async_fire(EVENT_OPEN, dict(call.data))

    async def handle_close(call: ServiceCall) -> None:
        hass.bus.async_fire(EVENT_CLOSE, dict(call.data))

    hass.services.async_register(DOMAIN, SERVICE_OPEN, handle_open, OPEN_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_CLOSE, handle_close, CLOSE_SCHEMA)
    entry.async_on_unload(entry.add_update_listener(async_update_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the Babycam config entry."""
    data = hass.data.get(DOMAIN)
    if data and data.get("entry_id") == entry.entry_id:
        hass.data.pop(DOMAIN)
        hass.services.async_remove(DOMAIN, SERVICE_OPEN)
        hass.services.async_remove(DOMAIN, SERVICE_CLOSE)
    return True


async def async_update_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload Babycam after its server URL changes."""
    await hass.config_entries.async_reload(entry.entry_id)


def signaling_url(hass: HomeAssistant, entity: str) -> str:
    """Build the configured upstream go2rtc websocket URL for a stream."""
    if not entity:
        raise ValueError("A go2rtc stream name is required")

    data = hass.data.get(DOMAIN)
    if not data or not data.get(CONF_URL):
        raise HomeAssistantError("Babycam is not configured")

    query = urlencode({"src": entity})
    return f"{data[CONF_URL]}/api/ws?{query}"




class WebSocketView(HomeAssistantView):
    """Proxy signed WebRTC signaling websocket traffic to go2rtc."""

    url = "/api/babycam/ws"
    name = "api:babycam:ws"
    # Match the proven legacy WebRTC transport: validate the signed path before
    # upgrading instead of relying on HomeAssistantView's route-auth wrapper.
    requires_auth = False

    async def get(self, request: web.Request) -> web.WebSocketResponse:
        """Open the proxied signaling websocket."""
        if not utils.validate_signed_request(request):
            raise web.HTTPUnauthorized

        entity = request.query.get("entity", "").strip()
        if not entity:
            raise web.HTTPBadRequest(text="Missing entity")

        client = web.WebSocketResponse(autoclose=False, autoping=False)
        await client.prepare(request)

        try:
            hass = request.app[KEY_HASS]
            upstream_url = signaling_url(hass, entity)
            forwarded_for = request.headers.get("X-Forwarded-For")
            forwarded_for = (
                f"{forwarded_for}, {request.remote}"
                if forwarded_for
                else request.remote
            )
            headers = {
                "X-Forwarded-For": forwarded_for,
                "X-Forwarded-Host": request.host,
                "X-Forwarded-Proto": request.scheme,
            }
            if user_agent := request.headers.get("User-Agent"):
                headers["User-Agent"] = user_agent

            async with async_get_clientsession(hass).ws_connect(
                upstream_url,
                autoclose=False,
                autoping=False,
                headers=headers,
            ) as upstream:
                await asyncio.wait(
                    [
                        asyncio.create_task(_websocket_forward(client, upstream)),
                        asyncio.create_task(_websocket_forward(upstream, client)),
                    ],
                    return_when=asyncio.FIRST_COMPLETED,
                )
        except Exception as err:  # noqa: BLE001 - websocket/network boundary
            _LOGGER.debug("Babycam signaling proxy failed: %s", err)
            if not client.closed:
                await client.send_json({"type": "error", "value": str(err)})

        return client


class StreamView(HomeAssistantView):
    """Perform a REST SDP exchange for non-websocket clients."""

    url = "/api/babycam/stream"
    name = "api:babycam:stream"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        """Exchange an SDP offer with the configured go2rtc server."""
        params = await request.post()
        entity = str(params.get("entity", "")).strip()
        sdp = str(params.get("sdp", "")).strip()
        if not entity or not sdp:
            raise web.HTTPBadRequest(text="Missing entity or sdp")

        hass = request.app[KEY_HASS]
        try:
            upstream_url = signaling_url(hass, entity)
            async with async_get_clientsession(hass).ws_connect(upstream_url) as ws:
                await ws.send_json({"type": "webrtc", "sdp": sdp})
                response = await ws.receive_json(timeout=15)
        except HomeAssistantError as err:
            raise web.HTTPServiceUnavailable(text=str(err)) from err
        except Exception as err:  # noqa: BLE001 - network boundary
            _LOGGER.debug("Babycam SDP exchange failed: %s", err)
            return web.json_response({"error": str(err)}, status=502)

        return web.json_response(response)
