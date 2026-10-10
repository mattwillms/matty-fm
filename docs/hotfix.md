# Fixing things during the party

Run `tools/hotfix.sh worker|studio|both`. It runs both test suites, deploys, waits for the live queue to report
the new `code`, and restarts the studio only while the next song is already in the console.

## What guests see

Nothing. The guest page and the admin page carry a fingerprint of themselves on every poll (`page` in
`/api/state` and `/api/admin/state`). When a deploy changes a page, each open copy swaps itself for the new one
at a quiet moment: while the phone is locked or in another app, or after 90 seconds untouched with nothing
typed and nothing open (60 s for the admin page). The scroll position comes back. Names live in the phone's
storage and the device cookie survives, so limits, picks and "Your requests" carry on.

## What a hotfix may change

- **The queue (Durable Object) keeps its state across a deploy.** Never reset, never bump `QUEUE_VERSION`.
  Bump `code` in `party.ts` when the queue's code changes, so the script can tell when it's live (~5 min).
- **Tables change by adding only**: a new column goes in the `ALTER TABLE … ADD COLUMN` list in the
  constructor. Never drop, rename or retype a column.
- **Old and new run side by side for a while.** For ~5 minutes the routes are new and the queue old; open pages
  stay old until their quiet moment. So: new response fields are optional, nothing a page or the studio reads
  is removed or renamed, and new request fields are ignored by the old queue without harm.
- **The studio** restarts in ~3 s. The song on air keeps playing (the Pi plays it). Songs being prepared go
  back in line when their 2-minute lease runs out and are prepared again. Jokes riding on a queued song are
  remembered on disk (`media/breaks/joke_on.json`).
- **The Pi**: not during the party. Restarting the console cuts the music; a song cut off goes back to the
  front once.

## Undo

- Worker: `cd worker && npx wrangler rollback` (pages swap back the same quiet way; a queue change takes ~5 min).
- Studio: `git revert <sha>`, then `tools/hotfix.sh studio`.
