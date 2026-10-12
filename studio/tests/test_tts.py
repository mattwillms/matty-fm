import json
import httpx

from mattyfm import tts


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_respell_whole_words_only():
    names = {"Siobhan": "Shiv-awn", "Bo": "Boh"}
    assert tts.respell("For Siobhan and Bob from Bo.", names) == "For Shiv-awn and Bob from Boh."


def test_eleven_success_uses_tone_voice(tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        return httpx.Response(200, content=b"ID3voice")

    engine = tts.speak("hi", "sweet", tmp_path / "v.mp3", http=client(handler),
                       aura=lambda t: b"", assets=tmp_path, names={})
    assert engine == "eleven"
    assert tts.VOICES["sweet"] in seen["url"]
    assert (tmp_path / "v.mp3").read_bytes() == b"ID3voice"


def test_falls_back_to_aura_then_generic(tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    down = client(lambda req: httpx.Response(401, json={"detail": "quota"}))
    assert tts.speak("hi", "funny", tmp_path / "a.mp3", http=down, aura=lambda t: b"ID3aura",
                     assets=tmp_path, names={}) == "aura"

    (tmp_path / "generic-funny.mp3").write_bytes(b"ID3generic")

    def aura_down(text):
        raise httpx.ConnectError("no")

    assert tts.speak("hi", "funny", tmp_path / "g.mp3", http=down, aura=aura_down,
                     assets=tmp_path, names={}) == "generic"
    assert (tmp_path / "g.mp3").read_bytes() == b"ID3generic"


def test_a_voice_that_is_not_audio_falls_through_to_the_generic_clip(tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    html = client(lambda req: httpx.Response(200, content=b"<html>quota page</html>"))
    (tmp_path / "generic-funny.mp3").write_bytes(b"ID3generic")
    assert tts.speak("hi", "funny", tmp_path / "x.mp3", http=html, aura=lambda t: b'{"error":"bad"}',
                     assets=tmp_path, names={}) == "generic"


def test_pause_cues_go_to_elevenlabs_but_never_to_aura(tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    sent = {}

    def handler(req):
        sent["eleven"] = json.loads(req.content)["text"]
        return httpx.Response(500)
    def aura(text):
        sent["aura"] = text
        return b"ID3voice"
    tts.speak("You're on MattyFM. [pause] All requests, all night.", "funny", tmp_path / "v.mp3",
              http=client(handler), aura=aura, assets=tmp_path, names={})
    assert "[pause]" in sent["eleven"]
    assert "[" not in sent["aura"] and "MattyFM" in sent["aura"]


def test_voices_are_picked_by_weight_from_the_settings_file(tmp_path):
    f = tmp_path / "voices.toml"
    f.write_text('[funny]\n"johnny" = 2\n"her" = 1\n[sweet]\n"casey" = 1\n')
    voices = tts.load_voices(f)
    picks = [tts.pick_voice(voices, "funny", roll=r) for r in (0.0, 0.5, 0.66, 0.67, 0.99)]
    assert picks == ["johnny", "johnny", "johnny", "her", "her"]
    assert tts.pick_voice(voices, "sweet", roll=0.9) == "casey"
    assert tts.load_voices(tmp_path / "missing.toml") == tts.DEFAULT_VOICES   # no file: the built-in pair
