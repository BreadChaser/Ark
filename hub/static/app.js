let sessions = [];
let peers = [];
let activeId = null;
let since = 0;
let msgTimer = null;
let liveTimer = null;
let runningTag = null;
let liveStartedAt = 0;
let liveCommand = "";
let liveBubble = null;
let currentSession = null;
let suggestIndex = -1;
let suggestAbort = null;

const sessionList = document.getElementById("session-list");
const messagesEl = document.getElementById("messages");
const welcome = document.getElementById("welcome");
const sessionTitle = document.getElementById("session-title");
const sessionMeta = document.getElementById("session-meta");
const commandInput = document.getElementById("command-input");
const sendBtn = document.getElementById("send-btn");
const composer = document.getElementById("composer");
const btnClose = document.getElementById("btn-close");
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
const suggestEl = document.getElementById("suggest");
const feedEl = document.getElementById("messages");
let tmuxHosts = [];

const COLLAPSE_KEY = "ark-collapsed-machines";
const SIDEBAR_KEY = "ark-sidebar-open";
const SSH_USER_KEY = "ark-ssh-user";

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

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  if (m.role === "command" || m.role === "user") {
    return `<span class="cmd-text">${escapeHtml(m.content.replace(/^\$\s*/, ""))}</span>`;
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

function renderMessages(msgs, append = false) {
  if (!append) messagesEl.innerHTML = "";
  if (!msgs.length && !append) { showWelcome(true); return; }
  showWelcome(false);
  for (const m of msgs) addBubble(m);
  scrollFeedBottom();
}

function scrollFeedBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function createLiveBubble() {
  if (liveBubble) liveBubble.remove();
  liveBubble = document.createElement("div");
  liveBubble.className = "msg-row output live";
  liveBubble.innerHTML = `
    <div class="msg-avatar">⌘</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="live-head">
          <span><span class="live-dot"></span>Live app</span>
          <button type="button" class="btn-stop" id="btn-stop-live">Stop</button>
        </div>
        <div class="live-terminal"><span class="output-ok">running…</span></div>
      </div>
      <div class="msg-time">live</div>
    </div>`;
  messagesEl.appendChild(liveBubble);
  liveBubble.querySelector("#btn-stop-live").onclick = stopLiveApp;
  scrollFeedBottom();
}

function setLiveContent(html) {
  if (!liveBubble) return;
  const b = liveBubble.querySelector(".live-terminal");
  b.innerHTML = html || `<span class="output-ok">running…</span>`;
  const bubble = liveBubble.querySelector(".msg-bubble");
  bubble.scrollTop = bubble.scrollHeight;
  scrollFeedBottom();
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
      li.innerHTML = `<div class="session-item-name">${escapeHtml(s.name)}</div><div class="session-item-sub">${escapeHtml(previewText(s))}</div>`;
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
  for (const p of [...online, ...offline]) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.disabled = !p.online;
    opt.textContent = `${p.hostname}${p.is_self ? " · hub" : ""}${p.online ? "" : " (offline)"}`;
    machineSelect.appendChild(opt);
  }
  if (online.length) machineSelect.value = online[0].id;
  updateHint();
}

function updateHint() {
  const p = peers.find((x) => x.id === machineSelect.value);
  const host = tmuxHosts.find((h) => h.peer.id === machineSelect.value);
  tmuxSelect.innerHTML = '<option value="__new__">New Ark session</option>';
  for (const s of host?.sessions || []) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = `${s.name}${s.ark ? "" : " · external"}${s.attached ? " · attached" : ""}`;
    tmuxSelect.appendChild(opt);
  }
  machineHint.className = "field-hint";
  const user = sshUserInput.value.trim();
  const suffix = user ? ` · ssh ${user}` : "";
  machineHint.textContent = p ? `${p.dns_name || p.tailscale_ip} · ${p.os}${suffix}` : "";
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
  liveCommand = "";
  liveBubble = null;
  stopLivePoll();
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  currentSession = s;
  sessionTitle.textContent = s.name;
  sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip}`;
  btnClose.classList.remove("hidden");
  commandInput.disabled = false;
  sendBtn.disabled = false;
  keybar.classList.add("visible");
  renderSidebar();
  messagesEl.innerHTML = '<div class="session-empty">Loading…</div>';
  await refreshMessages(true);
  await refreshState();
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
  liveTimer = setInterval(pollLive, 700);
  if (isLiveCommand(liveCommand)) {
    createLiveBubble();
    pollLive();
  }
}

function stopLivePoll() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
}

async function pollLive() {
  if (!activeId || !runningTag) return;
  try {
    const shouldRenderPane = liveBubble || isLiveCommand(liveCommand) || Date.now() - liveStartedAt > 1000;
    if (shouldRenderPane) {
      const paneRes = await fetch(`/api/v1/sessions/${activeId}/pane`);
      const pane = await paneRes.json();
      const output = filterLivePane(pane.text || "");
      if (!liveBubble) createLiveBubble();
      setLiveContent(output ? ansiToHtml(output) : "");
    }

    const res = await fetch(`/api/v1/sessions/${activeId}/live?tag=${runningTag}`);
    const d = await res.json();
    if (d.state === "done") {
      stopLivePoll();
      runningTag = null;
      liveStartedAt = 0;
      liveCommand = "";
      if (liveBubble) { liveBubble.remove(); liveBubble = null; }
      since = Math.max(0, since - 0.001);
      await refreshMessages(true);
      await refreshState();
      await loadSessions();
    } else if (d.state === "error") {
      if (liveBubble) setLiveContent(escapeHtml(d.output || "session lost"));
      stopLivePoll();
      runningTag = null;
      liveStartedAt = 0;
      liveCommand = "";
    }
  } catch {}
}

function isLiveCommand(cmd) {
  return /^(codex|opencode|htop|top|btop|vim|vi|nano|less|man|ssh|python3?\s+-i|node\s+-i)\b/.test(String(cmd || "").trim());
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
  liveCommand = "";
  liveBubble = null;
  if (msgTimer) clearInterval(msgTimer);
  stopLivePoll();
  msgTimer = null;
  currentSession = null;
  messagesEl.innerHTML = "";
  sessionTitle.textContent = "Welcome";
  sessionMeta.textContent = "Open a session on any machine";
  btnClose.classList.add("hidden");
  commandInput.disabled = true;
  sendBtn.disabled = true;
  keybar.classList.remove("visible");
  showWelcome(true);
  renderSidebar();
}

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

  if (runningTag) {
    // App is running: send raw input to it (typing into codex / htop).
    await fetch(`/api/v1/sessions/${activeId}/type`, {
      method: "POST", headers, body: JSON.stringify({ text: cmd }),
    });
    since = Math.max(0, since - 0.001);
    await refreshMessages(false);
    await pollLive();
    return;
  }

  const res = await fetch(`/api/v1/sessions/${activeId}/run`, {
    method: "POST", headers, body: JSON.stringify({ command: cmd }),
  });
  const data = await res.json().catch(() => ({}));
  since = Math.max(0, since - 0.001);
  await refreshMessages(false); // render the command bubble
  if (data.tag) {
    runningTag = data.tag;
    liveStartedAt = Date.now();
    liveCommand = cmd;
    startLivePoll(); // monitor for completion (stores output server-side)
  }
  await refreshState();
  if (data.name) sessionTitle.textContent = data.name;
  await loadSessions();
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cmd = commandInput.value.trim();
  if (!cmd || !activeId) return;
  commandInput.value = "";
  hideSuggest();
  sendBtn.disabled = true;
  await sendCommand(cmd);
  sendBtn.disabled = false;
  commandInput.focus();
});

btnClose.onclick = async () => {
  if (!activeId || !confirm("End session and close remote tmux?")) return;
  await fetch(`/api/v1/sessions/${activeId}?kill=true`, { method: "DELETE" });
  await loadSessions();
  closeUi();
};

// ── Key bar + shortcuts ──
async function sendKey(key) {
  if (!activeId) return;
  await fetch(`/api/v1/sessions/${activeId}/keys`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (runningTag) pollLive();
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
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    const t = e.target;
    if (t === commandInput && commandInput.selectionStart !== commandInput.selectionEnd) return;
    e.preventDefault();
    runningTag ? stopLiveApp() : sendKey("C-c");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "l") { e.preventDefault(); sendKey("C-l"); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "d") { e.preventDefault(); sendKey("C-d"); return; }
});

async function stopLiveApp() {
  if (!activeId) return;
  await fetch(`/api/v1/sessions/${activeId}/stop`, { method: "POST" });
  runningTag = null;
  liveStartedAt = 0;
  liveCommand = "";
  stopLivePoll();
  if (liveBubble) { liveBubble.remove(); liveBubble = null; }
  since = Math.max(0, since - 0.001);
  await refreshMessages(true);
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
  const v = commandInput.value;
  if (!v) { hideSuggest(); return; }
  const list = await currentSuggestions(v);
  if (commandInput.value === v) showSuggest(list);
});
commandInput.addEventListener("keydown", (e) => {
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
