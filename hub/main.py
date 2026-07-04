"""The Ark hub — session-based chat mission control."""

from __future__ import annotations

import os
import socket
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ark_common.tailscale import TailscalePeer, list_peers
from naming import infer_name, should_auto_rename
from remote import (
    capture_pane,
    complete_shell,
    ensure_tmux,
    extract_pane_output,
    kill_tmux,
    list_tmux_sessions,
    pane_current_path,
    send_key,
    send_line,
    send_text_line,
    tmux_missing,
)
from store import ArkStore

STATIC = Path(__file__).resolve().parent / "static"
DATA = Path(os.environ.get("ARK_DATA", Path.home() / ".local/share/ark"))
store = ArkStore(DATA / "ark.db")

HUB_TS_IP = os.environ.get("ARK_HUB_TS_IP", "")


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


class TypeText(BaseModel):
    text: str


class SendKey(BaseModel):
    key: str


_pending: dict[str, bool] = {}


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


def _session_peer_local(session):
    peer = peer_map().get(session.peer_id)
    return peer, is_local_peer(peer) if peer else False


def _session_ssh_user(session) -> str | None:
    return session.ssh_user or None


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
    return {"ok": code == 0, "cwd": cwd if code == 0 else "", "tmux": session.tmux_name}


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
    ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
    send_text_line(session.tmux_name, text, session.tailscale_ip, local=local, user=user)
    store.add_message(session_id, "user", text)
    return {"ok": True}


@app.get("/api/v1/sessions/{session_id}/live")
def api_live(session_id: str, tag: str):
    """Poll a running command's filtered output. Stores it once done."""
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    code, pane = capture_pane(
        session.tmux_name,
        session.tailscale_ip,
        local=local,
        scroll=500,
        user=_session_ssh_user(session),
    )
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
    code, text = capture_pane(
        session.tmux_name, session.tailscale_ip, local=local, scroll=0, user=user
    )
    if tmux_missing(text):
        ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
        code, text = capture_pane(
            session.tmux_name, session.tailscale_ip, local=local, scroll=0, user=user
        )
    return {"ok": code == 0, "text": text}


@app.post("/api/v1/sessions/{session_id}/keys")
def api_keys(session_id: str, body: SendKey):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    user = _session_ssh_user(session)
    code, out = send_key(session.tmux_name, body.key, session.tailscale_ip, local=local, user=user)
    if tmux_missing(out):
        ensure_tmux(session.tmux_name, session.tailscale_ip, local=local, user=user)
        code, out = send_key(session.tmux_name, body.key, session.tailscale_ip, local=local, user=user)
    return {"ok": code == 0}


@app.post("/api/v1/sessions/{session_id}/stop")
def api_stop(session_id: str):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    _peer, local = _session_peer_local(session)
    code, out = send_key(
        session.tmux_name,
        "C-c",
        session.tailscale_ip,
        local=local,
        user=_session_ssh_user(session),
    )
    if code == 0:
        store.add_message(session_id, "system", "Stopped the running app.")
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
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
