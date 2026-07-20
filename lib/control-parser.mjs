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
  // tmux capture includes scrollback. A past "Working" line must not keep a
  // completed session marked as active after Codex has returned to its prompt.
  const recent = screen.split(/\r?\n/).filter((line) => line.trim()).slice(-24).join("\n");
  return /(?:Working|Thinking|Reasoning)(?:\.{3}|…|\s*\()|esc to interrupt|Running\s+\w+.*hook|waiting for (?:a tool|tool output|agents?)/i.test(recent)
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
  const promptLines = activePromptLines(cleanLines);
  const promptText = cleanControlText(promptLines.join("\n"));
  if (promptLines.length) {
    const lower = promptText.toLowerCase();
    const reasoningIndex = lower.lastIndexOf("select reasoning level");
    const modelIndex = lower.lastIndexOf("select model and effort");
    if (reasoningIndex > modelIndex) return [reasoningControl(promptText.slice(reasoningIndex))];
    if (modelIndex >= 0) return [modelControl(promptText.slice(modelIndex))];
    if (/Would you like to run the following command\?/i.test(promptText)) return [commandApprovalControl(promptLines)];
    if (permissionsMenu(promptLines)) return [permissionsControl(promptLines)];
    const interactive = interactiveControl(promptText, promptLines);
    if (interactive) return [interactive];
  }
  const statusLines = activeStatusLines(cleanLines);
  return statusLines.length ? [statusControl(statusLines)] : [];
}

function activePromptLines(lines) {
  const end = lines.findLastIndex((line) => /^Press enter to (?:confirm|continue|select)\b/i.test(line)
    || /\[\s*y(?:es)?\s*\/\s*n(?:o)?\s*\]\s*$/i.test(line));
  if (end < 0 || !lines.slice(end + 1).every(passiveControlTail)) return [];
  const start = lines.findLastIndex((line, index) => index <= end && (/^(?:Would you|Do you|Allow\b.*\?|Resume paused goal\?|Update Model Permissions$|Update\b.*\?|Select Model and Effort$|Select Reasoning Level\b|Choose\b)/i.test(line)
    || /\bUpdate available!/i.test(line)
    || /\b(?:requires?|requested)\b.*\b(?:approval|confirmation|permission|safety checks?)\b/i.test(line)));
  return start < 0 ? [] : lines.slice(start, end + 1);
}

function passiveControlTail(line) {
  return /^gpt-[\w.-]+\s+(?:none|minimal|low|medium|high|xhigh|extra\s*high|max|ultra)\b.*·/i.test(line)
    || /^Goal (?:achieved|hit)\b/i.test(line);
}

function permissionsMenu(lines) {
  const ask = lines.findIndex((line) => /^(?:›\s*)?1\.\s*Ask for approval\b/i.test(line));
  const approve = lines.findIndex((line) => /^(?:›\s*)?2\.\s*Approve for me\b/i.test(line));
  const full = lines.findIndex((line) => /^(?:›\s*)?3\.\s*Full Access\b/i.test(line));
  return /^Update Model Permissions$/i.test(lines[0] || "") && ask > 0 && approve > ask && full > approve;
}

function activeStatusLines(lines) {
  const context = lines.findLastIndex((line) => /^Context window:/i.test(line));
  const start = lines.findLastIndex((line, index) => index <= context && /^Model:/i.test(line));
  if (start < 0) return [];
  const statusField = /^(?:Model|Directory|Permissions|Agents\.md|Account|Collaboration mode|Session|Context window|5h limit|Weekly limit|GPT-[^:]+ limit|premium limit):/i;
  const end = lines.findLastIndex((line, index) => index >= context && statusField.test(line));
  const fields = lines.slice(start, end + 1);
  if (!fields.some((line) => /^Directory:/i.test(line)) || !fields.some((line) => /^Permissions:/i.test(line))) return [];
  return lines.slice(end + 1).every(passiveControlTail) ? fields : [];
}

function commandApprovalControl(lines) {
  return {
    kind: "approval",
    title: "Approve command",
    prompt: interactivePrompt(lines),
    choices: [
      { value: "1", label: "Yes, proceed", description: "Run this command once" },
      { value: "2", label: "Yes, remember", description: "Also allow commands with this prefix" },
      { value: "3", label: "No", description: "Tell Codex what to do differently" },
    ],
  };
}

function interactiveControl(text, lines) {
  const strongPrompt = /Press enter to (?:confirm|continue|select)|esc to cancel|use (?:the )?(?:up and down )?arrow keys|Do you trust|Would you like to (?:run|allow|continue|proceed|update|install)|Do you want to (?:allow|continue|proceed|update|install)|requires? (?:your )?(?:approval|confirmation)|requested (?:your )?(?:approval|permission)/i.test(text);
  if (!strongPrompt) return null;
  const choices = dedupeChoices(numberedBlocks(text).map(({ value, block, selected }) => genericChoice(value, block, selected)).filter(Boolean));
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
  const update = lines.findLastIndex((line) => /\bUpdate available!/i.test(line));
  const start = update >= 0 ? update : lines.findLastIndex((line) => !/\b(?:printf|echo)\b/i.test(line)
    && /\?|Would you|Do you|Select|Choose|approval|permission|safety checks?|update|install/i.test(line));
  if (start < 0) return "Codex is waiting for you.";
  const end = lines.findIndex((line, index) => index > start
    && (/^(?:›\s*)?\d+\.\s*/.test(line) || /Press enter|esc to (?:cancel|go back)/i.test(line)));
  const prompt = lines.slice(start, end < 0 ? undefined : end).join("\n");
  return prompt.length > 800 ? `${prompt.slice(0, 799)}…` : prompt;
}

function genericChoice(value, block, selected = false) {
  const text = block.replace(/Press enter.*$/i, "").trim();
  if (!text) return null;
  const goal = text.match(/^(Resume goal|Leave paused)\b/i);
  if (goal) return { value, label: goal[1], description: text.slice(goal[0].length).trim(), selected };
  const parts = text.split(/\s{2,}|(?<=[.!?])\s+/);
  return {
    value,
    label: parts[0].slice(0, 120),
    description: parts.slice(1).join(" ").slice(0, 180),
    current: /\((?:current|default)\)/i.test(text),
    selected,
  };
}

export function modelControl(text) {
  const parsed = numberedBlocks(text).map(({ value, block, selected }) => {
    const label = (block.match(/^([a-z0-9][a-z0-9._-]*?)(?=\s|\(|[A-Z]|$)/) || [])[1];
    if (!label) return null;
    const description = block
      .replace(label, "")
      .replace(/\((current|default)\)/ig, "")
      .replace(/Press enter.*$/i, "")
      .replace(/Select Reasoning.*$/i, "")
      .trim();
    return { value, label, description: description || modelHint(label), current: /\(current\)/i.test(block), selected };
  }).filter(Boolean);
  const choices = dedupeChoices(parsed);
  return choices.length
    ? { kind: "model", title: "Choose model", prompt: "Select a Codex model.", choices }
    : { kind: "model", title: "Model menu changed", prompt: "Ark could not safely map this menu. No choice was sent.", fields: [{ label: "Status", value: "Unsupported menu layout" }] };
}

function reasoningControl(text) {
  const target = (text.match(/Select Reasoning Level(?: for ([\w.-]+))?/i) || [])[1] || "";
  const parsed = numberedBlocks(text).map(({ value, block, selected }) => {
    const label = (block.match(/^\s*(Extra high|Extrahigh|Xhigh|Minimal|None|Low|Medium|High|Max|Ultra)/i) || [])[1];
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
      selected,
    };
  }).filter(Boolean);
  const choices = dedupeChoices(parsed);
  return choices.length
    ? { kind: "reasoning", title: "Choose reasoning", prompt: target ? `For ${target}` : "Select reasoning effort.", choices }
    : { kind: "reasoning", title: "Reasoning menu changed", prompt: "Ark could not safely map this menu. No choice was sent.", fields: [{ label: "Status", value: "Unsupported menu layout" }] };
}

function permissionsControl(lines) {
  const selected = (lines.find((line) => /^›\s*[123]\./.test(line))?.match(/^›\s*([123])\./) || [])[1];
  return {
    kind: "permissions",
    title: "Choose permissions",
    prompt: "Select how much Ark can let Codex do.",
    choices: [
      { value: "1", label: "Ask for approval", description: "Safer default", selected: selected === "1" },
      { value: "2", label: "Approve for me", description: "Fewer prompts", selected: selected === "2" },
      { value: "3", label: "Full Access", description: "Outside files and internet without asking", selected: selected === "3" },
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
  // A menu dot is not followed by a digit. This keeps compact Codex menus
  // ("1.Low") working without treating 0.144.4 as three menu choices.
  const matches = [...text.matchAll(/(?:^|›\s*|\s)(\d+)\.(?!\d)\s*/g)];
  return matches.map((match, index) => ({
    value: match[1],
    block: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
    selected: match[0].includes("›"),
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
  const footer = [...screen.matchAll(/\b([a-z0-9][\w.-]*\d[\w.-]*)\s+(none|minimal|low|medium|high|xhigh|extrahigh|extra high|max|ultra)\b(?:\s+(fast))?\s*·/gi)].at(-1);
  const match = status || footer;
  if (!match) return null;
  return { model: match[1], reasoning_effort: match[2]?.toLowerCase().replace("extra high", "xhigh") || "", service_tier: footer ? (footer[3] ? "priority" : "default") : "", source: "terminal-screen" };
}

export function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b\([A-Za-z0-9]/g, "");
}
