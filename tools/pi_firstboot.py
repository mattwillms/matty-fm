"""Write cloud-init first-boot files onto a freshly flashed Raspberry Pi OS card.

Usage: .venv/bin/python tools/pi_firstboot.py /dev/sdf1
Reads PI_SSH_PUBKEY, WIFI_SSID, WIFI_PSK from ~/.config/mattyfm/env.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
from mattyfm.config import load_env  # noqa: E402


def main(part: str) -> None:
    load_env()
    key, ssid, psk = (os.environ[k] for k in ("PI_SSH_PUBKEY", "WIFI_SSID", "WIFI_PSK"))
    out = subprocess.run(["udisksctl", "mount", "-b", part], capture_output=True, text=True, check=True).stdout
    mount = Path(re.search(r" at (/\S+)", out).group(1).rstrip("."))
    if not (mount / "config.txt").exists():
        sys.exit(f"{mount} does not look like a Raspberry Pi boot partition")
    (mount / "user-data").write_text(f"""#cloud-config
hostname: mattyfm
manage_etc_hosts: true
timezone: America/Chicago
enable_ssh: true
users:
  - name: matt
    groups: users,adm,dialout,audio,netdev,video,plugdev,sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - {key}
""")
    (mount / "network-config").write_text(f"""network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      optional: true
  wifis:
    renderer: NetworkManager
    wlan0:
      dhcp4: true
      regulatory-domain: "US"
      access-points:
        {json.dumps(ssid)}:
          password: {json.dumps(psk)}
      optional: true
""")
    subprocess.run(["sync"], check=True)
    subprocess.run(["udisksctl", "unmount", "-b", part], check=True)
    print(f"Wrote user-data and network-config to {part}. Card is safe to remove.")


if __name__ == "__main__":
    main(sys.argv[1])
