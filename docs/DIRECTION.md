# New Ark Direction

Ark is a private-network controller for real CLI agents.

## Shape

- One web hub.
- Many SSH devices.
- tmux sessions own persistence.
- CLI tools own behavior.
- Ark owns discovery, launch, reattach, parsing, and a phone-friendly UI.

## V1 Rules

- SSH is required for remote devices.
- tmux is preferred. Without tmux, a later degraded mode can support one live
  shell, but no persistence.
- Terminal sessions run on the selected device. Codex also runs directly on
  the selected device in the selected directory, so repository work happens
  where the repository lives. Remote OpenCode and Claude sessions currently
  use the hub as central runners.
- Codex is first. OpenCode, Claude, and terminal sessions share the same tmux
  backend.
- No per-device Ark daemon.
- No hard-coded gaming PC, Air, HP, or Tailscale-only assumptions.

## First Reliable Flow

1. Select a device.
2. Browse to a repo path on that device.
3. Pick a runtime: terminal, Codex, OpenCode, or Claude.
4. Ark creates or attaches a tmux session.
5. Ark captures the pane and renders parsed or raw output in the web UI.
6. If the parser is wrong, switch to the raw terminal view.

## Recovery

Recovery order:

1. Reattach the tmux session if it still exists.
2. If tmux is gone and a Codex session id is known, start a new tmux session and
   run `codex resume <session-id>`.
3. If only a local repo/runtime is known, offer `codex resume --last` from that
   repo. A central remote runner must show the all-session picker instead of
   guessing from the hub's working directory.
4. Fall back to raw terminal.

## Deferred

- Direct remote runners for every supported tool profile, including portable
  profile/auth provisioning where that is intentionally configured.
- Native app.
- Windows native support beyond SSH/WSL.
- Background push when Ark is fully closed.
- Structured control events from providers that expose them; terminal fixtures
  remain the fallback.
