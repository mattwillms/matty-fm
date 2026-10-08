# MattyFM — spec

**Version 0.1.0 · 2026-10-07 · Event: Sunday 2026-10-11, at home.**

A family-reunion radio. It plays SomaFM Left Coast 70s non-stop. Guests request
songs from their phones at fm.willms.co. A virtual DJ reads each request and
message, then the song plays. The owner manages the queue from a phone.

Built once a year. The code stays in this repo; cloud resources are torn down
after the event (`docs/teardown.md`) and rebuilt from `docs/setup.md`.

## Goals

1. **Never dead air.** Music plays for the whole party, even if the internet,
   a service, or a program fails.
2. **Sounds like radio.** Sting, DJ voice over the song intro with the music
   ducked, crossfades between songs, smooth fades to and from SomaFM.
3. **Zero attention from the owner** unless something needs a decision. The
   admin page shows health; the owner glances, not watches.
4. **Easy for guests.** Scan a QR code, search, tap, type a message. No app.

## Non-goals

- Running anywhere but the owner's home network.
- Apple Music playback (not possible on Linux; only its catalog search is used).
- Multi-room sync, Turnstile, drag-and-drop reorder, an R2 audio store.

## Architecture

```
guests' phones ──► fm.willms.co  (Cloudflare Worker + one Durable Object)
                       ▲ │  HTTPS beat ~3 s, bearer secret
                       │ ▼
Arch workstation:  studio (Python) ──telnet──► Liquidsoap 2.4.5 ──► Icecast 2.4.4
                                               (requests, backup)     │ MP3 + ICY titles, LAN :8040
                                                                      ▼
SomaFM (internet) ─────────────────────────────────────────► Pi 1 Model B: two mpg123 players,
                                                              crossfaded via ALSA softvol ──► PA
```

**SomaFM is played only by the Pi, as an ordinary listener.** SomaFM blocks
Liquidsoap (any user agent containing "Liquidsoap" gets zero bytes), which is
how they enforce their no-restreaming terms; we do not disguise around it.

Every connection starts from inside the house. Nothing listens on the internet.

### 1. Worker — `worker/`

Cloudflare Worker + one Durable Object (SQLite) named `party`. Holds the queue,
now-playing, settings, and studio heartbeat. **The Worker never touches audio
and holds no AI keys.**

Guest page (`/?k=<party code>`):
- Search box → `/api/search` → iTunes Search API **and** Deezer, merged and
  de-duplicated, cached 24 h. Debounced, 3+ characters.
- Tap a result → name (required, ≤40 chars) + message (optional, ≤280 chars).
- After submit: "Accepted · #N in line", later "Now playing". Status by polling.
- Shows now playing and the next few songs.
- If studio heartbeat is older than 60 s: "DJ's on a break — your request is
  saved."
- Fallback: "Can't find it? Type artist and title" → free-text request,
  flagged unverified.
- Notice: names and messages are deleted 48 h after the party.

Admin page (`/admin?t=<admin token>`):
- Health: studio heartbeat age, station status, current source (requests /
  SomaFM / backup), last error.
- Full queue with original message, DJ line, match confidence, status.
- Skip current · delete · move up/down · add request on someone's behalf ·
  mute a device.
- Switches: **last call** (stop accepting), **stop after current**,
  **SomaFM only** (panic: suspend requests).

Rules:
- Party code required on every guest API call. Admin token on admin calls.
  Studio uses a separate bearer secret. All three are Worker secrets.
- Device ID: random UUID in a cookie. Max **2 waiting** requests per device.
  Rate limit binding: 20 submits / 60 s per IP (everyone on the home wifi
  shares one public IP). The device cap is a nudge, not a lock: a guest can
  clear cookies; the owner can mute. Album art is accepted only from the
  iTunes and Deezer image hosts.
- **Order: round-robin by device.** Each device's next request waits until
  every other device with a waiting request has had a turn. An admin move
  pins an explicit position and overrides round-robin for that item.
- **Duplicates:** a request for a song already waiting merges into that item;
  requesters are appended. The DJ names up to 3, then "and friends".
- Explicit songs are **allowed**. The owner skips by hand.
- Job claims use a **lease**: the studio claims an item with a 120 s lease
  and renews it while working. An expired lease returns the item to pending.
  Results are written by item ID, so a retry overwrites, never duplicates.
- Data purge: a Durable Object alarm deletes names and messages 48 h after
  the party date.

### 2. Studio — `studio/`

Python on the workstation, under systemd (user unit). Two loops:

**Prepare loop** — for each pending item, in queue order, up to 2 at a time:
1. **DJ line:** Claude `claude-haiku-5-5`, low effort. The guest message is
   passed as quoted data inside tags, never as instructions. Light-touch
   moderation: keep teasing, inside jokes and mild language; paraphrase in DJ
   voice; refuse slurs, sexual content and real cruelty. Output
   `{ok, tone, script}`. **Tone picks the voice:** `funny` → Johnny Dynamite
   (jokes, teasing, party energy, and requests with no message); `sweet` →
   Countdown Casey (anniversaries, love, thanks, memorials — anything where a
   joke would land wrong). Refusal, timeout (10 s), or a bad reply → template line
   ("Here's one from {name} — {title} by {artist}!"). Output is checked by
   a short deny-list before it is voiced.
2. **Voice:** ElevenLabs `eleven_v4`, Starter plan (library voices need a
   paid plan). Johnny Dynamite `CeNX9CMwmxDxUF5Q2Inm` or Countdown Casey
   `mKoqwDP2laxTdq1gEgU6`, by tone. A name-respelling map (`studio/names.toml`) is
   applied first. Failure → a pre-rendered generic clip.
3. **Song:** local cache first (`media/cache/`, keyed by normalized
   artist+title). Otherwise yt-dlp (Deno runtime, pinned version):
   `ytsearch8:"artist - title"`, score each result — duration within ±5 s of
   the catalog duration, "- Topic" channel bonus, penalty for live / remix /
   karaoke / cover / extended / sped up / 8D unless the catalog title has the
   word. Below threshold → still play the best match, flag "low confidence"
   on the admin page. Cap 10 minutes. 5 s sleep between downloads.
   Failure → item marked failed, guest told, DJ line dropped.
4. **Pre-mix with ffmpeg** into one file: sting → DJ voice over the song's
   first seconds, song ducked ~12 dB under the voice, then the song at full
   level. Voice chain: high-pass 80 Hz, presence +3 dB at 3 kHz, 4:1
   compression. Whole file loudness-normalized to −16 LUFS, −1.5 dBTP.
   Output MP3 at the station sample rate. `ffprobe` check before ready.
5. Report `ready` with duration and confidence.

**Feed loop** — keeps exactly **one** item inside Liquidsoap:
- When nothing from requests is playing and the head of the queue is ready,
  push it.
- When Liquidsoap reports 30 s remaining on a request, ask the Worker for the
  next ready item **in queue order** and push it. If the head is not ready,
  push the next ready item and leave the head in place.
- Skip / delete of the playing item → `reqs.skip` over telnet.
- Now-playing and heartbeat posted to the Worker every 3 s.
- On restart: Liquidsoap's queue is empty; the feed loop re-pushes from the
  Worker. The item that was playing is marked played.

### 3. Station — `station/`

Liquidsoap **2.4.5** in Docker (`savonet/liquidsoap:v2.4.5`), host network,
`--restart unless-stopped`, wrapped in `systemd-inhibit` so the workstation
cannot sleep while it runs.

Source chain (each level takes over automatically):
1. `reqs` — the request queue, crossfaded (6 s).
2. Backup playlist — `media/backup/`, local MP3s (heard only when SomaFM is
   unreachable at the Pi). **Must never be empty.**
3. `mksafe` — silence filler, last resort.

The in-stream (ICY) title is `MATTYFM:<id> <artist> - <title>` while a request
plays and `IDLE` otherwise. Telnet on 127.0.0.1:1234 for push / skip / queue.
Output: `output.icecast` MP3 192 kbps to Icecast (`libretime/icecast:2.4.4`,
Docker, host port 8040, mount `/radio`). Liquidsoap's own harbor server does
not send ICY titles on 2.4.5, so Icecast is required.
Sample rate: **48 kHz if the Logitech adapter only accepts 48 kHz**,
otherwise 44.1 kHz — the whole pipeline uses one rate.

### 4. Receiver — `pi/`

Raspberry Pi 1 Model B, Raspberry Pi OS Lite 32-bit (Trixie). Wifi via USB
dongle (to be tested — see risks), Logitech USB audio adapter, analog out to
the PA.

- Two `mpg123` players run all the time: SomaFM (`ice6`, fallback `ice2`)
  into ALSA softvol `SomaVol`, and the station into softvol `StationVol`,
  both mixed by `dmix` on the Logitech card (`hw:CARD=X`). Measured decode
  cost: ~12% CPU for both.
- A controller (Python, systemd) reads the station's ICY titles from
  `mpg123 -R` and crossfades over ~2.5 s: station up when a title starts
  with `MATTYFM:`, SomaFM up otherwise. If the SomaFM player is down, the
  station (backup playlist) is up.
- Watchdog timer (15 s): restart the player if the ALSA stream is not
  RUNNING or its hardware pointer has not moved.
- Card selected **by name**, never by index. Onboard audio off
  (`dtparam=audio=off`). Mixer at 100%, saved with `alsactl store`; the PA
  sets the level.
- Wifi power-save off. Good 5 V 2.5 A supply. No USB hot-plugging while
  running.
- Read-only overlay filesystem once setup is final.

## Failure behaviour

| Failure | Result |
|---|---|
| Home internet down | Pi's SomaFM player drops → controller fades to the station's backup playlist. Requests already prepared still play. Guests on cellular can still submit; they wait. |
| yt-dlp broken / blocked | Cache hits still work. Misses fail fast; guest told; admin flagged. |
| Claude down | Template DJ line. |
| TTS down or out of credits | Cloudflare Aura-2 (`orion`); if that fails too, a generic pre-rendered clip. |
| Studio crash | systemd restarts it; leases return items to pending. |
| Liquidsoap crash | Docker restarts it; studio re-pushes. |
| Pi stream drops | The controller restarts the dead mpg123 within 2 s; buffers cover blips. |
| Workstation dies | Silence at the PA. Manual backup: a phone with a playlist on an aux cable, labeled, by the PA. |

## Testing

- Unit tests: round-robin ordering, duplicate merge, lease expiry, yt-dlp
  result scoring, DJ-line fallbacks.
- Fake-request script (`tools/fake_requests.py`): explicit songs, duplicates,
  emoji, 40-char names, non-English titles, prompt-injection messages, one
  device flooding.
- Chaos drill (Saturday): kill studio, kill Liquidsoap, pull workstation
  network, reboot the Pi, revoke an API key, block YouTube. Music must never
  stop for more than a few seconds.
- Pre-cache run: ~100 likely requests downloaded and pre-checked.

## Timeline

| Day | Work |
|---|---|
| Wed night | Spec, voice samples, Pi SD flashed |
| Thu | Station + studio + Worker end to end on the workstation |
| Fri | Pi receiver, dongle tests, admin page, guest page polish |
| Sat | Pre-cache, names map, chaos drill, dress rehearsal, QR cards |
| Sun | Setup checklist, party |
| Mon+ | Teardown, notes |

## Open decisions

1. ~~DJ voice~~ — decided 2026-10-07 by ear: ElevenLabs, Johnny Dynamite
   (funny) and Countdown Casey (sweet). Aura-2 kept as the fallback voice.
2. ~~Sample rate~~ — 44.1 kHz. The adapter is a Logitech G PRO X DAC
   (card id `X`), playback rates 16–48 kHz including 44100.

## Risks

- **Pi 1 + USB wifi dongle** is the weakest link. Dongles must be tested for
  driver support on ARMv6 and for dropouts under load.
- **YouTube** may break yt-dlp on the day. Mitigated by pinning, a
  Saturday-morning check, and the cache.
- **Terms of service:** SomaFM's terms say personal use; YouTube's terms bar
  downloading. Private family gathering at home; owner's call.
