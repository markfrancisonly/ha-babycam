"""Babycam integration: go2rtc proxy and browser-wide camera overlays."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlencode

import voluptuous as vol
from aiohttp import ClientWebSocketResponse, WSMsgType, web
from homeassistant.components import websocket_api
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.const import CONF_URL
from homeassistant.core import Event, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.setup import async_when_setup

from . import utils
from .const import (
    CARD_FILENAME,
    CARD_URL,
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


class CardView(HomeAssistantView):
    """Serve the bundled card with always-revalidate caching.

    ``no-cache`` plus FileResponse's validators (ETag / Last-Modified) mean a
    plain dashboard reload picks up a replaced file — no Home Assistant
    restart, no version query — while unchanged loads stay cheap 304s.
    """

    url = CARD_URL
    name = "babycam:card"
    requires_auth = False  # module scripts are fetched without auth headers

    async def get(self, _request: web.Request) -> web.FileResponse:
        """Return the card source."""
        return web.FileResponse(CARD_PATH, headers={"Cache-Control": "no-cache"})

    async def head(self, request: web.Request) -> web.FileResponse:
        """Answer HEAD probes (FileResponse sends headers only for HEAD)."""
        return await self.get(request)


async def async_setup(hass: HomeAssistant, _config: ConfigType) -> bool:
    """Register integration-wide HTTP, websocket, and frontend resources."""
    hass.http.register_view(WebSocketView)
    hass.http.register_view(StreamView)
    hass.http.register_view(CardView)
    websocket_api.async_register_command(hass, ws_subscribe)

    async def register_card(hass: HomeAssistant, _component: str) -> None:
        await utils.async_init_resource(hass, CARD_URL)

    async_when_setup(hass, "lovelace", register_card)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the single Babycam config entry."""
    hass.data[DOMAIN] = {
        "entry_id": entry.entry_id,
        CONF_URL: entry.data[CONF_URL],
    }

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


async def _forward_websocket(
    source: web.WebSocketResponse | ClientWebSocketResponse,
    target: web.WebSocketResponse | ClientWebSocketResponse,
) -> None:
    """Forward websocket frames until one side closes."""
    async for message in source:
        if message.type is WSMsgType.TEXT:
            await target.send_str(message.data)
        elif message.type is WSMsgType.BINARY:
            await target.send_bytes(message.data)
        elif message.type is WSMsgType.PING:
            await target.ping(message.data)
        elif message.type is WSMsgType.PONG:
            await target.pong(message.data)
        elif message.type in (
            WSMsgType.CLOSE,
            WSMsgType.CLOSING,
            WSMsgType.CLOSED,
        ):
            break
        elif message.type is WSMsgType.ERROR:
            raise ConnectionError("Websocket transport failed")


class WebSocketView(HomeAssistantView):
    """Proxy an authenticated WebRTC signaling websocket to go2rtc."""

    url = "/api/babycam/ws"
    name = "api:babycam:ws"
    # Home Assistant's auth middleware accepts the signed URL generated by
    # auth/sign_path and validates its path, query, expiry, and issuing user.
    requires_auth = True

    async def get(self, request: web.Request) -> web.WebSocketResponse:
        """Open the proxied signaling websocket."""
        entity = request.query.get("entity", "").strip()
        if not entity:
            raise web.HTTPBadRequest(text="Missing entity")

        hass = request.app[KEY_HASS]
        try:
            upstream_url = signaling_url(hass, entity)
        except HomeAssistantError as err:
            raise web.HTTPServiceUnavailable(text=str(err)) from err

        client = web.WebSocketResponse(autoclose=False, autoping=False)
        await client.prepare(request)

        forwarded_for = ", ".join(
            part
            for part in (request.headers.get("X-Forwarded-For"), request.remote)
            if part
        )
        headers = {
            "X-Forwarded-Host": request.host,
            "X-Forwarded-Proto": request.scheme,
        }
        if forwarded_for:
            headers["X-Forwarded-For"] = forwarded_for
        if user_agent := request.headers.get("User-Agent"):
            headers["User-Agent"] = user_agent

        try:
            async with async_get_clientsession(hass).ws_connect(
                upstream_url,
                autoclose=False,
                autoping=False,
                headers=headers,
            ) as upstream:
                tasks = {
                    asyncio.create_task(_forward_websocket(client, upstream)),
                    asyncio.create_task(_forward_websocket(upstream, client)),
                }
                done, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for task in done:
                    task.result()
        except Exception as err:  # noqa: BLE001 - network boundary
            _LOGGER.debug("Babycam signaling proxy failed: %s", err)
            if not client.closed:
                with suppress(ConnectionError, RuntimeError):
                    await client.send_json({"type": "error", "value": str(err)})
        finally:
            if not client.closed:
                await client.close()

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
