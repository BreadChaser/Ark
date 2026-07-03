# ⚓ The Ark

A Tailscale-only mission control dashboard for your homelab — **all Linux**: gaming PC, laptop, MacBook Air (Linux), llama models, opencode/Codex sessions, and goal tests. One web UI hosted on the gaming PC.

## Docs

- **[Master plan](docs/PLAN.md)** — architecture, phases, UI mockup, deployment

## Quick summary

| Piece | Where | Port |
|-------|-------|------|
| **ark-hub** | Gaming PC (`tony-gaming`) | 8787 |
| **ark-probe** | Each Linux machine (same unit file) | 9100 |

**Access:** `http://tony-gaming:8787` (Tailscale only)

## Status

Planning phase — Phase 0 not started yet.
