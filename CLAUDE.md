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

## Rules
- Secrets only in `~/.config/mattyfm/env` and Worker secrets. Never commit them.
- Never rebind `reqs` in radio.liq (wrapped sources lose push/skip).
- Liquidsoap image tag is pinned: `savonet/liquidsoap:v2.4.5`.
- Pi audio card is addressed by name (`plughw:CARD=<name>`), never by index.
- The Worker queue is the single source of truth; Liquidsoap holds at most one pushed item.

## Findings
- **SomaFM drops any client whose user agent contains "Liquidsoap"** (their no-restreaming rule). The Pi plays SomaFM itself; never disguise the station's user agent.
- Liquidsoap 2.4.5 `output.harbor` never sends ICY titles; Icecast does. The Pi times crossfades from those titles.
- The Liquidsoap image's entrypoint is `liquidsoap`: run checks as `docker run --rm --entrypoint sh … -c 'liquidsoap --check …'`, never `… liquidsoap --check` (the extra word is parsed as a script and the check is meaningless).
- Port 8000 on this workstation belongs to another project's uvicorn; MattyFM uses 8040 (firewalld rich rule allows 192.168.86.0/24).
- `nc` is not installed; talk to Liquidsoap telnet with Python (`mattyfm.station.Station`).
- Pi: Model B Rev 1 (rev 0003, 256 MB), IP 192.168.86.31, `ssh mattyfm`. Logitech G PRO X DAC = ALSA card `X`, 44.1 kHz OK. Two mpg123 decodes ≈ 12% CPU.
- ElevenLabs free tier cannot use library voices or Voice Design via API (402/403).
- SomaFM returns 200 to curl from this machine; a 403 seen from a subagent sandbox was not a block.
