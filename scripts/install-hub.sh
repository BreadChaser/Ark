#!/usr/bin/env bash
# Install The Ark hub on this machine (run on tony-gaming).
set -euo pipefail

ARK_DIR="${ARK_DIR:-$HOME/ark}"
REPO="${ARK_REPO:-git@github.com:BreadChaser/Ark.git}"

if [[ ! -d "$ARK_DIR/.git" ]]; then
  git clone "$REPO" "$ARK_DIR"
else
  git -C "$ARK_DIR" pull --ff-only
fi

cd "$ARK_DIR/hub"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

mkdir -p ~/.config/systemd/user
cp "$ARK_DIR/hub/systemd/ark-hub.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ark-hub.service

echo "Ark hub: http://$(hostname):8787"
systemctl --user status ark-hub.service --no-pager | head -5
