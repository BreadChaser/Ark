# The Ark — Master Plan

**One Tailscale dashboard for every machine, service, and agent you run.**

Hosted on the **gaming PC** (`tony-gaming`). Reachable from laptop, MacBook Air, and phone via Tailscale only.

**All machines run Linux** — same paths, same systemd user services, one probe binary everywhere.

---

## Vision

You have three Linux boxes and a mess of UIs:

| Device | Role | Tools today |
|--------|------|-------------|
| **Gaming PC** | Always-on GPU box | llama-server, Llama Panel, Docker, Sunshine |
| **Laptop** (HP ProBook) | Primary dev | opencode, Cursor, Codex, Syncthing |
| **MacBook Air** (Linux) | Secondary / portable | Codex CLI (sub-account), opencode |

**The Ark** is not a replacement for Cursor, Codex, or opencode. It is:

1. **Home** — one pretty page you bookmark on every device
2. **Status board** — what's running, what's idle, what's broken
3. **Launch pad** — open the right tool on the right machine in one click
4. **Resume helper** — see active opencode/Codex sessions and jump back in

---

## Architecture

```
                    Tailscale mesh
    ┌──────────────────────────────────────────────────────┐
    │                                                      │
    │   Laptop          MacBook Air         Gaming PC      │
    │   ┌─────────┐     ┌─────────┐     ┌─────────────┐  │
    │   │ ark-    │     │ ark-    │     │  THE ARK    │  │
    │   │ probe   │     │ probe   │────▶│  (hub)      │  │
    │   │ :9100   │     │ :9100   │     │  :8787      │  │
    │   └─────────┘     └─────────┘     └──────┬──────┘  │
    │        │               │                  │         │
    │   opencode.db      codex sessions    llama/docker  │
    │   local projects   local projects   panel :8090   │
    └──────────────────────────────────────────────────────┘
```

### Components

| Component | Runs on | Purpose |
|-----------|---------|---------|
| **ark-hub** | Gaming PC | Web UI + API + aggregator |
| **ark-probe** | Each Linux device | Same binary + systemd user unit on all three |
| **ark-config** | Gaming PC | `config.yaml` — hosts, services, links |

### Data flow

1. **ark-probe** on each machine exposes `GET /api/v1/report` (localhost + Tailscale bind).
2. **ark-hub** polls probes every 30s (or probes push — start with poll).
3. Hub also scrapes **local** gaming-PC services (nvidia-smi, docker, llama health).
4. Browser loads hub → single SPA with cards per device + service tiles.

### Security model

- **No public internet exposure.** Bind hub to Tailscale IP or `0.0.0.0` with Tailscale ACL restricting port 8787 to your user tag.
- Optional: simple token in probe → hub requests (`ARK_PROBE_TOKEN` env).
- Read-only probes by default — no remote command execution in v1.

---

## Tech stack (recommended)

| Layer | Choice | Why |
|-------|--------|-----|
| Hub API | **Python 3.12 + FastAPI** | Matches your stack, fast to iterate |
| Hub UI | **HTMX + Alpine.js** or **vanilla JS** | Pretty without a React build chain; good enough for v1 |
| Styling | **Tailwind** (CDN or build) | Clean dashboard aesthetic |
| Probes | **Python** (shared `ark_common` package) | Same sqlite parsers as `watch_goal.py` |
| Deploy | **systemd user service** on gaming PC | Same pattern as llama-panel |
| Config | **YAML** | Human-editable service registry |

Avoid Electron, avoid custom auth in v1 — Tailscale *is* the VPN/auth layer.

---

## UI layout (target)

```
╔══════════════════════════════════════════════════════════════╗
║  ⚓ THE ARK                              tony-gaming  12:10 PM ║
╠══════════════════════════════════════════════════════════════╣
║  QUICK LAUNCH                                                ║
║  [Llama Panel] [Open WebUI] [opencode laptop] [Moonlight]    ║
╠══════════════════════════════════════════════════════════════╣
║  GAMING PC ──────────────────────────── GPU 6.2/8 GB  42%  ║
║  llama-ornith ●  Qwen3.6-35B   ~10 tok/s                     ║
║  llama-panel  ●  :8090                                       ║
╠══════════════════════════════════════════════════════════════╣
║  LAPTOP (tony-hp435g8) ────────────────────────  idle 2m    ║
║  opencode sessions:                                          ║
║    ● minecraft-python-goal   active   [resume] [folder]      ║
║    ○ halo decomp             idle 3h  [resume]               ║
║  [opencode web] [SSH]                                        ║
╠══════════════════════════════════════════════════════════════╣
║  MACBOOK AIR (linux) ──────────────────────────  offline?   ║
║  codex + opencode sessions: (probe required)                 ║
╠══════════════════════════════════════════════════════════════╣
║  GOAL TESTS / WATCHERS                                       ║
║  minecraft-python-goal  last: tool:write  in=12k out=4k      ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Service registry (`config/services.yaml`)

Central list of everything the Ark knows about:

```yaml
devices:
  gaming-pc:
    hostname: tony-gaming
    tailscale: 100.114.148.108
    probe: http://100.114.148.108:9100
    local: true

  laptop:
    hostname: tony-hp435g8
    probe: http://<laptop-tailscale>:9100

  macbook-air:
    hostname: tony-mba  # tailscale set --hostname on the Air
    probe: http://<mba-tailscale>:9100

services:
  llama-panel:
    device: gaming-pc
    url: http://100.114.148.108:8090
    icon: cpu

  llama-api:
    device: gaming-pc
    health: http://100.114.148.108:8080/health

  opencode-web-laptop:
    device: laptop
    url: http://<laptop-tailscale>:<port>  # opencode web when running
```

---

## Probe capabilities (per device)

### All devices
- Hostname, uptime, last seen
- Disk free on home partition

### Gaming PC (local + probe)
- `nvidia-smi` — VRAM, util, temp
- Docker container status (`llama-ornith`, etc.)
- `curl` llama `/v1/models` — active model, ctx
- Llama Panel settings snapshot (if API exists)

### Laptop / MacBook Air (probe — identical on both)
Same probe code, same paths (`~/.local/share/`, systemd user units):
- **opencode** — read `~/.local/share/opencode/opencode.db` (read-only):
  - sessions: id, title, directory, tokens, time_updated, idle
  - deep link: `opencode -s <id>` command text for copy
- **Codex CLI** — parse session list via `codex` CLI or `~/.codex/` (paths TBD on Air)
- Optional: syncthing status

### Goal test watcher (migrate `watch_goal.py`)
- Probe tails `~/minecraft_goal_watch.log` or reports inline
- Hub shows last snapshot per registered test in `config/tests.yaml`

---

## Phased rollout

### Phase 0 — Foundation (week 1)
**Goal:** Hub loads in browser on Tailscale; gaming PC status works.

- [ ] Repo structure (`hub/`, `probe/`, `common/`, `config/`)
- [ ] `ark-hub` FastAPI: `/`, `/api/v1/status`, `/health`
- [ ] Gaming PC local collector (GPU, docker, llama)
- [ ] Static dashboard v0 (dark theme, one card)
- [ ] systemd: `ark-hub.service` on gaming PC, port 8787
- [ ] Document Tailscale ACL / MagicDNS URL

**Done when:** `http://tony-gaming:8787` shows GPU + llama status from phone.

---

### Phase 1 — Launch pad (week 1–2)
**Goal:** Replace bookmark folder.

- [ ] `config/services.yaml` with all your links
- [ ] Quick-launch grid (Llama Panel, Moonlight, RustDesk, SSH web)
- [ ] Service health pings (green/red dot)
- [ ] Favicon + branding ("The Ark")

**Done when:** You stop using random bookmarks.

---

### Phase 2 — Laptop probe (week 2)
**Goal:** See and resume opencode sessions from any device.

- [ ] `ark-probe` package
- [ ] opencode sqlite reader (port from `watch_goal.py`)
- [ ] `ark-probe.service` on laptop
- [ ] Hub polls laptop probe; session cards with resume hints
- [ ] "Copy resume command" button

**Done when:** From the MacBook Air, you see the laptop's minecraft goal session and know if it's alive.

---

### Phase 3 — MacBook Air probe (week 3)
**Goal:** Third Linux node in the dashboard.

- [ ] Copy same `ark-probe.service` user unit to the Air (no platform fork)
- [ ] Codex CLI session discovery — inspect `~/.codex/` or `codex sessions` on Air
- [ ] Offline detection (probe stale > 5 min)
- [ ] Optional: opencode on Air if you run agents there too

**Done when:** All three Linux machines on one screen.

---

### Phase 4 — Polish & extensions (ongoing)
- [ ] Goal test registry + live log tail in UI
- [ ] Open WebUI integration (optional chat tile)
- [ ] Notifications (ntfy / Pushover when goal test stalls)
- [ ] Simple graphs (GPU history, token growth) — SQLite time series
- [ ] Mobile-friendly layout

---

## Repo structure

```
ark/
├── README.md
├── docs/
│   ├── PLAN.md              # this file
│   └── DEPLOY.md            # gaming PC install steps
├── config/
│   ├── services.yaml
│   └── tests.yaml
├── packages/
│   └── ark_common/          # shared parsers (opencode db, nvidia, docker)
├── hub/
│   ├── main.py
│   ├── collectors/
│   │   ├── gaming_pc.py
│   │   └── probe_client.py
│   ├── static/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── systemd/
│       └── ark-hub.service
└── probe/
    ├── main.py
    ├── reporters/
    │   ├── opencode.py
    │   └── codex.py
    └── systemd/
        └── ark-probe.service
```

---

## Deployment (gaming PC)

```bash
# On tony-gaming
git clone <repo> ~/Development/ark
cd ~/Development/ark/hub
python3 -m venv .venv && .venv/bin/pip install -e ../packages/ark_common -r requirements.txt
systemctl --user enable --now ark-hub.service
```

Tailscale URL: `http://tony-gaming:8787` or `http://100.114.148.108:8787`

Probes on laptop / MacBook Air: **identical install** — clone repo, `probe/`, port **9100**, `systemctl --user enable ark-probe`.

### Homogeneous Linux fleet (advantage)

Because every box is Linux:
- One `ark-probe.service` unit file — no launchd, no macOS paths
- Shared XDG paths: `~/.local/share/opencode/`, `~/.config/`
- Deploy with the same SSH + systemd playbook you already use for llama-panel
- Tailscale SSH works the same on all three (`tailscale ssh tony@tony-gaming`, etc.)

---

## Non-goals (v1)

- Replacing Cursor / Codex / opencode UIs
- Syncing opencode.db between machines (conflict nightmare)
- Public-facing deployment
- Running agents from the Ark (read-only + links only)
- Full homelab asset inventory (Proxmox, etc.) — add later as tiles

---

## Open questions (decide as we build)

1. **MacBook Air Tailscale hostname** — e.g. `tony-mba` via `tailscale set --hostname`
2. **opencode web port** — dynamic? Probe reports current port if `opencode serve` running
3. **Codex CLI session format** — inspect on Air (`~/.codex/` or CLI output); same Linux filesystem assumptions
4. **Auth layer** — Tailscale-only sufficient, or add `ARK_HUB_TOKEN` for shared household tailnet?

---

## Success criteria

The Ark is "done" for v1 when:

1. One URL on every device opens the dashboard
2. Gaming PC GPU + model status is live
3. Laptop opencode sessions visible with idle time
4. Quick-launch opens Llama Panel, opencode web, Moonlight without hunting bookmarks
5. Goal test watcher visible on dashboard

---

## Next step

**Phase 0 implementation** — scaffold hub, gaming PC collector, minimal UI, systemd unit.

Say **"build phase 0"** when ready to start coding.
