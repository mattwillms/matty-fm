# Setup (rebuild next year)

Everything lives in this repo except secrets (`~/.config/mattyfm/env`, mode 600) and
the Cloudflare/ElevenLabs/Anthropic accounts. Values with spaces are quoted.

## 1. Keys — `~/.config/mattyfm/env`
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY` — **Starter plan or above**: library voices (Johnny Dynamite, Countdown Casey) need a paid plan.
- `PARTY_CODE`, `ADMIN_TOKEN`, `STUDIO_SECRET` — generate: `python3 -c 'import secrets;print(secrets.token_urlsafe(6))'`, `openssl rand -hex 32` ×2
- `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD` — `openssl rand -hex 16`
- `PI_SSH_PUBKEY="ssh-ed25519 …"`, `WIFI_SSID`, `WIFI_PSK`
- Optional: `MATTYFM_RATE` (default 44100)

## 2. Workstation
1. `python3 -m venv .venv && .venv/bin/pip install -e 'studio[dev]'` — Deno must be on PATH (yt-dlp needs a JS runtime for YouTube).
2. `docker pull savonet/liquidsoap:v2.4.5 libretime/icecast:2.4.4`
3. Firewall: `sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family="ipv4" source address="192.168.86.0/24" port port="8040" protocol="tcp" accept' && sudo firewall-cmd --reload`
4. Units: `for u in icecast station studio; do ln -sf ~/dev/mattyfm/systemd/mattyfm-$u.service ~/.config/systemd/user/; done; systemctl --user daemon-reload`
5. Assets and cache: `.venv/bin/python tools/make_assets.py` then `.venv/bin/python tools/precache.py tools/precache.txt` (~30 min). `media/backup/` must never be empty.

## 3. Worker (fm.willms.co)
```
cd worker && npm install && npx wrangler login
npx wrangler deploy
bash -c 'set -a; . ~/.config/mattyfm/env; for k in PARTY_CODE ADMIN_TOKEN STUDIO_SECRET; do printf %s "${!k}" | npx wrangler secret put $k; done'
```
Run the secret loop under **bash** — zsh has no `${!k}` and silently uploads empty secrets.
New DNS may take a while to resolve at home: the Pi-hole caches "no such name" (`pihole reloaddns` clears it).

## 4. Pi (receiver)
1. Flash Raspberry Pi OS Lite 32-bit: `xzcat raspios-lite-armhf.img.xz | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress`.
2. `.venv/bin/python tools/pi_firstboot.py /dev/sdX1` (hostname mattyfm, user matt, key, wifi).
3. `~/.ssh/config.d/mattyfm.conf` → `HostName <pi ip>`, `IdentityFile ~/.ssh/id_ed25519_mattyfm` (the main config includes `config.d/*.conf` only).
4. `scp -r pi mattyfm: && ssh mattyfm 'sudo bash pi/setup.sh http://<workstation-ip>:8040/radio && sudo reboot'`
5. Router: DHCP reservations for the workstation and the Pi (ethernet `b8:27:eb:f6:be:b2`, Edimax wifi `74:da:38:89:dc:5f`).

## 5. Print
`.venv/bin/python tools/qr_card.py` → `media/qr-card.html`, print 6–8.
