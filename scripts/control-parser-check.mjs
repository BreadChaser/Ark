import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentStateFromScreen, codexStateFromScreen, parseAgentControls } from "../lib/control-parser.mjs";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/controls");
const cases = {
  "status.txt": { kind: "status", state: "ready", fields: ["Model", "Directory", "Permissions", "Context window"] },
  "approval.txt": { kind: "approval", state: "needs_input", choices: 3, labels: ["Yes, proceed", "Yes, remember", "No"] },
  "approval-command-numbers.txt": { kind: "approval", state: "needs_input", choices: 3, labels: ["Yes, proceed", "Yes, remember", "No"] },
  "stale-status-approval.txt": { kind: "approval", state: "needs_input", choices: 3 },
  "hook-update.txt": { kind: "input", state: "needs_input", choices: 2 },
  "safety-checks.txt": { kind: "input", state: "needs_input", choices: 2, labels: ["Keep waiting", "Learn more"] },
  "codex-update.txt": { kind: "input", state: "needs_input", choices: 3, labels: ["Update now (runs the official installer)", "Skip", "Skip until next version"] },
  "goal-resume.txt": { kind: "input", state: "needs_input", choices: 2, labels: ["Resume goal", "Leave paused"] },
  "ordinary.txt": { kind: null, state: "ready" },
  "diff-control.txt": { kind: null, state: "ready" },
  "model.txt": { kind: "model", state: "needs_input", choices: 7, labels: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"], selected: "2" },
  "model-echoed-command.txt": { kind: "model", state: "needs_input", choices: 4, labels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] },
  "reasoning.txt": { kind: "reasoning", state: "needs_input", choices: 6, labels: ["Low", "Medium", "High", "Extra high", "Max", "Ultra"], selected: "3" },
  "permissions.txt": { kind: "permissions", state: "needs_input", choices: 3, labels: ["Ask for approval", "Approve for me", "Full Access"] },
  "permissions-stale.txt": { kind: null, state: "ready" },
};

for (const [name, expected] of Object.entries(cases)) {
  const text = await readFile(path.join(fixtures, name), "utf8");
  const controls = parseAgentControls("codex", text);
  assert.equal(controls[0]?.kind || null, expected.kind, `${name} control kind`);
  assert.equal(agentStateFromScreen({ tool: "codex" }, text, controls), expected.state, `${name} agent state`);
  if (expected.choices) assert.equal(controls[0].choices.length, expected.choices, `${name} choices`);
  if (expected.labels) assert.deepEqual(controls[0].choices.map((choice) => choice.label), expected.labels, `${name} labels`);
  if (expected.selected) assert.equal(controls[0].choices.find((choice) => choice.selected)?.value, expected.selected, `${name} selected choice`);
  if (expected.kind === "model") {
    assert.doesNotMatch(controls[0].choices[0].description, /gpt-5\.4|\\n2\./, `${name} first description`);
  }
  if (expected.fields) assert.deepEqual(controls[0].fields.map((field) => field.label), expected.fields, `${name} fields`);
  if (name === "approval.txt") assert.match(controls[0].prompt, /Command: npm run check\nReason: Verify Ark/, `${name} request context`);
  if (name === "codex-update.txt") assert.match(controls[0].prompt, /Update available!/, `${name} prompt`);
}

assert.deepEqual(
  codexStateFromScreen("gpt-5.6-sol xhigh fast · ~/Development/ark"),
  { model: "gpt-5.6-sol", reasoning_effort: "xhigh", service_tier: "priority", source: "terminal-screen" },
);
assert.equal(codexStateFromScreen("gpt-5.6-luna ultra fast · /tmp")?.reasoning_effort, "ultra");
const staleWorking = ["• Working (2s • esc to interrupt)", ...Array.from({ length: 24 }, () => "Earlier completed output"), "› Ready for the next task"].join("\n");
assert.equal(agentStateFromScreen({ tool: "codex" }, staleWorking), "ready", "stale working scrollback kept a completed session active");
