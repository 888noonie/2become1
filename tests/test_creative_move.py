"""The creative classifier returns one move. It does not edit a project."""

import io
import json

from twobecomeone.producer_brain import ProducerUnavailable, classify_creative


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _opener(payload):
    def opener(req, timeout):
        assert timeout <= 20
        body = json.loads(req.data.decode())
        assert body["model"] == "qwen2.5:3b-instruct"
        assert "audio" not in body["messages"][1]["content"]
        return _Response(json.dumps({"message": {"content": json.dumps(payload)}}).encode())
    return opener


def test_classify_creative_keeps_a_known_move():
    out = classify_creative("punch it up", opener=_opener({"move": "energy", "bars": 4}))
    assert out == {"move": "energy", "model": "qwen2.5:3b-instruct", "local": True}


def test_classify_creative_refuses_a_cloud_model():
    try:
        classify_creative("punch it up", env={
            "TWOBECOMEONE_PRODUCER_MODEL": "inkling-2-small:cloud",
            "TWOBECOMEONE_PRODUCER_URL": "http://127.0.0.1:11434",
        })
    except ProducerUnavailable as exc:
        assert "cloud" in str(exc)
    else:
        raise AssertionError("a cloud model was allowed")


def test_classify_creative_drops_an_unknown_move():
    out = classify_creative("do a cartwheel", opener=_opener({"move": "fly"}))
    assert out["move"] == "none"


def test_classify_creative_drops_a_non_string_move():
    out = classify_creative("punch it up", opener=_opener({"move": []}))
    assert out["move"] == "none"


def test_the_creative_prompt_describes_every_move():
    seen = {}

    def opener(req, timeout):
        seen["system"] = json.loads(req.data.decode())["messages"][0]["content"]
        return _Response(json.dumps({"message": {"content": json.dumps({"move": "gentle"})}}).encode())

    assert classify_creative("let it breathe", opener=opener)["move"] == "gentle"
    for move in ("energy", "gentle", "different", "previous-vocal", "take-over", "surprise", "none"):
        assert f"- {move}:" in seen["system"], move


def test_a_crashed_load_makes_status_say_so(monkeypatch):
    import urllib.error
    import urllib.request

    from twobecomeone import producer_brain

    class _Tags(_Response):
        pass

    def fake_urlopen(req, timeout):
        if req.full_url.endswith("/api/tags"):
            return _Tags(json.dumps({"models": [{"name": "qwen2.5:3b-instruct"}]}).encode())
        raise urllib.error.HTTPError(req.full_url, 500, "Internal Server Error", {}, io.BytesIO(
            b'{"error":"llama-server process has terminated: signal: segmentation fault (core dumped)"}'))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(producer_brain, "_LAST_CALL", {})
    env = {"TWOBECOMEONE_PRODUCER_URL": "http://127.0.0.1:11434"}
    assert producer_brain.status(env=env)["available"] is True
    assert producer_brain.status(env=env)["answered"] is None
    try:
        classify_creative("punch it up", env=env)
    except ProducerUnavailable as exc:
        assert "segmentation fault" in str(exc)
    else:
        raise AssertionError("a crashed load was reported as an answer")
    after = producer_brain.status(env=env)
    assert after["available"] is False
    assert "installed, but its last call failed" in after["note"] and "segmentation fault" in after["note"]


def test_an_error_inside_a_200_answer_is_a_failed_call(monkeypatch):
    import urllib.request

    from twobecomeone import producer_brain

    def fake_urlopen(req, timeout):
        if req.full_url.endswith("/api/tags"):
            return _Response(json.dumps({"models": [{"name": "qwen2.5:3b-instruct"}]}).encode())
        return _Response(b'{"error":"runner failed"}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(producer_brain, "_LAST_CALL", {})
    env = {"TWOBECOMEONE_PRODUCER_URL": "http://127.0.0.1:11434"}
    try:
        classify_creative("punch it up", env=env)
    except ProducerUnavailable:
        pass
    else:
        raise AssertionError("an error answer was accepted")
    after = producer_brain.status(env=env)
    assert after["available"] is False and after["answered"] is False


def test_unusable_content_in_a_200_answer_is_not_an_answer(monkeypatch):
    import urllib.request

    from twobecomeone import producer_brain

    replies = iter([b'{"message":{"content":"{\\"move\\":\\"energy\\"}"}}', b'{"message":{"content":"not json"}}'])

    def fake_urlopen(req, timeout):
        if req.full_url.endswith("/api/tags"):
            return _Response(json.dumps({"models": [{"name": "qwen2.5:3b-instruct"}]}).encode())
        return _Response(next(replies))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(producer_brain, "_LAST_CALL", {})
    env = {"TWOBECOMEONE_PRODUCER_URL": "http://127.0.0.1:11434"}
    assert classify_creative("punch it up", env=env)["move"] == "energy"
    assert producer_brain.status(env=env)["answered"] is True
    try:
        classify_creative("punch it up", env=env)
    except ProducerUnavailable:
        pass
    else:
        raise AssertionError("non-JSON content was accepted")
    after = producer_brain.status(env=env)
    assert after["available"] is False and after["answered"] is False


def test_an_answer_without_a_move_is_not_an_answer(monkeypatch):
    import urllib.request

    from twobecomeone import producer_brain

    def fake_urlopen(req, timeout):
        if req.full_url.endswith("/api/tags"):
            return _Response(json.dumps({"models": [{"name": "qwen2.5:3b-instruct"}]}).encode())
        return _Response(b'{"message":{"content":"{}"}}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(producer_brain, "_LAST_CALL", {})
    env = {"TWOBECOMEONE_PRODUCER_URL": "http://127.0.0.1:11434"}
    assert classify_creative("hmm", env=env)["move"] == "none"
    assert producer_brain.status(env=env)["answered"] is False
