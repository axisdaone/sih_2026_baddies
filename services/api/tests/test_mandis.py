from __future__ import annotations

from fastapi.testclient import TestClient


def test_lists_thirteen_mandis(client: TestClient) -> None:
    response = client.get("/api/v1/mandis")
    assert response.status_code == 200
    mandis = response.json()
    assert len(mandis) == 13
    by_id = {m["id"] for m in mandis}
    assert {"koyambedu", "dharmapuri", "kolar", "bengaluru", "madurai"} <= by_id
    sample = next(m for m in mandis if m["id"] == "koyambedu")
    assert sample["state"] == "Tamil Nadu"
    assert sample["agmarknet_market"] == "Koyambedu"
    assert 8 < sample["lat"] < 14 and 76 < sample["lon"] < 81


def test_mandis_seed_is_idempotent(client: TestClient) -> None:
    from app.db import SessionLocal
    from app.seed import seed_mandis

    with SessionLocal() as db:
        assert seed_mandis(db) == 13
    assert len(client.get("/api/v1/mandis").json()) == 13
