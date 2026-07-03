# tmux + The Ark

## The rule

| Run in **systemd** | Run in **tmux** |
|--------------------|-----------------|
| ark-hub, ark-probe | opencode TUI |
| llama-panel, docker | codex CLI |
| sunshine, syncthing | dev servers, goal tests you're watching |
| anything "always on" | anything you **detach and resume** |

**The Ark hub never lives in tmux.** Long-lived agents and interactive work do.

---

## Session naming (use on every machine)

```
agents/opencode     — opencode TUI (goal tests, decomp, etc.)
agents/codex        — codex CLI on MacBook Air
dev/ark             — building The Ark itself
watch/<test-id>     — optional: tail logs while a goal test runs
```

List: `tmux ls`  
Attach: `tmux attach -t agents/opencode`  
New: `tmux new -s agents/opencode`

---

## Cross-machine workflow (all Linux + Tailscale)

**Start on laptop:**
```bash
ssh tony@tony-hp435g8 -t 'tmux new -A -s agents/opencode'
cd ~/Tests/2026-07-03_qwen36-35b_minecraft-python-goal && opencode
# Ctrl-b d to detach
```

**Resume from MacBook Air:**
```bash
ssh tony@tony-hp435g8 -t 'tmux attach -t agents/opencode'
```

**Resume from phone/Termux** (same idea):
```bash
tailscale ssh tony@tony-hp435g8 -- tmux attach -t agents/opencode
```

**Gaming PC** — mostly systemd; tmux only for debugging llama/docker:
```bash
tmux new -s dev/llama-debug
```

---

## Shared config

Copy once per machine (or symlink):

```bash
ln -sf ~/ark/config/tmux.conf ~/.tmux.conf
# or clone path: ~/Projects/ark/config/tmux.conf
```

Reload: `tmux source-file ~/.tmux.conf`

---

## Helper script

From any machine with SSH keys + Tailscale:

```bash
~/ark/scripts/ark-attach laptop agents/opencode
~/ark/scripts/ark-attach gaming dev/llama-debug
```

---

## Future: Ark dashboard integration

`ark-probe` will report `tmux list-sessions` so the hub shows:

```
Laptop: agents/opencode (attached) · agents/codex (detached)
```

Click → copies `ssh … tmux attach -t …` to clipboard.
