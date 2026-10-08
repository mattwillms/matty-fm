import threading
import urllib.error
import urllib.request

from mattyfm import files


def test_only_playout_folders_are_served(tmp_path):
    for d in ("ready", "voice", "backup", "breaks", "cache"):
        (tmp_path / d).mkdir()
        (tmp_path / d / "x.mp3").write_bytes(b"ID3")
    (tmp_path / "qr-card.html").write_text("party code")
    srv = files.make_server(tmp_path, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        for ok in ("ready/x.mp3", "voice/x.mp3", "backup/x.mp3", "breaks/x.mp3"):
            assert urllib.request.urlopen(f"{base}/{ok}").read() == b"ID3"
        for bad in ("cache/x.mp3", "qr-card.html", "ready/../qr-card.html", ""):
            try:
                urllib.request.urlopen(f"{base}/{bad}")
                raise AssertionError(f"{bad} was served")
            except urllib.error.HTTPError as e:
                assert e.code == 404
    finally:
        srv.shutdown()
