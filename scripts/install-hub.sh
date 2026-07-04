#!/usr/bin/env bash
# Install The Ark hub on this machine (run on tony-gaming).
# No sudo required — uses uv for the Python venv.
set -euo pipefail

ARK_DIR="${ARK_DIR:-$HOME/Development/ark}"
REPO="${ARK_REPO:-https://github.com/BreadChaser/Ark.git}"

if [[ ! -d "$ARK_DIR/.git" ]]; then
  git clone "$REPO" "$ARK_DIR"
else
  git -C "$ARK_DIR" pull --ff-only
fi

export PATH="$HOME/.local/bin:$PATH"

if ! command -v uv &>/dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

cd "$ARK_DIR/hub"
rm -rf .venv
uv venv .venv
uv pip install -r requirements.txt

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ark-hub.service <<EOF
[Unit]
Description=The Ark mission control hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME/Development/ark/hub
Environment=ARK_IS_HUB_HOST=1
Environment=ARK_LLAMA_URL=http://127.0.0.1:8080
ExecStart=$HOME/Development/ark/hub/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8787
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ark-hub.service
loginctl enable-linger "$USER" 2>/dev/null || true
ln -sfn "$ARK_DIR/config/tmux.conf" "$HOME/.tmux.conf" 2>/dev/null || true

sleep 2
systemctl --user is-active ark-hub.service
echo "Ark hub: http://$(hostname):8787"
