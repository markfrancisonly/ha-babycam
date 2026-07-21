"""Tests for Babycam URL validation."""

import pytest

from custom_components.babycam.config_flow import normalize_server_url


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
