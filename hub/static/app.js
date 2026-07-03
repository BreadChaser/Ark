let sessions = [];
let peers = [];
let activeId = null;
let since = 0;
let pollTimer = null;

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
const machineHint = document.getElementById("machine-hint");

const AVATAR = { system: "⚓", command: "›", output: "⌘", error: "!", user: "U" };

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdownLite(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function showWelcome(show) {
  if (show) {
    if (!document.getElementById("welcome-clone")) {
      const w = welcome.cloneNode(true);
      w.id = "welcome-clone";
      messagesEl.innerHTML = "";
      messagesEl.appendChild(w);
    }
  }
}

function renderMessages(msgs, append = false) {
  if (!append) messagesEl.innerHTML = "";
  if (!msgs.length && !append) {
    showWelcome(true);
    return;
  }
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = `msg-row ${m.role}`;
    const av = AVATAR[m.role] || "·";
    row.innerHTML = `
      <div class="msg-avatar">${av}</div>
      <div>
        <div class="msg-bubble">${renderMarkdownLite(m.content)}</div>
        <div class="msg-time">${fmtTime(m.created_at)}</div>
      </div>`;
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderSidebar() {
  sessionList.innerHTML = "";
  if (!sessions.length) {
    sessionList.innerHTML =
      '<li class="session-empty">No sessions yet.<br>Start one with <strong>+ New session</strong>.</li>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === activeId ? " active" : "");
    li.innerHTML = `
      <div class="session-item-name">${escapeHtml(s.name)}</div>
      <div class="session-item-sub"><span class="machine-tag">${escapeHtml(s.hostname)}</span>${escapeHtml(truncate(s.preview, 40))}</div>`;
    li.onclick = () => openSession(s.id);
    sessionList.appendChild(li);
  }
}

function truncate(s, n) {
  if (!s) return "";
  const t = s.replace(/\n/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function loadSessions() {
  const res = await fetch("/api/v1/sessions");
  sessions = (await res.json()).sessions || [];
  renderSidebar();
  if (activeId) {
    const s = sessions.find((x) => x.id === activeId);
    if (s) {
      sessionTitle.textContent = s.name;
      sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip}`;
    }
  }
}

async function loadPeers() {
  const res = await fetch("/api/v1/peers");
  peers = (await res.json()).peers || [];
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
  machineHint.className = "field-hint";
  machineHint.textContent = p
    ? `${p.dns_name || p.tailscale_ip} · ${p.os}`
    : "";
}

machineSelect.addEventListener("change", updateHint);

async function openSession(id) {
  activeId = id;
  since = 0;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  sessionTitle.textContent = s.name;
  sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip} · ${s.tmux_name}`;
  btnClose.classList.remove("hidden");
  commandInput.disabled = false;
  sendBtn.disabled = false;

  messagesEl.innerHTML = '<div class="session-empty">Loading…</div>';
  renderSidebar();
  await refreshMessages(true);
  startPolling();
  commandInput.focus();
}

async function refreshMessages(full = false) {
  if (!activeId) return;
  const res = await fetch(`/api/v1/sessions/${activeId}/messages?since=${since}`);
  const msgs = (await res.json()).messages || [];
  if (full) {
    renderMessages(msgs);
    if (msgs.length) since = msgs[msgs.length - 1].created_at;
  } else if (msgs.length) {
    renderMessages(msgs, true);
    since = msgs[msgs.length - 1].created_at;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshMessages(false), 1500);
}

function closeUi() {
  activeId = null;
  since = 0;
  if (pollTimer) clearInterval(pollTimer);
  sessionTitle.textContent = "Welcome";
  sessionMeta.textContent = "Open a session on any Tailscale machine";
  btnClose.classList.add("hidden");
  commandInput.disabled = true;
  sendBtn.disabled = true;
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
  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  btn.textContent = "Connecting…";

  try {
    const res = await fetch("/api/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id }),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      throw new Error(detail || "Connection failed");
    }
    dialog.close();
    await loadSessions();
    await openSession(data.session.id);
  } catch (err) {
    machineHint.textContent = err.message;
    machineHint.className = "field-hint err";
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
};

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cmd = commandInput.value.trim();
  if (!cmd || !activeId) return;
  commandInput.value = "";
  sendBtn.disabled = true;

  const res = await fetch(`/api/v1/sessions/${activeId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });
  const data = await res.json();
  since = Math.max(0, since - 0.001);
  await refreshMessages(true);
  await loadSessions();
  if (data.name) sessionTitle.textContent = data.name;
  sendBtn.disabled = false;
  commandInput.focus();
});

btnClose.onclick = async () => {
  if (!activeId || !confirm("End session and close remote tmux?")) return;
  await fetch(`/api/v1/sessions/${activeId}?kill=true`, { method: "DELETE" });
  await loadSessions();
  closeUi();
};

loadSessions();
