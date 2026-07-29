"""Tests for Babycam URL validation."""

import pytest

from custom_components.babycam.config_flow import (
    normalize_ice_servers,
    normalize_server_url,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("ws://go2rtc:1984", "ws://go2rtc:1984"),
        (" WSS://example.com:443/ ", "wss://example.com:443"),
        ("ws://[fd00::1]:1984/", "ws://[fd00::1]:1984"),
        ("ws://go2rtc:1984/proxy/", "ws://go2rtc:1984/proxy"),
        ("ws://go2rtc:1984/proxy/api/ws", "ws://go2rtc:1984/proxy"),
    ],
)
def test_normalize_server_url(value: str, expected: str) -> None:
    assert normalize_server_url(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "http://go2rtc:1984",
        "ws://",
        "ws://go2rtc:bad",
        "ws://go2rtc:70000",
        "ws://go2rtc:1984?src=camera.nursery",
    ],
)
def test_reject_invalid_server_url(value: str) -> None:
    assert normalize_server_url(value) is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", []),
        ("   ", []),
        (
            '{"urls": "stun:stun.example.com:3478"}',
            [{"urls": "stun:stun.example.com:3478"}],
        ),
        (
            '[{"urls": ["stun:a.example.com", "turns:b.example.com:443?transport=tcp"],'
            ' "username": "u", "credential": "c"}]',
            [
                {
                    "urls": [
                        "stun:a.example.com",
                        "turns:b.example.com:443?transport=tcp",
                    ],
                    "username": "u",
                    "credential": "c",
                }
            ],
        ),
    ],
)
def test_normalize_ice_servers(value: str, expected: list) -> None:
    assert normalize_ice_servers(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "not json",
        "[]",
        '"stun:server"',
        '["stun:server"]',
        '[{"username": "u"}]',
        '[{"urls": []}]',
        '[{"urls": "https://example.com"}]',
        '[{"urls": ["stun:ok", 5]}]',
    ],
)
def test_reject_invalid_ice_servers(value: str) -> None:
    assert normalize_ice_servers(value) is None
