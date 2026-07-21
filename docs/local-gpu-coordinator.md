# Shared local GPU coordinator

Ark owns the single llama.cpp slot on `tony-gaming`. Do not call the controller's
`/apply` or `/toggle` endpoints from an agent.

## Agent use

On `ark-hub`, a Codex agent can ask the recommended local model for a read-only
second opinion:

```bash
/home/tony/Development/ark/scripts/ark-opencode "review this approach"
```

It defaults to `recommended`, the controller's saved `/config.selected` model.
Use `--model active` to keep the currently warm GGUF. To request a different
model, the agent must opt into waiting:

```bash
/home/tony/Development/ark/scripts/ark-opencode --model ternary-bonsai-27b-q2-0 --wait "compare these two implementations"
```

Ark discovers every controller `/config.models` entry at request time. Its ID is
the GGUF filename without `.gguf`, lowercased with non-alphanumeric runs
changed to hyphens; colliding filenames gain a stable short hash of their
controller key. `GET /api/local-gpu` exposes the current catalog.

## Recommendation policy

`/config.selected` is Ark's durable recommendation source. It must be the
exact controller key from `/config.models`; Ark never keeps a static ranking or
hardcoded default model.

The Local_LLM maintainer decides the recommendation from current benchmark and
quality evidence, then changes the controller's normal selected model/preset
through its own model-control workflow. No Ark code change or deployment is
needed. Agents using Ark must not call the controller's `/apply` or `/toggle`
endpoints themselves.

The recommendation affects new no-argument `ark-opencode` consultations only.
It never interrupts an existing GPU lease. Use `--model active` to prefer the
currently loaded GGUF, or an explicit generated model ID with `--wait` to
request another model. Confirm the chosen recommendation in
`GET /api/local-gpu` as `recommended_model`; `loaded` remains the physical
runtime truth and can differ during a benchmark or model transition.

## Backend rules

- Lease state is persisted at `~/.local/share/ark/local-gpu.json`; it expires
  after 90 seconds without a heartbeat.
- Requests for the loaded model are serialized. A different model returns the
  choices `use active model`, `wait`, or `use hosted model` unless the caller
  explicitly sets `wait`.
- Only Ark switches a model. It polls llama.cpp `/health` and controller
  `/status.loaded` before admitting the queued job.
- Each lease gets its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
  `XDG_CACHE_HOME` under `~/.local/share/ark/local-gpu/`. Its OpenCode config
  exposes only the admitted `llamacpp/<model-id>` and sets compaction to
  `auto=true`, `prune=true`, and `reserved=4096`.
- The Models panel reads the same lease record and shows runtime loaded model,
  busy count, and queue length. Manual start/stop/switch controls are blocked
  while a lease is live.

The controller's saved `/config.selected` is not runtime truth. Use
`/status.loaded` whenever a decision depends on the physical GGUF.
