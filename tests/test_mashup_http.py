"""Interpret route: grammar hits do not call a model; misses fail closed."""

import pytest


@pytest.mark.anyio
async def test_grammar_hit_does_not_call_a_model(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    import httpx
    from twobecomeone import mashup_provider
    from twobecomeone.webapp import create_app

    def forbidden(*_args, **_kwargs):
        raise AssertionError("model called for a grammar hit")

    monkeypatch.setattr(mashup_provider, "complete_json", forbidden)
    app = create_app(tmp_path / "data")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            response = await client.post("/api/mashup/interpret", json={"text": "drop the bass on deck A"})
        body = response.json()
        assert response.status_code == 200
        assert body["ok"] is True
        assert body["tier"] == "deterministic"
        assert body["model"] is None
        assert body["ops"] == [{"op": "eq", "deck": "A", "band": "low", "db": -12.0}]
    finally:
        app.state.studio.close()


@pytest.mark.anyio
async def test_grammar_miss_without_a_provider_leaves_playback_unchanged(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    import httpx
    from twobecomeone import mashup_provider
    from twobecomeone.webapp import create_app

    monkeypatch.setattr(mashup_provider, "complete_json", lambda *_args, **_kwargs: None)
    app = create_app(tmp_path / "data")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            response = await client.post("/api/mashup/interpret", json={"text": "make it slap"})
        body = response.json()
        assert response.status_code == 200
        assert body["ok"] is False
        assert body["ops"] == []
        assert body["error"]["code"] == "PR_PROVIDER_UNAVAILABLE"
    finally:
        app.state.studio.close()


@pytest.mark.anyio
async def test_model_draft_is_rejected_when_the_op_is_illegal(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    import httpx
    from twobecomeone import mashup_provider
    from twobecomeone.webapp import create_app

    monkeypatch.setattr(
        mashup_provider,
        "complete_json",
        lambda *_args, **_kwargs: '{"ops":[{"op":"separate","deck":"A"}],"declined":[]}',
    )
    app = create_app(tmp_path / "data")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            response = await client.post("/api/mashup/interpret", json={"text": "make it slap"})
        body = response.json()
        assert body["ok"] is False
        assert body["ops"] == []
        assert body["error"]["code"] == "PR_DRAFT_INVALID"
    finally:
        app.state.studio.close()
