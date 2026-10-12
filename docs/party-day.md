# Party day — 2026-10-11

The real thing. Party clock 10:48–20:40 CDT (about 10 hours). Figures come from the queue's export, taken the next
day before the privacy wipe; names and messages stay out of this repo.

## Result

**No outage during the party.** The studio lost the Pi only twice, both outside the party clock: 8 minutes at 10:05
(the Pi moved outside, and a knocked plug rebooted everything) and from 20:43 on (unplugged at the end).

| | |
|---|---|
| Guests | 17 phones took part, 16 of them requested songs; 21 names claimed |
| Songs | 101 requests, 97 played (1 skipped), 6 removed in the booth, 0 failed |
| Wait | request to on air: median 17 min, 90th percentile 40, longest 88 |
| DJ | every read voiced by ElevenLabs; 101 of 106 lines in the funny tone, 4 sweet |
| Messages | 57: 38 announcements (20 urgent) and 16 jokes aired; 2 jokes expired unaired; 1 rejected (not English) |
| Busiest hour | 18:00, 22 requests |
| Orrdle | 76 games, 49 wins, 16 players; fastest win in one guess, 3.3 s |
| Hunt | 121 medals on 14 phones; 7 golden quarters |
| Costs for the day | about 5,000 ElevenLabs characters; about $2 of song-source credit |

## Found during the party

- **Urgent messages were demoted to jokes** when the DJ's model judged one a shout-out ("come find me, now"), and
  then waited in the joke line (one every 5 minutes). Fixed live: an urgent message stays urgent (`jokeResult`,
  test in `limits.test.ts`). Two messages sent before the fix aired late.
- **The booth's Station Off switch was on** after the Pi moved outside, so the Pi was silent. Switched back on from
  the booth API.
- **One song matched the wrong recording.** The studio noted the mismatch, but the song played anyway.
- **Guests' phones ran hot with heavy use** (several guests). Not measured; likely the page never idles (see the
  `CLAUDE.md` finding).

## After

The booth gained an `export` action (every table, one call) so the night could be saved before the wipe.
Teardown steps: `docs/teardown.md`.
