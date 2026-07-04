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
    """True only while the session still has a generic initial name."""
    return current_name in (hostname, f"New on {hostname}", "New session")


def polish_output(text: str) -> str:
    """Strip noise and dedupe captured shell output."""
    if not text or text in ("(ok)", "(no output)", "(empty pane)"):
        return text

    lines = text.splitlines()
    cleaned: list[str] = []
    prev = None

    for line in lines:
        s = line.strip()
        if not s or s == "$":
            continue
        if "__ARK_" in s:
            continue
        if "; echo __ARK_" in s:
            continue
        if re.match(r"^.*\$\s+\S", line) and "echo __ARK_" in line:
            continue
        if re.match(r"^[\w@.~-]+:.*[$#]\s*", line):
            continue
        if s.startswith("$ ") and len(s) > 2:
            continue
        if s == prev:
            continue
        cleaned.append(line.rstrip())
        prev = s

    return "\n".join(cleaned).strip() or text.strip()


def clean_tmux_output(text: str) -> str:
    """Strip noisy shell prompts from captured pane."""
    return polish_output(text)
