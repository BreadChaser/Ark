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
from naming import clean_tmux_output, infer_name, should_auto_rename
from remote import capture_tmux, ensure_tmux, kill_tmux, run_in_tmux
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


class RunCommand(BaseModel):
    command: str


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

    code, out = ensure_tmux(tmux_name, peer.tailscale_ip, local=local)
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


@app.get("/api/v1/sessions/{session_id}/messages")
def api_messages(session_id: str, since: float = 0):
    if not store.get_session(session_id):
        raise HTTPException(404, "session not found")
    return {
        "messages": [m.to_dict() for m in store.list_messages(session_id, since=since)]
    }


@app.post("/api/v1/sessions/{session_id}/run")
def api_run_command(session_id: str, body: RunCommand):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")

    cmd = body.command.strip()
    if not cmd:
        raise HTTPException(400, "empty command")

    peer = peer_map().get(session.peer_id)
    local = is_local_peer(peer) if peer else False

    store.add_message(session_id, "command", f"$ {cmd}")

    if cmd in ("capture", ":capture"):
        code, out = capture_tmux(session.tmux_name, session.tailscale_ip, local=local)
    else:
        code, out = run_in_tmux(
            session.tmux_name, cmd, session.tailscale_ip, local=local
        )

    out = clean_tmux_output(out)
    role = "output" if code == 0 else "error"
    store.add_message(session_id, role, out[:20000] or f"(exit {code})")

    new_name = infer_name(cmd, session.hostname)
    if new_name and should_auto_rename(session.name, session.hostname):
        store.rename_session(session_id, new_name)

    return {"ok": code == 0, "exit_code": code, "name": store.get_session(session_id).name}


@app.delete("/api/v1/sessions/{session_id}")
def api_delete_session(session_id: str, kill: bool = True):
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if kill:
        peer = peer_map().get(session.peer_id)
        local = is_local_peer(peer) if peer else False
        kill_tmux(session.tmux_name, session.tailscale_ip, local=local)
    store.delete_session(session_id)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
