"""Purchase-order store (SQLite) with the human-approval gate.

Agents may only create POs as 'pending'. Approve/reject live in separate functions that the
agent tool registry never exposes; the HTTP layer additionally requires APPROVER_KEY.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from app import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id TEXT, supplier_name TEXT, status TEXT NOT NULL,
  total_cost REAL, lead_time_days INTEGER, lines_json TEXT, warnings_json TEXT, rationale TEXT,
  created_at TEXT, decided_at TEXT, decided_by TEXT, note TEXT, created_by TEXT);
"""


@contextmanager
def _db():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(r):
    d = dict(r)
    d["lines"] = json.loads(d.pop("lines_json") or "[]")
    d["warnings"] = json.loads(d.pop("warnings_json") or "[]")
    return d


def create_pending(drafts: list[dict], rationale: str = "", created_by: str = "agent") -> list[dict]:
    """Persist drafts as PENDING. A newer pending PO for the same supplier supersedes the old one."""
    out = []
    with _db() as con:
        for d in drafts:
            con.execute("UPDATE purchase_orders SET status='superseded', decided_at=? WHERE supplier_id=? AND status='pending'",
                        (_now(), d["supplier_id"]))
            cur = con.execute(
                "INSERT INTO purchase_orders(supplier_id,supplier_name,status,total_cost,lead_time_days,lines_json,warnings_json,rationale,created_at,created_by)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (d["supplier_id"], d["supplier_name"], "pending", d["total_cost"], d["lead_time_days"],
                 json.dumps(d["lines"]), json.dumps(d.get("warnings", [])), rationale, _now(), created_by))
            out.append(_row(con.execute("SELECT * FROM purchase_orders WHERE id=?", (cur.lastrowid,)).fetchone()))
    return out


def list_pos(status: str | None = None) -> list[dict]:
    with _db() as con:
        q = "SELECT * FROM purchase_orders" + (" WHERE status=?" if status else "") + " ORDER BY id DESC"
        return [_row(r) for r in con.execute(q, (status,) if status else ())]


def decide(po_id: int, approve: bool, by: str, note: str = "") -> dict:
    with _db() as con:
        r = con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone()
        if r is None:
            raise KeyError(f"PO {po_id} not found")
        if r["status"] != "pending":
            raise ValueError(f"PO {po_id} is {r['status']}, only pending POs can be decided")
        con.execute("UPDATE purchase_orders SET status=?, decided_at=?, decided_by=?, note=? WHERE id=?",
                    ("approved" if approve else "rejected", _now(), by, note, po_id))
        return _row(con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone())


def reset() -> None:
    with _db() as con:
        con.execute("DELETE FROM purchase_orders")
