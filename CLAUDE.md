# MattyFM

Family-reunion radio. Spec: `spec.md`. Plan: `docs/superpowers/plans/2026-10-07-mattyfm.md`.
Version 0.1.0 (semver = big.small.bug).

## Run
- Studio: `systemctl --user {start,status} mattyfm-studio` (or `cd studio && ../.venv/bin/python -m mattyfm`); it serves the Pi
  its files via `mattyfm-files`. Tap listener: `mattyfm-listen` (http://127.0.0.1:8045).
- Worker: `cd worker && npx wrangler dev` / `npx wrangler deploy`. Party-day fixes: `tools/hotfix.sh worker|studio|both`.
- Tests: `.venv/bin/pytest studio/tests -q` · `cd worker && npx vitest run`
- Pi receiver: `scp -r pi mattyfm: && ssh mattyfm 'sudo bash pi/setup.sh http://192.168.86.44:8040 <PI_TOKEN>'`; logs `ssh mattyfm journalctl -u mattyfm-pi -f`
- Sound pads are hand-picked clips (top of `tools/make_pads.py`); the script refuses to run without `--overwrite-the-real-pads`.

## Rules
- **During the party, fix through `tools/hotfix.sh worker|studio|both` only** (rules: `docs/hotfix.md`). Pages swap themselves quietly; never reset the party or touch the Pi.
- Secrets only in `~/.config/mattyfm/env` and Worker secrets. Never commit them.
- Pi audio card is addressed by name (`plughw:CARD=<name>`), never by index.
- The Worker queue is the single source of truth; the Pi holds at most one pushed item.
- **Text size floor on the guest page (small phones, older guests):** reading text ≥ 17px, hints and secondary
  text ≥ 16px, the radio's stamped labels (dial numbers, REQUESTED, RETURN, placards) ≥ 12px. Nothing smaller.

## Findings
- **Song sources keep the home IP off YouTube:** search = YouTube Data API v3 (key `YOUTUBE_API_KEY`, ~100 searches/day; one key only: a second Google project for the same app breaks YouTube's API policy and risks suspending both; cached in media/cache/search.json); download = Apify actors on their servers (`APIFY_TOKEN`; primary thenetaji/youtube-music-downloader, fallback lurkapi). yt-dlp from home tripped "confirm you're not a bot" after ~50 downloads — the studio no longer has a yt-dlp path at all.
- **A deploy reaches the live queue (Durable Object) slowly: ~5½ min on 2026-10-08**, not at once. Never bump `QUEUE_VERSION` to make a change live; deploy, then read back `code` in `/api/admin/state` (bump its value in party.ts with each queue change) until it shows. Earlier bumps came from checking after 40 s. A bump is the last resort and is no longer destructive: a never-used queue takes over the previous version's state (`exportState`/`importState`, ids kept).
- Pi is the console (pi/console.py): SomaFM + deckA/deckB + dj + fx softvols into dmix (fx = admin sound pads, media/breaks/pad-1..5.mp3, made by tools/make_pads.py; tap → PA ≈ 1.5–3 s via the studio beat); transition = outgoing fades to silence (1.5 s), DJ at +0.5 s, 0.4 s gap, incoming fades up to full as the voice ends. Liquidsoap/Icecast retired.
- **SomaFM drops any client whose user agent contains "Liquidsoap"** (their no-restreaming rule). The Pi plays SomaFM itself; never disguise the station's user agent.
- Liquidsoap 2.4.5 `output.harbor` never sends ICY titles; Icecast does. The Pi times crossfades from those titles.
- The Liquidsoap image's entrypoint is `liquidsoap`: run checks as `docker run --rm --entrypoint sh … -c 'liquidsoap --check …'`, never `… liquidsoap --check` (the extra word is parsed as a script and the check is meaningless).
- Port 8000 on this workstation belongs to another project's uvicorn; MattyFM uses 8040 (firewalld rich rule allows 192.168.86.0/24).
- `nc` is not installed; talk to Liquidsoap telnet with Python (`mattyfm.station.Station`).
- Pi crossfade timing comes from the station's ICY title read by `mpg123 -R` (`@I ICY-META: StreamTitle='MATTYFM:…'`). Push→fade measured at ~7 s, skip→fade back ~9 s.
- Pi: Model B Rev 1 (rev 0003, 256 MB), IP 192.168.86.31, `ssh mattyfm`. Logitech G PRO X DAC = ALSA card `X`, 44.1 kHz OK. Two mpg123 decodes ≈ 12% CPU.
- **iPhones cannot use Apple's search API** (301 to musics://); the studio looks up year/album/cover/Apple link from home and hands them to the Worker (studio/mattyfm/apple.py). Apple's `uo=4` opens the iTunes Store; links use `app=music`.
- **A beat with source "silence" means the studio couldn't reach the Pi**: the Worker changes no song state and hands nothing out. The Pi reports `recent` (requests it started, with age) so songs played while the studio was offline are marked played, not re-handed.
- **Guests need the device cookie the page issues before they can request** (dropping it no longer dodges the 2-song cap or Mute). Rate limits: 20/min per phone, 120/min per IP, 30 new phone ids/min per IP (only the page-load `/api/state` hands them out). No cap on waiting songs per IP: the whole house shares one.
- **Commands expire after 20 s, except clear** (running it late is safe; losing it played a deleted song); a skip names the song it targets. A deleted song the Pi starts anyway gets one targeted skip. Privacy wipe is fixed at 2026-10-13 12:00 UTC (PURGE_AT in party.ts).
- **Reduce Motion is deliberately ignored** on the guest page: scrolling text, the lamp pulse and tap toys must work on iPhones with it on.
- ElevenLabs free tier cannot use library voices or Voice Design via API (402/403).
- SomaFM returns 200 to curl from this machine; a 403 seen from a subagent sandbox was not a block.
- **Outage recovery:** the studio unit is enabled and user lingering is on (`loginctl enable-linger matt`), so a power cut brings back mattyfm-files and mattyfm-studio without a login; the Pi unit is enabled with Restart=always. Queue state lives in the Durable Object's storage. A request cut off early without a Skip (Pi restart) goes back to the front once.
- Bumpers rotate as a shuffle bag per kind (media/breaks/plays.json): every clip plays before any repeats.
- **Every row a queue query looks at is billed** (free plan: 5M rows read/day; it took the queue down on 2026-10-08; the account is now on Workers Paid). Polls must stay indexed: `worker/test/reads.test.ts` pins rows per poll, queries over 500 rows log "heavy query" to Workers Logs, and `python3 tools/usage.py [hours]` shows hourly requests and rows read.
- **Match confidence is not a junk test** (party test 2026-10-09: real songs scored 25–45, "lol" scored 55). The studio asks the DJ's model whether a request is a real song and the video plausibly it (`djline.doubt`); the Worker holds the song for the host on that word. The page's `freeText` flag is the guest's claim and gates nothing.
- **Guests' phones ran hot with heavy use (party 2026-10-11, reported by several guests).** Not yet measured. Likely
  cause: the guest page never idles. `scrollFrame` (index.html) runs a requestAnimationFrame loop every frame for the
  life of the page (60–120 Hz) and rewrites each scroller's transform even when nothing moves; on top of it run CSS
  `infinite` animations (spinning record, lamp throb, prep pulse), a 250 ms clock tick and the 15 s poll, with Reduce
  Motion deliberately ignored. Next time: profile on a real phone (Safari Web Inspector → Timelines), run the loop only
  while a line actually scrolls, and pause scrollers and spins when off screen or after a minute of no touch.
