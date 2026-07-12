# ARK operations

## Install and run

Requirements: Node 20+, npm, Git, tmux, SSH, and the agent CLIs used by the
profiles. Codex also needs bubblewrap for its preferred sandbox setup.

```bash
npm ci
npm run check
npm run service:install
loginctl enable-linger "$USER"
```

The user service is `ark.service`. Check it with:

```bash
systemctl --user status ark
curl -fsS http://127.0.0.1:4873/health
```

Use `npm run service:restart` after source changes. Restarting ARK does not
kill tmux sessions because the unit uses `KillMode=process`.

## Access and network exposure

Keep port 4873 private. Permit it only from the local LAN and Tailscale; do
not publish it through a public reverse proxy. ARK can bind to all interfaces
only when the host firewall provides that boundary.

Use SSH keys for the ARK user. A password is optional and is only needed for a
local VM-console login, not for normal SSH administration.

The hub also needs an outbound key for every remote device it manages. The
current hub uses `~/.ssh/ark_hub_ed25519`; its public key is authorized for
the laptop and the SSH config maps the laptop's Tailscale address to that key.
Back up this private key with the VM's protected host configuration, never in
the repository or ARK application state.

## State and backups

ARK state is under `~/.local/share/ark/`:

```text
config.yml       settings and tool commands
devices.yml      discovered device inventory
profiles.yml     non-secret profile definitions
secrets.yml      mode-600 secret values
sessions.json    session index
sessions/        session metadata, messages, terminal logs, attachments
uploads/         browser uploads
transcripts/     local mirrors of remote Codex rollout tails
```

Codex history remains under `~/.codex/`. Back up both directories together,
preserving ownership and modes. Do not copy unrelated scratch files merely
because they share the ARK data root.

## Recovery and diagnosis

1. Check `/health` and `systemctl --user status ark`.
2. Verify the selected device is online in Tailscale and SSH works from the
   hub as the configured user.
3. Open Raw/Terminal when a parsed chat view appears wrong.
4. If scrolling was used, return from tmux copy mode before testing CLI input;
   ARK does this automatically for chat sends.
5. Use Resume only for a stopped tmux session. A live session should be
   reattached, not restarted.

Run `npm run check` for source validation and `npm run gui-smoke` for an
isolated browser smoke suite. The latter uses temporary ARK state and cleans
up its own disposable sessions.
