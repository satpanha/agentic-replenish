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
