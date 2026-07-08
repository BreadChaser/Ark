# Ark

Ark is a web hub for running coding agents over SSH.

The useful primitive is simple:

```text
browser -> Ark hub -> ssh -> tmux -> codex/opencode/claude/shell
```

The hub does not require an agent daemon on every machine. A managed machine
needs SSH. If it also has tmux, Ark can detach and recover sessions.

## Goals

- Web-first controller for private machines.
- Device-first UI: device, then repo, then sessions.
- Real CLI agents in tmux, not vendor app-server bridges.
- Codex first, with OpenCode, Claude, and raw shells using the same path.
- Raw terminal fallback whenever the parsed chat UI is not enough.

## Run

```bash
npm start
```

Open `http://localhost:4873`.

No package install is required for the current slice. The server uses Node's
built-in HTTP and child process APIs.

## Device Discovery

Ark always includes the hub machine as `local`.

It also reads:

- `~/.ssh/config` host aliases
- `tailscale status --json`, when Tailscale is installed

No private keys are stored in Ark. SSH authentication stays in your normal SSH
agent/config.

## V1

This branch is the V1 rewrite base. It can:

- list discovered devices
- browse directories on each device
- list tmux sessions on a selected device
- start terminal/Codex/OpenCode/Claude sessions in tmux
- attach existing tmux sessions
- capture tmux output as parsed lines or raw terminal text
- send input or Ctrl-C
- restart stored sessions
- resume the last Codex session for a repo when tmux is gone
- forget stored sessions or kill tmux with confirmation
- switch between light, dark, and Ark amber themes

Parsing starts intentionally small. Ark strips ANSI and separates prompt lines
from output lines. Rich Codex/OpenCode controls come after the tmux path stays
boring and reliable.
