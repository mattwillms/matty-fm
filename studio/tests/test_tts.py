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
