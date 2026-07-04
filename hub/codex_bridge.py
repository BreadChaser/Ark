"""Small stdio bridge to `codex app-server`."""

from __future__ import annotations

import getpass
import json
import queue
import shlex
import subprocess
import threading
from dataclasses import dataclass, field


@dataclass
class CodexApp:
    session_id: str
    tailscale_ip: str
    cwd: str
    local: bool = False
    user: str | None = None
    proc: subprocess.Popen | None = None
    thread_id: str = ""
    turn_id: str = ""
    busy: bool = False
    ready: bool = False
    error: str = ""
    transcript: str = ""
    _turn_text: str = ""
    status: str = "starting"
    completed: queue.SimpleQueue[str] = field(default_factory=queue.SimpleQueue)
    _next_id: int = 1
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _ready_event: threading.Event = field(default_factory=threading.Event)

    def start(self) -> tuple[bool, str]:
        cmd = ["codex", "app-server", "--stdio"] if self.local else [
            "ssh",
            "-o", "ConnectTimeout=10",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            f"{self.user or getpass.getuser()}@{self.tailscale_ip}",
            f"export PATH=$HOME/.local/bin:$PATH; cd {shlex.quote(self.cwd or '~')} && codex app-server --stdio",
        ]
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._send("initialize", {"clientInfo": {"name": "ark", "title": "Ark", "version": "0.1"}})
        self._notify("initialized", {})
        self._send("thread/start", {
            "cwd": self.cwd or None,
            "sandbox": "workspace-write",
            "approvalPolicy": "never",
        })
        if not self._ready_event.wait(15):
            self.stop()
            return False, self.error or "codex app-server did not become ready"
        return True, ""

    def send(self, text: str) -> None:
        if self.busy and self.turn_id:
            self._send("turn/steer", {
                "threadId": self.thread_id,
                "expectedTurnId": self.turn_id,
                "input": [{"type": "text", "text": text}],
            })
        else:
            self._send("turn/start", {
                "threadId": self.thread_id,
                "cwd": self.cwd or None,
                "input": [{"type": "text", "text": text}],
            })
        self.status = "sent"

    def state(self) -> dict:
        return {
            "active": self.proc is not None and self.proc.poll() is None,
            "ready": self.ready,
            "busy": self.busy,
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "status": self.status,
            "transcript": self.transcript,
            "error": self.error,
        }

    def drain_completed(self) -> list[str]:
        out: list[str] = []
        while True:
            try:
                out.append(self.completed.get_nowait())
            except queue.Empty:
                return out

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def _send(self, method: str, params: dict) -> int:
        with self._lock:
            msg_id = self._next_id
            self._next_id += 1
            self._write({"method": method, "id": msg_id, "params": params})
            return msg_id

    def _notify(self, method: str, params: dict) -> None:
        self._write({"method": method, "params": params})

    def _write(self, msg: dict) -> None:
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("codex app-server is not running")
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            try:
                self._handle(json.loads(line))
            except json.JSONDecodeError:
                continue
        if not self.error:
            self.error = "codex app-server exited"
        self._ready_event.set()

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            if line.strip():
                self.error = line.strip()[-500:]

    def _handle(self, msg: dict) -> None:
        if msg.get("error"):
            self.error = msg["error"].get("message", str(msg["error"]))
            self.status = "error"
            self._ready_event.set()
            return
        result = msg.get("result") or {}
        if "thread" in result:
            self.thread_id = result["thread"]["id"]
            self.ready = True
            self.status = "ready"
            self._ready_event.set()
            return
        method = msg.get("method")
        params = msg.get("params") or {}
        if method == "turn/started":
            self.busy = True
            self.turn_id = (params.get("turn") or {}).get("id", "")
            self._turn_text = ""
            self.status = "working"
        elif method == "item/agentMessage/delta":
            delta = params.get("delta", "")
            self.transcript += delta
            self._turn_text += delta
            self.status = "streaming"
        elif method == "turn/completed":
            self.busy = False
            self.status = "ready"
            if self._turn_text.strip():
                self.completed.put(self._turn_text.strip())
        elif method == "error":
            self.error = params.get("message", "codex error")
            self.status = "error"


_apps: dict[str, CodexApp] = {}


def start_app(session_id: str, tailscale_ip: str, cwd: str, local: bool, user: str | None) -> tuple[bool, str]:
    stop_app(session_id)
    app = CodexApp(session_id, tailscale_ip, cwd, local=local, user=user)
    ok, error = app.start()
    if ok:
        _apps[session_id] = app
    return ok, error


def get_app(session_id: str) -> CodexApp | None:
    app = _apps.get(session_id)
    if app and app.proc and app.proc.poll() is None:
        return app
    _apps.pop(session_id, None)
    return None


def stop_app(session_id: str) -> None:
    app = _apps.pop(session_id, None)
    if app:
        app.stop()
