# ARK architecture

## Runtime model

```text
browser
  -> ARK HTTP/SSE hub
  -> SSH (for remote devices)
  -> tmux session
  -> terminal or coding-agent CLI
```

ARK is a single Node service. It does not install an ARK daemon on managed
machines. SSH and tmux are the remote execution and persistence layers.

## Device and runner ownership

- `device_id` is the machine/repository the user selected.
- `tmux_device_id` is where the tmux server actually owns the session.
- `runner_device_id` is where the CLI executable runs.
- New terminal and Codex sessions use the selected device for all three.
- Existing central-runner sessions retain their recorded ownership so they can
  be recovered without silently moving work between machines.

Tailscale and SSH-config discoveries are merged when they describe the same
machine. A reachable machine without tmux remains visible as unavailable for
session creation rather than being presented as offline.

## Session lifecycle

1. The browser selects a device, directory, tool, and optional profile.
2. ARK verifies the tool on its runner device and creates a named tmux session.
3. ARK records readable session metadata and starts a terminal log.
4. The browser uses SSE for parsed chat/session state and, in terminal view,
   a PTY-backed tmux attachment.
5. If tmux survives, ARK reattaches. If tmux is gone and a Codex session ID is
   known, ARK can resume that exact conversation.

ARK-owned state is append-oriented: clean chat messages are separate from raw
terminal logs. Codex chat prefers structured rollout JSONL, including remote
transcripts mirrored over SSH, and falls back to terminal parsing only when no
structured transcript is available.

## Input and terminal behavior

The terminal is tmux, not a browser-owned scrollback buffer. Mouse-wheel
scrolling enters tmux copy mode. Before ARK sends chat text or a control key it
exits copy mode so keys reach the CLI pane.

Codex changes its input behavior while an agent is working. ARK sends:

- `Enter` to a ready Codex session.
- `Tab` to a working Codex session, which queues the follow-up.

The chat UI may show a queued message before Codex starts its next turn; that
is intentional. A queued status is not a delivery failure.

## Security boundary

ARK is designed for private LAN/Tailscale exposure. It has no application
login layer. SSH keys, Tailscale ACLs, host firewalls, and file permissions are
the security boundary. ARK never stores private SSH keys and keeps secret
values in a mode-600 `secrets.yml` file.
