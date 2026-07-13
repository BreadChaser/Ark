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

Run `npm install` once before first launch. Ark keeps the HTTP/session layer
small, but uses xterm.js, node-pty, and YAML packages for the terminal and
readable app-owned storage.

## Device Discovery

Ark always includes the hub machine as `local`.

It also reads:

- `~/.ssh/config` host aliases
- `tailscale status --json`, when Tailscale is installed

No private keys are stored in Ark. SSH authentication stays in your normal SSH
agent/config.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) explains devices, tmux, agent runners,
  state, and the chat/terminal boundary.
- [Operations](docs/OPERATIONS.md) covers installation, systemd, access,
  backups, recovery, and troubleshooting.
- [Migration](docs/MIGRATION.md) records the current Proxmox deployment and
  cutover boundaries.
- [Direction](docs/DIRECTION.md) records product constraints and deferred work.

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
- keep stopped session cards after a reboot
- resume the exact saved Codex conversation when tmux is gone
- keep human-input prompts in a durable session inbox until they are answered
- notify supported installed browsers when a session needs input
- stream active captures and session state over shared SSE connections
- merge matching SSH and Tailscale entries into one machine with multiple routes
- forget stored sessions or kill tmux with confirmation
- switch between light, dark, and Ark amber themes

Codex messages prefer its structured rollout transcript. Interactive terminal
controls use a fixture-tested parser, with the raw terminal always available
when a tool changes its UI.

For a remote Codex session, Ark mounts the selected repository over SSHFS and
starts Codex and tmux on the hub. This keeps Codex/auth only on ARK while
`/review`, reads, and edits use the selected repository. Terminal scrolling uses tmux copy mode; a chat send
always exits copy mode first. After pasting text into Codex, Ark waits 150 ms
before sending the submit key so Codex cannot mistake it for a multiline paste.
Ready Codex receives Enter, while a currently working Codex session receives
Tab so the message is queued instead of being left in its multiline composer.
