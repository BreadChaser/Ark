"""Infer session display names from user activity."""

from __future__ import annotations

import os
import re


_SKIP_VERBS = frozenset(
    {
        "ls",
        "pwd",
        "echo",
        "hostname",
        "whoami",
        "capture",
        ":capture",
        "clear",
        "tmux",
        "cd",
    }
)


def infer_name(command: str, hostname: str) -> str | None:
    """Return a human session name from a command, or None to keep current."""
    cmd = command.strip()
    if not cmd or cmd in ("capture", ":capture"):
        return None

    # cd [path] — most common "what I'm doing" signal
    first_part = cmd.split("&&")[0].strip()
    m = re.match(r"cd\s+(.+)$", first_part)
    if m:
        path = m.group(1).strip().strip('"').strip("'")
        path = path.replace("~/", "").rstrip("/")
        base = os.path.basename(path) or path.split("/")[-1] or path
        if base and base not in (".", "..", "~"):
            return f"{hostname} · {base}"

    # compound without leading cd on first part — try any segment
    if "&&" in cmd:
        parts = [p.strip() for p in cmd.split("&&")]
        for part in parts:
            name = infer_name(part, hostname)
            if name and "·" in name:
                return name
        if len(parts) >= 2:
            tail = parts[-1].split()[0].split("/")[-1]
            if tail not in _SKIP_VERBS:
                head = parts[0]
                m2 = re.match(r"cd\s+(.+)$", head)
                if m2:
                    path = m2.group(1).strip().strip('"').strip("'").rstrip("/")
                    base = os.path.basename(path) or path.split("/")[-1]
                    return f"{hostname} · {base}"

    first = cmd.split()[0].split("/")[-1]
    if first in ("opencode", "codex", "python", "cargo", "npm", "git"):
        return f"{hostname} · {first}"
    if first not in _SKIP_VERBS and not first.startswith("-"):
        return f"{hostname} · {first}"
    return None


def should_auto_rename(current_name: str, hostname: str) -> bool:
    """True if session still has a generic name."""
    if current_name in (hostname, f"New on {hostname}", "New session"):
        return True
    if current_name.startswith(f"{hostname} · "):
        return True  # allow refining cd path
    return False


def clean_tmux_output(text: str) -> str:
    """Strip noisy shell prompts from captured pane."""
    lines = text.splitlines()
    cleaned: list[str] = []
    prompt_re = re.compile(r"^[\w@.~-]+:.*[$#]\s*")
    for line in lines:
        if prompt_re.match(line) and not line.strip().endswith(("\\", "|")):
            continue
        if line.strip() in ("", "$"):
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip() or text.strip()
