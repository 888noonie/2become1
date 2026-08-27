"""Phase 7B security hardening: network-exposure gate and truthful reporting.

Section 13 of the implementation plan requires that binding a non-loopback host
needs an explicit ``--allow-network`` flag and that the Engine view reports the
exposure truthfully. These tests pin that contract.
"""

from __future__ import annotations

import pytest

from twobecomeone import webapp


def _is_loopback(host: str) -> bool:
    return webapp._is_loopback_host(host)


class TestLoopbackDetection:
    def test_loopback_hosts(self):
        for host in ("127.0.0.1", "localhost", "::1"):
            assert _is_loopback(host), host

    def test_non_loopback_hosts(self):
        for host in ("0.0.0.0", "::", "192.168.1.10", "example.com"):
            assert not _is_loopback(host), host


class TestNetworkExposureReporting:
    def test_loopback_bind_reports_loopback_only(self):
        exposure = webapp._network_exposure("127.0.0.1")
        assert exposure["loopback_only"] is True
        assert exposure["authenticated"] is False

    def test_non_loopback_bind_reports_exposed(self):
        exposure = webapp._network_exposure("0.0.0.0")
        assert exposure["loopback_only"] is False
        assert exposure["authenticated"] is False
        assert "no authentication" in exposure["warning"].lower()


class TestAllowNetworkGate:
    def test_non_loopback_requires_allow_network(self):
        """Binding a non-loopback host without --allow-network is refused."""
        from twobecomeone.cli import _require_allow_network
        from twobecomeone.common import UserError

        with pytest.raises(UserError, match="allow-network"):
            _require_allow_network("0.0.0.0", allow_network=False)

    def test_loopback_never_requires_flag(self):
        from twobecomeone.cli import _require_allow_network

        # Loopback binds are always permitted without the flag.
        _require_allow_network("127.0.0.1", allow_network=False)
        _require_allow_network("localhost", allow_network=False)

    def test_non_loopback_with_flag_is_permitted(self):
        from twobecomeone.cli import _require_allow_network

        _require_allow_network("0.0.0.0", allow_network=True)

    def test_cli_fails_before_app_creation_for_non_loopback(self, monkeypatch):
        from twobecomeone.cli import main

        def forbidden_create_app(*_args, **_kwargs):
            raise AssertionError("create_app must not run before the network gate")

        monkeypatch.setattr(webapp, "create_app", forbidden_create_app)
        assert main(["web", "--host", "0.0.0.0"]) == 1
