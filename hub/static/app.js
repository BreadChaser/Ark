let conversations = [];
let activeId = null;
let pollTimer = null;
let since = 0;

const convList = document.getElementById("conv-list");
const messagesEl = document.getElementById("messages");
const convTitle = document.getElementById("conv-title");
const convMeta = document.getElementById("conv-meta");
const convStatus = document.getElementById("conv-status");
const commandInput = document.getElementById("command-input");
const sendBtn = document.getElementById("send-btn");
const composer = document.getElementById("composer");

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderMarkdownLite(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMessages(msgs) {
  if (!msgs.length && !activeId) return;
  messagesEl.innerHTML = "";
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

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSidebar() {
  convList.innerHTML = "";
  for (const c of conversations) {
    const li = document.createElement("li");
    li.className = "conv-item" + (c.id === activeId ? " active" : "");
    li.dataset.id = c.id;
    li.innerHTML = `
      <div class="conv-name">
        <span class="dot ${c.online ? "on" : "off"}"></span>
        ${escapeHtml(c.hostname)}${c.is_self ? " (you)" : ""}
      </div>
      <div class="conv-preview">${escapeHtml(c.preview || "")}</div>`;
    li.onclick = () => selectConversation(c.id);
    convList.appendChild(li);
  }
}

async function loadConversations() {
  const res = await fetch("/api/v1/conversations");
  const data = await res.json();
  conversations = data.conversations || [];
  renderSidebar();
  if (activeId && !conversations.find((c) => c.id === activeId)) {
    activeId = null;
  }
}

async function loadMessages() {
  if (!activeId) return;
  const res = await fetch(
    `/api/v1/conversations/${activeId}/messages?since=${since}`
  );
  const data = await res.json();
  const msgs = data.messages || [];
  if (msgs.length) {
    since = msgs[msgs.length - 1].created_at;
    const existing = messagesEl.querySelectorAll(".msg").length;
    if (existing === 0) {
      renderMessages(msgs);
    } else {
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
  }
}

function selectConversation(id) {
  activeId = id;
  since = 0;
  const c = conversations.find((x) => x.id === id);
  if (!c) return;

  convTitle.textContent = c.hostname + (c.is_self ? " (this machine)" : "");
  convMeta.textContent = `${c.dns_name || c.tailscale_ip} · ${c.os}`;
  convStatus.textContent = c.online ? "online" : "offline";
  convStatus.className = "status-pill" + (c.online ? " online" : "");

  commandInput.disabled = false;
  sendBtn.disabled = false;
  commandInput.placeholder = c.is_self
    ? "Run a command locally…"
    : `ssh tony@${c.tailscale_ip} — type command…`;

  messagesEl.innerHTML = '<div class="loading">Loading…</div>';
  renderSidebar();
  loadMessages();
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMessages, 2000);
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cmd = commandInput.value.trim();
  if (!cmd || !activeId) return;
  commandInput.value = "";
  sendBtn.disabled = true;

  await fetch(`/api/v1/conversations/${activeId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });

  since = 0;
  messagesEl.innerHTML = "";
  await loadMessages();
  sendBtn.disabled = false;
  commandInput.focus();
});

document.getElementById("btn-refresh").onclick = async () => {
  await loadConversations();
  if (activeId) selectConversation(activeId);
};

loadConversations();
setInterval(loadConversations, 30000);
