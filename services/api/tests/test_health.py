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


def test_spoofed_forwarded_for_cannot_bypass_the_limit(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Without TRUST_PROXY the peer address is the key: a rotating X-Forwarded-For is ignored."""
    from app.config import get_settings
    from app.deps import rate_limiter

    assert get_settings().TRUST_PROXY is False
    monkeypatch.setattr(get_settings(), "RATE_LIMIT_PER_MIN", 2)
    rate_limiter.reset()
    for i in range(2):
        response = client.get("/api/v1/health", headers={"X-Forwarded-For": f"10.0.0.{i}"})
        assert response.status_code == 200
    blocked = client.get("/api/v1/health", headers={"X-Forwarded-For": "10.0.0.99"})
    assert blocked.status_code == 429
    assert rate_limiter.tracked_keys == 1


def test_trusted_proxy_uses_real_ip_then_last_forwarded_hop(  # type: ignore[no-untyped-def]
    client: TestClient, monkeypatch
) -> None:
    from app.config import get_settings
    from app.deps import rate_limiter

    monkeypatch.setattr(get_settings(), "TRUST_PROXY", True)
    monkeypatch.setattr(get_settings(), "RATE_LIMIT_PER_MIN", 1)
    rate_limiter.reset()
    # X-Real-IP wins over everything the client may have put in X-Forwarded-For.
    headers = {"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "1.1.1.1, 203.0.113.7"}
    assert client.get("/api/v1/health", headers=headers).status_code == 200
    assert client.get("/api/v1/health", headers=headers).status_code == 429
    spoofed = {"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "2.2.2.2, 203.0.113.7"}
    assert client.get("/api/v1/health", headers=spoofed).status_code == 429
    # Without X-Real-IP the LAST hop (added by the proxy) is used, never the first.
    rate_limiter.reset()
    def hit(xff: str) -> int:
        return client.get("/api/v1/health", headers={"X-Forwarded-For": xff}).status_code

    assert hit("1.1.1.1, 203.0.113.8") == 200
    assert hit("9.9.9.9, 203.0.113.8") == 429
    assert hit("9.9.9.9, 203.0.113.9") == 200


def test_rate_limiter_key_table_is_bounded() -> None:
    from app.deps import SlidingWindowRateLimiter

    limiter = SlidingWindowRateLimiter(window_s=60.0, max_keys=50, sweep_every=1000)
    for i in range(500):  # one-shot keys, as a spoofing loop would produce
        allowed, _ = limiter.check(f"public:{i}", 60, now=1000.0 + i * 0.01)
        assert allowed
    assert limiter.tracked_keys <= 50
    # Expired keys are swept, not just capped: after the window every key is gone.
    limiter.check("public:new", 60, now=2000.0)
    assert limiter.tracked_keys == 1
    # Periodic sweep also fires without hitting the cap.
    sweeper = SlidingWindowRateLimiter(window_s=60.0, max_keys=10_000, sweep_every=10)
    for i in range(9):
        sweeper.check(f"k{i}", 60, now=100.0)
    sweeper.check("late", 60, now=500.0)  # 10th check -> sweep drops the 9 expired keys
    assert sweeper.tracked_keys == 1


def test_public_routers_use_distinct_buckets(client: TestClient, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Jury phones spamming /quality-pass behind one NAT must not 429 /prices or /health."""
    from app.config import get_settings
    from app.deps import rate_limiter

    monkeypatch.setattr(get_settings(), "RATE_LIMIT_PER_MIN", 2)
    rate_limiter.reset()
    ghost = "00000000-0000-4000-8000-000000000000"
    for _ in range(2):
        assert client.get(f"/api/v1/quality-pass/{ghost}").status_code == 404
    assert client.get(f"/api/v1/quality-pass/{ghost}").status_code == 429
    assert client.get("/api/v1/prices").status_code == 200
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/mandis").status_code == 200
    assert client.get("/api/v1/protocols").status_code == 200
