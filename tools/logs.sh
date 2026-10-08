#!/usr/bin/env bash
# Everything MattyFM logged since a time, merged in time order, for diagnosis.
# Usage: tools/logs.sh "22:30"   (or "-15 min"; default: last 15 minutes)
since="${1:--15 min}"
{
  journalctl --user -u mattyfm-studio -u mattyfm-station -u mattyfm-icecast --since "$since" --no-pager -o short-iso-precise \
    | grep -vE 'HTTP Request:|Content type is|Using: |New client|Client 127.0.0.1 disconnected' | sed 's/^/[ws] /'
  ssh -o ConnectTimeout=5 mattyfm "journalctl -u mattyfm-pi -u mattyfm-watchdog --since '$since' --no-pager -o short-iso-precise" 2>&1 \
    | grep -vE 'mattyfm-watchdog.service' | sed 's/^/[pi] /'
} | sort -k2,2
