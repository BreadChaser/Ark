"""The Ark hub — chat mission control."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ark_common.gaming_pc import collect_gaming_pc
from ark_common.tailscale import TailscalePeer, list_peers
from remote import run_on_host
from store import MessageStore

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
DATA = Path(os.environ.get("ARK_DATA", Path.home() / ".local/share/ark"))
store = MessageStore(DATA / "messages.db")

# conversation_id -> peer snapshot
_peers: dict[str, TailscalePeer] = {}
_last_status_post: dict[str, float] = {}


def peer_map() -> dict[str, TailscalePeer]:
    global _peers
    _peers = {p.id: p for p in list_peers()}
    return _peers


def format_status_message(peer: TailscalePeer) -> str | None:
    """Status snapshot as a chat system message."""
    if peer.is_self and os.environ.get("ARK_IS_HUB_HOST", "1") == "1":
        llama_url = os.environ.get("ARK_LLAMA_URL", "http://127.0.0.1:8080")
        r = collect_gaming_pc(hostname=peer.hostname, llama_url=llama_url).to_dict()
        gpu = r.get("gpu") or {}
        llama = r.get("llama") or {}
        lines = [
            f"**{peer.hostname}** hub host",
            f"**GPU** {gpu.get('memory_used_mib', '?')} MiB · {gpu.get('utilization_pct', '?')}% · {gpu.get('temperature_c', '?')}°C",
            f"**Model** {llama.get('model_id', '?')} · ctx {llama.get('n_ctx', '?')}",
        ]
        for c in r.get("docker") or []:
            lines.append(f"**{c['name']}** {c['status']}")
        return "\n".join(lines)

    state = "online" if peer.online else "offline"
    return f"**{peer.hostname}** · {state} · `{peer.tailscale_ip}` · {peer.os}"


async def poll_loop():
    while True:
        try:
            peers = peer_map()
            now = time.time()
            for pid, peer in peers.items():
                if now - _last_status_post.get(pid, 0) < 60:
                    continue
                text = format_status_message(peer)
                if text:
                    store.add(pid, "system", text)
                    _last_status_post[pid] = now
        except Exception:
            pass
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    peer_map()
    task = asyncio.create_task(poll_loop())
    yield
    task.cancel()


app = FastAPI(title="The Ark", version="0.2.0", lifespan=lifespan)


class PostMessage(BaseModel):
    content: str


class RunCommand(BaseModel):
    command: str


@app.get("/health")
def health():
    return {"ok": True, "hostname": socket.gethostname()}


@app.get("/api/v1/peers")
def api_peers():
    return {"peers": [p.to_dict() for p in peer_map().values()]}


@app.get("/api/v1/conversations")
def api_conversations():
    peers = peer_map()
    convs = []
    for p in peers.values():
        msgs = store.list(p.id, limit=1)
        preview = msgs[-1].content[:80] if msgs else "No messages yet"
        convs.append(
            {
                **p.to_dict(),
                "preview": preview,
                "message_count": len(store.list(p.id, limit=500)),
            }
        )
    return {"conversations": convs}


@app.get("/api/v1/conversations/{conversation_id}/messages")
def api_messages(conversation_id: str, since: float = 0):
    if conversation_id not in peer_map():
        raise HTTPException(404, "unknown conversation")
    return {
        "messages": [m.to_dict() for m in store.list(conversation_id, since=since)]
    }


@app.post("/api/v1/conversations/{conversation_id}/messages")
def api_post_message(conversation_id: str, body: PostMessage):
    peers = peer_map()
    if conversation_id not in peers:
        raise HTTPException(404, "unknown conversation")
    msg = store.add(conversation_id, "user", body.content.strip())
    return {"message": msg.to_dict()}


@app.post("/api/v1/conversations/{conversation_id}/run")
def api_run_command(conversation_id: str, body: RunCommand):
    peers = peer_map()
    peer = peers.get(conversation_id)
    if not peer:
        raise HTTPException(404, "unknown conversation")
    cmd = body.command.strip()
    if not cmd:
        raise HTTPException(400, "empty command")

    store.add(conversation_id, "command", f"`{cmd}`")
    if peer.is_self:
        import subprocess

        try:
            p = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=120
            )
            out = (p.stdout or "") + (p.stderr or "")
            code = p.returncode
        except Exception as e:
            code, out = 1, str(e)
    else:
        if not peer.online:
            store.add(conversation_id, "error", f"{peer.hostname} is offline")
            return {"ok": False}
        code, out = run_on_host(peer.tailscale_ip, cmd)

    role = "output" if code == 0 else "error"
    store.add(conversation_id, role, out[:16000] or f"(exit {code})")
    return {"ok": code == 0, "exit_code": code}


@app.get("/api/v1/conversations/{conversation_id}/stream")
async def api_stream(conversation_id: str, since: float = 0):
    if conversation_id not in peer_map():
        raise HTTPException(404, "unknown conversation")

    async def gen():
        cursor = since
        while True:
            msgs = store.list(conversation_id, since=cursor)
            for m in msgs:
                cursor = m.created_at
                yield f"data: {json.dumps(m.to_dict())}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
