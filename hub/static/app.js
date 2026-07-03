let sessions = [];
let peers = [];
let activeId = null;
let since = 0;
let pollTimer = null;

const sessionList = document.getElementById("session-list");
const messagesEl = document.getElementById("messages");
const emptyState = document.getElementById("empty-state");
const sessionTitle = document.getElementById("session-title");
const sessionMeta = document.getElementById("session-meta");
const commandInput = document.getElementById("command-input");
const sendBtn = document.getElementById("send-btn");
const composer = document.getElementById("composer");
const btnClose = document.getElementById("btn-close");
const dialog = document.getElementById("new-dialog");
const machineSelect = document.getElementById("machine-select");
const machineHint = document.getElementById("machine-hint");
const sessionNameInput = document.getElementById("session-name");

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdownLite(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMessages(msgs, append = false) {
  if (!append) {
    messagesEl.innerHTML = "";
    if (!msgs.length) {
      messagesEl.appendChild(emptyState.cloneNode(true));
      return;
    }
  }
  for (const m of msgs) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    div.innerHTML =
      renderMarkdownLite(escapeHtml(m.content)) +
      `<div class="msg-time">${fmtTime(m.created_at)}</div>`;
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderSidebar() {
  sessionList.innerHTML = "";
  if (!sessions.length) {
    const li = document.createElement("li");
    li.className = "conv-preview";
    li.style.padding = "1rem";
    li.style.color = "var(--muted)";
    li.style.fontSize = "0.85rem";
    li.textContent = "No sessions yet";
    sessionList.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "conv-item" + (s.id === activeId ? " active" : "");
    li.innerHTML = `
      <div class="conv-name">${escapeHtml(s.name)}</div>
      <div class="conv-preview">${escapeHtml(s.hostname)} · ${escapeHtml(s.preview || "")}</div>`;
    li.onclick = () => openSession(s.id);
    sessionList.appendChild(li);
  }
}

async function loadSessions() {
  const res = await fetch("/api/v1/sessions");
  const data = await res.json();
  sessions = data.sessions || [];
  renderSidebar();
}

async function loadPeers() {
  const res = await fetch("/api/v1/peers");
  const data = await res.json();
  peers = data.peers || [];
  machineSelect.innerHTML = '<option value="">Choose a machine…</option>';
  for (const p of peers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.disabled = !p.online;
    opt.textContent = `${p.hostname}${p.is_self ? " (hub)" : ""}${p.online ? "" : " — offline"}`;
    machineSelect.appendChild(opt);
  }
}

machineSelect.addEventListener("change", () => {
  const p = peers.find((x) => x.id === machineSelect.value);
  if (!p) {
    machineHint.textContent = "";
    return;
  }
  machineHint.textContent = `${p.dns_name || p.tailscale_ip} · ${p.os}${p.online ? "" : " (offline)"}`;
});

async function openSession(id) {
  activeId = id;
  since = 0;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;

  sessionTitle.textContent = s.name;
  sessionMeta.textContent = `${s.hostname} · ${s.tailscale_ip} · tmux ${s.tmux_name}`;
  btnClose.classList.remove("hidden");
  commandInput.disabled = false;
  sendBtn.disabled = false;
  emptyState.classList.add("hidden");

  messagesEl.innerHTML = '<div class="loading" style="color:var(--muted)">Loading…</div>';
  renderSidebar();
  await refreshMessages(true);
  startPolling();
}

async function refreshMessages(full = false) {
  if (!activeId) return;
  const res = await fetch(`/api/v1/sessions/${activeId}/messages?since=${since}`);
  const data = await res.json();
  const msgs = data.messages || [];
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
  pollTimer = setInterval(() => refreshMessages(false), 2000);
}

function closeUi() {
  activeId = null;
  since = 0;
  if (pollTimer) clearInterval(pollTimer);
  sessionTitle.textContent = "No session open";
  sessionMeta.textContent = "Create a session and pick a machine";
  btnClose.classList.add("hidden");
  commandInput.disabled = true;
  sendBtn.disabled = true;
  messagesEl.innerHTML = "";
  messagesEl.appendChild(emptyState);
  renderSidebar();
}

document.getElementById("btn-new").onclick = async () => {
  await loadPeers();
  sessionNameInput.value = "";
  machineSelect.value = "";
  machineHint.textContent = "";
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
      body: JSON.stringify({
        name: sessionNameInput.value.trim(),
        peer_id,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "failed to create session");
    dialog.close();
    await loadSessions();
    await openSession(data.session.id);
  } catch (err) {
    machineHint.textContent = err.message;
    machineHint.style.color = "var(--bad)";
  } finally {
    btn.disabled = false;
    btn.textContent = "Open session";
  }
};

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cmd = commandInput.value.trim();
  if (!cmd || !activeId) return;
  commandInput.value = "";
  sendBtn.disabled = true;
  await fetch(`/api/v1/sessions/${activeId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });
  since = Math.max(0, since - 0.001);
  await refreshMessages(false);
  sendBtn.disabled = false;
  commandInput.focus();
});

btnClose.onclick = async () => {
  if (!activeId) return;
  if (!confirm("End this session? (tmux on remote machine will be closed)")) return;
  await fetch(`/api/v1/sessions/${activeId}?kill=true`, { method: "DELETE" });
  await loadSessions();
  closeUi();
};

loadSessions();
