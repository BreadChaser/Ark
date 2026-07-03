# Deploy The Ark hub on the gaming PC (tony-gaming)

## Prerequisites

- Tailscale connected
- Docker + llama-ornith running
- `git`, `python3`, `python3-venv`, `tmux` (optional, for dev)

## Install

```bash
git clone git@github.com:BreadChaser/Ark.git ~/ark
cd ~/ark/hub
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# systemd user service
mkdir -p ~/.config/systemd/user
cp ~/ark/hub/systemd/ark-hub.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ark-hub.service
loginctl enable-linger "$USER"   # if not already
```

## Access

- http://tony-gaming:8787
- http://100.114.148.108:8787

Tailscale only — do not port-forward to the public internet.

## tmux (optional, same on all machines)

```bash
ln -sf ~/ark/config/tmux.conf ~/.tmux.conf
tmux new -s dev/ark    # only for interactive dev/debug
```

Hub runs under **systemd**, not tmux.

## Update

```bash
cd ~/ark && git pull
systemctl --user restart ark-hub
```
