# WORR (MattyFM)

A pretend 1970s FM station for a family reunion. Guests scan a QR code, pick a song on their phone, add a
message, and a DJ with a real voice reads it on air before the song plays. Between requests the station
plays SomaFM's Seventies channel, so there is never dead air.

Built by Matt Williams with Claude Code in October 2026, for one party a year.

## What a guest sees

- **A radio on their phone:** search for a song, tap it, add a line for the DJ ("for Grandma, 50 years!").
  Each phone gets two songs at a time; the line is kept fair, one turn each.
- **The DJ:** Claude writes each intro, ElevenLabs voices it, and the music dips under the voice.
- **Jokes and announcements:** sent from the page, written up and read on air at the next break.
- **Sound buttons:** air horns and applause over the party speakers (or just on the phone).
- **Games:** a family Wordle (Orrdle) and a scavenger hunt hidden in the radio itself. Find every medal for a
  golden quarter: one more song.
- **Lyrics and sleeves:** the song on air, its album cover and its lyrics, live.

The host gets a booth page: the queue, held requests, the guest list (mute, kick, a free quarter, free play
for one phone), sound pads, and the station's health.

## How it fits together

```
guests' phones ──► Cloudflare Worker + one Durable Object (the queue: the single source of truth)
                        ▲ │  a heartbeat every ~3 s
                        │ ▼
a PC at home:      the studio (Python): finds and downloads each song, writes and voices the DJ's line
                        │  push / skip / status over the home network
                        ▼
a Raspberry Pi:    the console: SomaFM, two song decks, the DJ and the sound pads, mixed live ──► the PA
```

| Folder | What lives there |
|---|---|
| `worker/` | The Cloudflare Worker: the guest page (`public/index.html`), the booth (`public/admin.html`), the queue (`src/party.ts`) and its tests |
| `studio/` | The Python studio: song search and download, the DJ's writer and voice, the break scheduler, its tests |
| `pi/` | The console on the Pi (`console.py`), its ALSA mixer config, systemd units and setup script |
| `tools/` | One-off makers (station IDs, jingles, sound pads, icons, the QR card), the party simulator, deploy and log helpers |
| `docs/` | Setup, the day-of checklist, hotfix rules, teardown, the code audit and party test reports |
| `spec.md` | What it must do, and why |

## Running it

Full setup, including the cloud resources and secrets, is in [`docs/setup.md`](docs/setup.md). Day to day:

```sh
# the studio (a systemd user unit) and its tests
systemctl --user start mattyfm-studio
.venv/bin/pytest studio/tests -q

# the Worker, locally and live
cd worker && npx wrangler dev
cd worker && npx vitest run
tools/hotfix.sh worker      # deploys, then waits until the live queue runs the new code

# the Pi
scp -r pi mattyfm: && ssh mattyfm 'sudo bash pi/setup.sh http://<studio-ip>:8040 <PI_TOKEN>'
```

Secrets live only in `~/.config/mattyfm/env` and in the Worker's secrets, never in this repo.

## Services it uses

- **Cloudflare Workers Paid** for the queue (a Durable Object with SQLite).
- **Anthropic Claude** writes the DJ's lines and checks that a request is a real song.
- **ElevenLabs** for the DJ's voice, the station IDs and the sung jingles; Cloudflare's Aura voice as a backup.
- **YouTube Data API** to find songs, and **Apify** to download them away from a home IP.
- **Apple's search API** for album, year and cover art; **LRCLIB** for lyrics.
- **SomaFM** Seventies between requests (played by the Pi as an ordinary listener).

## Make your own

Fork it and change the family: the station name (`MATTYFM_STATION_NAME`), how the DJ says your names
(`studio/names.toml`), the DJ's house rules (`studio/mattyfm/djline.py`) and the Orrdle words (`worker/src/party.ts`). Then follow
`docs/setup.md`. `docs/party-test-2.md` shows what four hours of a simulated full house looks like.

## How it was built

Every line was written by Claude Code from Matt's requests, most of them a screenshot and one sentence.
`CLAUDE.md` holds the project's working rules and the hard-won findings; `docs/AUDIT.md` is the pre-party
code audit. The page's About panel (tap "made by matty") tells the story for non-programmers.
