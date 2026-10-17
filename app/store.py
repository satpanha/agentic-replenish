"""Purchase-order store (SQLite) with the human-approval gate, plus confirmed supplier updates.

Agents may only create POs as 'pending'. Every other transition lives in functions that the agent
tool registry never exposes; the HTTP layer additionally requires APPROVER_KEY for them.

PO lifecycle (only states that a real action produces):
  draft --submit--> pending --approve--> approved --mark_sent--> sent --acknowledge--> acknowledged
                            --reject---> rejected
  pending --return--> draft (sent back for revision, with a note)
  draft / pending / approved --cancel--> cancelled
  pending --(newer agent draft for the same supplier)--> superseded
'sent' and 'acknowledged' are recorded by a person; nothing is transmitted automatically.

Dispatch records are kept separately from the status. A *simulated* dispatch (demo of the email /
webhook / Evolus integration points) is logged as such and never moves an order to 'sent'.
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
CREATE TABLE IF NOT EXISTS supplier_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id TEXT NOT NULL, sku TEXT, field TEXT NOT NULL,
  old_value REAL, new_value REAL NOT NULL, effective TEXT, source_doc TEXT, source_ref TEXT,
  confirmed_by TEXT, confirmed_at TEXT, reverted_at TEXT);
"""
# columns added after the first release; created on demand so existing databases keep working
PO_EXTRA_COLUMNS = {"events_json": "TEXT", "updated_at": "TEXT", "terms_json": "TEXT", "dispatch_json": "TEXT"}
DISPATCH_CHANNELS = {"email": "Supplier email", "webhook": "Supplier webhook", "evolus": "Evolus AI workflow"}

SKU_FIELDS = {"unit_cost", "moq", "pack_size"}
SUPPLIER_FIELDS = {"lead_time_days", "min_order_value"}

TRANSITIONS = {
    "submit": ({"draft"}, "pending"),
    "approve": ({"pending"}, "approved"),
    "return": ({"pending"}, "draft"),
    "reject": ({"pending"}, "rejected"),
    "mark_sent": ({"approved"}, "sent"),
    "acknowledge": ({"sent"}, "acknowledged"),
    "cancel": ({"draft", "pending", "approved"}, "cancelled"),
}


@contextmanager
def _db():
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    have = {r["name"] for r in con.execute("PRAGMA table_info(purchase_orders)")}
    for col, typ in PO_EXTRA_COLUMNS.items():
        if col not in have:
            con.execute(f"ALTER TABLE purchase_orders ADD COLUMN {col} {typ}")
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
    d["events"] = json.loads(d.pop("events_json", None) or "[]")
    d["terms"] = json.loads(d.pop("terms_json", None) or "{}")
    d["dispatch"] = json.loads(d.pop("dispatch_json", None) or "[]")
    d["updated_at"] = d.get("updated_at") or d.get("decided_at") or d.get("created_at")
    return d


def _insert(con, d: dict, status: str, rationale: str, created_by: str, terms: dict | None = None) -> dict:
    now = _now()
    events = [{"at": now, "action": "created", "status": status, "by": created_by, "note": rationale}]
    cur = con.execute(
        "INSERT INTO purchase_orders(supplier_id,supplier_name,status,total_cost,lead_time_days,lines_json,warnings_json,"
        "rationale,created_at,created_by,events_json,updated_at,terms_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (d["supplier_id"], d["supplier_name"], status, d["total_cost"], d["lead_time_days"], json.dumps(d["lines"]),
         json.dumps(d.get("warnings", [])), rationale, now, created_by, json.dumps(events), now, json.dumps(terms or {})))
    return _row(con.execute("SELECT * FROM purchase_orders WHERE id=?", (cur.lastrowid,)).fetchone())


def create_pending(drafts: list[dict], rationale: str = "", created_by: str = "agent") -> list[dict]:
    """Persist drafts as PENDING. A newer pending PO for the same supplier supersedes the old one."""
    out = []
    with _db() as con:
        for d in drafts:
            for old in con.execute("SELECT id, events_json FROM purchase_orders WHERE supplier_id=? AND status='pending'", (d["supplier_id"],)).fetchall():
                ev = json.loads(old["events_json"] or "[]") + [{"at": _now(), "action": "superseded", "status": "superseded", "by": created_by, "note": "Replaced by a newer draft"}]
                con.execute("UPDATE purchase_orders SET status='superseded', decided_at=?, updated_at=?, events_json=? WHERE id=?",
                            (_now(), _now(), json.dumps(ev), old["id"]))
            out.append(_insert(con, d, "pending", rationale, created_by))
    return out


def create_drafts(drafts: list[dict], rationale: str = "", created_by: str = "user", terms: dict | None = None) -> list[dict]:
    """Persist user-built drafts as DRAFT. They need an explicit submit before anyone can approve them."""
    with _db() as con:
        return [_insert(con, d, "draft", rationale, created_by, terms) for d in drafts]


def list_pos(status: str | None = None) -> list[dict]:
    with _db() as con:
        q = "SELECT * FROM purchase_orders" + (" WHERE status=?" if status else "") + " ORDER BY id DESC"
        return [_row(r) for r in con.execute(q, (status,) if status else ())]


def get_po(po_id: int) -> dict:
    with _db() as con:
        r = con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone()
        if r is None:
            raise KeyError(f"PO {po_id} not found")
        return _row(r)


def transition(po_id: int, action: str, by: str, note: str = "") -> dict:
    if action not in TRANSITIONS:
        raise KeyError(f"Unknown action {action}")
    if action == "return" and not note.strip():
        raise ValueError("Say what needs revising when returning an order")
    allowed, new = TRANSITIONS[action]
    with _db() as con:
        r = con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone()
        if r is None:
            raise KeyError(f"PO {po_id} not found")
        if r["status"] not in allowed:
            raise ValueError(f"PO {po_id} is {r['status']}; '{action}' needs status {' or '.join(sorted(allowed))}")
        now = _now()
        ev = json.loads(r["events_json"] or "[]") + [{"at": now, "action": action, "status": new, "by": by, "note": note}]
        decided = action in ("approve", "reject")
        con.execute("UPDATE purchase_orders SET status=?, updated_at=?, events_json=?" + (", decided_at=?, decided_by=?, note=?" if decided else "") + " WHERE id=?",
                    (new, now, json.dumps(ev), *((now, by, note) if decided else ()), po_id))
        return _row(con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone())


def simulate_dispatch(po_id: int, channel: str, by: str) -> dict:
    """Record a DEMO dispatch through an integration point. Nothing is sent; the status is unchanged."""
    if channel not in DISPATCH_CHANNELS:
        raise KeyError(f"Unknown channel {channel}")
    with _db() as con:
        r = con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone()
        if r is None:
            raise KeyError(f"PO {po_id} not found")
        if r["status"] != "approved":
            raise ValueError(f"PO {po_id} is {r['status']}; only approved orders can be dispatched")
        now = _now()
        rec = {"at": now, "channel": channel, "channel_label": DISPATCH_CHANNELS[channel], "mode": "simulated", "by": by,
               "result": "Simulated only: no integration is connected, nothing was sent to the supplier."}
        disp = json.loads(r["dispatch_json"] or "[]") + [rec]
        ev = json.loads(r["events_json"] or "[]") + [{"at": now, "action": "simulated_dispatch", "status": r["status"], "by": by,
                                                       "note": f"{DISPATCH_CHANNELS[channel]} (simulated, nothing sent)"}]
        con.execute("UPDATE purchase_orders SET dispatch_json=?, events_json=?, updated_at=? WHERE id=?", (json.dumps(disp), json.dumps(ev), now, po_id))
        return _row(con.execute("SELECT * FROM purchase_orders WHERE id=?", (po_id,)).fetchone())


def decide(po_id: int, approve: bool, by: str, note: str = "") -> dict:
    return transition(po_id, "approve" if approve else "reject", by, note)


def reset() -> None:
    with _db() as con:
        con.execute("DELETE FROM purchase_orders")


# ---- confirmed supplier updates (trusted data overrides) ------------------------------------

def add_updates(updates: list[dict], by: str) -> list[dict]:
    """Record confirmed field changes. Each update: supplier_id, field, new_value, [sku, old_value, effective, source_doc, source_ref]."""
    out = []
    with _db() as con:
        for u in updates:
            f = u["field"]
            if f not in SKU_FIELDS | SUPPLIER_FIELDS:
                raise ValueError(f"Field '{f}' cannot be updated")
            if f in SKU_FIELDS and not u.get("sku"):
                raise ValueError(f"'{f}' needs a SKU")
            v = float(u["new_value"])
            if v < 0 or (f in ("moq", "pack_size", "lead_time_days") and v != int(v)) or (f == "pack_size" and v < 1):
                raise ValueError(f"Invalid value {v} for {f}")
            cur = con.execute(
                "INSERT INTO supplier_updates(supplier_id,sku,field,old_value,new_value,effective,source_doc,source_ref,confirmed_by,confirmed_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (u["supplier_id"], u.get("sku") if f in SKU_FIELDS else None, f, u.get("old_value"), v, u.get("effective"),
                 u.get("source_doc"), u.get("source_ref"), by, _now()))
            out.append(dict(con.execute("SELECT * FROM supplier_updates WHERE id=?", (cur.lastrowid,)).fetchone()))
    return out


def list_updates(include_reverted: bool = False) -> list[dict]:
    with _db() as con:
        q = "SELECT * FROM supplier_updates" + ("" if include_reverted else " WHERE reverted_at IS NULL") + " ORDER BY id"
        return [dict(r) for r in con.execute(q)]


def revert_update(update_id: int) -> None:
    with _db() as con:
        if not con.execute("UPDATE supplier_updates SET reverted_at=? WHERE id=? AND reverted_at IS NULL", (_now(), update_id)).rowcount:
            raise KeyError(f"Update {update_id} not found or already reverted")


def reset_updates() -> None:
    with _db() as con:
        con.execute("DELETE FROM supplier_updates")
