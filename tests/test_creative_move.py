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
