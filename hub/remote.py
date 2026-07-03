"""Run commands on remote Ark fleet machines via Tailscale SSH."""

from __future__ import annotations

import subprocess


def run_on_host(
    tailscale_ip: str,
    command: str,
    user: str = "tony",
    timeout: int = 120,
) -> tuple[int, str]:
    """Execute command on remote host. Returns (exit_code, combined_output)."""
    remote = f"{user}@{tailscale_ip}"
    try:
        p = subprocess.run(
            [
                "ssh",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
                remote,
                command,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = (p.stdout or "") + (p.stderr or "")
        return p.returncode, out.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return 124, f"(timed out after {timeout}s)"
    except Exception as e:
        return 1, str(e)
