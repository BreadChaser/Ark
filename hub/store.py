"""Persistent sessions and messages for The Ark."""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Session:
    id: str
    name: str
    peer_id: str
    hostname: str
    tailscale_ip: str
    tmux_name: str
    created_at: float
    updated_at: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "peer_id": self.peer_id,
            "hostname": self.hostname,
            "tailscale_ip": self.tailscale_ip,
            "tmux_name": self.tmux_name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class Message:
    id: str
    session_id: str
    role: str
    content: str
    created_at: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
        }


class ArkStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        return c

    def _init_db(self) -> None:
        with self._conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    peer_id TEXT NOT NULL,
                    hostname TEXT NOT NULL,
                    tailscale_ip TEXT NOT NULL,
                    tmux_name TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session
                    ON messages(session_id, created_at);
                """
            )

    def create_session(
        self,
        session_id: str,
        name: str,
        peer_id: str,
        hostname: str,
        tailscale_ip: str,
        tmux_name: str,
    ) -> Session:
        now = time.time()
        session = Session(
            id=session_id,
            name=name.strip() or hostname,
            peer_id=peer_id,
            hostname=hostname,
            tailscale_ip=tailscale_ip,
            tmux_name=tmux_name,
            created_at=now,
            updated_at=now,
        )
        with self._conn() as c:
            c.execute(
                "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
                (
                    session.id,
                    session.name,
                    session.peer_id,
                    session.hostname,
                    session.tailscale_ip,
                    session.tmux_name,
                    session.created_at,
                    session.updated_at,
                ),
            )
        return session

    def list_sessions(self) -> list[Session]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        return [self._row_session(r) for r in rows]

    def get_session(self, session_id: str) -> Session | None:
        with self._conn() as c:
            r = c.execute(
                "SELECT * FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
        return self._row_session(r) if r else None

    def rename_session(self, session_id: str, name: str) -> None:
        with self._conn() as c:
            c.execute(
                "UPDATE sessions SET name=?, updated_at=? WHERE id=?",
                (name.strip(), time.time(), session_id),
            )

    def delete_session(self, session_id: str) -> bool:
        with self._conn() as c:
            c.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
            cur = c.execute("DELETE FROM sessions WHERE id=?", (session_id,))
            return cur.rowcount > 0

    def _row_session(self, r: sqlite3.Row) -> Session:
        return Session(
            id=r["id"],
            name=r["name"],
            peer_id=r["peer_id"],
            hostname=r["hostname"],
            tailscale_ip=r["tailscale_ip"],
            tmux_name=r["tmux_name"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )

    def add_message(self, session_id: str, role: str, content: str) -> Message:
        msg = Message(
            id=uuid.uuid4().hex[:12],
            session_id=session_id,
            role=role,
            content=content,
            created_at=time.time(),
        )
        with self._conn() as c:
            c.execute(
                "INSERT INTO messages (id, session_id, role, content, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (msg.id, msg.session_id, msg.role, msg.content, msg.created_at),
            )
            c.execute(
                "UPDATE sessions SET updated_at=? WHERE id=?",
                (msg.created_at, session_id),
            )
        return msg

    def list_messages(
        self, session_id: str, since: float = 0, limit: int = 300
    ) -> list[Message]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM messages WHERE session_id=? AND created_at>? "
                "ORDER BY created_at ASC LIMIT ?",
                (session_id, since, limit),
            ).fetchall()
        return [
            Message(
                id=r["id"],
                session_id=r["session_id"],
                role=r["role"],
                content=r["content"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    def last_message_preview(self, session_id: str) -> str:
        with self._conn() as c:
            r = c.execute(
                "SELECT content FROM messages WHERE session_id=? "
                "ORDER BY created_at DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        return (r["content"][:80] if r else "") or "Session started"
