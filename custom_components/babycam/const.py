"""Constants for the Babycam integration."""

from typing import Final

DOMAIN: Final = "babycam"

CARD_FILENAME: Final = "webrtc-babycam.js"
CARD_URL: Final = f"/{DOMAIN}/{CARD_FILENAME}"

# Option: serve the card live from disk instead of the startup snapshot.
CONF_DEV_MODE: Final = "dev_mode"

# Integration-level STUN/TURN servers advertised to cards; a card's own
# ice_servers overrides. Empty/unset falls back to the default below.
CONF_ICE_SERVERS: Final = "ice_servers"
DEFAULT_ICE_SERVERS: Final = [{"urls": "stun:stun.l.google.com:19302"}]

EVENT_OPEN: Final = f"{DOMAIN}_open"
EVENT_CLOSE: Final = f"{DOMAIN}_close"

SERVICE_OPEN: Final = "open"
SERVICE_CLOSE: Final = "close"
