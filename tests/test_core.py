import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, store
from app.main import app
from app.tools.forecast import forecast_series
from app.tools.replenish import decide_order

KEY = {"X-Approver-Key": config.APPROVER_KEY}
c = TestClient(app)


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    yield


def test_forecast_picks_seasonal_model_on_weekly_pattern():
    rng = np.random.default_rng(0)
    y = np.array([100 if i % 7 in (5, 6) else 50 for i in range(200)]) + rng.integers(-3, 4, 200)
    r = forecast_series(y, 28)
    assert r["wape"] < 0.1 and r["method"] in ("seasonal_naive", "ses_seasonal", "holt_seasonal")
    assert len(r["forecast"]) == 28 and (r["forecast"] >= 0).all()


def test_forecast_handles_short_history():
    assert forecast_series([1, 2, 3], 10)["method"] == "insufficient_history"


def test_decide_order_rounds_to_pack_and_moq():
    fc = np.full(30, 10.0)
    d = decide_order(fc, 3.0, 5, 1.0, 7, 0.95, position=0, pack=12, moq=24)
    assert d["triggered"] and d["order_qty"] % 12 == 0 and d["order_qty"] >= 24
    assert d["order_up_to"] >= 120  # at least L+R days of demand
    assert not decide_order(fc, 3.0, 5, 1.0, 7, 0.95, position=10_000)["triggered"]


def test_shelf_life_caps_order_up_to():
    fc = np.full(60, 10.0)
    d = decide_order(fc, 3.0, 5, 1.0, 7, 0.95, position=0, max_cover_days=10)
    assert d["order_up_to"] <= 100.0001


def test_tools_are_exposed_and_no_approve_tool():
    names = [t["name"] for t in c.get("/api/tools").json()["tools"]]
    assert "create_purchase_order_drafts" in names and not any("approve" in n for n in names)


def test_agent_offline_creates_only_pending_and_gate_works():
    r = c.post("/api/agent/run", json={}).json()
    assert r["purchase_orders"] and all(p["status"] == "pending" for p in r["purchase_orders"])
    po_id = r["purchase_orders"][0]["id"]
    assert c.post(f"/api/pos/{po_id}/approve").status_code == 401
    assert c.post(f"/api/pos/{po_id}/approve", headers=KEY).json()["status"] == "approved"
    assert c.post(f"/api/pos/{po_id}/approve", headers=KEY).status_code == 409


def test_new_draft_supersedes_old_pending():
    c.post("/api/agent/run", json={})
    c.post("/api/agent/run", json={})
    st = [p["status"] for p in store.list_pos()]
    assert st.count("pending") == len(st) // 2 and st.count("superseded") == len(st) // 2


def test_llm_loop_with_mock(monkeypatch):
    """Exercise the tool-calling loop without a network: fake client calls one tool, then answers."""
    from types import SimpleNamespace as NS

    from app import agent
    monkeypatch.setattr(config, "LLM_ENABLED", True)
    monkeypatch.setattr(config, "LLM_MODEL", "mock")
    calls = {"n": 0}

    class FakeChat:
        def create(self, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                tc = NS(id="1", function=NS(name="detect_inventory_risk", arguments='{"top_n":3}'))
                return NS(choices=[NS(message=NS(content=None, tool_calls=[tc]))])
            return NS(choices=[NS(message=NS(content="done", tool_calls=None))])

    monkeypatch.setattr(agent, "_client", lambda: NS(chat=NS(completions=FakeChat())))
    r = agent.run_agent("test", create_drafts=False)
    assert r["mode"] == "llm" and r["answer"] == "done" and r["trace"][0]["tool"] == "detect_inventory_risk"


def test_dashboard_payload_is_consistent_with_tools():
    d = c.get("/api/dashboard").json()
    risk = c.get("/api/risk?top_n=100").json()
    rep = c.post("/api/tools/optimize_replenishment", json={}).json()
    by = {p["sku"]: p for p in d["products"]}
    assert len(by) == risk["total_skus"]
    assert {p["sku"] for p in d["products"] if p["primary_reason"] != "OK"} == {x["sku"] for x in risk["top"]}
    assert round(sum(p["recommendation"]["line_cost"] for p in by.values() if p["recommendation"]), 2) == rep["total_cost"]
    p = next(iter(by.values()))
    assert len(p["forecast"]["history"]) == 56 and len(p["forecast"]["values"]) == 28


def test_optimizer_matches_policy_at_full_budget_and_respects_budget():
    full = c.post("/api/optimize", json={"budget": 1e9}).json()
    rep = c.post("/api/tools/optimize_replenishment", json={}).json()
    assert full["spend"] == rep["total_cost"] and full["counts"]["deferred"] == 0
    tight = c.post("/api/optimize", json={"budget": 3000}).json()
    assert tight["spend"] <= 3000 and tight["counts"]["deferred"] > 0
    for l in tight["lines"]:
        assert l["qty"] == 0 or (l["qty"] % l["pack_size"] == 0 and l["qty"] >= l["moq"])
        assert round(l["qty"] * l["unit_cost"], 2) == l["line_cost"]
    assert round(sum(l["line_cost"] for l in tight["lines"]), 2) == tight["spend"]


def test_forecast_workspace_metrics_are_defined():
    f = c.get("/api/forecast/SKU032?history_days=90&horizon=14").json()
    assert len(f["history"]) == 90 and len(f["forecast"]) == 14
    m = f["holdout"]["metrics"]["model"]
    assert m["rmse"] >= m["mae"] >= 0 and (m["mape"] is None) == (m["mape_note"] is not None and not m["mape_note"].endswith("excluded."))
    assert c.get("/api/forecast/NOPE").status_code == 404


def test_assistant_is_grounded_and_reports_tools():
    r = c.post("/api/assistant", json={"question": "What happens if my weekly budget decreases by 15%?", "budget": 12000}).json()
    assert r["intent"] == "budget_change" and r["tools_run"] and r["mode"] == "deterministic"
    r = c.post("/api/assistant", json={"question": "Why is this SKU at risk?", "sku": "SKU032"}).json()
    assert r["intent"] == "why_risk" and "Peanuts" in r["answer"]
    r = c.post("/api/assistant", json={"question": "What if Siam Snacks adds 5 days to the lead time?"}).json()
    assert r["intent"] == "lead_time_change"


def test_cart_drafts_lifecycle():
    bad = c.post("/api/pos/drafts", json={"lines": [{"sku": "SKU032", "qty": 741}]})
    assert bad.status_code == 422 and "case pack" in bad.json()["detail"]
    po = c.post("/api/pos/drafts", json={"lines": [{"sku": "SKU032", "qty": 740}, {"sku": "SKU033", "qty": 504}]}).json()["created"][0]
    assert po["status"] == "draft" and po["total_cost"] == round(740 * 2.22 + 504 * 2.2, 2)
    assert c.post(f"/api/pos/{po['id']}/approve", headers=KEY).status_code == 409  # drafts must be submitted first
    assert c.post(f"/api/pos/{po['id']}/submit").json()["status"] == "pending"
    assert c.post(f"/api/pos/{po['id']}/approve", headers=KEY).json()["status"] == "approved"
    assert c.post(f"/api/pos/{po['id']}/mark_sent").status_code == 401
    assert c.post(f"/api/pos/{po['id']}/mark_sent", headers=KEY).json()["status"] == "sent"
    done = c.post(f"/api/pos/{po['id']}/acknowledge", headers=KEY).json()
    assert done["status"] == "acknowledged" and [e["action"] for e in done["events"]] == ["created", "submit", "approve", "mark_sent", "acknowledge"]


def test_confirmed_supplier_update_changes_calculations():
    from app.service import reload_engine
    reload_engine()
    before = next(p for p in c.get("/api/dashboard").json()["products"] if p["sku"] == "SKU008")
    try:
        u = c.post("/api/supplier-updates", json={"updates": [{"supplier_id": "S2", "sku": "SKU008", "field": "unit_cost", "old_value": 1.28, "new_value": 1.36}]}).json()["confirmed"][0]
        after = next(p for p in c.get("/api/dashboard").json()["products"] if p["sku"] == "SKU008")
        assert after["unit_cost"] == 1.36 != before["unit_cost"]
        assert after["recommendation"]["line_cost"] == round(after["recommendation"]["qty"] * 1.36, 2)
        assert c.post("/api/supplier-updates", json={"updates": [{"supplier_id": "S2", "sku": "SKU008", "field": "pack_size", "new_value": 0}]}).status_code == 422
        c.delete(f"/api/supplier-updates/{u['id']}")
        assert next(p for p in c.get("/api/dashboard").json()["products"] if p["sku"] == "SKU008")["unit_cost"] == before["unit_cost"]
    finally:
        reload_engine()


def test_data_check_rejects_bad_csv():
    r = c.post("/api/data/check", json={"files": {"suppliers": "supplier_id,name\nS1,X\n"}}).json()
    assert not r["ok"] and "missing" in r["errors"][0]


def test_return_for_revision_and_simulated_dispatch():
    po = c.post("/api/pos/drafts", json={"lines": [{"sku": "SKU008", "qty": 576}]}).json()["created"][0]
    c.post(f"/api/pos/{po['id']}/submit")
    assert c.post(f"/api/pos/{po['id']}/return", headers=KEY, json={"note": ""}).status_code == 409  # a reason is required
    back = c.post(f"/api/pos/{po['id']}/return", headers=KEY, json={"note": "Check Cola quantity"}).json()
    assert back["status"] == "draft" and back["events"][-1]["note"] == "Check Cola quantity"
    assert c.post(f"/api/pos/{po['id']}/dispatch", headers=KEY, json={"channel": "email"}).status_code == 409  # not approved yet
    c.post(f"/api/pos/{po['id']}/submit")
    c.post(f"/api/pos/{po['id']}/approve", headers=KEY)
    assert c.post(f"/api/pos/{po['id']}/dispatch", json={"channel": "email"}).status_code == 401
    d = c.post(f"/api/pos/{po['id']}/dispatch", headers=KEY, json={"channel": "evolus"}).json()
    assert d["status"] == "approved"  # a simulation never marks the order as sent
    assert d["dispatch"][-1]["mode"] == "simulated" and "nothing was sent" in d["dispatch"][-1]["result"]
    assert c.post(f"/api/pos/{po['id']}/dispatch", headers=KEY, json={"mode": "live"}).status_code == 501
