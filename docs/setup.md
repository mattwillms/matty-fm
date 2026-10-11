# Setup (rebuild next year)

Everything lives in this repo except secrets (`~/.config/mattyfm/env`, mode 600) and
the Cloudflare/ElevenLabs/Anthropic accounts. Values with spaces are quoted.

## 1. Keys — `~/.config/mattyfm/env`
- `ANTHROPIC_API_KEY` — the DJ's lines and the "is this a real song?" check.
- `ELEVENLABS_API_KEY` — **Starter plan or above**: library voices need a paid plan. A party of ~100 intros
  uses about 35k characters.
- `YOUTUBE_API_KEY` — YouTube Data API v3, for search only (~100 searches a day on the free quota; one key).
- `APIFY_TOKEN` — downloads run on Apify's servers, so the home IP never pulls from YouTube (~$0.024 a song).
- `PARTY_CODE`, `ADMIN_TOKEN`, `STUDIO_SECRET`, `DEVICE_SECRET` — generate:
  `python3 -c 'import secrets;print(secrets.token_urlsafe(6))'` for the code, `openssl rand -hex 32` for the rest.
- `PI_TOKEN` — `openssl rand -hex 16`; the studio and the Pi share it.
- `MATTYFM_WORKER_URL`, `MATTYFM_PI_URL` (`http://<pi-ip>:8042`).
- `PI_SSH_PUBKEY="ssh-ed25519 …"`, `WIFI_SSID`, `WIFI_PSK` — for the Pi's first boot.
- Optional: `MATTYFM_STATION_NAME` (default WORR), `MATTYFM_VOICE=aura` (the free backup voice), `MATTYFM_RATE` (44100).

## 2. Workstation
1. `python3 -m venv .venv && .venv/bin/pip install -e 'studio[dev]'`
2. Firewall: `sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family="ipv4" source address="192.168.86.0/24" port port="8040" protocol="tcp" accept' && sudo firewall-cmd --reload`
3. Units: `for u in files studio listen; do ln -sf ~/dev/mattyfm/systemd/mattyfm-$u.service ~/.config/systemd/user/; done; systemctl --user daemon-reload`,
   then `loginctl enable-linger $USER` so they come back after a power cut without a login.
4. Assets and cache: `.venv/bin/python tools/make_assets.py`, then `.venv/bin/python tools/precache.py tools/precache.txt`
   (downloads the songs you expect, ahead of time).

## 3. Worker (fm.willms.co)
```
cd worker && npm install && npx wrangler login
npx wrangler deploy
bash -c 'set -a; . ~/.config/mattyfm/env; for k in PARTY_CODE ADMIN_TOKEN STUDIO_SECRET DEVICE_SECRET; do printf %s "${!k}" | npx wrangler secret put $k; done'
```
Run the secret loop under **bash** — zsh has no `${!k}` and silently uploads empty secrets.
New DNS may take a while to resolve at home: the Pi-hole caches "no such name" (`pihole reloaddns` clears it).

## 4. Pi (receiver)
1. Flash Raspberry Pi OS Lite 32-bit: `xzcat raspios-lite-armhf.img.xz | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress`.
2. `.venv/bin/python tools/pi_firstboot.py /dev/sdX1` (hostname mattyfm, user matt, key, wifi).
3. `~/.ssh/config.d/mattyfm.conf` → `HostName <pi ip>`, `IdentityFile ~/.ssh/id_ed25519_mattyfm` (the main config includes `config.d/*.conf` only).
4. `scp -r pi mattyfm: && ssh mattyfm 'sudo bash pi/setup.sh http://<workstation-ip>:8040 <PI_TOKEN> && sudo reboot'`
5. Router: DHCP reservations for the workstation and the Pi (ethernet `b8:27:eb:f6:be:b2`, Edimax wifi `74:da:38:89:dc:5f`).

## 5. Print
`.venv/bin/python tools/qr_card.py` → `media/qr-card.html`, print 6–8.
