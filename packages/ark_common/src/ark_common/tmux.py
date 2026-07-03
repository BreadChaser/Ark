"""Read tmux session list (for ark-probe, Phase 2+)."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass
class TmuxSession:
    name: str
    attached: bool
    windows: int = 0


def list_sessions() -> list[TmuxSession]:
    try:
        p = subprocess.run(
            [
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_attached}\t#{session_windows}",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return []
    if p.returncode != 0 or not p.stdout.strip():
        return []
    sessions: list[TmuxSession] = []
    for line in p.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        sessions.append(
            TmuxSession(
                name=parts[0],
                attached=parts[1] == "1",
                windows=int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
            )
        )
    return sessions
