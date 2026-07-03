"""The Ark hub — mission control API."""

from __future__ import annotations

import os
import socket
from pathlib import Path

import yaml
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ark_common.gaming_pc import collect_gaming_pc

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "services.yaml"
STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="The Ark", version="0.1.0")


def load_config() -> dict:
    if not CONFIG.exists():
        return {}
    with CONFIG.open() as f:
        return yaml.safe_load(f) or {}


def is_hub_host() -> bool:
    cfg = load_config()
    for dev in (cfg.get("devices") or {}).values():
        if dev.get("is_hub_host"):
            return True
    return os.environ.get("ARK_IS_HUB_HOST", "1") == "1"


@app.get("/health")
def health():
    return {"ok": True, "hostname": socket.gethostname()}


@app.get("/api/v1/status")
def status():
    payload: dict = {
        "hostname": socket.gethostname(),
        "hub": True,
        "gaming_pc": None,
        "config": load_config(),
    }
    if is_hub_host():
        llama_url = os.environ.get("ARK_LLAMA_URL", "http://127.0.0.1:8080")
        payload["gaming_pc"] = collect_gaming_pc(
            hostname=socket.gethostname(),
            llama_url=llama_url,
        ).to_dict()
    return payload


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
