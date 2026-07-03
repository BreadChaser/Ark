#!/usr/bin/env bash
# Install shared tmux config on any Ark fleet machine.
set -euo pipefail
ARK_DIR="${ARK_DIR:-$HOME/ark}"
# fallback: dev clone on laptop
if [[ ! -f "$ARK_DIR/config/tmux.conf" && -f "$HOME/Projects/ark/config/tmux.conf" ]]; then
  ARK_DIR="$HOME/Projects/ark"
fi
CONF="$ARK_DIR/config/tmux.conf"
if [[ ! -f "$CONF" ]]; then
  echo "missing $CONF — clone Ark first" >&2
  exit 1
fi
ln -sfn "$CONF" "$HOME/.tmux.conf"
echo "linked ~/.tmux.conf -> $CONF"
tmux -V 2>/dev/null || echo "install tmux: sudo apt install tmux"
