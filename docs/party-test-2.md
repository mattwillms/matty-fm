# Party test 2 — 2026-10-10

A four-hour simulated party on the live system (Worker, studio, Pi), after the code audit (`docs/AUDIT.md`).

- **Guests:** 31 simulated phones (`tools/party_sim.py`): 12 regular, 4 hammer, 5 clueless, 4 lurker, 3 gamer, 3 hunter.
- **Host:** a simulated host acting every 5–15 min.
- **Browsers:** 3 real browsers (`tools/ui_soak.mjs`, Firefox and Chromium at iPhone size) tapping everything on the
  guest page and checking for stacked dialogs, stuck scroll lock, overflow, bad transforms, piled-up effects, stuck toasts.

Run 10:48–14:45 CDT (the browsers from 10:20). The DJ spoke through Aura (`MATTYFM_VOICE=aura`) to keep the
ElevenLabs credit for the party; the ElevenLabs path was proven in party test 1.

## Result

**No breakage a guest would notice.** No crash, no server error, no stalled station, no stacked dialogs.

| | |
|---|---|
| Guest actions | 4,649 (1,112 requests, 619 pads, 665 Orrdle guesses, 414 medal claims, 203 jokes, 119 lyrics) |
| Server errors | 0 (1 dropped connection on a pad press) |
| Station | requests on air at 1,415 of 1,419 checks; never stale (Pi report ≤ 3 s old) |
| Songs | 59 played, 62 removed (guest cancel, host, long-line rules), 7 failed (6 deliberate junk, 1 real) |
| Line | peaked at 27 waiting; a played song waited a median **67 min** (max 151) from request to finish |
| Jokes | 24 aired, 36 expired unaired, 8 deleted by the host, 1 declined by the DJ (a spam link) |
| Host actions | 15 (move, kick, give a quarter, family mode off 5 min, drop jokes, pad gap, stats): all worked |
| Browser bots | ~15,600 taps; 1 finding (below) |
| Hotfixes during the run | 6 Worker deploys (one changed the queue), none noticed by guests or bots |

## Found and fixed during the run

- **A phone could finish the hunt nameless, and the DJ announced "One of you".** A page open across a reset kept
  believing its name was claimed. The guest poll now says `named`; the page claims its name again (after the kick
  check, so a kicked phone never re-registers). Test: `limits.test.ts` "named".
- **About panel:** name corrected to Matt Williams; diagram boxes' padding evened; an editing pass, and a new
  section on mathom and the four tiers.
- **Golden quarter back:** RIP / Deandra / (Dee Dee).

## Harness problems (not the site)

- The first 25 min of the sim were void: its guests never made the page-load call that now issues a phone id.
  Fixed (`load=1` on the first poll); the run was restarted.
- 3 "clueless" guests were locked out after a simulated cookie wipe (142 refusals): the sim's new phone skipped the
  page load. Fixed for future runs; their refusals are excluded above.
- The headless browsers played the "My phone" pads through this PC's speakers. Bots are muted now.
- 159 bot "errors" are all "browser has been closed", from the two moments the bots were stopped.
- The sim's monitor reads the admin view, which (since the audit) no longer lists finished songs and jokes: final
  statuses come from the play history instead.

## Findings for after the test

1. **The line is long under a full house.** 31 active guests kept 20–27 songs waiting all afternoon; a request
   waited about an hour. The long-line rule (one song at a time past 20 waiting) fired about 540 times and is what kept it
   bounded. Real guests will request less than the sim's hammers, but this is the ceiling to expect.
2. **Most jokes expire.** With requests back to back, a joke airs at a break (every 10 min), so about 6 an hour; a
   joke not aired in 30 min expires. A setting choice: shorter breaks, a longer expiry, or blending more jokes into
   song intros.
3. **Medals earned in a row arrive slowly** (reported by Matt). By design: one medal per phone per 10 s; a refused
   one waits for the next 15 s poll. Proposed: retry when the 10 s are up, and a 3 s gap.
4. **One junk request slipped the doubt check** ("X - Song", 10:45); the next 10 identical ones were held. `doubt`
   returns "" both for "fine" and for a failed call, and the studio now remembers that answer per song: a failed
   check would be remembered as "fine". Fix: tell the two apart and remember only real answers.
5. **One real song failed:** Lady Gaga, "Just Dance (Richard Vission Remix)": the primary download service returned
   400 and the fallback's files would not decode.
6. **Rows read: ~3.5M an hour at peak** (~280 per request), with no single query over 500 rows. Affordable on
   Workers Paid (25B/month included), but well above what the polls should cost with a long line; profile the
   guest and admin polls with a 30-song line.
7. **Tap-toy sparks overflow the page by up to 28 px for a moment.** Invisible (the page clips sideways overflow).
   Left as is.
8. One lyrics lookup took 10 s (LRCLIB slow); the page shows the sleeve without them meanwhile.

## Credits after the run

- ElevenLabs: 23,811 characters left (unchanged; resets Nov 7).
- Apify: $3.47 of $5.00 used this cycle (ends Nov 7).
- Cloudflare: 0 errors; ~14M rows read in 24 h.

## Done after the run (2026-10-10)

1. Long line: no change; the long-line rule holds it.
2. Jokes wait 45 minutes before they expire (was 30); the pace stays one every 5 minutes.
3. Medals: one a phone every 3 s (was 10); a refusal says when to try again and the page retries then.
4. A failed doubt check is no longer remembered as "fine" (`doubt` returns None on failure).
5. No change: a download service failed on one remix.
6. Profiled with 30 waiting: a guest poll reads ~65 rows for the line, ~35 to count it, plus that phone's own
   history (the sim's heavy phones had 20 requests each). No single waste; left as is.

Also: per-phone Free Play in the booth's guest list; the music dips 6 dB under a sound pad.
