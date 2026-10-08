#!/bin/sh
# Restart the receiver if the USB card's stream is not RUNNING or its hardware pointer stopped moving.
. /etc/mattyfm.conf
f="/proc/asound/$CARD/pcm0p/sub0/status"
state=$(awk '/^state:/ {print $2}' "$f" 2>/dev/null)
hw=$(awk '/^hw_ptr/ {print $3}' "$f" 2>/dev/null)
last=$(cat /run/mattyfm-hwptr 2>/dev/null)
echo "$hw" > /run/mattyfm-hwptr
if [ "$state" != "RUNNING" ] || [ "$hw" = "$last" ]; then
  logger -t mattyfm-watchdog "state=$state hw=$hw last=$last: restarting receiver"
  systemctl restart mattyfm-pi
fi
