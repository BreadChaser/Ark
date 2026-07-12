# Ark Product Plan

Ark is a local/Tailscale web app for owning terminal and AI coding sessions across machines.

## Core Product Goal

Ark is the central orchestrator. It runs as one simple app, connects to devices over SSH/Tailscale, owns tmux sessions, stores readable session history, and presents first-class terminal and chat interfaces.

Ark is not a tmux screenshot viewer. tmux is transport/persistence. The UI should feel like an app.

## Locked Decisions

- Access is Tailscale/local-network only for now. No login screen yet.
- Ark runs centrally; remote devices should not need Ark installed.
- Remote devices are controlled through SSH and tmux.
- Remote repo access stays SSH/tmux-only for v1. Do not sync or mount repos.
- Long term, remote devices should not need Codex installed either.
- Ark should own Codex/Claude/OpenCode sessions and route them through configured tool/profile runners.
- New remote Codex sessions run directly on the selected machine and selected
  repository path. They should not need to reason about an extra SSH hop.
- New sessions default to the last active session on reload.
- Sidebar shows machines only, each with a dropdown of active sessions.
- Offline machines go into a collapsible offline section.
- Project browsing/tool selection appears only when starting a session.
- Terminal sessions use a first-class terminal UI.
- Chat tools use a clean chat UI and hide CLI junk by default.
- Raw tmux/debug output remains available as a fallback only.
- Session info appears cleanly at the top of the active session.
- Settings stay small and practical.
- Themes are supported structurally, but not the main focus.
- Mobile phone usage away from home is a primary goal, not an afterthought.
- Desktop and mobile screenshots are mandatory before claiming UI quality.

## Storage Direction

Use readable local files first, not an opaque database.

YAML is approved for human-readable config files.

Suggested layout:

```text
~/.local/share/ark/
  config.yml
  devices.yml
  profiles.yml
  sessions/
    <session-id>/
      session.yml
      messages.jsonl
      terminal.log
      attachments/
  uploads/
```

Session storage goals:

- Ark-owned sessions should preserve full scrollback from the start.
- Adopted tmux sessions should import full available scrollback once, then log from that point forward.
- Chat history should be stored as clean messages, not rebuilt only from tmux scrollback.
- Terminal output should be logged separately for full fidelity.
- Attachments are copied into Ark-managed storage before being sent.

## Terminal Direction

Use xterm.js-style terminal UI with a backend PTY path where needed.

- First target: local Ark-owned tmux sessions.
- Then make remote SSH/tmux sessions match the same behavior.
- Keep tmux as the persistence/session layer.
- Avoid making the terminal depend on fragile screenshot polling long term.

Approved dependencies if needed:

- `@xterm/xterm`
- `@xterm/addon-fit`
- `node-pty`

## Chat Direction

Chat tools include Codex, Claude, and OpenCode.

Chat UI requirements:

- Show only user messages, assistant responses, and minimal system status.
- Hide CLI decoration/junk by default.
- Keep Raw debug available.
- Store clean chat history in readable files.
- Composer sends on Enter.
- Shift+Enter should be reserved for multiline input.
- Message UI stays minimal and polished.
- Attachments can include clipboard contents or files.
- Multiple attachments can be queued and sent with one message.
- Attachments should not auto-send when pasted; they send with the next user message.
- Attachments are sent as file paths first.

## Tool Profiles And Routing

Ark should support multiple tool profiles/accounts.

Codex accounts are profiles over one Codex install. Each profile may set its own `CODEX_HOME`, for example:

```yaml
- id: codex-tony-pro
  label: Tony Pro
  tool: codex
  command: /home/tony/.local/npm/bin/codex --no-alt-screen
  env:
    CODEX_HOME: /home/tony/.codex
  enabled: true
```

Portable account homes should live under `~/.local/share/ark/codex-accounts/` when they are Ark-owned. Do not sync raw auth folders between random machines unless export/import encryption is intentionally built.

Accounts should be easy to add/remove from the GUI. Removing an account from Ark removes the profile entry, not the auth folder, unless a dangerous delete-files flow is explicitly built later.

Login should happen through Ark too: the GUI opens an Ark-owned terminal session running `codex login` with that account's `CODEX_HOME`, so accounts feel like they live in the app instead of in host shell setup.

The account list should show non-secret auth state, especially the signed-in email or a clear "Needs login" state.

API keys are separate from Codex login accounts. Ark stores them in app-owned `secrets.yml` with masked GUI display, and profiles may reference them through `env_from_secrets` so raw keys are only injected at launch time.

Examples:

- `personal`
- `work`
- `high-limit`
- `cheap`

Initial routing goal:

- Choose available profiles first.
- Availability-based routing is preferred over usage-cost optimization for v1.
- Multiple concurrent sessions may use the same Codex CLI install/profile.
- Profile availability should eventually consider configured status, executable presence, authentication, start success, and obvious rate-limit/account failures.
- Repo rules and deeper usage balancing can come later.

## Session Ownership

Ark should create its own sessions and adopt existing tmux sessions as it sees them.

- Ark-owned sessions are first-class and should get full logs/history from the start.
- Adopted sessions should import available tmux scrollback, then continue under Ark management.
- Attachments should be copied into Ark-managed storage and sent as file paths first.
- Do not sync or mount repos for v1. Work through SSH/tmux where the repo already lives.

## Latest Confirmed Implementation Choices

- Add the approved terminal dependencies.
- Codex runs directly on the selected device; terminal and Codex tmux state
  therefore live alongside the selected repository.
- Remote OpenCode and Claude remain central-runner sessions until direct
  profile provisioning is intentionally implemented.
- A chat send exits tmux copy mode before it sends Enter or queues with Tab.
- A single Codex CLI install/profile can run many concurrent sessions.
- Ark creates its own sessions and adopts existing tmux sessions as they appear.
- Attachments use paths first.
- Remote work stays over SSH/tmux with no syncing layer.

## Deployment Goal

Ark should stay simple to run.

- Prefer a simple app command over complex deployment.
- Keep `npm start` or equivalent working.
- A service installer can come later, but should not be required for development.

## UI Quality Bar

Use T3-style polish as inspiration:

- Intentional layout.
- Clean spacing.
- Clear hierarchy.
- Minimal but useful controls.
- Mobile-first usability.
- No nested-box mess.
- No claims of UI quality without screenshot proof.

Required screenshot set for UI work:

- Desktop: machine/session sidebar.
- Desktop: terminal session.
- Desktop: chat session.
- Desktop: add-session picker.
- Desktop: settings.
- Mobile: sidebar/session selection.
- Mobile: terminal session.
- Mobile: chat session.
- Mobile: composer with attachments.
