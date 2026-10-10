# Code audit — 2026-10-10

Four read-only reviews (Worker backend, guest page, admin page, studio + Pi + tools), before the second party
test. Findings first; what was done about them is appended under **Remediation**. Nothing critical was found:
no crash paths, no data loss.

## Findings

### Worker (party.ts, index.ts)
- **Serious** — A phone that won't keep the id cookie was minted a new id on every 15 s poll: a ghost row in the
  guest list each time, and the house's new-phone limit (30/min per address) used up.
- **Serious** — `flags()` (8 settings reads) ran ~7 times per guest poll (~56 queries), twice per beat, more per
  admin poll and per request.
- **Serious** — adminState ran `songLimit` (flags + counts, sometimes a write) per locked phone every 3 s, and sent
  15 finished songs and 10 finished jokes the page never reads, each with its own requesters query.
- **Serious** — `exportState`/`importState` left out the newer tables (names, kicked, orrdle).
- **Serious** — `commands` is never pruned, and three queries on it (`type`/`created_at`/`target`) had no index:
  late in the night every song end read thousands of rows.
- Minor — the rate-limit block copied 7 times in index.ts (cancel lacked the per-address limit); the purge-alarm
  block copied 3 times; reset didn't clear the wait-estimate cache; kick left the name on a shared held song;
  dead `retry` action; comments that lie (QUEUE_VERSION, pad "1 to 5", comments on the wrong lines); `requesters.ip`
  and `jokes.ip` stored but never read.

### Guest page (index.html)
- **Serious** — after a failed send, Send re-enabled before the coin finished rolling back: a second tap ran two
  roll animations at once.
- **Serious** — a medal whose reply was lost stayed in the phone's retry list forever and was re-awarded after a
  hunt reset (and kept the Orrdle sign shiny).
- **Serious** — the tube glow wrote CSS variables every animation frame, forever, even off screen or under a
  full-screen dialog (battery).
- Minor bugs — close-then-reopen within 240 ms closed the new Orrdle/About; a stale sleeve listener could close the
  next sleeve on open; the sleeve could open over Orrdle or About; toasts were hidden under dialogs and the medal
  viewer; the medal viewer ignored Escape and didn't hold off a hotfix reload; double medal toasts; overlapping polls.
- Noisy — cables relaid on every resize; limits text rewritten every 10 s unchanged; `reclaimName` POSTing every
  poll after any non-rule refusal; `loadCached` while hidden.
- Dead — `.fx.glint`, `.log-say`, `button.quiet`, `.fine`, `.again.spent`, `.display .art`, `.song .art`,
  `ICON_SPENT`, the left cable's path, always-true `typeof` guards, the one-time `mfm_polished` cleanup; split
  `.presets` rules.
- **Text size** — text below 16 px on a guest's screen: radio stamps (dial numbers 9.6, REQUESTED 10.4, RETURN ~10,
  placard 11), the flip clock's AM (5.8), the For Marie burst (6–8), About diagram labels (11–12), Made by (12.5),
  Orrdle's Enter (12.5), hints (15).

### Admin page (admin.html)
- **Serious** — the 30 s stats refresh ran while the tab was hidden, and kept running after the party ended.
- Minor — "N min ago" froze when a poll changed nothing; every action rendered twice; missing/stale toast texts
  (approve, dropJokes, reset, partyEnd); the "line over 20" note hidden when no jokes waited; the wipe confirm
  undersold the wipe; archive delete ignored a refusal; a duplicate CSS rule; `.ico` sizing leaking into pads; an
  undefined CSS variable; the admin token rewritten to storage every 3 s.

### Studio, Pi, tools
- **Serious** — the SomaFM feed lookup (up to ~11 s) ran while holding the lock every thread shares: the beat and
  every prepare thread could stall behind it.
- **Serious** — commands were acked before they ran: a Pi error mid-beat lost a host's skip or clear.
- **Serious** — yt-dlp search/download (from home, forbidden by CLAUDE.md) still the default in `songs.get_song`;
  `voice_samples.py` uses it.
- **Serious** — `make_pads.py` would overwrite the hand-picked pads if run.
- **Serious** — `voice/<rid>.raw.mp3` left behind on the generic-clip fallback (42 files).
- Minor bugs — after 20 failed resends the result was logged "delivered late"; the `_tries` counter was posted to the
  Worker; a prepare thread's error was wiped before it was sent; `backannounce` could voice "None"; temp files leak
  when ffmpeg fails; old media never swept; zombie mpg123 processes on the Pi until the next play on that channel.
- Noisy — the cache folder listed every beat under the lock; a Claude "doubt" check and an Apple lookup for every
  prepared song, even cached repeats; ffmpeg speech analysis of the stock bumpers on every play.
- Dead / redundant — Liquidsoap-era config and docs; `mix.VOICE_AT`/`song_start`; `songs.pick`; unused imports and a
  variable; six copies of the Claude call boilerplate; four copies of the voice pipeline.

## Remediation
