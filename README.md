# ⚓ The Ark

A Tailscale-only mission control dashboard for your homelab — **all Linux**: gaming PC, laptop, MacBook Air (Linux), llama models, opencode/Codex sessions, and goal tests. One web UI hosted on the gaming PC.

## Docs

- **[Master plan](docs/PLAN.md)** — architecture, phases, UI mockup, deployment
- **[Deploy hub](docs/DEPLOY.md)** — gaming PC install
- **[tmux workflow](docs/TMUX.md)** — when to use tmux vs systemd

## tmux vs systemd

| systemd | tmux |
|---------|------|
| ark-hub, llama, probes | opencode, codex CLI |
| always-on services | detach/resume from any machine |

```bash
~/Development/ark/scripts/ark-attach laptop agents/opencode
```

## Quick summary

| Piece | Where | Port |
|-------|-------|------|
| **ark-hub** | Gaming PC (`tony-gaming`) | 8787 |
| **ark-probe** | Each Linux machine (same unit file) | 9100 |

**Access:** `http://tony-gaming:8787` (Tailscale only)

## Status

Phase 0 in progress — hub code on `main`, deploy to gaming PC with `scripts/install-hub.sh`.
