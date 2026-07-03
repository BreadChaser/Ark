"""Persistent chat message store for The Ark."""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Message:
    id: str
    conversation_id: str
    role: str  # user | system | command | output | error
    content: str
    created_at: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
        }


class MessageStore:
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
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_conv
                    ON messages(conversation_id, created_at);
                """
            )

    def add(self, conversation_id: str, role: str, content: str) -> Message:
        msg = Message(
            id=uuid.uuid4().hex[:12],
            conversation_id=conversation_id,
            role=role,
            content=content,
            created_at=time.time(),
        )
        with self._conn() as c:
            c.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (msg.id, msg.conversation_id, msg.role, msg.content, msg.created_at),
            )
        return msg

    def list(
        self, conversation_id: str, since: float = 0, limit: int = 200
    ) -> list[Message]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND created_at>? "
                "ORDER BY created_at ASC LIMIT ?",
                (conversation_id, since, limit),
            ).fetchall()
        return [
            Message(
                id=r["id"],
                conversation_id=r["conversation_id"],
                role=r["role"],
                content=r["content"],
                created_at=r["created_at"],
            )
            for r in rows
        ]
