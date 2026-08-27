from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_reports_db_and_prices(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["db"] == "ok"
    assert body["version"] == "0.1.0"
    assert set(body["prices"]) == {"source", "fetched_at", "stale"}
    assert body["prices"]["source"] in {
        "unknown", "agmarknet_live", "agmarknet_cache", "bundled_snapshot"
    }


def test_public_route_rate_limited(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from app.config import get_settings
    from app.deps import rate_limiter

    monkeypatch.setattr(get_settings(), "RATE_LIMIT_PER_MIN", 2)
    rate_limiter.reset()
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/health").status_code == 200
    blocked = client.get("/api/v1/health")
    assert blocked.status_code == 429
    assert "retry-after" in blocked.headers
