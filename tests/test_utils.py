"""Tests for Babycam integration helpers."""

import time
from types import SimpleNamespace

import jwt
import pytest
from homeassistant.components.http.auth import DATA_SIGN_SECRET, SIGN_QUERY_PARAM

from custom_components.babycam.utils import async_init_resource, validate_signed_request


def test_validate_signed_request_accepts_matching_path() -> None:
    """A current signature for the requested proxy path is accepted."""
    secret = "test-secret"
    signature = jwt.encode(
        {"path": "/api/babycam/ws", "exp": time.time() + 60},
        secret,
        algorithm="HS256",
    )
    request = SimpleNamespace(
        app={"hass": SimpleNamespace(data={DATA_SIGN_SECRET: secret})},
        query={SIGN_QUERY_PARAM: signature},
        path="/api/babycam/ws",
    )

    assert validate_signed_request(request) is True


def test_validate_signed_request_rejects_other_path() -> None:
    """A signature cannot be reused for a different endpoint."""
    secret = "test-secret"
    signature = jwt.encode(
        {"path": "/api/other/ws", "exp": time.time() + 60},
        secret,
        algorithm="HS256",
    )
    request = SimpleNamespace(
        app={"hass": SimpleNamespace(data={DATA_SIGN_SECRET: secret})},
        query={SIGN_QUERY_PARAM: signature},
        path="/api/babycam/ws",
    )

    assert validate_signed_request(request) is False


class FakeResources:
    """Small ResourceStorageCollection stand-in."""

    def __init__(self, items: list[dict]) -> None:
        self.items = items
        self.created: list[dict] = []
        self.updated: list[tuple[str, dict]] = []
        self.loaded = False

    async def async_get_info(self) -> dict[str, int]:
        self.loaded = True
        return {"resources": len(self.items)}

    def async_items(self) -> list[dict]:
        return self.items

    async def async_create_item(self, data: dict) -> None:
        self.created.append(data)

    async def async_update_item(self, item_id: str, data: dict) -> None:
        self.updated.append((item_id, data))


def _hass(resources: FakeResources) -> SimpleNamespace:
    return SimpleNamespace(data={"lovelace": SimpleNamespace(resources=resources)})


@pytest.mark.asyncio
async def test_register_resource() -> None:
    resources = FakeResources([])

    changed = await async_init_resource(_hass(resources), "/babycam/webrtc-babycam.js")

    assert changed is True
    assert resources.loaded is True
    assert resources.created == [
        {"res_type": "module", "url": "/babycam/webrtc-babycam.js"}
    ]


@pytest.mark.asyncio
async def test_existing_resource_is_untouched() -> None:
    resources = FakeResources(
        [
            {
                "id": "resource-id",
                "res_type": "module",
                "url": "/babycam/webrtc-babycam.js",
            }
        ]
    )

    changed = await async_init_resource(_hass(resources), "/babycam/webrtc-babycam.js")

    assert changed is False
    assert resources.created == []
    assert resources.updated == []


@pytest.mark.asyncio
async def test_normalize_legacy_versioned_resource() -> None:
    resources = FakeResources(
        [
            {
                "id": "resource-id",
                "res_type": "module",
                "url": "/babycam/webrtc-babycam.js?v=2026.7.5",
            }
        ]
    )

    changed = await async_init_resource(_hass(resources), "/babycam/webrtc-babycam.js")

    assert changed is True
    assert resources.updated == [
        ("resource-id", {"res_type": "module", "url": "/babycam/webrtc-babycam.js"})
    ]
    assert resources.created == []


@pytest.mark.asyncio
async def test_ignore_similarly_prefixed_resource() -> None:
    resources = FakeResources(
        [{"id": "other-resource", "url": "/babycam/webrtc-babycam.js.backup?v=old"}]
    )

    await async_init_resource(_hass(resources), "/babycam/webrtc-babycam.js")

    assert resources.updated == []
    assert len(resources.created) == 1
