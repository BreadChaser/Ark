let sessions = [];
let peers = [];
let activeId = null;
let since = 0;
let msgTimer = null;
let liveTimer = null;
let runningTag = null;
let liveStartedAt = 0;
let adoptedLive = false;
let codexMode = false;
let liveCommand = "";
let liveBubble = null;
let codexBubble = null;
let terminalMode = false;
let autoTerminalMode = false;
let currentSession = null;
let sending = false;
let pendingLocalUsers = [];
let suggestIndex = -1;
let suggestAbort = null;
let terminalTypeQueue = Promise.resolve();
let terminalSending = false;
let terminalPollInFlight = false;
let terminalTextBuffer = "";
let terminalFlushTimer = null;
let pendingCodexImages = [];

const sessionList = document.getElementById("session-list");
const messagesEl = document.getElementById("messages");
const welcome = document.getElementById("welcome");
const sessionTitle = document.getElementById("session-title");
const sessionMeta = document.getElementById("session-meta");
const commandInput = document.getElementById("command-input");
const sendBtn = document.getElementById("send-btn");
const composer = document.getElementById("composer");
const btnClose = document.getElementById("btn-close");
const btnRename = document.getElementById("btn-rename");
const dialog = document.getElementById("new-dialog");
const machineSelect = document.getElementById("machine-select");
const tmuxSelect = document.getElementById("tmux-select");
const sshUserInput = document.getElementById("ssh-user");
const machineHint = document.getElementById("machine-hint");
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const btnSidebar = document.getElementById("btn-sidebar");
const btnSidebarClose = document.getElementById("btn-sidebar-close");
const keybar = document.getElementById("keybar");
const btnTerminal = document.getElementById("btn-terminal");
const btnCodex = document.getElementById("btn-codex");
const suggestEl = document.getElementById("suggest");
const feedEl = document.getElementById("messages");
const btnSettings = document.getElementById("btn-settings");
const btnScrollBottom = document.getElementById("btn-scroll-bottom");
const settingsDialog = document.getElementById("settings-dialog");
const themeSelect = document.getElementById("theme-select");
const llamaStatus = document.getElementById("llama-status");
const llamaLink = document.getElementById("llama-link");
let tmuxHosts = [];

const COLLAPSE_KEY = "ark-collapsed-machines";
const SIDEBAR_KEY = "ark-sidebar-open";
const SSH_USER_KEY = "ark-ssh-user";
const THEME_KEY = "ark-theme";
const SESSION_UI_KEY = "ark-session-ui-state";

const AGENT_PROVIDERS = {
  codex: { command: "codex", structured: true, label: "Codex" },
  opencode: { command: "opencode", structured: false, label: "OpenCode" },
};

const SUGGESTIONS = [
  "/model", "/status", "/help", "/clear", "/compact", "/diff", "/new", "/exit",
  "ls -la", "ls", "pwd", "cd ..", "cd ~", "cd ",
  "git status", "git diff", "git log --oneline -10", "git pull", "git push",
  "cat ", "grep -rn ", "find . -name ", "rg ",
  "python3 ", "npm ", "cargo ", "node ",
  "htop", "top", "btop",
  "tailscale status", "tailscale ip", "hostname", "whoami", "uptime", "df -h", "free -h",
  "opencode", "codex", "vim ", "nano ", "less ",
  "systemctl --user status", "journalctl -e -n 50",
];

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveCollapsed(set) { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
let collapsedMachines = loadCollapsed();
sshUserInput.value = localStorage.getItem(SSH_USER_KEY) || "";
themeSelect.value = localStorage.getItem(THEME_KEY) || "crt-soft";
applyTheme(themeSelect.value);

function isMobile() { return window.innerWidth <= 768; }
function defaultSidebarOpen() {
  const stored = localStorage.getItem(SIDEBAR_KEY);
  if (stored !== null) return stored === "true";
  return !isMobile();
}
function setSidebarOpen(open) {
  localStorage.setItem(SIDEBAR_KEY, open ? "true" : "false");
  sidebar.classList.toggle("collapsed", !open);
  sidebarBackdrop.classList.toggle("visible", open && isMobile());
}
function toggleSidebar() { setSidebarOpen(sidebar.classList.contains("collapsed")); }
btnSidebar.onclick = toggleSidebar;
btnSidebarClose.onclick = () => setSidebarOpen(false);
sidebarBackdrop.onclick = () => setSidebarOpen(false);
setSidebarOpen(defaultSidebarOpen());

function applyTheme(name) {
  document.body.dataset.theme = name || "crt-soft";
}
themeSelect.addEventListener("change", () => {
  localStorage.setItem(THEME_KEY, themeSelect.value);
  applyTheme(themeSelect.value);
});
btnSettings.onclick = async () => {
  settingsDialog.showModal();
  try {
    const d = await (await fetch("/api/v1/llama")).json();
    llamaLink.href = d.panel_url || llamaLink.href;
    llamaStatus.textContent = d.ok
      ? `${d.model || "local"}${d.ctx ? ` · ctx ${d.ctx}` : ""}`
      : `offline · ${d.error || "no model"}`;
  } catch {
    llamaStatus.textContent = "offline";
  }
};
btnScrollBottom.onclick = scrollFeedBottom;
messagesEl.addEventListener("scroll", updateScrollButton);

function loadSessionUiState() {
  try { return JSON.parse(localStorage.getItem(SESSION_UI_KEY) || "{}"); }
  catch { return {}; }
}

function saveSessionUiState(patch) {
  if (!activeId) return;
  const state = loadSessionUiState();
  state[activeId] = { ...(state[activeId] || {}), ...patch };
  localStorage.setItem(SESSION_UI_KEY, JSON.stringify(state));
}

function getSessionUiState(id) {
  return loadSessionUiState()[id] || {};
}

function setTerminalMode(next, { auto = false, persist = !auto } = {}) {
  terminalMode = next;
  autoTerminalMode = auto;
  if (persist) saveSessionUiState({ terminalMode: next });
  updateInputMode();
}

function updateInputMode() {
  document.body.classList.toggle("terminal-mode", terminalMode);
  btnTerminal.classList.toggle("active", terminalMode);
  btnCodex.classList.toggle("active", codexMode);
  if (codexMode) commandInput.placeholder = "Message Codex…";
  else if (terminalMode) commandInput.placeholder = "Type into terminal…";
  else if (runningTag && !codexMode) commandInput.placeholder = "Type into app…";
  else commandInput.placeholder = "Run a command…";
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function twinkleText(text) {
  let n = 0;
  return [...String(text)].map((ch) => {
    if (/[A-Za-z0-9]/.test(ch) && (++n % 17 === 0 || n % 29 === 0)) {
      return `<span class="phosphor-pop">${escapeHtml(ch)}</span>`;
    }
    return escapeHtml(ch);
  }).join("");
}
function renderMarkdownLite(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// ── ANSI → HTML (keep ls / htop / codex colors) ──
const ANSI = [
  "#000000","#cc2222","#22cc44","#cccc22","#2266cc","#cc22cc","#22cccc","#cccccc",
  "#666666","#ff4444","#44ff44","#ffff44","#6699ff","#ff66ff","#44ffff","#ffffff",
];
function ansiToHtml(input) {
  if (!input) return "";
  const s = escapeHtml(input);
  let out = "", buf = "", style = {};
  function flush() {
    if (!buf) return;
    const css = [];
    if (style.bold) css.push("font-weight:700");
    if (style.dim) css.push("opacity:.55");
    if (style.italic) css.push("font-style:italic");
    if (style.color) css.push("color:" + style.color);
    if (style.bg) css.push("background:" + style.bg);
    out += css.length ? `<span style="${css.join(";")}">${buf}</span>` : buf;
    buf = "";
  }
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      flush();
      let j = i + 2;
      while (j < s.length && s[j] !== "m") j++;
      const codes = s.slice(i + 2, j).split(";").map((n) => parseInt(n, 10) || 0);
      for (const c of codes) {
        if (c === 0) style = {};
        else if (c === 1) style.bold = true;
        else if (c === 2) style.dim = true;
        else if (c === 3) style.italic = true;
        else if (c === 22) { style.bold = false; style.dim = false; }
        else if (c === 23) style.italic = false;
        else if (c >= 30 && c <= 37) style.color = ANSI[c - 30];
        else if (c >= 90 && c <= 97) style.color = ANSI[8 + (c - 90)];
        else if (c >= 40 && c <= 47) style.bg = ANSI[c - 40];
        else if (c >= 100 && c <= 107) style.bg = ANSI[8 + (c - 100)];
        else if (c === 39) style.color = null;
        else if (c === 49) style.bg = null;
      }
      i = j + 1;
    } else {
      buf += s[i];
      i++;
    }
  }
  flush();
  return out;
}

function showWelcome(show) {
  welcome.style.display = show ? "" : "none";
}

function bubbleHtml(m) {
  if (m.role === "image" && /^data:image\//.test(m.content)) {
    return `<img class="pasted-image" src="${m.content}" alt="Pasted image" loading="lazy" />`;
  }
  if (m.role === "command" || m.role === "user") {
    return `<span class="cmd-text">${twinkleText(m.content.replace(/^\$\s*/, ""))}</span>`;
  }
  if (m.role === "system") return renderMarkdownLite(m.content);
  return ansiToHtml(m.content) || `<span class="output-ok">done</span>`;
}

function addBubble(m) {
  const row = document.createElement("div");
  row.className = `msg-row ${m.role}`;
  const av = (m.role === "command" || m.role === "user") ? "›" : m.role === "error" ? "!" : m.role === "system" ? "·" : "⌘";
  row.innerHTML = `
    <div class="msg-avatar">${av}</div>
    <div class="msg-body">
      <div class="msg-bubble">${bubbleHtml(m)}</div>
      <div class="msg-time">${fmtTime(m.created_at)}</div>
    </div>`;
  if (liveBubble && liveBubble.parentNode === messagesEl) {
    messagesEl.insertBefore(row, liveBubble);
  } else {
    messagesEl.appendChild(row);
  }
  return row;
}

function removeCodexBubble() {
  if (codexBubble) codexBubble.remove();
  codexBubble = null;
}

function setCodexBubble(text, status = "working") {
  const feedTop = messagesEl.scrollTop;
  if (!codexBubble) {
    codexBubble = document.createElement("div");
    codexBubble.className = "msg-row output codex-chat";
    codexBubble.innerHTML = `
      <div class="msg-avatar">⌘</div>
      <div class="msg-body">
        <div class="msg-bubble"></div>
        <div class="msg-time"></div>
      </div>`;
    messagesEl.appendChild(codexBubble);
  }
  codexBubble.querySelector(".msg-bubble").innerHTML = text ? twinkleText(text) : `<span class="output-ok">${escapeHtml(status)}</span>`;
  codexBubble.querySelector(".msg-time").textContent = status;
  messagesEl.scrollTop = feedTop;
  updateScrollButton();
}

function renderMessages(msgs, append = false) {
  const feedTop = messagesEl.scrollTop;
  if (!append) messagesEl.innerHTML = "";
  if (!append) pendingLocalUsers = [];
  const shown = append ? filterPendingUserEchoes(msgs) : msgs;
  if (!shown.length && !append) { showWelcome(true); return; }
  showWelcome(false);
  for (const m of shown) addBubble(m);
  if (!append) scrollFeedBottom();
  else {
    messagesEl.scrollTop = feedTop;
    updateScrollButton();
  }
}

function filterPendingUserEchoes(msgs) {
  const now = Date.now() / 1000;
  pendingLocalUsers = pendingLocalUsers.filter((p) => now - p.created_at < 20);
  return msgs.filter((m) => {
    if (m.role !== "user") return true;
    const i = pendingLocalUsers.findIndex((p) => p.content === m.content && Math.abs(m.created_at - p.created_at) < 20);
    if (i < 0) return true;
    pendingLocalUsers.splice(i, 1);
    return false;
  });
}

function scrollFeedBottom(scrollLive = true) {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (scrollLive) {
    const bubble = liveBubble?.querySelector(".msg-bubble");
    if (bubble) bubble.scrollTop = bubble.scrollHeight;
  }
  updateScrollButton();
}

function isNearBottom(el, pad = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < pad;
}

function updateScrollButton() {
  const bubble = liveBubble?.querySelector(".msg-bubble");
  const show = activeId && (!isNearBottom(messagesEl, 80) || (bubble && !isNearBottom(bubble, 80)));
  btnScrollBottom.classList.toggle("hidden", !show);
}

function createLiveBubble() {
  if (liveBubble) liveBubble.remove();
  liveBubble = document.createElement("div");
  liveBubble.className = "msg-row output live";
  liveBubble.dataset.firstPaint = "1";
  liveBubble.innerHTML = `
    <div class="msg-avatar">⌘</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="live-head">
          <span><span class="live-dot"></span><span class="live-title">Live app</span></span>
          <button type="button" class="btn-stop" id="btn-stop-live">Stop</button>
        </div>
        <div class="live-terminal"><span class="output-ok">running…</span></div>
      </div>
      <div class="msg-time">live</div>
    </div>`;
  messagesEl.appendChild(liveBubble);
  liveBubble.querySelector(".live-title").textContent = terminalMode ? "Terminal" : "Live app";
  liveBubble.querySelector("#btn-stop-live").onclick = stopLiveApp;
  liveBubble.querySelector(".msg-bubble").addEventListener("scroll", updateScrollButton);
  scrollFeedBottom();
}

function setLiveContent(html, rawText = null) {
  if (!liveBubble) return;
  const feedTop = messagesEl.scrollTop;
  const firstPaint = liveBubble.dataset.firstPaint === "1";
  const b = liveBubble.querySelector(".live-terminal");
  const bubble = liveBubble.querySelector(".msg-bubble");
  const bubbleTop = bubble.scrollTop;
  b.innerHTML = html || `<span class="output-ok">running…</span>`;
  if (firstPaint) {
    delete liveBubble.dataset.firstPaint;
    bubble.scrollTop = bubble.scrollHeight;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    bubble.scrollTop = bubbleTop;
    messagesEl.scrollTop = feedTop;
  }
  updateScrollButton();
}

function isAgentCommand(cmd) {
  const command = String(cmd || "").trim().split(/\s+/, 1)[0];
  return !!AGENT_PROVIDERS[command];
}

function agentProviderForCommand(cmd) {
  const command = String(cmd || "").trim().split(/\s+/, 1)[0];
  return AGENT_PROVIDERS[command] || null;
}

function freezeLiveSnapshot(label = "Snapshot") {
  if (!liveBubble) return;
  setLiveContent(liveBubble.querySelector(".live-terminal")?.innerHTML || "");
  const snapshot = liveBubble.cloneNode(true);
  snapshot.classList.remove("live");
  snapshot.classList.add("snapshot");
  const head = snapshot.querySelector(".live-head span");
  if (head) head.textContent = label;
  snapshot.querySelector("#btn-stop-live")?.remove();
  snapshot.querySelector(".msg-time").textContent = fmtTime(Date.now() / 1000);
  messagesEl.insertBefore(snapshot, liveBubble);
  liveBubble.remove();
  liveBubble = null;
}

function machineKey(s) { return s.peer_id || s.hostname; }

function groupSessionsByMachine(list) {
  const groups = new Map();
  for (const s of list) {
    const key = machineKey(s);
    if (!groups.has(key)) groups.set(key, { key, hostname: s.hostname, sessions: [] });
    groups.get(key).sessions.push(s);
  }
  return [...groups.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function previewText(s) {
  if (!s.preview) return "ready";
  return s.preview.replace(/\n/g, " ").slice(0, 42);
}

function renderSidebar() {
  sessionList.innerHTML = "";
  if (!sessions.length) {
    sessionList.innerHTML = '<div class="session-empty">No sessions yet.<br>Hit <strong>+ New session</strong>.</div>';
    return;
  }
  const activeSession = sessions.find((s) => s.id === activeId);
  if (activeSession) {
    collapsedMachines.delete(machineKey(activeSession));
    saveCollapsed(collapsedMachines);
  }
  for (const group of groupSessionsByMachine(sessions)) {
    const isCollapsed = collapsedMachines.has(group.key);
    const wrap = document.createElement("div");
    wrap.className = "machine-group" + (isCollapsed ? " collapsed" : "");
    const header = document.createElement("button");
    header.type = "button";
    header.className = "machine-header";
    header.innerHTML = `<span class="machine-chevron">▼</span><span class="machine-name">${escapeHtml(group.hostname)}</span><span class="machine-count">${group.sessions.length}</span>`;
    header.onclick = () => {
      collapsedMachines.has(group.key) ? collapsedMachines.delete(group.key) : collapsedMachines.add(group.key);
      saveCollapsed(collapsedMachines);
      renderSidebar();
    };
    const ul = document.createElement("ul");
    ul.className = "machine-sessions";
    for (const s of group.sessions) {
      const li = document.createElement("li");
      li.className = "session-item" + (s.id === activeId ? " active" : "");
      li.innerHTML = `
        <div class="session-item-top">
          <div class="session-item-name">${escapeHtml(s.name)}</div>
          <button type="button" class="session-rename" title="Rename" aria-label="Rename">✎</button>
        </div>
        <div class="session-item-sub">${escapeHtml(previewText(s))}</div>`;
      li.querySelector(".session-rename").onclick = (e) => {
        e.stopPropagation();
        renameSession(s.id, s.name);
      };
      li.onclick = (e) => { e.stopPropagation(); openSession(s.id); if (isMobile()) setSidebarOpen(false); };
      ul.appendChild(li);
    }
    wrap.appendChild(header);
    wrap.appendChild(ul);
    sessionList.appendChild(wrap);
  }
}

async function loadSessions() {
  const res = await fetch("/api/v1/sessions");
  sessions = (await res.json()).sessions || [];
  renderSidebar();
  if (activeId) {
    const s = sessions.find((x) => x.id === activeId);
    if (s) { sessionTitle.textContent = s.name; sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip}`; }
  }
}

async function loadPeers() {
  const res = await fetch("/api/v1/peers");
  peers = (await res.json()).peers || [];
  const user = sshUserInput.value.trim();
  const tmuxRes = await fetch(`/api/v1/tmux?ssh_user=${encodeURIComponent(user)}`);
  tmuxHosts = (await tmuxRes.json()).hosts || [];
  machineSelect.innerHTML = "";
  const online = peers.filter((p) => p.online);
  const offline = peers.filter((p) => !p.online);
  online.sort((a, b) => Number(!a.is_self) - Number(!b.is_self) || a.hostname.localeCompare(b.hostname));
  for (const p of [...online, ...offline]) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.disabled = !p.online;
    opt.textContent = `${p.hostname}${p.is_self ? " · hub" : ""}${p.online ? "" : " (offline)"}`;
    machineSelect.appendChild(opt);
  }
  if (online.length) machineSelect.value = online.find((p) => p.is_self)?.id || online[0].id;
  updateHint();
}

function updateHint() {
  const p = peers.find((x) => x.id === machineSelect.value);
  const host = tmuxHosts.find((h) => h.peer.id === machineSelect.value);
  tmuxSelect.innerHTML = '<option value="__new__">New Ark session</option>';
  const sessions = host?.sessions || [];
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = `${s.name}${s.ark ? "" : " · external"}${s.attached ? " · attached" : ""}`;
    tmuxSelect.appendChild(opt);
  }
  if (host && !host.ok) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.textContent = `tmux unavailable: ${host.error || "connection failed"}`;
    tmuxSelect.appendChild(opt);
  } else if (host && sessions.length === 0) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.textContent = "No existing tmux sessions found";
    tmuxSelect.appendChild(opt);
  }
  machineHint.className = "field-hint";
  const user = sshUserInput.value.trim();
  const suffix = user ? ` · ssh ${user}` : "";
  const tmuxStatus = host && !host.ok ? ` · ${host.error || "tmux unavailable"}` : "";
  machineHint.textContent = p ? `${p.dns_name || p.tailscale_ip} · ${p.os}${suffix}${tmuxStatus}` : "";
}
machineSelect.addEventListener("change", updateHint);
sshUserInput.addEventListener("change", async () => {
  localStorage.setItem(SSH_USER_KEY, sshUserInput.value.trim());
  await loadPeers();
});

async function openSession(id) {
  activeId = id;
  since = 0;
  runningTag = null;
  liveStartedAt = 0;
  adoptedLive = false;
  codexMode = false;
  pendingCodexImages = [];
  terminalMode = !!getSessionUiState(id).terminalMode;
  autoTerminalMode = false;
  liveCommand = "";
  liveBubble = null;
  removeCodexBubble();
  stopLivePoll();
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  currentSession = s;
  sessionTitle.textContent = s.name;
  sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip}`;
  btnClose.classList.remove("hidden");
  btnRename.classList.remove("hidden");
  commandInput.disabled = false;
  sendBtn.disabled = false;
  keybar.classList.add("visible");
  updateInputMode();
  renderSidebar();
  messagesEl.innerHTML = '<div class="session-empty">Loading…</div>';
  await refreshMessages(true);
  const state = await refreshState();
  await restoreCodexFromState();
  restoreLiveFromState(state);
  if (terminalMode && !runningTag && !codexMode) startTerminalPoll();
  startMsgPolling();
  commandInput.focus();
}

async function refreshState() {
  if (!activeId || !currentSession) return;
  try {
    const res = await fetch(`/api/v1/sessions/${activeId}/state`);
    const d = await res.json();
    const cwd = d.cwd ? d.cwd.replace(/^\/home\/[^/]+/, "~") : currentSession.tailscale_ip;
    sessionMeta.textContent = `${currentSession.hostname} · ${cwd} · ${d.tmux || currentSession.tmux_name}`;
    return d;
  } catch {}
  return null;
}

function restoreLiveFromState(state) {
  if (!state?.live?.running || runningTag) return;
  runningTag = "adopted";
  adoptedLive = true;
  liveStartedAt = Date.now();
  liveCommand = state.live.command || "";
  createLiveBubble();
  startLivePoll();
}

async function restoreCodexFromState() {
  try {
    const d = await (await fetch(`/api/v1/sessions/${activeId}/codex/state`)).json();
    if (!d.active) return;
    runningTag = "codex-api";
    codexMode = true;
    liveStartedAt = Date.now();
    liveCommand = "codex";
    renderCodexState(d);
    startCodexPoll();
  } catch {}
}

async function refreshMessages(full = false) {
  if (!activeId) return;
  const s = full ? 0 : since;
  const res = await fetch(`/api/v1/sessions/${activeId}/messages?since=${s}`);
  const msgs = (await res.json()).messages || [];
  if (full) {
    renderMessages(msgs);
    if (msgs.length) since = msgs[msgs.length - 1].created_at;
  } else if (msgs.length) {
    renderMessages(msgs, true);
    since = msgs[msgs.length - 1].created_at;
  }
}

function startMsgPolling() {
  if (msgTimer) clearInterval(msgTimer);
  msgTimer = setInterval(() => refreshMessages(false), 2500);
}

function startLivePoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(pollLive, 250);
  if (isLiveCommand(liveCommand) || terminalMode) {
    createLiveBubble();
    pollLive();
  }
  updateInputMode();
}

function stopLivePoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
}

function startCodexPoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(pollCodex, 900);
  pollCodex();
}

async function pollCodex() {
  if (!activeId || !codexMode) return;
  try {
    const d = await (await fetch(`/api/v1/sessions/${activeId}/codex/state`)).json();
    if (!d.active) {
      codexMode = false;
      pendingCodexImages = [];
      runningTag = null;
      stopLivePoll();
      removeCodexBubble();
      await refreshMessages(true);
      return;
    }
    renderCodexState(d);
  } catch {}
}

function renderCodexState(d) {
  if (d.messages?.length) {
    removeCodexBubble();
    for (const m of d.messages) {
      addBubble(m);
      since = Math.max(since, m.created_at || since);
    }
    updateScrollButton();
  }
  if (d.completed && !d.busy) {
    removeCodexBubble();
    return;
  }
  setCodexBubble(d.transcript || "", d.status || "ready");
}

async function pollCommand(tag, tries = 80) {
  if (!activeId || !tag || tries <= 0) return;
  try {
    const res = await fetch(`/api/v1/sessions/${activeId}/live?tag=${tag}`);
    const d = await res.json();
    if (d.state === "done") {
      await refreshMessages(false);
      await refreshState();
      await loadSessions();
      return;
    }
  } catch {}
  setTimeout(() => pollCommand(tag, tries - 1), 700);
}

function startTerminalPoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(pollTerminal, 150);
  createLiveBubble();
  pollTerminal();
  updateInputMode();
}

async function pollTerminal() {
  if (!activeId || !terminalMode) return;
  if (terminalPollInFlight) return;
  terminalPollInFlight = true;
  try {
    const pane = await (await fetch(`/api/v1/sessions/${activeId}/pane`)).json();
    if (!terminalMode) return;
    if (!liveBubble) createLiveBubble();
    const text = String(pane.text || "").split("\n").slice(-1200).join("\n").trim();
    setLiveContent(text ? ansiToHtml(text) : "", text);
  } catch {
  } finally {
    terminalPollInFlight = false;
  }
}

function flushTerminalText() {
  if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
  terminalFlushTimer = null;
  drainTerminalText();
  return terminalTypeQueue.then(() => terminalTextBuffer ? flushTerminalText() : undefined);
}

function drainTerminalText() {
  if (terminalSending) return terminalTypeQueue;
  const text = terminalTextBuffer;
  terminalTextBuffer = "";
  if (!activeId || !text) return terminalTypeQueue;
  terminalSending = true;
  terminalTypeQueue = fetch(`/api/v1/sessions/${activeId}/type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, store: false, submit: false }),
  }).catch(() => {}).finally(() => {
    terminalSending = false;
    if (terminalTextBuffer) setTimeout(drainTerminalText, 0);
  });
  return terminalTypeQueue;
}

function sendTerminalText(text) {
  if (!text) return;
  terminalTextBuffer += text;
  if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
  if (!terminalSending) terminalFlushTimer = setTimeout(drainTerminalText, 8);
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read pasted image"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load pasted image"));
    img.src = src;
  });
}

async function imageFileToDataUrl(file) {
  if (file.size <= 6_000_000) return readBlobAsDataUrl(file);
  const src = await readBlobAsDataUrl(file);
  const img = await loadImage(src);
  const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

async function addPastedImage(file) {
  if (!activeId || !file || !file.type.startsWith("image/")) return;
  if (file.size > 25_000_000) {
    addBubble({ role: "system", content: "Pasted image is too large for Ark right now. Try a smaller crop.", created_at: Date.now() / 1000 });
    return;
  }
  const content = await imageFileToDataUrl(file);
  if (content.length > 14_000_000) {
    addBubble({ role: "system", content: "Pasted image is too large for Codex. Try a smaller crop.", created_at: Date.now() / 1000 });
    return;
  }
  const res = await fetch(`/api/v1/sessions/${activeId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "image", content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "image paste failed");
  addBubble(data.message);
  if (codexMode) pendingCodexImages.push(content);
  since = Math.max(since, data.message.created_at);
  scrollFeedBottom();
  await loadSessions();
}

async function handlePaste(e) {
  if (e.defaultPrevented) return;
  const itemFiles = [...(e.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  const files = [...(e.clipboardData?.files || []), ...itemFiles]
    .filter((f, i, all) => f.type.startsWith("image/") && all.findIndex((x) => x.name === f.name && x.size === f.size) === i);
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  const wasSending = sending;
  try {
    for (const file of files.slice(0, 4)) {
      await addPastedImage(file).catch((err) => {
        addBubble({ role: "system", content: err.message || "image paste failed", created_at: Date.now() / 1000 });
      });
    }
  } finally {
    if (!wasSending) {
      sending = false;
      commandInput.disabled = false;
      sendBtn.disabled = false;
      updateInputMode();
      commandInput.focus();
    }
  }
}

async function pollLive() {
  if (!activeId || !runningTag) return;
  const tag = runningTag;
  try {
    const shouldRenderPane = liveBubble || terminalMode || isLiveCommand(liveCommand) || Date.now() - liveStartedAt > 1000;
    let paneRendered = false;
    if (shouldRenderPane) {
      const paneRes = await fetch(`/api/v1/sessions/${activeId}/pane`);
      const pane = await paneRes.json();
      if (runningTag !== tag) return;
      paneRendered = true;
      const output = filterLivePane(pane.text || "");
      if (!liveBubble) createLiveBubble();
      setLiveContent(output ? ansiToHtml(output) : "", output);
    }

    if (adoptedLive) {
      const state = await refreshState();
      if (!state?.live?.running) {
        stopLivePoll();
        runningTag = null;
        adoptedLive = false;
        liveStartedAt = 0;
        liveCommand = "";
        if (liveBubble) freezeLiveSnapshot("Stopped");
      }
      return;
    }

    const res = await fetch(`/api/v1/sessions/${activeId}/live?tag=${tag}`);
    const d = await res.json();
    if (runningTag !== tag) return;
    if (d.state === "done") {
      stopLivePoll();
      runningTag = null;
      liveStartedAt = 0;
      adoptedLive = false;
      if (autoTerminalMode) {
        setTerminalMode(false, { persist: false });
      }
      liveCommand = "";
      freezeLiveSnapshot("Done");
      updateInputMode();
      since = Math.max(0, since - 0.001);
      await refreshMessages(false);
      await refreshState();
      await loadSessions();
    } else if (d.state === "error") {
      if (liveBubble) setLiveContent(escapeHtml(d.output || "session lost"));
      stopLivePoll();
      runningTag = null;
      liveStartedAt = 0;
      adoptedLive = false;
      if (autoTerminalMode) {
        setTerminalMode(false, { persist: false });
      }
      liveCommand = "";
      freezeLiveSnapshot("Stopped");
      updateInputMode();
    }
  } catch {}
}

function isLiveCommand(cmd) {
  const provider = agentProviderForCommand(cmd);
  if (provider && !provider.structured) return true;
  return /^(htop|top|btop|vim|vi|nano|less|man|ssh|python3?\s+-i|node\s+-i)\b/.test(String(cmd || "").trim());
}

function isTerminalCommand(cmd) {
  return /^sudo\b/.test(String(cmd || "").trim());
}

const MARKER_RE = /(?:__ARK_[0-9a-f]+__|@@[0-9a-f]+):\d+/g;
const MARKER_LINE_RE = /^\s*(?:__ARK_[0-9a-f]+__|@@[0-9a-f]+):\d+\s*$/;
const MARKER_SUFFIX_RE = /;(?:\s*code=\$\?;\s*)?(?:echo|printf).*?(?:__ARK_[0-9a-f]+__|@@[0-9a-f]+)/;

function filterTerminalEcho(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(MARKER_SUFFIX_RE, ""))
    .map((l) => l.replace(MARKER_RE, ""))
    .filter((l) => !MARKER_LINE_RE.test(l.replace(/\x1b\[[0-9;]*m/g, "")))
    .join("\n")
    .trim();
}

function filterLivePane(text) {
  let skippedCommand = false;
  const command = String(liveCommand || "").trim();
  const lines = String(text || "").replace(/\r/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    if (MARKER_LINE_RE.test(plain.trim())) continue;
    if (runningTag && plain.includes(`@@${runningTag}`)) continue;
    if (!skippedCommand && command && plain.includes(command)) {
      skippedCommand = true;
      continue;
    }
    out.push(line.replace(MARKER_SUFFIX_RE, "").replace(MARKER_RE, ""));
  }
  return out.join("\n").trim().split("\n").slice(-120).join("\n");
}

function closeUi() {
  activeId = null;
  since = 0;
  runningTag = null;
  liveStartedAt = 0;
  adoptedLive = false;
  codexMode = false;
  pendingCodexImages = [];
  setTerminalMode(false, { persist: false });
  autoTerminalMode = false;
  liveCommand = "";
  liveBubble = null;
  removeCodexBubble();
  if (msgTimer) clearInterval(msgTimer);
  stopLivePoll();
  msgTimer = null;
  currentSession = null;
  messagesEl.innerHTML = "";
  sessionTitle.textContent = "Welcome";
  sessionMeta.textContent = "Open a session on any machine";
  btnClose.classList.add("hidden");
  btnRename.classList.add("hidden");
  commandInput.disabled = true;
  sendBtn.disabled = true;
  keybar.classList.remove("visible");
  updateInputMode();
  updateScrollButton();
  showWelcome(true);
  renderSidebar();
}

function toggleTerminalMode() {
  if (!activeId) return;
  setTerminalMode(!terminalMode);
  if (terminalMode) {
    liveCommand = liveCommand || "terminal";
    if (runningTag) startLivePoll();
    else startTerminalPoll();
  } else {
    if (runningTag) startLivePoll();
    else {
      stopLivePoll();
      if (liveBubble) { liveBubble.remove(); liveBubble = null; }
    }
    updateInputMode();
  }
}
btnTerminal.onclick = toggleTerminalMode;

btnCodex.onclick = async () => {
  if (!activeId || codexMode) return;
  if (runningTag) {
    alert("Stop the current live app before starting Codex.");
    return;
  }
  setTerminalMode(false);
  await sendCommand("codex");
};

async function renameSession(id, currentName) {
  const name = prompt("Rename chat", currentName || sessionTitle.textContent);
  if (name === null) return;
  const next = name.trim();
  if (!next) return;
  const res = await fetch(`/api/v1/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: next }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.detail || "Rename failed");
    return;
  }
  if (id === activeId) {
    currentSession = data.session;
    sessionTitle.textContent = data.session.name;
  }
  await loadSessions();
}

btnRename.onclick = () => {
  if (activeId && currentSession) renameSession(activeId, currentSession.name);
};

document.getElementById("btn-new").onclick = async () => {
  await loadPeers();
  machineHint.className = "field-hint";
  dialog.showModal();
};
document.getElementById("btn-cancel").onclick = () => dialog.close();

document.getElementById("new-form").onsubmit = async (e) => {
  e.preventDefault();
  const peer_id = machineSelect.value;
  if (!peer_id) return;
  const tmux_name = tmuxSelect.value;
  const ssh_user = sshUserInput.value.trim();
  localStorage.setItem(SSH_USER_KEY, ssh_user);
  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const headers = { "Content-Type": "application/json" };
    let res;
    if (tmux_name && tmux_name !== "__new__") {
      res = await fetch("/api/v1/sessions/import", {
        method: "POST", headers, body: JSON.stringify({ peer_id, tmux_name, ssh_user }),
      });
      if (res.status === 409 && confirm("This tmux session was not created by Ark. Attach anyway?")) {
        res = await fetch("/api/v1/sessions/import", {
          method: "POST", headers, body: JSON.stringify({ peer_id, tmux_name, ssh_user, confirmed: true }),
        });
      }
    } else {
      res = await fetch("/api/v1/sessions", {
        method: "POST", headers, body: JSON.stringify({ peer_id, ssh_user }),
      });
    }
    const data = await res.json();
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      throw new Error(detail || "Connection failed");
    }
    dialog.close();
    await loadSessions();
    await openSession(data.session.id);
    setSidebarOpen(false);
  } catch (err) {
    machineHint.textContent = err.message;
    machineHint.className = "field-hint err";
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
};

async function sendCommand(cmd) {
  if (!cmd || !activeId) return;
  if (/^tmux\b/.test(cmd) && !confirm("This can change Ark's managed tmux session. Run it anyway?")) {
    return;
  }
  const headers = { "Content-Type": "application/json" };

  if (terminalMode && !codexMode) {
    await fetch(`/api/v1/sessions/${activeId}/type`, {
      method: "POST", headers, body: JSON.stringify({ text: cmd, store: false }),
    }).catch(() => {});
    if (runningTag) pollLive();
    else pollTerminal();
    return;
  }

  const provider = agentProviderForCommand(cmd);
  if (!runningTag && provider?.structured && provider.command === "codex") {
    runningTag = "codex-api";
    codexMode = true;
    liveStartedAt = Date.now();
    liveCommand = provider.command;
    updateInputMode();
    setCodexBubble("", `starting ${provider.label} app-server`);
    const res = await fetch(`/api/v1/sessions/${activeId}/codex/start`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      since = Math.max(0, since - 0.001);
      removeCodexBubble();
      await refreshMessages(false);
      renderCodexState(data.state || {});
      startCodexPoll();
      await refreshState();
      await loadSessions();
      return;
    }
    runningTag = null;
    codexMode = false;
    pendingCodexImages = [];
    liveCommand = "";
    updateInputMode();
    removeCodexBubble();
  }

  if (runningTag) {
    if (!codexMode) freezeLiveSnapshot();
    else removeCodexBubble();
    if (codexMode) {
      setCodexBubble("", "sent");
      const attachments = pendingCodexImages.slice(0, 8);
      const res = await fetch(`/api/v1/sessions/${activeId}/codex/send`, {
        method: "POST", headers, body: JSON.stringify({ text: cmd, attachments }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) pendingCodexImages = pendingCodexImages.slice(attachments.length);
      if (data.message) {
        addBubble(data.message);
        since = Math.max(since, data.message.created_at);
      }
      pollCodex();
      setTimeout(() => pollCodex(), 300);
      return;
    }
    const now = Date.now() / 1000;
    addBubble({ role: "user", content: cmd, created_at: now });
    pendingLocalUsers.push({ content: cmd, created_at: now });
    since = now;
    scrollFeedBottom();
    createLiveBubble();
    await fetch(`/api/v1/sessions/${activeId}/type`, {
      method: "POST", headers, body: JSON.stringify({ text: cmd }),
    }).catch(() => {});
    pollLive();
    setTimeout(() => pollLive(), 300);
    return;
  }

  const res = await fetch(`/api/v1/sessions/${activeId}/run`, {
    method: "POST", headers, body: JSON.stringify({ command: cmd }),
  });
  const data = await res.json().catch(() => ({}));
  since = Math.max(0, since - 0.001);
  await refreshMessages(false); // render the command bubble
  if (data.tag) {
    if (isLiveCommand(cmd) || isTerminalCommand(cmd)) {
      runningTag = data.tag;
      liveStartedAt = Date.now();
      adoptedLive = false;
      setTerminalMode(isTerminalCommand(cmd), { auto: isTerminalCommand(cmd) });
      liveCommand = cmd;
      startLivePoll(); // monitor for completion (stores output server-side)
    } else {
      pollCommand(data.tag);
    }
  }
  await refreshState();
  if (data.name) sessionTitle.textContent = data.name;
  await loadSessions();
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending) return;
  if (terminalMode && !codexMode) {
    commandInput.value = "";
    hideSuggest();
    await sendKey("Enter");
    return;
  }
  const cmd = commandInput.value.trim();
  if (!cmd || !activeId) return;
  commandInput.value = "";
  hideSuggest();
  sending = true;
  sendBtn.disabled = true;
  commandInput.disabled = true;
  try {
    await sendCommand(cmd);
  } finally {
    sending = false;
    commandInput.disabled = false;
    sendBtn.disabled = false;
    updateInputMode();
    commandInput.focus();
  }
});
composer.addEventListener("paste", (e) => { handlePaste(e); });
commandInput.addEventListener("paste", (e) => { handlePaste(e); });

btnClose.onclick = async () => {
  if (!activeId || !confirm("End session and close remote tmux?")) return;
  await fetch(`/api/v1/sessions/${activeId}?kill=true`, { method: "DELETE" });
  await loadSessions();
  closeUi();
};

// ── Key bar + shortcuts ──
async function sendKey(key) {
  if (!activeId) return;
  const postKey = () => fetch(`/api/v1/sessions/${activeId}/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (terminalMode && !codexMode) {
    flushTerminalText();
    terminalTypeQueue = terminalTypeQueue.then(postKey).then(() => {
      if (runningTag) pollLive();
      else pollTerminal();
    }).catch(() => {});
    return terminalTypeQueue;
  }
  await postKey();
  if (runningTag) pollLive();
  else if (terminalMode) pollTerminal();
}
keybar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-key]");
  if (!btn) return;
  if (btn.dataset.key === "C-c" && runningTag) {
    stopLiveApp();
    return;
  }
  sendKey(btn.dataset.key);
});

document.addEventListener("keydown", (e) => {
  if (!activeId) return;
  const ctrlKeyMap = {
    c: "C-c", d: "C-d", g: "C-g", j: "C-j", k: "C-k", l: "C-l",
    o: "C-o", r: "C-r", s: "C-s", t: "C-t", u: "C-u", w: "C-w", x: "C-x",
    y: "C-y",
  };
  const ctrlKey = (e.ctrlKey || e.metaKey) ? ctrlKeyMap[e.key.toLowerCase()] : null;
  if (ctrlKey) {
    const t = e.target;
    if (ctrlKey === "C-c" && t === commandInput && commandInput.selectionStart !== commandInput.selectionEnd) return;
    e.preventDefault();
    sendKey(ctrlKey);
    return;
  }
});

async function stopLiveApp() {
  if (!activeId) return;
  if (codexMode) {
    await fetch(`/api/v1/sessions/${activeId}/codex/stop`, { method: "POST" });
    codexMode = false;
    pendingCodexImages = [];
    runningTag = null;
    liveStartedAt = 0;
    liveCommand = "";
    stopLivePoll();
    removeCodexBubble();
    updateInputMode();
    since = Math.max(0, since - 0.001);
    await refreshMessages(false);
    await refreshState();
    return;
  }
  const res = await fetch(`/api/v1/sessions/${activeId}/stop`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    if (liveBubble) setLiveContent(escapeHtml(data.output || "Stop failed"));
    updateInputMode();
    await refreshState();
    return;
  }
  runningTag = null;
  liveStartedAt = 0;
  adoptedLive = false;
  setTerminalMode(false, { persist: false });
  liveCommand = "";
  stopLivePoll();
  freezeLiveSnapshot("Stopped");
  updateInputMode();
  since = Math.max(0, since - 0.001);
  await refreshMessages(false);
  await refreshState();
}

// ── Autocomplete ──
async function currentSuggestions(prefix) {
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  const seen = new Set();
  const out = [];

  function add(s) {
    const sl = s.toLowerCase();
    if (sl.startsWith(p) && !seen.has(sl)) {
      seen.add(sl);
      out.push(s);
    }
  }
  function addContext(list) {
    for (const s of list) {
      add(s);
      if (out.length >= 8) break;
    }
  }

  if (p.startsWith("tmux")) return [];
  if (p.startsWith("/")) {
    addContext(SUGGESTIONS.filter((s) => s.startsWith("/")));
  } else if (/^cd(\s|$)/.test(p)) {
    addContext(["cd ..", "cd ~", "cd "]);
  } else {
    addContext(SUGGESTIONS.filter((s) => !s.startsWith("/") && !s.startsWith("tmux")));
  }

  if (activeId && !p.startsWith("tmux")) {
    try {
      if (suggestAbort) suggestAbort.abort();
      suggestAbort = new AbortController();
      const res = await fetch(`/api/v1/sessions/${activeId}/complete?q=${encodeURIComponent(prefix)}`, {
        signal: suggestAbort.signal,
      });
      const data = await res.json();
      for (const s of data.items || []) {
        const sl = s.toLowerCase();
        if (!seen.has(sl)) {
          seen.add(sl);
          out.push(s);
          if (out.length >= 10) break;
        }
      }
    } catch {}
  }
  return out;
}
function showSuggest(list) {
  suggestIndex = -1;
  if (!list.length) { hideSuggest(); return; }
  suggestEl.innerHTML = list.map((s, i) => `<div class="suggest-item" data-i="${i}">${escapeHtml(s)}</div>`).join("");
  suggestEl.classList.add("visible");
}
function hideSuggest() {
  suggestEl.classList.remove("visible");
  suggestEl.innerHTML = "";
  suggestIndex = -1;
}
function acceptSuggest(text) {
  commandInput.value = text;
  hideSuggest();
  commandInput.focus();
  commandInput.setSelectionRange(text.length, text.length);
}
commandInput.addEventListener("input", async () => {
  if (terminalMode && !codexMode) {
    const text = commandInput.value;
    commandInput.value = "";
    hideSuggest();
    sendTerminalText(text);
    return;
  }
  const v = commandInput.value;
  if (!v) { hideSuggest(); return; }
  const list = await currentSuggestions(v);
  if (commandInput.value === v) showSuggest(list);
});
commandInput.addEventListener("keydown", (e) => {
  if (terminalMode && !codexMode) {
    const keyMap = {
      Enter: "Enter", Backspace: "BSpace", Tab: "Tab", Escape: "Escape",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
    };
    const key = keyMap[e.key];
    if (key) {
      e.preventDefault();
      commandInput.value = "";
      hideSuggest();
      sendKey(key);
    }
    return;
  }
  const items = suggestEl.querySelectorAll(".suggest-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex = (suggestIndex + 1) % items.length;
    items.forEach((it, i) => it.classList.toggle("active", i === suggestIndex));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex = (suggestIndex - 1 + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle("active", i === suggestIndex));
  } else if (e.key === "Tab" || (e.key === "Enter" && suggestIndex >= 0)) {
    e.preventDefault();
    const idx = suggestIndex >= 0 ? suggestIndex : 0;
    acceptSuggest(items[idx].textContent);
  } else if (e.key === "Escape") {
    hideSuggest();
  }
});
suggestEl.addEventListener("click", (e) => {
  const item = e.target.closest(".suggest-item");
  if (item) acceptSuggest(item.textContent);
});

window.addEventListener("resize", () => {
  if (!sidebar.classList.contains("collapsed")) sidebarBackdrop.classList.toggle("visible", isMobile());
});

loadSessions();
