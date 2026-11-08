# Teardown (the day after)

Before the privacy wipe (`PURGE_AT` in `worker/src/party.ts`):
- [x] Save the night: POST `/api/admin/action` with `{"action":"export"}` (every table), plus `stats`, `archive` and
      `guests`, into `media/party-archive-<date>/` (gitignored: it holds names and messages).
- [x] Save the logs: `journalctl --user -u mattyfm-studio -u mattyfm-files -u mattyfm-listen`, and on the Pi
      `journalctl -u mattyfm-pi`, for the party window.

Then:
- [x] `systemctl --user disable --now mattyfm-studio mattyfm-files mattyfm-listen` (the unit files stay in `systemd/`).
- [x] Pi: fetch its log, then power it off. Keep the card. (2026-10-13: no party log was left on the card.)
- [ ] Guest audio: `media/ready` (song files) and `media/voice` (the DJ's reads, with guests' names). Keep or delete.
- [x] Cloudflare: `cd worker && npx wrangler delete` removes the Worker, its custom domain and the Durable Object.
      Then cancel Workers Paid (Manage Account → Billing → Subscriptions).
- [x] ElevenLabs: cancel the plan (profile → Subscription → Manage subscription → Cancel). It runs to the end of the
      billing period. Delete the generated history.
- [x] Anthropic console: delete the API key; turn off auto-reload under Billing.
- [x] Song-source keys: delete them.
- [ ] `~/.config/mattyfm/env`: delete PARTY_CODE / ADMIN_TOKEN / STUDIO_SECRET / PI_TOKEN (they die with the Worker).
- [x] Record what broke and what generalises (`CLAUDE.md` findings; the vault, see the mathom skill).
