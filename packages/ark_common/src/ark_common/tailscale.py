"""Discover machines on the Tailscale tailnet."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass


@dataclass
class TailscalePeer:
    id: str
    hostname: str
    dns_name: str
    tailscale_ip: str
    online: bool
    os: str
    is_self: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "hostname": self.hostname,
            "dns_name": self.dns_name,
            "tailscale_ip": self.tailscale_ip,
            "online": self.online,
            "os": self.os,
            "is_self": self.is_self,
        }


def _slug(dns_name: str, hostname: str) -> str:
    name = (dns_name or hostname or "unknown").split(".")[0].lower()
    return name.replace(" ", "-")


def list_peers() -> list[TailscalePeer]:
    try:
        p = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return []
    if p.returncode != 0 or not p.stdout.strip():
        return []
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        return []

    peers: list[TailscalePeer] = []
    self_info = data.get("Self") or {}
    self_ip = (self_info.get("TailscaleIPs") or [""])[0]
    peers.append(
        TailscalePeer(
            id=_slug(self_info.get("DNSName", ""), self_info.get("HostName", "self")),
            hostname=self_info.get("HostName") or "self",
            dns_name=(self_info.get("DNSName") or "").rstrip("."),
            tailscale_ip=self_ip,
            online=True,
            os=self_info.get("OS") or "linux",
            is_self=True,
        )
    )

    for _key, peer in (data.get("Peer") or {}).items():
        ips = peer.get("TailscaleIPs") or []
        if not ips:
            continue
        dns = (peer.get("DNSName") or "").rstrip(".")
        host = peer.get("HostName") or dns.split(".")[0]
        peers.append(
            TailscalePeer(
                id=_slug(dns, host),
                hostname=host,
                dns_name=dns,
                tailscale_ip=ips[0],
                online=bool(peer.get("Online")),
                os=peer.get("OS") or "unknown",
            )
        )

    peers.sort(key=lambda x: (not x.is_self, not x.online, x.hostname.lower()))
    return peers
