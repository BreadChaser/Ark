"""SSH + tmux automation for Ark sessions."""

from __future__ import annotations

import shlex
import subprocess
import time


def _shell_single(cmd: str) -> str:
    return "'" + cmd.replace("'", "'\"'\"'") + "'"


def run_on_host(
    tailscale_ip: str,
    command: str,
    user: str = "tony",
    timeout: int = 120,
    local: bool = False,
) -> tuple[int, str]:
    if local:
        try:
            p = subprocess.run(
                command,
                shell=True,
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


def ensure_tmux(tmux_name: str, tailscale_ip: str, local: bool = False) -> tuple[int, str]:
    """Create detached tmux session if missing."""
    script = (
        f"tmux has-session -t {shlex.quote(tmux_name)} 2>/dev/null "
        f"|| tmux new-session -d -s {shlex.quote(tmux_name)}"
    )
    return run_on_host(tailscale_ip, script, local=local, timeout=30)


def run_in_tmux(
    tmux_name: str,
    command: str,
    tailscale_ip: str,
    local: bool = False,
    wait_s: float = 0.6,
) -> tuple[int, str]:
    """Send command to tmux session and capture pane output."""
    inner = (
        f"tmux send-keys -t {shlex.quote(tmux_name)} {_shell_single(command)} Enter; "
        f"sleep {wait_s}; "
        f"tmux capture-pane -pt {shlex.quote(tmux_name)} -S -120"
    )
    return run_on_host(tailscale_ip, inner, local=local, timeout=120)


def capture_tmux(tmux_name: str, tailscale_ip: str, local: bool = False) -> tuple[int, str]:
    cmd = f"tmux capture-pane -pt {shlex.quote(tmux_name)} -S -80"
    return run_on_host(tailscale_ip, cmd, local=local, timeout=15)


def kill_tmux(tmux_name: str, tailscale_ip: str, local: bool = False) -> tuple[int, str]:
    cmd = f"tmux kill-session -t {shlex.quote(tmux_name)} 2>/dev/null || true"
    return run_on_host(tailscale_ip, cmd, local=local, timeout=15)
