"""The Ark hub — session-based chat mission control."""

from __future__ import annotations

import os
import re
import shlex
import socket
import subprocess
import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from codex_bridge import get_app as get_codex_app
from codex_bridge import start_app as start_codex_app
from codex_bridge import stop_app as stop_codex_app
from ark_common.tailscale import TailscalePeer, list_peers
from naming import infer_name, should_auto_rename
from remote import (
    complete_shell,
    ensure_tmux,
    extract_pane_output,
    kill_tmux,
    list_tmux_sessions,
    pane_current_command,
    pane_current_path,
    send_line,
    send_text_line,
    stop_pane_app,
    tmux_missing,
)
from store import ArkStore

STATIC = Path(__file__).resolve().parent / "static"
DATA = Path(os.environ.get("ARK_DATA", Path.home() / ".local/share/ark"))
store = ArkStore(DATA / "ark.db")

SHELL_COMMANDS = {"bash", "zsh", "sh", "fish", "tmux", "login", "sudo"}
HUB_TS_IP = os.environ.get("ARK_HUB_TS_IP", "")
LLAMA_URL = os.environ.get("ARK_LLAMA_URL", "http://127.0.0.1:8080")
LLAMA_PANEL_URL = os.environ.get("ARK_LLAMA_PANEL_URL", "http://100.114.148.108:8090")


def peer_map() -> dict[str, TailscalePeer]:
    return {p.id: p for p in list_peers()}


def is_local_peer(peer: TailscalePeer) -> bool:
    if peer.is_self:
        return True
    if HUB_TS_IP and peer.tailscale_ip == HUB_TS_IP:
        return True
    return False


app = FastAPI(title="The Ark", version="0.3.0")


class CreateSession(BaseModel):
    peer_id: str
    ssh_user: str = ""


class ImportSession(BaseModel):
    peer_id: str
    tmux_name: str
    confirmed: bool = False
    ssh_user: str = ""


class RunCommand(BaseModel):
    command: str


class RenameSession(BaseModel):
    name: str


class TypeText(BaseModel):
    text: str
    store: bool = True
    submit: bool = True


class SendKey(BaseModel):
    key: str


class CodexInput(BaseModel):
    text: str = ""
    attachments: list[str] = []


class AddMessage(BaseModel):
    role: str
    content: str


_pending: dict[str, bool] = {}


class _TmuxInput:
    def __init__(self, tmux_name: str, tailscale_ip: str, local: bool, user: str | None):
        self.tmux_name = tmux_name
        self.tailscale_ip = tailscale_ip
        self.local = local
        self.user = user
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()

    def _ensure(self) -> None:
        if self.proc and self.proc.poll() is None and self.proc.stdin:
            return
        if self.local:
            cmd = ["bash"]
        else:
            remote = f"{self.user or os.environ.get('ARK_SSH_USER') or os.environ.get('USER')}@{self.tailscale_ip}"
            cmd = [
                "ssh",
                "-o", "ConnectTimeout=10",
                "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "ControlMaster=auto",
                "-o", "ControlPersist=90",
                "-o", "ControlPath=/tmp/ark-ssh-%r@%h:%p",
                remote,
                "bash -s",
            ]
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    def _write_unlocked(self, command: str) -> None:
        self._ensure()
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def _reset(self) -> None:
        if self.proc:
            self.proc.kill()
        self.proc = None

    def _write(self, command: str) -> None:
        with self.lock:
            for attempt in range(2):
                try:
                    self._write_unlocked(command)
                    return
                except (BrokenPipeError, OSError):
                    self._reset()
                    if attempt:
                        raise

    def text(self, text: str) -> None:
        self._write(
            f"tmux send-keys -t {shlex.quote(self.tmux_name)} -l {shlex.quote(text)}"
        )

    def key(self, key: str) -> None:
        self._write(
            f"tmux send-keys -t {shlex.quote(self.tmux_name)} {shlex.quote(key)}"
        )

    def capture(self, scroll: int = 300) -> str:
        marker = f"__ARK_CAPTURE_{uuid.uuid4().hex}__"
        start = f" -S -{scroll}" if scroll > 0 else ""
        command = (
            f"tmux capture-pane -pt {shlex.quote(self.tmux_name)}{start} -e; "
            f"printf '\\n{marker}\\n'"
        )
        with self.lock:
            for attempt in range(2):
                try:
                    self._write_unlocked(command)
                    assert self.proc and self.proc.stdout
                    lines: list[str] = []
                    while True:
                        line = self.proc.stdout.readline()
                        if line == "":
                            raise BrokenPipeError("tmux capture stream closed")
                        if line.rstrip("\n") == marker:
                            return "".join(lines).rstrip("\n")
                        lines.append(line)
                except (BrokenPipeError, OSError):
                    self._reset()
                    if attempt:
                        raise
        return ""


_tmux_inputs: dict[tuple, _TmuxInput] = {}
_tmux_inputs_lock = threading.Lock()


def _tmux_input(tmux_name: str, tailscale_ip: str, local: bool, user: str | None) -> _TmuxInput:
    target = (tmux_name, tailscale_ip, local, user)
    with _tmux_inputs_lock:
        stream = _tmux_inputs.get(target)
        if not stream:
            stream = _TmuxInput(tmux_name, tailscale_ip, local, user)
            _tmux_inputs[target] = stream
        return stream


class _TypeQueue:
    def __init__(self):
        self.items = deque()
        self.cond = threading.Condition()
        self.busy = False
        self.thread: threading.Thread | None = None

    def enqueue(self, item: dict) -> None:
        with self.cond:
            self.items.append(item)
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
            self.cond.notify()

    def drain(self, timeout: float = 10) -> bool:
        end = time.monotonic() + timeout
        with self.cond:
            while self.items or self.busy:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return False
                self.cond.wait(remaining)
            return True

    def _run(self) -> None:
        while True:
            with self.cond:
                while not self.items:
                    self.cond.wait(30)
                    if not self.items:
                        return
                item = self.items.popleft()
                while (
                    not item["submit"]
                    and self.items
                    and not self.items[0]["submit"]
                    and self.items[0]["target"] == item["target"]
                ):
                    item["text"] += self.items.popleft()["text"]
                self.busy = True
            try:
                _tmux_input(
                    item["tmux_name"],
                    item["tailscale_ip"],
                    item["local"],
                    item["user"],
                ).text(item["text"])
                if item["submit"]:
                    _tmux_input(
                        item["tmux_name"],
                        item["tailscale_ip"],
                        item["local"],
                        item["user"],
                    ).key("Enter")
            finally:
                with self.cond:
                    self.busy = False
                    self.cond.notify_all()


_type_queues: dict[str, _TypeQueue] = {}
_type_queues_lock = threading.Lock()


def _type_queue(session_id: str) -> _TypeQueue:
    with _type_queues_lock:
        q = _type_queues.get(session_id)
        if not q:
            q = _TypeQueue()
            _type_queues[session_id] = q
        return q


def _drain_type_queue(session_id: str) -> None:
    if not _type_queue(session_id).drain():
        raise HTTPException(503, "terminal input is still flushing")


@app.get("/health")
def health():
    return {"ok": True, "hostname": socket.gethostname()}


@app.get("/api/v1/peers")
def api_peers():
    """Machines for the new-session dropdown only."""
    peers = list(peer_map().values())
    peers.sort(key=lambda p: (not p.online, p.is_self, p.hostname.lower()))
    return {"peers": [p.to_dict() for p in peers]}


@app.get("/api/v1/sessions")
def api_sessions():
    return {
        "sessions": [
            {**s.to_dict(), "preview": store.last_message_preview(s.id)}
            for s in store.list_sessions()
        ]
    }


@app.get("/api/v1/tmux")
def api_tmux_sessions(ssh_user: str = ""):
    rows = []
    user = ssh_user.strip() or None
    for peer in peer_map().values():
        if not peer.online:
            continue
        local = is_local_peer(peer)
        code, sessions, error = list_tmux_sessions(peer.tailscale_ip, local=local, user=user)
        rows.append(
            {
                "peer": peer.to_dict(),
                "ok": code == 0,
                "error": error,
                "sessions": sessions,
            }
        )
    return {"hosts": rows}


@app.get("/api/v1/llama")
def api_llama():
    url = f"{LLAMA_URL.rstrip('/')}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        return {"ok": False, "panel_url": LLAMA_PANEL_URL, "error": str(e)}
    models = data.get("data") or data.get("models") or []
    model = models[0] if models else {}
    meta = model.get("meta") or {}
    return {
        "ok": bool(models),
        "panel_url": LLAMA_PANEL_URL,
        "model": model.get("id") or model.get("name") or "local",
        "ctx": meta.get("n_ctx"),
        "params": meta.get("n_params"),
    }


@app.post("/api/v1/sessions")
def api_create_session(body: CreateSession):
    peer = peer_map().get(body.peer_id)
    if not peer:
        raise HTTPException(404, "machine not found on tailnet")
    if not peer.online:
        raise HTTPException(503, f"{peer.hostname} is offline")

    session_id = uuid.uuid4().hex[:10]
    tmux_name = f"ark-{session_id}"
    local = is_local_peer(peer)
    user = body.ssh_user.strip()

    code, out = ensure_tmux(tmux_name, peer.tailscale_ip, local=local, user=user or None)
    if code != 0:
        raise HTTPException(500, f"tmux setup failed: {out}")

    name = f"New on {peer.hostname}"
    session = store.create_session(
        session_id=session_id,
        name=name,
        peer_id=peer.id,
        hostname=peer.hostname,
        tailscale_ip=peer.tailscale_ip,
        tmux_name=tmux_name,
        ssh_user=user,
    )
    store.add_message(
        session.id,
        "system",
        f"Connected to **{peer.hostname}** · tmux `{tmux_name}`\n"
        f"Run a command — session name updates automatically.",
    )
    return {
        "session": {**session.to_dict(), "preview": store.last_message_preview(session.id)}
    }


@app.post("/api/v1/sessions/import")
def api_import_session(body: ImportSession):
    peer = peer_map().get(body.peer_id)
    if not peer:
        raise HTTPException(404, "machine not found on tailnet")
    if not peer.online:
        raise HTTPException(503, f"{peer.hostname} is offline")

    tmux_name = body.tmux_name.strip()
    user = body.ssh_user.strip()
    if not tmux_name:
        raise HTTPException(400, "empty tmux session")
    if not tmux_name.startswith("ark-") and not body.confirmed:
        raise HTTPException(409, "This tmux session was not created by Ark. Attach anyway?")

    for s in store.list_sessions():
        if s.peer_id == peer.id and s.tmux_name == tmux_name and s.ssh_user == user:
            return {"session": {**s.to_dict(), "preview": store.last_message_preview(s.id)}}

    local = is_local_peer(peer)
    code, out = ensure_tmux(tmux_name, peer.tailscale_ip, local=local, user=user or None)
    if code != 0:
        raise HTTPException(500, f"tmux attach failed: {out}")

    session_id = uuid.uuid4().hex[:10]
    session = store.create_session(
        session_id=session_id,
        name=f"{peer.hostname} · {tmux_name}",
        peer_id=peer.id,
        hostname=peer.hostname,
        tailscale_ip=peer.tailscale_ip,
        tmux_name=tmux_name,
        ssh_user=user,
    )
    store.add_message(
        session.id,
        "system",
        f"Attached to **{peer.hostname}** · tmux `{tmux_name}`.",
    )
    return {"session": {**session.to_dict(), "preview": store.last_message_preview(session.id)}}


@app.get("/api/v1/sessions/{session_id}")
def api_get_session(session_id: str):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    return {
        "session": {
            **session.to_dict(),
            "preview": store.last_message_preview(session_id),
        }
    }


@app.patch("/api/v1/sessions/{session_id}")
def api_rename_session(session_id: str, body: RenameSession):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "empty session name")
    store.rename_session(session_id, name[:80])
    updated = store.get_session(session_id)
    return {"session": {**updated.to_dict(), "preview": store.last_message_preview(session_id)}}


def _session_peer_local(session):
    peer = peer_map().get(session.peer_id)
    return peer, is_local_peer(peer) if peer else False


def _session_ssh_user(session) -> str | None:
    return session.ssh_user or None


def _live_command_hint(command: str) -> dict:
    name = re.sub(r"^[-/]*(?:.*?/)?", "", command.strip()).lower()
    running = bool(name and name not in SHELL_COMMANDS)
    return {"running": running, "command": name if running else "", "adopted": running}


@app.get("/api/v1/sessions/{session_id}/state")
def api_session_state(session_id: str):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    code, cwd = pane_current_path(
        session.tmux_name,
        session.tailscale_ip,
        local=local,
        user=_session_ssh_user(session),
    )
    cmd_code, pane_cmd = pane_current_command(
        session.tmux_name,
        session.tailscale_ip,
        local=local,
        user=_session_ssh_user(session),
    )
    return {
        "ok": code == 0,
        "cwd": cwd if code == 0 else "",
        "tmux": session.tmux_name,
        "live": _live_command_hint(pane_cmd if cmd_code == 0 else ""),
    }


@app.get("/api/v1/sessions/{session_id}/complete")
def api_complete(session_id: str, q: str = ""):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    code, items, error = complete_shell(
        session.tmux_name,
        q,
        session.tailscale_ip,
        local=local,
        user=_session_ssh_user(session),
    )
    return {"ok": code == 0, "items": items, "error": error}


@app.get("/api/v1/sessions/{session_id}/messages")
def api_messages(session_id: str, since: float = 0):
    if not store.get_session(session_id):
        raise HTTPException(404, "session not found")
    return {
        "messages": [m.to_dict() for m in store.list_messages(session_id, since=since)]
    }


@app.post("/api/v1/sessions/{session_id}/messages")
def api_add_message(session_id: str, body: AddMessage):
    if not store.get_session(session_id):
        raise HTTPException(404, "session not found")
    if body.role != "image" or not body.content.startswith("data:image/"):
        raise HTTPException(400, "only pasted image messages are supported")
    if len(body.content) > 14_000_000:
        raise HTTPException(413, "image paste is too large")
    return {"message": store.add_message(session_id, "image", body.content).to_dict()}


@app.post("/api/v1/sessions/{session_id}/run")
def api_run_command(session_id: str, body: RunCommand):
    """Start a shell command: wrap with a marker so we can detect completion."""
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")

    cmd = body.command.strip()
    if not cmd:
        raise HTTPException(400, "empty command")

    _peer, local = _session_peer_local(session)

    tag = uuid.uuid4().hex[:8]
    wrapped = f"{cmd};c=$?;echo;echo @@{tag}:$c"

    user = _session_ssh_user(session)
    ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
    send_line(session.tmux_name, wrapped, session.tailscale_ip, local=local, user=user)
    store.add_message(session_id, "user", cmd)

    new_name = infer_name(cmd, session.hostname)
    if new_name and should_auto_rename(session.name, session.hostname):
        store.rename_session(session_id, new_name)

    return {"ok": True, "tag": tag, "name": store.get_session(session_id).name}


@app.post("/api/v1/sessions/{session_id}/type")
def api_type(session_id: str, body: TypeText):
    """Send raw input to a running interactive app (no marker, no auto-name)."""
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    text = body.text
    if not text:
        raise HTTPException(400, "empty text")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    if body.store:
        store.add_message(session_id, "user", text)
    _type_queue(session_id).enqueue(
        {
            "target": (session.tmux_name, session.tailscale_ip, local, user),
            "tmux_name": session.tmux_name,
            "tailscale_ip": session.tailscale_ip,
            "local": local,
            "user": user,
            "text": text,
            "submit": body.submit,
        }
    )
    return {"ok": True, "queued": True}


@app.post("/api/v1/sessions/{session_id}/codex/start")
def api_codex_start(session_id: str):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    code, cwd = pane_current_path(session.tmux_name, session.tailscale_ip, local=local, user=user)
    ok, error = start_codex_app(
        session_id,
        session.tailscale_ip,
        cwd if code == 0 else "",
        local=local,
        user=user,
    )
    if not ok:
        return {"ok": False, "error": error}
    store.add_message(session_id, "user", "codex")
    return {"ok": True, "state": get_codex_app(session_id).state()}


@app.post("/api/v1/sessions/{session_id}/codex/send")
def api_codex_send(session_id: str, body: CodexInput):
    app = get_codex_app(session_id)
    if not app:
        raise HTTPException(404, "codex app-server is not running")
    text = body.text.strip()
    attachments = [a for a in body.attachments[:8] if a.startswith("data:image/")]
    if not text and not attachments:
        raise HTTPException(400, "empty text")
    msg = store.add_message(session_id, "user", text or "(image)")
    app.send(text, attachments=attachments)
    return {"ok": True, "message": msg.to_dict(), "state": app.state()}


@app.get("/api/v1/sessions/{session_id}/codex/state")
def api_codex_state(session_id: str):
    app = get_codex_app(session_id)
    if not app:
        return {"active": False}
    completed = False
    messages = []
    for text in app.drain_completed():
        messages.append(store.add_message(session_id, "output", text[:20000]).to_dict())
        completed = True
    return {**app.state(), "completed": completed, "messages": messages}


@app.post("/api/v1/sessions/{session_id}/codex/stop")
def api_codex_stop(session_id: str):
    stop_codex_app(session_id)
    if store.get_session(session_id):
        store.add_message(session_id, "system", "Stopped Codex app-server.")
    return {"ok": True}


@app.get("/api/v1/sessions/{session_id}/live")
def api_live(session_id: str, tag: str):
    """Poll a running command's filtered output. Stores it once done."""
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    try:
        pane = _tmux_input(session.tmux_name, session.tailscale_ip, local, user).capture(scroll=500)
        code = 0
    except Exception as e:
        code, pane = 1, str(e)
    if tmux_missing(pane):
        ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
        try:
            pane = _tmux_input(session.tmux_name, session.tailscale_ip, local, user).capture(scroll=500)
            code = 0
        except Exception as e:
            code, pane = 1, str(e)
    if code != 0 or tmux_missing(pane):
        return {"state": "error", "output": pane or "session lost", "exit": 1, "stored": False}

    state, exit_code, output = extract_pane_output(pane, tag)
    stored = False
    if state == "done" and not _pending.get(tag):
        if output or exit_code != 0:
            role = "error" if exit_code != 0 else "output"
            content = output[:20000] if output else f"(exit {exit_code})"
            store.add_message(session_id, role, content)
        _pending[tag] = True
        stored = True

    return {"state": state, "exit": exit_code, "output": output, "stored": stored}


@app.get("/api/v1/sessions/{session_id}/pane")
def api_pane(session_id: str):
    """Raw live capture of the whole tmux pane (ANSI preserved) — terminal mode."""
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    try:
        text = _tmux_input(session.tmux_name, session.tailscale_ip, local, user).capture(scroll=5000)
        code = 0
    except Exception as e:
        code, text = 1, str(e)
    if tmux_missing(text):
        ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
        try:
            text = _tmux_input(session.tmux_name, session.tailscale_ip, local, user).capture(scroll=5000)
            code = 0
        except Exception as e:
            code, text = 1, str(e)
    return {"ok": code == 0, "text": text}


@app.post("/api/v1/sessions/{session_id}/keys")
def api_keys(session_id: str, body: SendKey):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    _drain_type_queue(session_id)
    if not re.match(r"^[A-Za-z0-9_-]+$", body.key):
        raise HTTPException(400, "invalid key")
    try:
        _tmux_input(session.tmux_name, session.tailscale_ip, local, user).key(body.key)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/v1/sessions/{session_id}/stop")
def api_stop(session_id: str):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    _drain_type_queue(session_id)
    code, out = stop_pane_app(
        session.tmux_name,
        session.tailscale_ip,
        local=local,
        user=_session_ssh_user(session),
    )
    if code == 0:
        store.add_message(session_id, "system", out or "Stopped the running app.")
    return {"ok": code == 0, "output": out}


@app.delete("/api/v1/sessions/{session_id}")
def api_delete_session(session_id: str, kill: bool = True):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if kill:
        _peer, local = _session_peer_local(session)
        kill_tmux(
            session.tmux_name,
            session.tailscale_ip,
            local=local,
            user=_session_ssh_user(session),
        )
    store.delete_session(session_id)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
