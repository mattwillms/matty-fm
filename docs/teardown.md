# Teardown (Monday)

- [ ] ElevenLabs: **cancel the Starter plan** (renews monthly). Delete generated history (Settings → History).
- [ ] Cloudflare: `cd worker && npx wrangler delete` (removes the Worker, the fm.willms.co custom domain and the Durable Object).
      Confirm in the dashboard that no `fm` DNS record remains.
- [ ] Anthropic console: delete the MattyFM API key.
- [ ] `~/.config/mattyfm/env`: delete PARTY_CODE / ADMIN_TOKEN / STUDIO_SECRET lines (they die with the Worker anyway).
- [ ] `systemctl --user disable --now mattyfm-icecast mattyfm-station mattyfm-studio`; remove the unit symlinks.
- [ ] `rm -rf media/ready media/voice` (guest audio). Keep `media/cache` for next year if wanted.
- [ ] Pi: power off; keep the card (or reflash).
- [ ] Record in CLAUDE.md: the yt-dlp version that worked, dongle verdict, anything that broke.
- [ ] Vault notes for what generalises (see the mathom skill).
