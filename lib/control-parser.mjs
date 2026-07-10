export function parseAgentControls(tool, text) {
  const lines = parseTerminalLines(text);
  if (tool === "codex") return parseCodexControls(text, lines);
  const cleanLines = lines.map((line) => cleanControlText(line.text)).filter(Boolean);
  const interactive = interactiveControl(cleanControlText(cleanLines.join("\n") || text), cleanLines);
  return interactive ? [interactive] : [];
}

export function agentStateFromScreen(session, text, controls = parseAgentControls(session?.tool, text)) {
  if (controls.some((control) => control.kind !== "status")) return "needs_input";
  const screen = stripAnsi(String(text || ""));
  return /(?:Working|Thinking|Reasoning)(?:\.{3}|…|\s*\()|esc to interrupt|Running\s+\w+.*hook|waiting for (?:a tool|tool output)/i.test(screen)
    ? "working"
    : "ready";
}

export function parseTerminalLines(text) {
  return stripAnsi(String(text || "")).split(/\r?\n/).filter((line) => line.trim()).slice(-160).map((line) => ({
    kind: /^[\w.@~-]+:.*[$#]\s*/.test(line) ? "prompt" : "text",
    text: line,
  }));
}

export function parseCodexControls(text, lines = parseTerminalLines(text)) {
  const cleanLines = lines.map((line) => cleanControlText(line.text)).filter(Boolean);
  const compact = cleanControlText(cleanLines.join("\n") || text);
  const lower = compact.toLowerCase();
  const reasoningIndex = lower.lastIndexOf("select reasoning level");
  const modelIndex = lower.lastIndexOf("select model and effort");
  if (reasoningIndex > modelIndex) return [reasoningControl(compact.slice(reasoningIndex))];
  if (modelIndex >= 0) return [modelControl(compact.slice(modelIndex))];
  if (/\/model\s+choose what model/i.test(compact)) return [modelControl(compact)];
  if (/\/permissions\s+choose|Ask for approval \(current\)|Approve for me/i.test(compact)) return [permissionsControl()];
  const interactive = interactiveControl(compact, cleanLines);
  if (interactive) return [interactive];
  return /Context window:|Account:|Permissions:|5h limit:/i.test(compact) ? [statusControl(cleanLines)] : [];
}

function interactiveControl(text, lines) {
  const strongPrompt = /Press enter to (?:confirm|continue|select)|esc to cancel|use (?:the )?(?:up and down )?arrow keys|Do you trust|Would you like to (?:run|allow|continue|proceed|update|install)|Do you want to (?:allow|continue|proceed|update|install)|requires? (?:your )?(?:approval|confirmation)|requested (?:your )?(?:approval|permission)/i.test(text);
  if (!strongPrompt) return null;
  const choices = dedupeChoices(numberedBlocks(text).map(({ value, block }) => genericChoice(value, block)).filter(Boolean));
  if (!choices.length) {
    const yesNo = text.match(/\[\s*([yY])(?:es)?\s*\/\s*([nN])(?:o)?\s*\]/);
    if (yesNo) choices.push(
      { value: yesNo[1].toLowerCase(), label: "Yes", description: "Confirm" },
      { value: yesNo[2].toLowerCase(), label: "No", description: "Decline" },
    );
  }
  if (!choices.length && /Press enter to (?:confirm|continue|select)/i.test(text)) {
    choices.push(
      { key: "Enter", label: "Continue", description: "Press Enter" },
      { key: "Escape", label: "Cancel", description: "Press Escape" },
    );
  }
  return {
    kind: "input",
    title: "Input needed",
    prompt: interactivePrompt(lines),
    choices,
    fields: choices.length ? [] : [{ label: "Prompt", value: lines.slice(-4).join(" ") }],
  };
}

function interactivePrompt(lines) {
  const start = lines.findLastIndex((line) => !/\b(?:printf|echo)\b/i.test(line)
    && /\?|Would you|Do you|Select|Choose|approval|permission|update|install/i.test(line));
  if (start < 0) return "Codex is waiting for you.";
  const end = lines.findIndex((line, index) => index > start
    && (/^(?:›\s*)?\d+\.\s*/.test(line) || /Press enter|esc to (?:cancel|go back)/i.test(line)));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").slice(0, 800);
}

function genericChoice(value, block) {
  const text = block.replace(/Press enter.*$/i, "").trim();
  if (!text) return null;
  const parts = text.split(/\s{2,}|(?<=[.!?])\s+/);
  return {
    value,
    label: parts[0].slice(0, 120),
    description: parts.slice(1).join(" ").slice(0, 180),
    current: /\((?:current|default)\)/i.test(text),
  };
}

export function modelControl(text) {
  const parsed = numberedBlocks(text).map(({ value, block }) => {
    const label = (block.match(/^([a-z0-9][a-z0-9._-]*?)(?=\s|\(|[A-Z]|$)/) || [])[1];
    if (!label) return null;
    const description = block
      .replace(label, "")
      .replace(/\((current|default)\)/ig, "")
      .replace(/Press enter.*$/i, "")
      .replace(/Select Reasoning.*$/i, "")
      .trim();
    return { value, label, description: description || modelHint(label), current: /\(current\)/i.test(block) };
  }).filter(Boolean);
  const choices = dedupeChoices(parsed);
  return choices.length
    ? { kind: "model", title: "Choose model", prompt: "Select a Codex model.", choices }
    : { kind: "model", title: "Model menu changed", prompt: "Ark could not safely map this menu. No choice was sent.", fields: [{ label: "Status", value: "Unsupported menu layout" }] };
}

function reasoningControl(text) {
  const target = (text.match(/Select Reasoning Level(?: for ([\w.-]+))?/i) || [])[1] || "";
  const parsed = numberedBlocks(text).map(({ value, block }) => {
    const label = (block.match(/^\s*(Extra high|Extrahigh|Xhigh|Minimal|None|Low|Medium|High)/i) || [])[1];
    if (!label) return null;
    const description = block
      .slice(block.indexOf(label) + label.length)
      .replace(/\((current|default)\)/ig, "")
      .replace(/Press enter.*$/i, "")
      .trim();
    return {
      value,
      label: label[0].toUpperCase() + label.slice(1).toLowerCase(),
      description: description || reasoningHint(label),
      current: /\(current\)/i.test(block),
      default: /\(default\)/i.test(block),
    };
  }).filter(Boolean);
  const choices = dedupeChoices(parsed);
  return choices.length
    ? { kind: "reasoning", title: "Choose reasoning", prompt: target ? `For ${target}` : "Select reasoning effort.", choices }
    : { kind: "reasoning", title: "Reasoning menu changed", prompt: "Ark could not safely map this menu. No choice was sent.", fields: [{ label: "Status", value: "Unsupported menu layout" }] };
}

function permissionsControl() {
  return {
    kind: "permissions",
    title: "Choose permissions",
    prompt: "Select how much Ark can let Codex do.",
    choices: [
      { value: "1", label: "Ask for approval", description: "Safer default" },
      { value: "2", label: "Approve for me", description: "Fewer prompts" },
    ],
  };
}

function statusControl(lines) {
  const seen = new Set();
  const fields = lines.map((line) => {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 ._-]{1,34}):\s*(.+)$/);
    if (!match || match[2].startsWith("//") || seen.has(match[1].toLowerCase())) return null;
    seen.add(match[1].toLowerCase());
    return { label: match[1].trim(), value: match[2].trim() };
  }).filter(Boolean);
  return { kind: "status", title: "Codex status", prompt: "Current session details.", fields };
}

function numberedBlocks(text) {
  const matches = [...text.matchAll(/(?:^|›\s*|\s)(\d+)\.\s*/g)];
  return matches.map((match, index) => ({
    value: match[1],
    block: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  }));
}

function dedupeChoices(choices) {
  const seen = new Set();
  return choices.filter((choice) => {
    const key = `${choice.value}:${choice.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modelHint(label) {
  if (/mini/i.test(label)) return "Fast/light";
  if (/spark/i.test(label)) return "Ultra fast";
  if (/5\.5/.test(label)) return "Frontier";
  return "Daily coding";
}

function reasoningHint(label) {
  if (/low/i.test(label)) return "Fastest";
  if (/medium/i.test(label)) return "Balanced";
  if (/extra/i.test(label)) return "Deepest";
  return "Default";
}

function cleanControlText(text) {
  return stripAnsi(String(text || ""))
    .replace(/[╭╰╮╯│─]+/g, " ")
    .replace(/[•◦]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function codexStateFromScreen(text) {
  const screen = stripAnsi(String(text || ""));
  const status = [...screen.matchAll(/\bModel:\s*([a-z0-9][\w.-]*)(?:\s+\(reasoning\s+([^,)]+))?/gi)].at(-1);
  const footer = [...screen.matchAll(/\b([a-z0-9][\w.-]*\d[\w.-]*)\s+(none|minimal|low|medium|high|xhigh|extrahigh|extra high)\b(?:\s+fast)?\s*·/gi)].at(-1);
  const match = status || footer;
  if (!match) return null;
  return { model: match[1], reasoning_effort: match[2]?.toLowerCase().replace("extra high", "xhigh") || "", source: "terminal-screen" };
}

export function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b\([A-Za-z0-9]/g, "");
}
