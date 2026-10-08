#!/usr/bin/env bash
# One-shot OrrFM console setup, run ON the Pi:
#   sudo bash setup.sh http://<workstation-ip>:8040 <PI_TOKEN>
set -euo pipefail
files="$1"
token="$2"
here="$(cd "$(dirname "$0")" && pwd)"
apt-get install -y -q mpg123 alsa-utils python3

card=$(awk -F'[][]' '/USB-Audio/ {gsub(/ /,"",$2); print $2; exit}' /proc/asound/cards)
[ -n "$card" ] || { echo "No USB audio card (cat /proc/asound/cards)"; exit 1; }
[ "$card" = "X" ] || sed -i "s/CARD=X/CARD=$card/; s/card X/card $card/g" "$here/asound.conf"
cat > /etc/mattyfm.conf <<CONF
CARD=$card
FILES_URL=$files
TOKEN=$token
PORT=8042
SOMA_URLS="https://ice6.somafm.com/seventies-128-mp3 https://ice2.somafm.com/seventies-128-mp3"
CONF
chmod 600 /etc/mattyfm.conf
install -m 644 "$here/asound.conf" /etc/asound.conf

# Onboard analog audio off so only the USB card exists.
cfg=/boot/firmware/config.txt
sed -i 's/^dtparam=audio=on/dtparam=audio=off/' "$cfg"
grep -q '^dtparam=audio=off' "$cfg" || echo 'dtparam=audio=off' >> "$cfg"

# Wifi power saving off (a common cause of dropouts on USB dongles).
mkdir -p /etc/NetworkManager/conf.d
printf '[connection]\nwifi.powersave = 2\n' > /etc/NetworkManager/conf.d/mattyfm-powersave.conf

# Hardware volume to 100%; the PA sets the level.
amixer -q -c "$card" sset PCM 100% unmute || true
alsactl store || true

install -m 755 "$here/console.py" /usr/local/bin/mattyfm-pi
install -m 755 "$here/mattyfm-watchdog.sh" /usr/local/bin/mattyfm-watchdog
install -m 644 "$here"/mattyfm-pi.service "$here"/mattyfm-watchdog.service "$here"/mattyfm-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mattyfm-pi mattyfm-watchdog.timer
systemctl restart mattyfm-pi
echo "card=$card files=$files — console restarted"
