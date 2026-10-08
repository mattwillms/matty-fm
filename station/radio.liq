# MattyFM station. Source chain: requests -> backup playlist -> silence.
# SomaFM is NOT played here: the Pi plays it directly as an ordinary listener
# and crossfades to this stream when the in-stream title starts with "MATTYFM:".
# The studio drives this station over telnet (127.0.0.1:1234). Output: Icecast on :8040/radio.

rate = int_of_string(environment.get(default="44100", "MATTYFM_RATE"))

settings.frame.audio.samplerate := rate
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234
settings.log.stdout := true
settings.log.file := false

backup = playlist(id="backup", mode="randomize", reload_mode="watch", "/media/backup")

# Do not rebind `reqs`: wrapped sources lose push/skip/set_queue.
reqs = request.queue(id="reqs")
current = ref("")
reqs.on_track(synchronous=true, fun (m) -> begin
  current := m["mattyfm_id"]
  log.important(label="mattyfm", "request on air: #{m['mattyfm_id']} #{m['artist']} - #{m['title']}")
end)
backup.on_track(synchronous=false, fun (m) -> log.important(label="mattyfm", "backup track: #{m['artist']} - #{m['title']}"))
played = crossfade(duration=6., fade_in=2., fade_out=4., reqs)

def to_req(a, b) = sequence([fade.out(duration=1., a), fade.in(duration=0.1, b)]) end
def to_backup(a, b) = add(normalize=false, [fade.in(duration=3., b), fade.out(duration=3., a)]) end

radio = fallback(id="radio", track_sensitive=false, transition_length=4.,
                 transitions=[to_req, to_backup], [played, backup])
radio = mksafe(radio)

# The Pi reads the ICY title in-band, so it switches exactly when the audio does.
def mark(m) =
  mid = m["mattyfm_id"]
  if mid != "" then [("title", "MATTYFM:#{mid} #{m['artist']} - #{m['title']}"), ("artist", "")]
  else [("title", "IDLE"), ("artist", "")] end
end
radio = metadata.map(mark, radio)

def status(_) =
  src = if reqs.is_ready() then "requests"
        elsif backup.is_ready() then "backup"
        else "silence" end
  json.stringify({source=src, current=current(), remaining=reqs.remaining(),
                  queued=list.length(reqs.queue())})
end
server.register("status", status)
server.register("clear", fun (_) -> begin reqs.set_queue([]); "ok" end)

output.icecast(id="out", %mp3(bitrate=192, stereo=true),
               host="127.0.0.1", port=8040, mount="radio",
               password=environment.get("ICECAST_SOURCE_PASSWORD"),
               name="MattyFM", radio)
