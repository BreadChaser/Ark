const ACTIVE_DEVICE_KEY = "ark-active-device";
const ACTIVE_SESSION_KEY = "ark-active-session";
const REPO_BY_DEVICE_KEY = "ark-repo-by-device";
const THEME_KEY = "ark-theme";
const VIEW_KEY = "ark-view-mode";
const DEFAULT_REPO = "~/Development";

const state = {
  devices: [],
  sessions: [],
  tmux: {},
  dirs: [],
  dirCwd: "~",
  dirParent: "~",
  activeDeviceId: localStorage.getItem(ACTIVE_DEVICE_KEY) || "local",
  activeSessionId: localStorage.getItem(ACTIVE_SESSION_KEY) || null,
  poll: null,
  view: localStorage.getItem(VIEW_KEY) || "parsed",
  lastCapture: null,
  adding: false,
};

const els = {
  workspace: document.querySelector(".workspace"),
  devices: document.querySelector("#devices"),
  tmux: document.querySelector("#tmux"),
  dirs: document.querySelector("#dirs"),
  dirCwd: document.querySelector("#dir-cwd"),
  title: document.querySelector("#title"),
  meta: document.querySelector("#meta"),
  status: document.querySelector("#status"),
  sessionPanel: document.querySelector("#session-panel"),
  output: document.querySelector("#output"),
  parsed: document.querySelector("#parsed"),
  repo: document.querySelector("#repo"),
  tool: document.querySelector("#tool"),
  start: document.querySelector("#start"),
  add: document.querySelector("#add-session"),
  closeAdd: document.querySelector("#close-add"),
  browse: document.querySelector("#browse"),
  homeDir: document.querySelector("#home-dir"),
  parentDir: document.querySelector("#parent-dir"),
  refresh: document.querySelector("#refresh"),
  refreshSidebar: document.querySelector("#sidebar-refresh"),
  refreshTmux: document.querySelector("#refresh-tmux"),
  input: document.querySelector("#input"),
  send: document.querySelector("#send"),
  interrupt: document.querySelector("#interrupt"),
  restart: document.querySelector("#restart"),
  resume: document.querySelector("#resume"),
  forget: document.querySelector("#forget"),
  kill: document.querySelector("#kill"),
  viewParsed: document.querySelector("#view-parsed"),
  viewRaw: document.querySelector("#view-raw"),
  theme: document.querySelector("#theme"),
  error: document.querySelector("#error"),
};

init();

async function init() {
  els.theme.value = localStorage.getItem(THEME_KEY) || "dark";
  setTheme(els.theme.value);
  els.theme.addEventListener("change", () => setTheme(els.theme.value));
  els.tool.addEventListener("change", updateStartButton);
  els.add.addEventListener("click", () => setAdding(true));
  els.closeAdd.addEventListener("click", () => setAdding(false));
  els.refresh.addEventListener("click", refresh);
  els.refreshSidebar.addEventListener("click", refresh);
  els.refreshTmux.addEventListener("click", refreshTmux);
  els.browse.addEventListener("click", () => browse(els.repo.value.trim() || "~"));
  els.homeDir.addEventListener("click", () => browse("~"));
  els.parentDir.addEventListener("click", () => browse(state.dirParent || "~"));
  els.start.addEventListener("click", startSession);
  els.send.addEventListener("click", sendInput);
  els.interrupt.addEventListener("click", interruptSession);
  els.restart.addEventListener("click", () => restartSession(false));
  els.resume.addEventListener("click", () => restartSession(true));
  els.forget.addEventListener("click", () => deleteSession(false));
  els.kill.addEventListener("click", () => deleteSession(true));
  els.viewParsed.addEventListener("click", () => setView("parsed"));
  els.viewRaw.addEventListener("click", () => setView("raw"));
  els.repo.addEventListener("change", rememberRepo);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendInput();
  });
  await refresh();
  updateStartButton();
}

async function refresh() {
  clearError();
  const [devices, sessions] = await Promise.all([api("/api/devices"), api("/api/sessions")]);
  state.devices = devices.devices;
  state.sessions = sessions.sessions;

  if (!state.devices.some((device) => device.id === state.activeDeviceId)) {
    state.activeDeviceId = state.devices[0]?.id || "local";
  }
  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }

  loadRememberedRepo();
  renderSidebar();
  await loadTmux(state.activeDeviceId);
  renderMain();
}

async function loadTmux(deviceId) {
  try {
    const data = await api(`/api/devices/${encodeURIComponent(deviceId)}/tmux`);
    state.tmux[deviceId] = data.sessions;
  } catch (error) {
    state.tmux[deviceId] = [];
    showError(error.message);
  }
}

async function refreshTmux() {
  await loadTmux(state.activeDeviceId);
  renderTmuxList();
}

async function browse(path, options = {}) {
  try {
    const data = await api(`/api/devices/${encodeURIComponent(state.activeDeviceId)}/dirs?path=${encodeURIComponent(path || "~")}`);
    state.dirs = data.dirs || [];
    state.dirCwd = data.cwd || path || "~";
    state.dirParent = data.parent || "~";
    els.repo.value = state.dirCwd;
    rememberRepo();
    renderDirs();
  } catch (error) {
    state.dirs = [];
    renderDirs();
    if (!options.quiet) showError(error.message);
  }
}

function renderSidebar() {
  els.devices.innerHTML = "";
  for (const device of state.devices) {
    const item = document.createElement("button");
    item.className = "device" + (device.id === state.activeDeviceId ? " active" : "");
    item.innerHTML = `<span>${escapeHtml(device.label)}</span><small>${escapeHtml(device.status)}</small>`;
    item.onclick = async () => {
      clearError();
      state.activeDeviceId = device.id;
      state.activeSessionId = null;
      localStorage.setItem(ACTIVE_DEVICE_KEY, device.id);
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      loadRememberedRepo();
      renderSidebar();
      await loadTmux(device.id);
      if (state.adding) await browse(els.repo.value.trim() || "~", { quiet: true });
      renderMain();
    };
    els.devices.append(item);

    const owned = state.sessions.filter((session) => session.device_id === device.id);
    for (const session of owned) {
      const child = document.createElement("button");
      child.className = "session" + (session.id === state.activeSessionId ? " active" : "");
      child.innerHTML = `<span>${escapeHtml(session.title || session.tmux_name)}</span><small>${escapeHtml(session.tool || "")}</small>`;
      child.onclick = () => openSession(session.id);
      els.devices.append(child);
    }
  }
}

function renderMain() {
  const device = activeDevice();
  const session = activeSession();
  els.title.textContent = session ? session.title : device?.label || "Ark";
  els.meta.textContent = session
    ? `${session.device_label} / ${session.cwd} / ${session.tmux_name}`
    : "Pick a device and repo, then start or attach a tmux session.";
  els.resume.hidden = !session || session.tool !== "codex";
  setSessionControls(Boolean(session));
  setAdding(state.adding);
  setStatus(session ? "Connecting" : "Idle");
  renderTmuxList();
  renderDirs();
  setView(state.view);

  if (session) {
    startPolling();
  } else {
    stopPolling();
    state.lastCapture = null;
    renderCapture();
  }
}

function renderDirs() {
  els.dirCwd.textContent = state.dirCwd || els.repo.value || DEFAULT_REPO;
  els.dirs.innerHTML = "";
  if (!state.dirs.length) {
    els.dirs.innerHTML = `<div class="empty-state">No child directories.</div>`;
    return;
  }
  for (const dir of state.dirs.slice(0, 120)) {
    const row = document.createElement("button");
    row.className = "dir-row";
    row.textContent = dir.name;
    row.onclick = () => browse(dir.path);
    els.dirs.append(row);
  }
}

function renderTmuxList() {
  const sessions = state.tmux[state.activeDeviceId] || [];
  els.tmux.innerHTML = "";
  if (!sessions.length) {
    els.tmux.innerHTML = `<div class="empty-state">No tmux sessions.</div>`;
    return;
  }
  for (const tmux of sessions) {
    const row = document.createElement("div");
    row.className = "tmux-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(tmux.name)}</strong>
        <small>${escapeHtml(tmux.cwd || "~")} ${escapeHtml(tmux.command || "")}</small>
      </div>
      <button>Attach</button>
    `;
    row.querySelector("button").onclick = () => adoptSession(tmux);
    els.tmux.append(row);
  }
}

async function startSession() {
  clearError();
  const cwd = els.repo.value.trim();
  if (!cwd) return showError("Enter a repo path on the selected device.");
  rememberRepo();
  setStatus("Starting");
  const data = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ device_id: state.activeDeviceId, cwd, tool: els.tool.value }),
  });
  state.sessions = (await api("/api/sessions")).sessions;
  setAdding(false);
  openSession(data.session.id);
  await refreshTmux();
}

async function adoptSession(tmux) {
  clearError();
  const data = await api("/api/sessions/adopt", {
    method: "POST",
    body: JSON.stringify({
      device_id: state.activeDeviceId,
      tmux_name: tmux.name,
      cwd: tmux.cwd || "~",
      tool: inferTool(tmux.command),
    }),
  });
  state.sessions = (await api("/api/sessions")).sessions;
  setAdding(false);
  openSession(data.session.id);
}

function openSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) {
    state.activeDeviceId = session.device_id;
    els.repo.value = session.cwd || els.repo.value;
    rememberRepo();
  }
  state.activeSessionId = sessionId;
  localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  localStorage.setItem(ACTIVE_DEVICE_KEY, state.activeDeviceId);
  renderSidebar();
  renderMain();
}

function startPolling() {
  stopPolling();
  capture();
  state.poll = setInterval(capture, 1800);
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

async function capture() {
  const session = activeSession();
  if (!session) return;
  try {
    const data = await api(`/api/sessions/${session.id}/capture`);
    state.lastCapture = data;
    renderCapture();
    setStatus("Connected");
    clearError();
  } catch (error) {
    setStatus("Disconnected");
    showError(`${error.message}. You can still type, restart, resume, or switch to another session.`);
  }
}

function renderCapture() {
  const data = state.lastCapture;
  els.output.hidden = state.view !== "raw";
  els.parsed.hidden = state.view !== "parsed";
  if (!data) {
    els.output.textContent = "No session selected.";
    els.parsed.innerHTML = `<div class="empty-session">Open a tool for the selected project or attach a tmux session.</div>`;
    return;
  }
  els.output.textContent = data.text || "(empty)";
  els.parsed.innerHTML = "";
  for (const row of data.parsed || []) {
    const line = document.createElement("div");
    line.className = `parsed-line ${row.kind || "text"}`;
    line.textContent = row.text;
    els.parsed.append(line);
  }
  if (!els.parsed.childElementCount) els.parsed.textContent = "(empty)";
  els.output.scrollTop = els.output.scrollHeight;
  els.parsed.scrollTop = els.parsed.scrollHeight;
}

async function sendInput() {
  const session = activeSession();
  if (!session) return showError("Select a session first.");
  const text = els.input.value;
  if (!text.trim()) return;
  els.input.value = "";
  setStatus("Sending");
  await api(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: JSON.stringify({ text, submit: true }),
  });
  await capture();
}

async function interruptSession() {
  const session = activeSession();
  if (!session) return;
  await api(`/api/sessions/${session.id}/interrupt`, { method: "POST" });
  await capture();
}

async function restartSession(resume) {
  const session = activeSession();
  if (!session) return;
  setStatus(resume ? "Resuming" : "Restarting");
  await api(`/api/sessions/${session.id}/restart`, {
    method: "POST",
    body: JSON.stringify({ resume }),
  });
  await Promise.all([refreshTmux(), capture()]);
}

async function deleteSession(kill) {
  const session = activeSession();
  if (!session) return;
  const verb = kill ? "Kill tmux and forget" : "Forget";
  if (!confirm(`${verb} ${session.tmux_name}?`)) return;
  await api(`/api/sessions/${session.id}?kill=${kill ? "true" : "false"}`, { method: "DELETE" });
  state.sessions = (await api("/api/sessions")).sessions;
  state.activeSessionId = state.sessions[0]?.id || null;
  if (state.activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
  await refreshTmux();
  renderSidebar();
  renderMain();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}

function activeDevice() {
  return state.devices.find((item) => item.id === state.activeDeviceId);
}

function activeSession() {
  return state.sessions.find((item) => item.id === state.activeSessionId);
}

function setView(view) {
  state.view = view === "raw" ? "raw" : "parsed";
  localStorage.setItem(VIEW_KEY, state.view);
  els.viewParsed.classList.toggle("active", state.view === "parsed");
  els.viewRaw.classList.toggle("active", state.view === "raw");
  renderCapture();
}

function setSessionControls(enabled) {
  els.workspace.classList.toggle("has-session", enabled);
  els.sessionPanel.classList.toggle("has-session", enabled);
  for (const control of [els.input, els.send, els.interrupt, els.restart, els.resume, els.forget, els.kill]) {
    control.disabled = !enabled;
  }
}

async function setAdding(next) {
  state.adding = next;
  els.workspace.classList.toggle("is-adding", next);
  if (next) {
    await Promise.all([loadTmux(state.activeDeviceId), browse(els.repo.value.trim() || DEFAULT_REPO, { quiet: true })]);
    renderTmuxList();
  }
}

function updateStartButton() {
  const labels = {
    codex: "Open Codex",
    terminal: "Open Terminal",
    opencode: "Open OpenCode",
    claude: "Open Claude",
  };
  els.start.textContent = labels[els.tool.value] || "Open";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function setStatus(status) {
  els.status.textContent = status;
  els.status.dataset.status = status.toLowerCase();
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.textContent = "";
  els.error.hidden = true;
}

function rememberRepo() {
  const data = readRepoMap();
  data[state.activeDeviceId] = els.repo.value.trim();
  localStorage.setItem(REPO_BY_DEVICE_KEY, JSON.stringify(data));
}

function loadRememberedRepo() {
  const data = readRepoMap();
  els.repo.value = data[state.activeDeviceId] || DEFAULT_REPO;
}

function readRepoMap() {
  try {
    return JSON.parse(localStorage.getItem(REPO_BY_DEVICE_KEY) || "{}");
  } catch {
    return {};
  }
}

function inferTool(command) {
  if (command === "codex") return "codex";
  if (command === "opencode") return "opencode";
  if (command === "claude") return "claude";
  return "terminal";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}
