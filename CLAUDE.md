# MattyFM

Family-reunion radio. Spec: `spec.md`. Plan: `docs/superpowers/plans/2026-10-07-mattyfm.md`.
Version 0.1.0 (semver = big.small.bug).

## Run
- Icecast: `station/icecast.sh` (libretime/icecast:2.4.4, host port 8040, mount /radio)
- Station: `station/run.sh` (Liquidsoap 2.4.5 in Docker, host network, streams into Icecast, telnet 127.0.0.1:1234)
- Studio: `cd studio && ../.venv/bin/python -m mattyfm`
- Worker: `cd worker && npx wrangler dev` / `npx wrangler deploy`
- Tests: `.venv/bin/pytest studio/tests -q` · `cd worker && npx vitest run`
- Units: `systemctl --user {start,status} mattyfm-icecast mattyfm-station mattyfm-studio`

- Pi receiver: `scp -r pi mattyfm: && ssh mattyfm 'sudo bash pi/setup.sh http://192.168.86.44:8040/radio'`; logs `ssh mattyfm journalctl -u mattyfm-pi -f`

## Rules
- Secrets only in `~/.config/mattyfm/env` and Worker secrets. Never commit them.
- Never rebind `reqs` in radio.liq (wrapped sources lose push/skip).
- Liquidsoap image tag is pinned: `savonet/liquidsoap:v2.4.5`.
- Pi audio card is addressed by name (`plughw:CARD=<name>`), never by index.
- The Worker queue is the single source of truth; Liquidsoap holds at most one pushed item.

## Findings
- **Song sources keep the home IP off YouTube:** search = YouTube Data API v3 (key `YOUTUBE_API_KEY`, ~100 searches/day, cached in media/cache/search.json); download = Apify actors on their servers (`APIFY_TOKEN`; primary thenetaji/youtube-music-downloader, fallback lurkapi). yt-dlp from home tripped "confirm you're not a bot" after ~50 downloads — do not use it on party day.
- **Durable Object kept running its first deploy's code** (deploys did not restart it, even idle). The queue instance name carries `QUEUE_VERSION` in worker/src/index.ts — bump it when party.ts changes (resets the queue; never on party day). **A bump is not proof:** on 2026-10-08 the fresh v9 instance still answered with old code (cause unproven: probably born during the deploy rollout). After a bump, read back a field only the new code has; if it's missing, bump again.
- Pi is the console (pi/console.py): SomaFM + deckA/deckB + dj softvols into dmix; transition = outgoing fades to silence (1.5 s), DJ at +0.5 s, 0.4 s gap, incoming fades up to full as the voice ends. Liquidsoap/Icecast retired.
- **SomaFM drops any client whose user agent contains "Liquidsoap"** (their no-restreaming rule). The Pi plays SomaFM itself; never disguise the station's user agent.
- Liquidsoap 2.4.5 `output.harbor` never sends ICY titles; Icecast does. The Pi times crossfades from those titles.
- The Liquidsoap image's entrypoint is `liquidsoap`: run checks as `docker run --rm --entrypoint sh … -c 'liquidsoap --check …'`, never `… liquidsoap --check` (the extra word is parsed as a script and the check is meaningless).
- Port 8000 on this workstation belongs to another project's uvicorn; MattyFM uses 8040 (firewalld rich rule allows 192.168.86.0/24).
- `nc` is not installed; talk to Liquidsoap telnet with Python (`mattyfm.station.Station`).
- Pi crossfade timing comes from the station's ICY title read by `mpg123 -R` (`@I ICY-META: StreamTitle='MATTYFM:…'`). Push→fade measured at ~7 s, skip→fade back ~9 s.
- Pi: Model B Rev 1 (rev 0003, 256 MB), IP 192.168.86.31, `ssh mattyfm`. Logitech G PRO X DAC = ALSA card `X`, 44.1 kHz OK. Two mpg123 decodes ≈ 12% CPU.
- ElevenLabs free tier cannot use library voices or Voice Design via API (402/403).
- SomaFM returns 200 to curl from this machine; a 403 seen from a subagent sandbox was not a block.
