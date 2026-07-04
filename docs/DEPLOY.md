# Deploy The Ark hub on the gaming PC (tony-gaming)

## Prerequisites

- Tailscale connected
- Docker + llama-ornith running
- `git`, `curl` — **no sudo required** (install script uses [uv](https://github.com/astral-sh/uv))

Optional (sudo, cleaner system packages):

```bash
sudo apt install -y tmux python3-venv
```

## Install

```bash
git clone git@github.com:BreadChaser/Ark.git ~/Development/ark
cd ~/Development/ark/hub
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# systemd user service
mkdir -p ~/.config/systemd/user
cp ~/Development/ark/hub/systemd/ark-hub.service ~/.config/systemd/user/
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
ln -sf ~/Development/ark/config/tmux.conf ~/.tmux.conf
tmux new -s dev/ark    # only for interactive dev/debug
```

Hub runs under **systemd**, not tmux.

## Update

```bash
cd ~/Development/ark && git pull
systemctl --user restart ark-hub
```
