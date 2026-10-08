# Day-of checklist (Sunday morning)

1. `.venv/bin/pip install -U "yt-dlp[default]"` only if Saturday's check failed; otherwise leave the pinned version.
2. `systemctl --user restart mattyfm-icecast mattyfm-station mattyfm-studio`; `systemd-inhibit --list | grep MattyFM`.
3. Pi: power on, `ssh mattyfm systemctl is-active mattyfm-pi` → active; PA knob at the marked spot.
4. Admin page open on Matt's phone: Studio OK, Playing SomaFM.
5. Real request from a phone on cellular (not home wifi) → hear it end to end.
6. ElevenLabs credits: check the usage page has > 10k left.
7. Backup phone with an offline playlist + aux cable, labeled, next to the PA.
8. Cards on tables.

## If something breaks
- Silence at the PA but the admin page says playing → `ssh mattyfm sudo systemctl restart mattyfm-pi`.
- Admin: Studio silent → `systemctl --user restart mattyfm-studio`; check `journalctl --user -u mattyfm-studio -n 50`.
- BACKUP playlist showing → home internet is down; requests already prepared still play.
- Anything weird → "SomaFM only — pause requests" on the admin page.
- Total failure → the backup phone on the aux cable.
