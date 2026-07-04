"""SSH + tmux automation for Ark sessions."""

from __future__ import annotations

import getpass
import os
import re
import shlex
import subprocess
import time
import uuid


def _shell_single(cmd: str) -> str:
    return "'" + cmd.replace("'", "'\"'\"'") + "'"


_PROMPT_RE = re.compile(r"^[\w@.~-]+:.*[$#]\s*")
_ANSI_STRIP = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _strip_ansi(s: str) -> str:
    return _ANSI_STRIP.sub("", s)


def _is_bare_cd(command: str) -> bool:
    s = command.strip()
    if s == "cd":
        return True
    if "&&" in s or ";" in s:
        return False
    return bool(re.match(r"^cd\s+\S", s))


def prepare_command(command: str) -> str:
    """Make silent commands (like bare cd) show useful output."""
    s = command.strip()
    if s == "cd":
        return "cd ~ && pwd"
    if _is_bare_cd(s):
        return f"{s} && pwd"
    return command


def extract_command_output(pane: str, marker: str, sent: str) -> tuple[int, str]:
    """Pull only the output from the latest command using an end marker."""
    lines = pane.splitlines()
    exit_code = 0
    end_idx = len(lines)

    for i in range(len(lines) - 1, -1, -1):
        if marker in lines[i]:
            m = re.search(rf"{re.escape(marker)}:(\d+)", lines[i])
            if m:
                exit_code = int(m.group(1))
            end_idx = i
            break
    else:
        return 1, pane

    cmd_hint = sent.split("; echo")[0]
    start_idx = max(0, end_idx - 20)
    for i in range(end_idx - 1, -1, -1):
        if cmd_hint in lines[i]:
            start_idx = i + 1
            break

    out_lines: list[str] = []
    for line in lines[start_idx:end_idx]:
        if _PROMPT_RE.match(line) and not line.strip().endswith(("\\", "|")):
            continue
        if line.strip() in ("", "$"):
            continue
        if "__ARK_" in line:
            continue
        if "; echo __ARK_" in line:
            continue
        if cmd_hint in line:
            continue
        out_lines.append(line)

    text = "\n".join(out_lines).strip()
    if not text:
        return exit_code, "(ok)" if exit_code == 0 else f"(exit {exit_code})"
    return exit_code, text


def run_on_host(
    tailscale_ip: str,
    command: str,
    user: str | None = None,
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

    ssh_user = user or os.environ.get("ARK_SSH_USER") or getpass.getuser()
    remote = f"{ssh_user}@{tailscale_ip}"
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


def ensure_tmux(
    tmux_name: str, tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, str]:
    """Create detached tmux session in $HOME if missing."""
    script = (
        f"tmux has-session -t {shlex.quote(tmux_name)} 2>/dev/null "
        f"|| tmux new-session -d -s {shlex.quote(tmux_name)} -c ~"
    )
    return run_on_host(tailscale_ip, script, local=local, user=user, timeout=30)


def list_tmux_sessions(
    tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, list[dict], str]:
    """Return tmux sessions visible on a host."""
    cmd = "tmux list-sessions -F '#S\t#{session_windows}\t#{session_attached}\t#{session_created}'"
    code, out = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    if code != 0:
        if "no server running" in out.lower():
            return 0, [], ""
        return code, [], out
    sessions = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, windows, attached, created = parts[:4]
        sessions.append(
            {
                "name": name,
                "windows": int(windows) if windows.isdigit() else None,
                "attached": int(attached) if attached.isdigit() else None,
                "created": int(created) if created.isdigit() else None,
                "ark": name.startswith("ark-"),
            }
        )
    return 0, sessions, ""


def tmux_missing(text: str) -> bool:
    low = text.lower()
    return "can't find pane" in low or "can't find session" in low or "no server running" in low


def run_in_tmux(
    tmux_name: str,
    command: str,
    tailscale_ip: str,
    local: bool = False,
    wait_s: float = 0.8,
    user: str | None = None,
) -> tuple[int, str]:
    """Send command to tmux session and return only its output."""
    prepared = prepare_command(command)
    tag = uuid.uuid4().hex[:8]
    marker = f"@@{tag}"
    wrapped = f"{prepared};c=$?;echo;echo {marker}:$c"

    inner = (
        f"tmux send-keys -t {shlex.quote(tmux_name)} {_shell_single(wrapped)} Enter; "
        f"sleep {wait_s}; "
        f"tmux capture-pane -pt {shlex.quote(tmux_name)} -S -60"
    )
    code, pane = run_on_host(tailscale_ip, inner, local=local, user=user, timeout=120)
    if code != 0 or tmux_missing(pane):
        return code, pane
    return extract_command_output(pane, marker, wrapped)


def capture_tmux(
    tmux_name: str, tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, str]:
    cmd = f"tmux capture-pane -pt {shlex.quote(tmux_name)} -S -40"
    code, pane = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    if code != 0 or tmux_missing(pane):
        return code, pane
    lines = pane.splitlines()
    cleaned: list[str] = []
    for line in lines:
        if _PROMPT_RE.match(line) and not line.strip().endswith(("\\", "|")):
            continue
        if line.strip() in ("", "$"):
            continue
        if "__ARK_" in line:
            continue
        cleaned.append(line)
    return code, "\n".join(cleaned).strip() or "(empty pane)"


def kill_tmux(
    tmux_name: str, tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, str]:
    cmd = f"tmux kill-session -t {shlex.quote(tmux_name)} 2>/dev/null || true"
    return run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)


# ── Live pane model ──

_VALID_KEYS = frozenset(
    {
        "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-j", "C-k", "C-l",
        "C-n", "C-o", "C-p", "C-r", "C-s", "C-t", "C-u", "C-v", "C-w", "C-x",
        "C-y", "C-z",
        "Up", "Down", "Left", "Right",
        "Tab", "BTab", "Enter", "Escape", "Space", "BSpace",
        "PageUp", "PageDown", "Home", "End",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    }
)


def send_line(
    tmux_name: str,
    command: str,
    tailscale_ip: str,
    local: bool = False,
    user: str | None = None,
) -> tuple[int, str]:
    """Send a command line + Enter to the pane. Output is read via capture_pane."""
    inner = (
        f"tmux send-keys -t {shlex.quote(tmux_name)} "
        f"{_shell_single(command)} Enter"
    )
    return run_on_host(tailscale_ip, inner, local=local, user=user, timeout=30)


def send_text_line(
    tmux_name: str,
    text: str,
    tailscale_ip: str,
    local: bool = False,
    user: str | None = None,
) -> tuple[int, str]:
    """Type literal text, then submit it. TUIs like Codex need Enter separately."""
    target = shlex.quote(tmux_name)
    inner = (
        f"tmux send-keys -t {target} -l {_shell_single(text)}; "
        "sleep 0.65; "
        f"tmux send-keys -t {target} Enter"
    )
    return run_on_host(tailscale_ip, inner, local=local, user=user, timeout=30)


def send_key(
    tmux_name: str,
    key: str,
    tailscale_ip: str,
    local: bool = False,
    user: str | None = None,
) -> tuple[int, str]:
    """Send a special tmux key (C-c, Up, Tab, ...) without Enter."""
    if key not in _VALID_KEYS:
        return 1, f"invalid key: {key}"
    inner = f"tmux send-keys -t {shlex.quote(tmux_name)} {shlex.quote(key)}"
    return run_on_host(tailscale_ip, inner, local=local, user=user, timeout=15)


def capture_pane(
    tmux_name: str,
    tailscale_ip: str,
    local: bool = False,
    scroll: int = 300,
    user: str | None = None,
) -> tuple[int, str]:
    """Capture the live pane with ANSI escape sequences preserved."""
    start = f" -S -{scroll}" if scroll > 0 else ""
    cmd = f"tmux capture-pane -pt {shlex.quote(tmux_name)}{start} -e"
    code, text = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    if code != 0 or tmux_missing(text):
        return code, text
    # Trim trailing blank lines but keep internal formatting.
    return code, "\n".join(text.splitlines()).rstrip("\n")


def pane_current_path(
    tmux_name: str, tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, str]:
    cmd = f"tmux display-message -p -t {shlex.quote(tmux_name)} '#{{pane_current_path}}'"
    code, text = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    return code, text.strip()


def pane_current_command(
    tmux_name: str, tailscale_ip: str, local: bool = False, user: str | None = None
) -> tuple[int, str]:
    cmd = f"tmux display-message -p -t {shlex.quote(tmux_name)} '#{{pane_current_command}}'"
    code, text = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    return code, text.strip()


def stop_pane_app(
    tmux_name: str,
    tailscale_ip: str,
    local: bool = False,
    user: str | None = None,
) -> tuple[int, str]:
    before_code, before = pane_current_command(tmux_name, tailscale_ip, local=local, user=user)
    if before_code != 0:
        return before_code, before
    if before in ("", "bash", "zsh", "sh", "fish", "tmux", "login", "sudo"):
        return 0, "already at shell"
    send_key(tmux_name, "C-c", tailscale_ip, local=local, user=user)
    time.sleep(0.8)
    _code, after = pane_current_command(tmux_name, tailscale_ip, local=local, user=user)
    if after != before:
        return 0, f"stopped {before}"
    send_key(tmux_name, "C-d", tailscale_ip, local=local, user=user)
    time.sleep(0.5)
    _code, after = pane_current_command(tmux_name, tailscale_ip, local=local, user=user)
    if after != before:
        return 0, f"stopped {before}"
    cmd = f"tmux respawn-pane -k -t {shlex.quote(tmux_name)}"
    code, out = run_on_host(tailscale_ip, cmd, local=local, user=user, timeout=15)
    return code, out or f"killed {before}"


def complete_shell(
    tmux_name: str,
    query: str,
    tailscale_ip: str,
    local: bool = False,
    user: str | None = None,
) -> tuple[int, list[str], str]:
    """Small context completion for shell paths. Keep tmux control out."""
    q = query.strip()
    slash = ["/model", "/status", "/help", "/clear", "/compact", "/diff", "/new", "/exit"]
    if q.startswith("/"):
        return 0, [s for s in slash if s.startswith(q)][:10], ""

    if not q.startswith("cd"):
        return 0, [], ""

    code, cwd = pane_current_path(tmux_name, tailscale_ip, local=local, user=user)
    if code != 0:
        return code, [], cwd
    arg = q[2:].strip()
    base = arg or "."
    script = (
        "python3 -c "
        + shlex.quote(
            "import os,sys\n"
            "cwd=sys.argv[1]; raw=sys.argv[2]\n"
            "raw=os.path.expanduser(raw or '.')\n"
            "path=raw if os.path.isabs(raw) else os.path.join(cwd, raw)\n"
            "parent=path if raw.endswith('/') else os.path.dirname(path) or cwd\n"
            "prefix='' if raw.endswith('/') else os.path.basename(path)\n"
            "try: names=os.listdir(parent)\n"
            "except OSError: names=[]\n"
            "for n in sorted(names):\n"
            " p=os.path.join(parent,n)\n"
            " if n.startswith(prefix) and os.path.isdir(p):\n"
            "  shown=os.path.join(raw if raw.endswith('/') else os.path.dirname(raw), n)\n"
            "  if not os.path.isabs(raw): shown=shown.lstrip('./')\n"
            "  print('cd ' + (shown or n) + '/')\n"
        )
        + f" {shlex.quote(cwd)} {shlex.quote(arg)}"
    )
    code, out = run_on_host(tailscale_ip, script, local=local, user=user, timeout=15)
    if code != 0:
        return code, [], out
    return 0, out.splitlines()[:10], ""


def extract_pane_output(pane: str, tag: str) -> tuple[str, int, str]:
    """Return (state, exit_code, output) for a tagged command.

    state is "done" if the marker is present, else "running". Output is the
    pane content after the last prompt up to the marker (or the live tail),
    with prompts, the echoed command, and marker lines filtered out.
    """
    lines = pane.splitlines()
    clean = [_strip_ansi(l) for l in lines]
    marker = f"@@{tag}"
    marker_re = re.compile(rf"(?:{re.escape(marker)}|__ARK_{re.escape(tag)}__):(\d+)")
    end_idx = None
    exit_code = 0
    marker_prefix = ""
    for i in range(len(clean) - 1, -1, -1):
        m = marker_re.search(clean[i])
        if m:
            exit_code = int(m.group(1))
            end_idx = i
            marker_prefix = clean[i][: m.start()].rstrip()
            break

    search_to = end_idx if end_idx is not None else len(clean)
    start_idx = 0
    for i in range(search_to - 1, -1, -1):
        if _PROMPT_RE.match(clean[i]):
            start_idx = i + 1
            break

    seg_idx = range(start_idx, end_idx) if end_idx is not None else range(start_idx, len(lines))
    out: list[str] = []
    for idx in seg_idx:
        c = clean[idx].strip()
        if not c:
            continue
        if marker in c or f"__ARK_{tag}__" in c:
            continue
        if _PROMPT_RE.match(clean[idx]):
            continue
        out.append(lines[idx].rstrip())

    if marker_prefix and marker not in marker_prefix and not _PROMPT_RE.match(marker_prefix):
        out.append(marker_prefix)

    state = "done" if end_idx is not None else "running"
    return state, exit_code, "\n".join(out).strip()
