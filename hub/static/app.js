const ACTIVE_DEVICE_KEY = "ark-active-device";
const ACTIVE_SESSION_KEY = "ark-active-session";
const REPO_BY_DEVICE_KEY = "ark-repo-by-device";
const THEME_KEY = "ark-theme";
const VIEW_KEY = "ark-view-mode";
const SIDEBAR_COLLAPSED_KEY = "ark-sidebar-collapsed";
const DEFAULT_TOOL_KEY = "ark-default-tool";
const IMAGE_MODE_KEY = "ark-image-mode";
const NOTIFIED_CONTROLS_KEY = "ark-notified-controls";
const DEFAULT_REPO = "~/Development";
const URL_SESSION_ID = new URLSearchParams(window.location.search).get("session");
const storedSidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);

const state = {
  devices: [],
  sessions: [],
  tmux: {},
  tools: {},
  profiles: [],
  secrets: [],
  tmuxErrors: {},
  tmuxLoading: new Set(),
  dirs: [],
  settings: null,
  diagnostics: null,
  startupImages: [],
  dirCwd: "~",
  dirParent: "~",
  activeDeviceId: localStorage.getItem(ACTIVE_DEVICE_KEY) || "local",
  activeSessionId: URL_SESSION_ID || localStorage.getItem(ACTIVE_SESSION_KEY) || null,
  expandedDevices: new Set([localStorage.getItem(ACTIVE_DEVICE_KEY) || "local"]),
  poll: null,
  view: localStorage.getItem(VIEW_KEY) || "parsed",
  lastCapture: null,
  captures: {},
  captureRequests: new Set(),
  chatMessages: {},
  sentChat: {},
  sessionStates: {},
  sessionStatesLoading: false,
  sessionStatePoll: null,
  sessionStateSource: null,
  captureSource: null,
  notifiedControls: new Set((() => {
    try {
      const value = JSON.parse(localStorage.getItem(NOTIFIED_CONTROLS_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  })()),
  dismissedControls: {},
  activeControlKey: null,
  controlFlow: null,
  forceBottomSessionId: null,
  drafts: {},
  attachmentQueues: {},
  adding: false,
  sidebarCollapsed: storedSidebarCollapsed === null
    ? window.matchMedia("(max-width: 760px)").matches
    : storedSidebarCollapsed === "true",
  otherDevicesExpanded: false,
  offlineExpanded: false,
  terminal: null,
  terminalFit: null,
  terminalSource: null,
  terminalSessionId: null,
  terminalResize: null,
  terminalObserver: null,
  audio: null,
};

const els = {
  sidebar: document.querySelector(".sidebar"),
  workspace: document.querySelector(".workspace"),
  main: document.querySelector(".main"),
  devices: document.querySelector("#devices"),
  inputInbox: document.querySelector("#input-inbox"),
  codexFooter: document.querySelector("#codex-footer"),
  tmux: document.querySelector("#tmux"),
  dirs: document.querySelector("#dirs"),
  dirCwd: document.querySelector("#dir-cwd"),
  title: document.querySelector("#title"),
  meta: document.querySelector("#meta"),
  sessionRuntime: document.querySelector("#session-runtime"),
  sessionModel: document.querySelector("#session-model"),
  sessionReasoning: document.querySelector("#session-reasoning"),
  sessionSpeed: document.querySelector("#session-speed"),
  status: document.querySelector("#status"),
  sessionPanel: document.querySelector("#session-panel"),
  sessionKind: document.querySelector("#session-kind"),
  sessionName: document.querySelector("#session-name"),
  sessionDetail: document.querySelector("#session-detail"),
  sessionStorage: document.querySelector("#session-storage"),
  output: document.querySelector("#output"),
  parsed: document.querySelector("#parsed"),
  messageNav: document.querySelector("#message-nav"),
  messagePrevious: document.querySelector("#message-previous"),
  messageNext: document.querySelector("#message-next"),
  xterm: document.querySelector("#xterm"),
  quickActions: document.querySelector("#quick-actions"),
  controlSheet: document.querySelector("#control-sheet"),
  controlClose: document.querySelector("#control-close"),
  controlKind: document.querySelector("#control-kind"),
  controlTitle: document.querySelector("#control-title"),
  controlPrompt: document.querySelector("#control-prompt"),
  controlBody: document.querySelector("#control-body"),
  repo: document.querySelector("#repo"),
  tool: document.querySelector("#tool"),
  profile: document.querySelector("#profile"),
  start: document.querySelector("#start"),
  startupImageButton: document.querySelector("#startup-image-button"),
  startupImageInput: document.querySelector("#startup-image-input"),
  startupImages: document.querySelector("#startup-images"),
  add: document.querySelector("#add-session"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sidebarOpen: document.querySelector("#sidebar-open"),
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
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsMenu: document.querySelector("#settings-menu"),
  settingsRefresh: document.querySelector("#settings-refresh"),
  defaultTool: document.querySelector("#default-tool"),
  defaultView: document.querySelector("#default-view"),
  imageMode: document.querySelector("#image-mode"),
  enableNotifications: document.querySelector("#enable-notifications"),
  notificationStatus: document.querySelector("#notification-status"),
  toolStatus: document.querySelector("#tool-status"),
  profileStatus: document.querySelector("#profile-status"),
  accountForm: document.querySelector("#account-form"),
  accountLabel: document.querySelector("#account-label"),
  accountHome: document.querySelector("#account-home"),
  secretForm: document.querySelector("#secret-form"),
  secretLabel: document.querySelector("#secret-label"),
  secretProvider: document.querySelector("#secret-provider"),
  secretValue: document.querySelector("#secret-value"),
  secretBaseUrl: document.querySelector("#secret-base-url"),
  secretStatus: document.querySelector("#secret-status"),
  diagnostics: document.querySelector("#diagnostics"),
  toolCommandInputs: [...document.querySelectorAll("[data-tool-command]")],
  saveToolCommands: document.querySelector("#save-tool-commands"),
  resetToolCommands: document.querySelector("#reset-tool-commands"),
  attachImage: document.querySelector("#attach-image"),
  imageInput: document.querySelector("#image-input"),
  attachmentQueue: document.querySelector("#attachment-queue"),
  imageViewer: document.querySelector("#image-viewer"),
  imageViewerImage: document.querySelector("#image-viewer-image"),
  imageViewerClose: document.querySelector("#image-viewer-close"),
  error: document.querySelector("#error"),
};

init();

async function init() {
  els.theme.value = localStorage.getItem(THEME_KEY) || "dark";
  els.defaultTool.value = localStorage.getItem(DEFAULT_TOOL_KEY) || "codex";
  els.defaultView.value = state.view;
  els.imageMode.value = "queue";
  els.tool.value = els.defaultTool.value;
  await loadSettings();
  await loadProfiles();
  await loadSecrets();
  setTheme(els.theme.value);
  applySidebarCollapsed();
  els.theme.addEventListener("change", () => setTheme(els.theme.value));
  document.addEventListener("pointerdown", armSounds, { once: true, capture: true });
  document.addEventListener("keydown", armSounds, { once: true, capture: true });
  els.defaultTool.addEventListener("change", () => {
    localStorage.setItem(DEFAULT_TOOL_KEY, els.defaultTool.value);
    els.tool.value = els.defaultTool.value;
    renderProfileOptions();
    updateStartButton();
  });
  els.defaultView.addEventListener("change", () => setView(els.defaultView.value));
  els.imageMode.addEventListener("change", () => localStorage.setItem(IMAGE_MODE_KEY, "queue"));
  els.enableNotifications.addEventListener("click", enableNotifications);
  els.codexFooter.addEventListener("click", toggleGoalAutoResume);
  els.settingsToggle.addEventListener("click", toggleSettings);
  els.settingsRefresh.addEventListener("click", refresh);
  els.saveToolCommands.addEventListener("click", () => saveToolCommands(false));
  els.resetToolCommands.addEventListener("click", () => saveToolCommands(true));
  els.accountForm.addEventListener("submit", createAccount);
  els.profileStatus.addEventListener("click", handleAccountAction);
  els.secretForm.addEventListener("submit", createSecret);
  els.secretStatus.addEventListener("click", handleSecretAction);
  document.addEventListener("click", closeSettingsOutside);
  els.sidebarToggle.addEventListener("click", toggleSidebar);
  els.sidebarOpen.addEventListener("click", toggleSidebar);
  els.main.addEventListener("click", closeSidebarFromMain, true);
  els.tool.addEventListener("change", () => {
    localStorage.setItem(DEFAULT_TOOL_KEY, els.tool.value);
    els.defaultTool.value = els.tool.value;
    renderProfileOptions();
    updateStartButton();
  });
  els.add.addEventListener("click", (event) => openDeviceComposer(state.activeDeviceId, event.currentTarget));
  els.closeAdd.addEventListener("click", () => setAdding(false));
  els.refresh.addEventListener("click", refresh);
  els.refreshSidebar.addEventListener("click", refresh);
  els.refreshTmux.addEventListener("click", refreshTmux);
  els.browse.addEventListener("click", () => browse(els.repo.value.trim() || "~"));
  els.homeDir.addEventListener("click", () => browse("~"));
  els.parentDir.addEventListener("click", () => browse(state.dirParent || "~"));
  els.start.addEventListener("click", startSession);
  els.startupImageButton.addEventListener("click", () => els.startupImageInput.click());
  els.startupImageInput.addEventListener("change", queueStartupImages);
  els.send.addEventListener("click", sendInput);
  els.quickActions.addEventListener("click", sendQuickCommand);
  els.controlSheet.addEventListener("click", sendQuickCommand);
  els.controlClose.addEventListener("click", closeControlSheet);
  els.parsed.addEventListener("click", openImageViewer);
  els.parsed.addEventListener("scroll", updateMessageNav, { passive: true });
  els.messagePrevious.addEventListener("click", () => navigateUserMessage(-1));
  els.messageNext.addEventListener("click", () => navigateUserMessage(1));
  els.attachmentQueue.addEventListener("click", openImageViewer);
  els.imageViewerClose.addEventListener("click", () => els.imageViewer.close());
  els.imageViewer.addEventListener("click", (event) => {
    if (event.target === els.imageViewer) els.imageViewer.close();
  });
  els.imageViewer.addEventListener("close", () => els.imageViewerImage.removeAttribute("src"));
  els.attachImage.addEventListener("click", () => els.imageInput.click());
  els.imageInput.addEventListener("change", attachImages);
  els.interrupt.addEventListener("click", interruptSession);
  els.restart.addEventListener("click", () => restartSession(false));
  els.resume.addEventListener("click", () => restartSession(true));
  els.forget.addEventListener("click", () => deleteSession(false));
  els.kill.addEventListener("click", () => deleteSession(true));
  els.viewParsed.addEventListener("click", () => setView("parsed"));
  els.viewRaw.addEventListener("click", () => setView("raw"));
  els.repo.addEventListener("change", rememberRepo);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendInput();
    }
  });
  els.input.addEventListener("input", saveComposerDraft);
  els.input.addEventListener("paste", pasteImages);
  for (const target of [els.input, els.sessionPanel]) {
    target.addEventListener("dragover", dragFiles);
    target.addEventListener("drop", dropFiles);
  }
  registerNotificationWorker();
  await refresh();
  startSessionStateStream();
  if (state.activeSessionId) collapseSidebarOnMobile();
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
  state.expandedDevices.add(state.activeDeviceId);
  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = null;
  }
  if (!state.activeSessionId && state.sessions.length) {
    state.activeSessionId = state.sessions[0].id;
    localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
  }
  const active = activeSession();
  if (active && state.devices.some((device) => device.id === active.device_id)) {
    state.activeDeviceId = active.device_id;
    state.expandedDevices.add(active.device_id);
    localStorage.setItem(ACTIVE_DEVICE_KEY, active.device_id);
  }

  loadRememberedRepo();
  await loadTmux(state.activeDeviceId);
  state.sessions = (await api("/api/sessions")).sessions;
  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  }
  if (!state.activeSessionId && state.sessions.length) {
    state.activeSessionId = state.sessions[0].id;
    localStorage.setItem(ACTIVE_SESSION_KEY, state.activeSessionId);
  }
  const activeAfterTmux = activeSession();
  if (activeAfterTmux && state.devices.some((device) => device.id === activeAfterTmux.device_id)) {
    state.activeDeviceId = activeAfterTmux.device_id;
    state.expandedDevices.add(activeAfterTmux.device_id);
    localStorage.setItem(ACTIVE_DEVICE_KEY, activeAfterTmux.device_id);
  }
  renderSidebar();
  await loadTools(state.activeDeviceId);
  await loadDiagnostics();
  renderMain();
  loadSidebarTmux();
}

async function loadTmux(deviceId, options = {}) {
  state.tmuxLoading.add(deviceId);
  try {
    const data = await api(`/api/devices/${encodeURIComponent(deviceId)}/tmux`);
    state.tmux[deviceId] = data.sessions;
    if (data.stored_sessions) state.sessions = data.stored_sessions;
    delete state.tmuxErrors[deviceId];
  } catch (error) {
    state.tmux[deviceId] = [];
    state.tmuxErrors[deviceId] = error.message;
    if (!options.silent) showError(error.message);
  } finally {
    state.tmuxLoading.delete(deviceId);
  }
}

async function loadSidebarTmux() {
  const devices = state.devices.filter(canQueryTmux);
  renderSidebar();
  await Promise.all(devices.map((device) => loadTmux(device.id, { silent: true })));
  state.sessions = (await api("/api/sessions")).sessions;
  renderSidebar();
  renderTmuxList();
}

async function loadSessionStates() {
  if (state.sessionStatesLoading) return;
  state.sessionStatesLoading = true;
  try {
    const data = await api("/api/session-states");
    applySessionStates(data.states || []);
  } catch {} finally {
    state.sessionStatesLoading = false;
  }
}

function applySessionStates(states) {
  const previous = state.sessionStates;
  state.sessionStates = Object.fromEntries(states.map((item) => [item.id, item.state]));
  for (const item of states) {
    const session = state.sessions.find((entry) => entry.id === item.id);
    if (!session) continue;
    session.pending_control = item.pending_control || null;
    session.ready_at = Math.max(Number(item.ready_at || 0), Number(session.ready_at || 0));
    session.viewed_at = Math.max(Number(item.viewed_at || 0), Number(session.viewed_at || 0));
    playAgentTransition(previous[item.id], item.state);
    if (item.id === state.activeSessionId && sessionIsDone(session, item.state)) markSessionViewed(session);
  }
  renderSidebar();
}

function startSessionStateStream() {
  state.sessionStateSource?.close();
  if (!("EventSource" in window)) {
    document.body.dataset.sessionStateTransport = "poll";
    loadSessionStates();
    state.sessionStatePoll = setInterval(loadSessionStates, 3000);
    return;
  }
  document.body.dataset.sessionStateTransport = "stream";
  const source = new EventSource("/api/session-states/stream");
  source.onmessage = (event) => applySessionStates(JSON.parse(event.data).states || []);
  source.addEventListener("ark-error", () => {});
  state.sessionStateSource = source;
}

async function refreshTmux() {
  await loadTmux(state.activeDeviceId);
  state.sessions = (await api("/api/sessions")).sessions;
  renderTmuxList();
  renderSidebar();
  renderMain();
}

async function loadSettings() {
  try {
    state.settings = await api("/api/settings");
    renderSettings();
  } catch (error) {
    showError(error.message);
  }
}

async function saveToolCommands(reset) {
  clearError();
  const tool_commands = reset ? {} : Object.fromEntries(
    els.toolCommandInputs.map((input) => [input.dataset.toolCommand, input.value.trim()]),
  );
  try {
    state.settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ tool_commands }),
    });
    renderSettings();
    await loadTools(state.activeDeviceId);
    await loadProfiles();
    await loadDiagnostics();
    setStatus(reset ? "Settings reset" : "Settings saved");
  } catch (error) {
    showError(error.message);
  }
}

async function loadTools(deviceId) {
  try {
    const data = await api(`/api/devices/${encodeURIComponent(deviceId)}/tools`);
    state.tools[deviceId] = data.tools || [];
  } catch {
    state.tools[deviceId] = [];
  }
  renderToolStatus();
  updateToolOptions();
}

async function loadDiagnostics() {
  try {
    state.diagnostics = await api("/api/diagnostics");
  } catch (error) {
    state.diagnostics = { error: error.message };
  }
  renderDiagnostics();
}

async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    state.profiles = data.profiles || [];
  } catch {
    state.profiles = [];
  }
  renderProfileStatus();
  renderProfileOptions();
  renderCodexFooter();
}

async function loadSecrets() {
  try {
    const data = await api("/api/secrets");
    state.secrets = data.secrets || [];
  } catch {
    state.secrets = [];
  }
  renderSecrets();
}

async function browse(path, options = {}) {
  const inputBeforeBrowse = els.repo.value.trim();
  try {
    const data = await api(`/api/devices/${encodeURIComponent(state.activeDeviceId)}/dirs?path=${encodeURIComponent(path || "~")}`);
    state.dirs = data.dirs || [];
    state.dirCwd = data.cwd || path || "~";
    state.dirParent = data.parent || "~";
    if (els.repo.value.trim() === inputBeforeBrowse) {
      els.repo.value = state.dirCwd;
      rememberRepo();
    }
    renderDirs();
  } catch (error) {
    state.dirs = [];
    renderDirs();
    if (!options.quiet) showError(error.message);
  }
}

function renderSidebar() {
  renderInputInbox();
  els.devices.innerHTML = "";
  const offline = [];
  const primary = [];
  const other = [];
  for (const device of state.devices) {
    if (device.status === "offline" || state.tmuxErrors[device.id]) {
      offline.push(device);
      continue;
    }
    const hasSessions = state.sessions.some((session) => session.device_id === device.id)
      || (state.tmux[device.id] || []).length > 0;
    (hasSessions || device.id === state.activeDeviceId ? primary : other).push(device);
  }
  for (const device of primary) renderDeviceGroup(device);
  renderDeviceSection("Other machines", other, "other", state.otherDevicesExpanded, () => {
    state.otherDevicesExpanded = !state.otherDevicesExpanded;
  });
  renderDeviceSection("Offline", offline, "offline", state.offlineExpanded, () => {
    state.offlineExpanded = !state.offlineExpanded;
  });
  renderCodexFooter();
}

function renderCodexFooter() {
  const session = activeSession();
  const profile = state.profiles.find((item) => item.id === session?.runner_id);
  if (session?.tool !== "codex") {
    els.codexFooter.hidden = true;
    return;
  }
  const email = profile?.auth?.email || session.runner_label || "Codex account";
  const label = profile?.label && profile.label !== email ? profile.label : "Codex";
  const usage = accountCodexUsage(session);
  const warning = usageWarning(usage);
  els.codexFooter.hidden = false;
  els.codexFooter.innerHTML = `
    <div class="codex-account">${toolIcon("codex")}<div><strong>${escapeHtml(email)}</strong><small>${escapeHtml(label)}${usage?.plan_type ? ` · ${escapeHtml(usage.plan_type)}` : ""}</small></div></div>
    ${usage ? `<div class="codex-limits">${usageLimit("5h", usage.primary)}${usageLimit("Weekly", usage.secondary)}</div>` : '<small>Usage appears after Codex responds.</small>'}
    ${warning ? `<div class="codex-usage-warning" role="status">${escapeHtml(warning)}</div>` : ""}
    <button class="codex-auto-resume" type="button" data-auto-resume aria-pressed="${Boolean(session.auto_resume_goal)}" title="Send /goal resume after a Codex usage reset">Auto-resume goal: ${session.auto_resume_goal ? "On" : "Off"}</button>
  `;
}

function accountCodexUsage(session) {
  const key = codexAccountKey(session);
  const usage = state.sessions.filter((item) => codexAccountKey(item) === key).map((item) => item.codex_usage).filter(Boolean);
  if (!usage.length) return null;
  const timestamped = usage.filter((item) => Number(item.updated_at) > 0).sort((a, b) => Number(a.updated_at) - Number(b.updated_at));
  if (timestamped.length) return timestamped.at(-1);
  const limit = (name) => usage.map((item) => item[name]).filter(Boolean).sort((a, b) => Number(a.resets_at) - Number(b.resets_at) || Number(a.used_percent) - Number(b.used_percent)).at(-1) || null;
  return { plan_type: usage.findLast((item) => item.plan_type)?.plan_type || "", primary: limit("primary"), secondary: limit("secondary") };
}

function codexAccountKey(session) {
  const device = session?.runner_device_id || session?.tmux_device_id || session?.device_id || "";
  const account = session?.runner_account_home || session?.runner_id || session?.runner_label || session?.id || "";
  return `${device}:${account}`;
}

function usageLimit(label, limit) {
  if (!limit) return "";
  const used = Math.max(0, Math.min(100, Number(limit.used_percent) || 0));
  const reset = limit.resets_at ? ` · resets ${new Date(limit.resets_at * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
  return `<div class="codex-limit${used >= 90 ? " warning" : ""}"><b>${escapeHtml(label)}</b><span><small>${used}% used${escapeHtml(reset)}</small><progress max="100" value="${used}"></progress></span></div>`;
}

function usageWarning(usage) {
  const near = [["5h", usage?.primary], ["Weekly", usage?.secondary]].filter(([, limit]) => Number(limit?.used_percent) >= 90);
  if (!near.length) return "";
  const exhausted = near.some(([, limit]) => Number(limit.used_percent) >= 100);
  return `${near.map(([label]) => label).join(" + ")} usage ${exhausted ? "is exhausted" : "is nearly exhausted"}.`;
}

async function toggleGoalAutoResume(event) {
  const button = event.target.closest("[data-auto-resume]");
  if (!button) return;
  const session = activeSession();
  if (!session || session.tool !== "codex") return;
  button.disabled = true;
  try {
    const enabled = !session.auto_resume_goal;
    const data = await api(`/api/sessions/${session.id}/auto-resume`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    Object.assign(session, data.session);
    renderCodexFooter();
    setStatus(enabled ? "Auto-resume enabled" : "Auto-resume disabled");
  } catch (error) {
    button.disabled = false;
    showError(error.message);
  }
}

function renderInputInbox() {
  const pending = state.sessions.filter((session) => session.pending_control);
  els.inputInbox.hidden = !pending.length;
  document.title = pending.length ? `(${pending.length}) Ark` : "Ark";
  if (!pending.length) {
    els.inputInbox.innerHTML = "";
    return;
  }
  els.inputInbox.innerHTML = `
    <strong>${pending.length} need${pending.length === 1 ? "s" : ""} you</strong>
    ${pending.map((session) => `
      <button type="button" data-pending-session="${escapeHtml(session.id)}">
        <span>${toolIcon(session.tool)}${escapeHtml(sessionDisplayName(session))}</span>
        <small>${escapeHtml(session.pending_control.prompt || session.pending_control.title || "Input needed")}</small>
      </button>
    `).join("")}
  `;
  for (const button of els.inputInbox.querySelectorAll("[data-pending-session]")) {
    button.onclick = () => {
      delete state.dismissedControls[button.dataset.pendingSession];
      openSession(button.dataset.pendingSession);
    };
  }
  for (const session of pending) notifyPendingControl(session);
}

function renderDeviceSection(label, devices, kind, expanded, toggleExpanded) {
  if (!devices.length) return;
  const section = document.createElement("div");
  section.className = `device-section ${kind}-section`;
  const toggle = document.createElement("button");
  toggle.className = "device-section-toggle";
  toggle.textContent = `${expanded ? "v" : ">"} ${label} (${devices.length})`;
  toggle.onclick = () => {
    toggleExpanded();
    renderSidebar();
  };
  section.append(toggle);
  if (expanded) for (const device of devices) renderDeviceGroup(device, section);
  els.devices.append(section);
}

function renderDeviceGroup(device, target = els.devices) {
  const owned = state.sessions.filter((session) => session.device_id === device.id);
  const tmuxSessions = state.tmux[device.id] || [];
  const ownedTmuxNames = new Set(state.sessions
    .filter((session) => (session.tmux_device_id || session.device_id) === device.id)
    .map((session) => session.tmux_name));
  const tmuxOnly = tmuxSessions.filter((tmux) => !ownedTmuxNames.has(tmux.name));
  const expanded = state.expandedDevices.has(device.id);
  const unavailable = device.status === "offline" || Boolean(state.tmuxErrors[device.id]);
  const displayCount = owned.length + tmuxOnly.length;

  const group = document.createElement("div");
  group.className = "device-group" + (device.id === state.activeDeviceId ? " active" : "");
  group.classList.toggle("offline", unavailable);

  const head = document.createElement("div");
  head.className = "device-head";

  const toggle = document.createElement("button");
  toggle.className = "device-toggle";
  toggle.dataset.count = unavailable ? "!" : String(displayCount);
  toggle.title = [device.label, ...deviceDetails(device)].filter(Boolean).join(" / ");
  toggle.innerHTML = `
    <span class="device-initial">${escapeHtml(deviceInitial(device))}</span>
    <span class="device-caret">${expanded ? "v" : ">"}</span>
    <span class="device-label">${escapeHtml(device.label)}</span>
    <small class="device-count" title="${displayCount} session${displayCount === 1 ? "" : "s"}">${displayCount || ""}</small>
  `;
  toggle.onclick = async () => {
    clearError();
    state.activeDeviceId = device.id;
    if (expanded) state.expandedDevices.delete(device.id);
    else state.expandedDevices.add(device.id);
    localStorage.setItem(ACTIVE_DEVICE_KEY, device.id);
    loadRememberedRepo();
    renderSidebar();
    if (canQueryTmux(device)) await loadTmux(device.id);
    if (canQueryTmux(device)) await loadTools(device.id);
    if (state.adding && canQueryTmux(device)) await browse(els.repo.value.trim() || "~", { quiet: true });
    renderMain();
  };

  const add = document.createElement("button");
  add.className = "device-add";
  add.title = `New session on ${device.label}`;
  add.textContent = "+";
  add.disabled = unavailable;
  add.onclick = (event) => openDeviceComposer(device.id, event.currentTarget);

  head.append(toggle, add);
  group.append(head);

  const menu = document.createElement("div");
  menu.className = "device-sessions";
  menu.hidden = !expanded;
  if (!owned.length && !tmuxOnly.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = unavailable ? deviceSummary(device) : "No tmux sessions";
    menu.append(empty);
  }
  for (const session of owned) {
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.sessionId = session.id;
    row.draggable = true;
    const child = document.createElement("button");
    const stopped = sessionIsStopped(session);
    const agentState = sessionStateName(session, stopped);
    child.className = `session agent-${agentState}` + (session.id === state.activeSessionId ? " active" : "") + (stopped ? " stopped" : "");
    child.innerHTML = `<span class="session-label">${toolIcon(session.tool)}<span>${escapeHtml(sessionDisplayName(session))}</span></span><small class="session-state" title="${escapeHtml(sessionStateLabel(session, agentState) || toolLabel(session.tool))}">${escapeHtml(sessionStateLabel(session, agentState))}</small>`;
    child.title = sessionDetail(session);
    if (session.id === state.activeSessionId) child.setAttribute("aria-current", "page");
    child.onclick = () => openSession(session.id);
    child.ondblclick = (event) => { event.preventDefault(); renameSession(session); };
    const actions = document.createElement("span");
    actions.className = "session-actions";
    actions.innerHTML = `
      <button type="button" data-session-rename title="Rename" aria-label="Rename ${escapeHtml(sessionDisplayName(session))}"><svg class="edit-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.5 2.5 14l2.5-.5L13 5.5 10.5 3 3 11.5Z"/><path d="m9.5 4 2.5 2.5"/></svg></button>
    `;
    actions.querySelector("[data-session-rename]").onclick = () => renameSession(session);
    row.ondragstart = (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", session.id);
      row.classList.add("dragging");
    };
    row.ondragend = () => row.classList.remove("dragging");
    row.ondragover = (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; row.classList.add("drop-target"); };
    row.ondragleave = () => row.classList.remove("drop-target");
    row.ondrop = (event) => {
      event.preventDefault();
      row.classList.remove("drop-target");
      dropSession(event.dataTransfer.getData("text/plain"), session.id, event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2);
    };
    row.append(child, actions);
    menu.append(row);
  }
  for (const tmux of tmuxOnly) {
    const child = document.createElement("button");
    child.className = "session tmux-session";
    child.innerHTML = `<span class="session-label">${toolIcon(inferTool(tmux.command))}<span>${escapeHtml(tmux.name)}</span></span>`;
    child.onclick = () => adoptSessionForDevice(device.id, tmux);
    menu.append(child);
  }
  group.append(menu);
  target.append(group);
}

function sessionStateName(session, stopped) {
  if (stopped) return "stopped";
  if (session.tool === "terminal") return "terminal";
  const value = state.sessionStates[session.id];
  if (sessionIsDone(session, value)) return "done";
  return ["working", "needs_input", "ready", "unknown"].includes(value) ? value : "unknown";
}

function sessionIsDone(session, value) {
  return value === "ready" && Number(session?.ready_at || 0) > Number(session?.viewed_at || 0);
}

function sessionStateLabel(session, value) {
  return {
    working: "working",
    done: "done",
    needs_input: "needs input",
    ready: "ready",
    stopped: "stopped",
    terminal: "",
    unknown: "",
  }[value];
}

function renderMain() {
  const device = activeDevice();
  const session = activeSession();
  bindComposerToSession(session?.id || "");
  const stopped = sessionIsStopped(session);
  els.title.innerHTML = session
    ? `${toolIcon(session.tool)}<span>${escapeHtml(sessionDisplayName(session))}</span>`
    : escapeHtml(device?.label || "Ark");
  els.meta.textContent = session
    ? sessionHeaderDetail(session)
    : "Pick a device and repo, then start or attach a tmux session.";
  els.meta.title = session ? sessionDetail(session) : "";
  renderSessionSummary(session, device);
  renderSessionRuntime(session);
  els.resume.hidden = !session || session.tool !== "codex";
  els.resume.textContent = session?.codex_session_id ? "Resume" : session?.central_runner ? "Choose resume" : "Resume last";
  setSessionControls(Boolean(session), stopped);
  setAdding(state.adding);
  renderStartupImages();
  setStatus(session ? stopped ? "Stopped" : "Connecting" : "Idle");
  renderTmuxList();
  renderDirs();
  renderToolStatus();
  updateToolOptions();
  renderAttachmentQueue();
  setView(state.view);

  if (session) {
    loadChatMessages(session);
    if (stopped) {
      stopPolling();
      stopTerminalStream();
    } else {
      startPolling();
    }
  } else {
    stopPolling();
    state.lastCapture = null;
    renderCapture();
  }
}

function renderSessionRuntime(session) {
  const runtime = session?.tool === "codex" ? session.codex_state : null;
  els.sessionRuntime.hidden = !runtime?.model;
  if (!runtime?.model) return;
  els.sessionModel.textContent = runtime.model;
  els.sessionReasoning.textContent = runtime.reasoning_effort ? `${runtime.reasoning_effort} reasoning` : "Reasoning unknown";
  els.sessionSpeed.textContent = runtime.service_tier === "priority" ? "fast speed" : runtime.service_tier ? "standard speed" : "speed unknown";
}

function renderSessionSummary(session, device) {
  els.sessionKind.textContent = session ? toolLabel(session.tool || "terminal") : "No session";
  els.sessionName.textContent = session ? session.title : device?.label || "Pick a machine";
  els.sessionDetail.textContent = session
    ? sessionDetail(session)
    : "Open or attach a tmux session.";
  els.sessionStorage.textContent = session?.storage_path ? "Stored in Ark session files" : "";
  els.sessionStorage.title = session?.storage_path || "";
}

function sessionDetail(session) {
  const detail = `${session.device_label} / ${session.cwd} / ${session.tmux_name}`;
  return [detail, sessionRunnerDetail(session)].filter(Boolean).join(" / ");
}

function sessionHeaderDetail(session) {
  const device = String(session.device_label || "").replace(/\s+\(local\)$/i, "");
  return [device, session.cwd].filter(Boolean).join(" / ");
}

function sessionRunnerDetail(session) {
  if (!session || session.tool === "terminal") return "";
  const bits = [];
  if (session.runner_label) bits.push(session.runner_label);
  if (session.runner_account_home) bits.push(session.runner_account_home.replace(/^\/home\/[^/]+/, "~"));
  if (session.central_runner) bits.push(`controller on ${session.runner_device_label || "Ark host"}; target via SSH`);
  return bits.join(" / ");
}

function sessionIsStopped(session) {
  if (!session) return false;
  const deviceId = session.tmux_device_id || session.device_id;
  const sessions = state.tmux[deviceId];
  return Array.isArray(sessions)
    && !state.tmuxErrors[deviceId]
    && !sessions.some((tmux) => tmux.name === session.tmux_name);
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

function renderToolStatus() {
  const tools = state.tools[state.activeDeviceId] || [];
  if (!tools.length) {
    els.toolStatus.textContent = "Tool status unavailable.";
    return;
  }
  els.toolStatus.innerHTML = tools.map((tool) => `
    <div class="tool-card ${tool.available ? "available" : "missing"}">
      <span>${escapeHtml(toolLabel(tool.tool))}</span>
      <small>${tool.available ? escapeHtml(toolStatusLine(tool)) : "missing - set command below"}</small>
    </div>
  `).join("");
}

function toolStatusLine(tool) {
  const bits = [];
  if (tool.runner_label) bits.push(tool.runner_label);
  if (tool.runner_account_home) bits.push(tool.runner_account_home.replace(/^\/home\/[^/]+/, "~"));
  if (tool.path) bits.push(tool.path);
  return bits.join(" / ") || "built in";
}

function renderDiagnostics() {
  if (!state.diagnostics || state.diagnostics.error) {
    els.diagnostics.textContent = state.diagnostics?.error || "Diagnostics unavailable.";
    return;
  }
  const available = new Map();
  for (const device of state.diagnostics.tool_devices || []) {
    for (const tool of device.tools || []) {
      if (!tool.available || tool.tool === "terminal") continue;
      if (!available.has(tool.tool)) available.set(tool.tool, []);
      available.get(tool.tool).push(device.label);
    }
  }
  els.diagnostics.innerHTML = ["codex", "opencode", "claude"].map((tool) => {
    const labels = available.get(tool) || [];
    return `
      <div class="diagnostic-row ${labels.length ? "ok" : "missing"}">
        <span>${escapeHtml(toolLabel(tool))}</span>
        <small>${escapeHtml(labels.length ? labels.join(", ") : "not found on reachable machines")}</small>
      </div>
    `;
  }).join("") + `
    <div class="diagnostic-row ok">
      <span>Devices</span>
      <small>${escapeHtml(`${state.diagnostics.device_count || 0} saved to ${state.diagnostics.device_inventory_path || "devices.yml"}`)}</small>
    </div>
  `;
}

function renderSettings() {
  const commands = state.settings?.tool_commands || {};
  for (const input of els.toolCommandInputs) {
    input.value = commands[input.dataset.toolCommand] || "";
  }
}

function updateToolOptions() {
  const tools = state.tools[state.activeDeviceId] || [];
  const available = new Map(tools.map((tool) => [tool.tool, tool.available]));
  for (const select of [els.tool, els.defaultTool]) {
    for (const option of select.options) {
      const ok = available.size ? available.get(option.value) !== false : true;
      option.disabled = !ok;
      option.textContent = `${toolLabel(option.value)}${ok ? "" : " (missing)"}`;
    }
    if (select.selectedOptions[0]?.disabled) select.value = "terminal";
  }
  localStorage.setItem(DEFAULT_TOOL_KEY, els.defaultTool.value);
  renderProfileOptions();
  updateStartButton();
}

function renderProfileOptions() {
  const current = els.profile.value;
  const tool = els.tool.value;
  const profiles = state.profiles.filter((profile) => profile.tool === tool && profile.enabled !== false);
  els.profile.innerHTML = `<option value="">Auto profile</option>` + profiles.map((profile) => `
    <option value="${escapeHtml(profile.id)}" ${profile.available === false ? "disabled" : ""}>${escapeHtml(profileOptionLabel(profile))}</option>
  `).join("");
  els.profile.disabled = tool === "terminal" || !profiles.length;
  if (profiles.some((profile) => profile.id === current && profile.available !== false)) els.profile.value = current;
}

function renderProfileStatus() {
  if (!els.profileStatus) return;
  const profiles = state.profiles
    .filter((profile) => profile.tool === "codex" && profile.enabled !== false)
    .sort((a, b) => Number(Boolean(b.auth?.signed_in)) - Number(Boolean(a.auth?.signed_in)) || String(a.label).localeCompare(String(b.label)));
  if (!profiles.length) {
    els.profileStatus.textContent = "No Codex profiles configured.";
    return;
  }
  els.profileStatus.innerHTML = profiles.map((profile) => `
    <div class="tool-card account-card ${accountCardClass(profile)}">
      <div class="account-card-main">
        <span>${escapeHtml(profile.label || profile.id)}</span>
        <small>${escapeHtml(profileStatusLine(profile))}</small>
      </div>
      <div class="account-actions">
        <button type="button" data-profile-login="${escapeHtml(profile.id)}">Login</button>
        <button type="button" data-profile-delete="${escapeHtml(profile.id)}">Remove</button>
      </div>
    </div>
  `).join("");
}

function accountCardClass(profile) {
  if (profile.status === "needs-login") return "needs-login";
  if (profile.available === false) return "missing";
  return profile.auth?.signed_in ? "available signed-in" : "needs-login";
}

async function createAccount(event) {
  event.preventDefault();
  clearError();
  const label = els.accountLabel.value.trim();
  if (!label) return showError("Enter an account name.");
  try {
    const data = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ label, account_home: els.accountHome.value.trim() }),
    });
    state.profiles = data.profiles || [];
    els.accountLabel.value = "";
    els.accountHome.value = "";
    renderProfileStatus();
    renderProfileOptions();
    await loadTools(state.activeDeviceId);
    await loadDiagnostics();
    setStatus("Account added");
  } catch (error) {
    showError(error.message);
  }
}

async function handleAccountAction(event) {
  const button = event.target.closest("button[data-profile-delete], button[data-profile-login]");
  if (!button) return;
  const id = button.dataset.profileDelete || button.dataset.profileLogin;
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return;
  if (button.dataset.profileLogin) return startAccountLogin(profile);
  if (!confirm(`Remove ${profile.label || profile.id} from Ark? Auth files stay on disk.`)) return;
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.profiles = data.profiles || [];
    renderProfileStatus();
    renderProfileOptions();
    await loadTools(state.activeDeviceId);
    await loadDiagnostics();
    setStatus("Account removed");
  } catch (error) {
    showError(error.message);
  }
}

async function startAccountLogin(profile) {
  clearError();
  setStatus("Starting login");
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(profile.id)}/login`, { method: "POST" });
    state.sessions = (await api("/api/sessions")).sessions;
    closeSettings();
    setAdding(false);
    openSession(data.session.id);
    await refreshTmux();
    setStatus("Login opened");
  } catch (error) {
    showError(error.message);
  }
}

function renderSecrets() {
  if (!els.secretStatus) return;
  if (!state.secrets.length) {
    els.secretStatus.textContent = "No API keys stored.";
    return;
  }
  els.secretStatus.innerHTML = state.secrets.map((secret) => `
    <div class="tool-card account-card ${secret.last_status === "ok" ? "available" : secret.last_status === "failed" ? "missing" : "needs-login"}">
      <div class="account-card-main">
        <span>${escapeHtml(secret.label || secret.id)}</span>
        <small>${escapeHtml(secretStatusLine(secret))}</small>
      </div>
      <div class="account-actions">
        <button type="button" data-secret-test="${escapeHtml(secret.id)}">Test</button>
        <button type="button" data-secret-delete="${escapeHtml(secret.id)}">Remove</button>
      </div>
    </div>
  `).join("");
}

function secretStatusLine(secret) {
  const bits = [secret.provider || "custom", secret.mask || "stored"];
  if (secret.last_status === "ok") bits.push("works");
  if (secret.last_status === "stored") bits.push("stored; not live-tested");
  if (secret.last_status === "failed") bits.push(`failed${secret.last_error ? `: ${secret.last_error}` : ""}`);
  if (secret.base_url) bits.push(secret.base_url);
  return bits.join(" / ");
}

async function createSecret(event) {
  event.preventDefault();
  clearError();
  const label = els.secretLabel.value.trim();
  const value = els.secretValue.value.trim();
  if (!label) return showError("Enter a key name.");
  if (!value) return showError("Paste an API key.");
  try {
    const data = await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({
        label,
        value,
        provider: els.secretProvider.value,
        base_url: els.secretBaseUrl.value.trim(),
      }),
    });
    state.secrets = data.secrets || [];
    els.secretLabel.value = "";
    els.secretValue.value = "";
    els.secretBaseUrl.value = "";
    renderSecrets();
    await loadDiagnostics();
    setStatus("API key added");
  } catch (error) {
    showError(error.message);
  }
}

async function handleSecretAction(event) {
  const button = event.target.closest("button[data-secret-test], button[data-secret-delete]");
  if (!button) return;
  const id = button.dataset.secretTest || button.dataset.secretDelete;
  const secret = state.secrets.find((item) => item.id === id);
  if (!secret) return;
  try {
    if (button.dataset.secretTest) {
      setStatus("Testing key");
      const data = await api(`/api/secrets/${encodeURIComponent(id)}/test`, { method: "POST" });
      state.secrets = state.secrets.map((item) => item.id === id ? data.secret : item);
      renderSecrets();
      setStatus(data.secret.last_status === "ok" ? "Key works" : "Key failed");
      return;
    }
    if (!confirm(`Remove ${secret.label || secret.id}?`)) return;
    const data = await api(`/api/secrets/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.secrets = data.secrets || [];
    renderSecrets();
    await loadDiagnostics();
    setStatus("API key removed");
  } catch (error) {
    showError(error.message);
  }
}

function profileOptionLabel(profile) {
  const detail = profile.auth?.email || (profile.auth?.signed_in === false ? "needs login" : shortAccountHome(profile));
  return `${profile.label || profile.id}${detail ? ` - ${detail}` : ""}${profile.available === false ? " (missing)" : ""}`;
}

function profileStatusLine(profile) {
  const bits = [];
  if (profile.auth?.email) bits.push(`Signed in as ${profile.auth.email}`);
  else if (profile.tool === "codex") bits.push("Needs login");
  const account = shortAccountHome(profile);
  if (account) bits.push(`CODEX_HOME ${account}`);
  if (profile.path) bits.push(profile.path);
  if (profile.status && profile.status !== "available") bits.push(profile.status);
  return bits.join(" / ") || profile.command || "default Codex account";
}

function shortAccountHome(profile) {
  const home = profile.runner_account_home || profile.account_home || profile.env?.CODEX_HOME || "";
  return home.replace(/^\/home\/[^/]+/, "~");
}

async function startSession() {
  clearError();
  const cwd = els.repo.value.trim();
  if (!cwd) return showError("Enter a repo path on the selected device.");
  rememberRepo();
  setStatus("Starting");
  try {
    const images = await uploadStartupImages();
    const data = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ device_id: state.activeDeviceId, cwd, tool: els.tool.value, profile_id: els.profile.value, images }),
    });
    state.sessions = (await api("/api/sessions")).sessions;
    state.startupImages = [];
    renderStartupImages();
    setAdding(false);
    openSession(data.session.id);
    await refreshTmux();
  } catch (error) {
    setStatus("Idle");
    showError(error.message);
  }
}

function queueStartupImages() {
  state.startupImages.push(...els.startupImageInput.files);
  els.startupImageInput.value = "";
  renderStartupImages();
}

function renderStartupImages() {
  if (!state.startupImages.length) {
    els.startupImages.textContent = "No startup images.";
    return;
  }
  els.startupImages.innerHTML = state.startupImages.map((file, index) => `
    <button type="button" data-remove-startup-image="${index}">
      <span>${escapeHtml(file.name)}</span>
      <small>remove</small>
    </button>
  `).join("");
  for (const button of els.startupImages.querySelectorAll("[data-remove-startup-image]")) {
    button.onclick = () => {
      state.startupImages.splice(Number(button.dataset.removeStartupImage), 1);
      renderStartupImages();
    };
  }
}

async function uploadStartupImages() {
  const uploads = [];
  const uploadDeviceId = selectedToolRunsCentrally() ? "local" : state.activeDeviceId;
  for (const file of state.startupImages) {
    const form = new FormData();
    form.append("image", file);
    const upload = await api(`/api/devices/${encodeURIComponent(uploadDeviceId)}/images`, { method: "POST", body: form });
    uploads.push(upload.path);
  }
  return uploads;
}

function selectedToolRunsCentrally() {
  const device = activeDevice();
  return Boolean(device && !device.local && els.tool.value !== "terminal");
}

async function adoptSessionForDevice(deviceId, tmux) {
  state.activeDeviceId = deviceId;
  state.expandedDevices.add(deviceId);
  localStorage.setItem(ACTIVE_DEVICE_KEY, deviceId);
  loadRememberedRepo();
  renderSidebar();
  await adoptSession(tmux);
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
  await refreshTmux();
}

function openSession(sessionId) {
  if (state.activeSessionId !== sessionId) hideControlSheet();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session) {
    state.activeDeviceId = session.device_id;
    state.expandedDevices.add(session.device_id);
    els.repo.value = session.cwd || els.repo.value;
    rememberRepo();
    markSessionViewed(session);
  }
  state.activeSessionId = sessionId;
  state.forceBottomSessionId = sessionId;
  bindComposerToSession(sessionId);
  state.lastCapture = state.captures[sessionId] || null;
  state.adding = false;
  localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  localStorage.setItem(ACTIVE_DEVICE_KEY, state.activeDeviceId);
  collapseSidebarOnMobile();
  renderSidebar();
  renderMain();
}

function markSessionViewed(session) {
  session.viewed_at = Math.floor(Date.now() / 1000);
  api(`/api/sessions/${encodeURIComponent(session.id)}/read`, { method: "POST" })
    .then((data) => Object.assign(session, data.session))
    .catch(() => {});
}

async function openDeviceComposer(deviceId, anchor) {
  clearError();
  state.activeDeviceId = deviceId || state.activeDeviceId;
  state.expandedDevices.add(state.activeDeviceId);
  localStorage.setItem(ACTIVE_DEVICE_KEY, state.activeDeviceId);
  positionComposer(anchor);
  loadRememberedRepo();
  renderSidebar();
  await loadTmux(state.activeDeviceId);
  await loadTools(state.activeDeviceId);
  await setAdding(true);
  collapseSidebarOnMobile();
  renderMain();
}

function startPolling() {
  stopPolling();
  if (!("EventSource" in window)) {
    els.sessionPanel.dataset.captureTransport = "poll";
    capture();
    state.poll = setInterval(capture, 1800);
    return;
  }
  els.sessionPanel.dataset.captureTransport = "stream";
  const sessionId = activeSession()?.id;
  if (!sessionId) return;
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/capture/stream`);
  source.onopen = () => setStatus("Connected");
  source.onmessage = (event) => applyCapture(sessionId, JSON.parse(event.data));
  source.addEventListener("ark-error", async (event) => {
    const error = JSON.parse(event.data);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (error.status === 410 && activeSession()?.id === sessionId) await recoverMissingSession(session);
    else if (activeSession()?.id === sessionId) showError(error.detail || "Capture stream failed");
  });
  source.onerror = () => {
    if (activeSession()?.id === sessionId) setStatus("Reconnecting");
  };
  state.captureSource = source;
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  state.captureSource?.close();
  state.captureSource = null;
}

async function capture() {
  const session = activeSession();
  if (!session || state.captureRequests.has(session.id)) return;
  state.captureRequests.add(session.id);
  try {
    const data = await api(`/api/sessions/${session.id}/capture`);
    applyCapture(session.id, data);
  } catch (error) {
    if (error.status === 410 || (error.status === 404 && error.message.startsWith("Unknown session:"))) {
      if (activeSession()?.id === session.id) await recoverMissingSession(session);
      return;
    }
    if (activeSession()?.id !== session.id) return;
    setStatus("Disconnected");
    showError(`${error.message}. You can still type, restart, resume, or switch to another session.`);
  } finally {
    state.captureRequests.delete(session.id);
  }
}

function applyCapture(sessionId, data) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || activeSession()?.id !== sessionId) return;
  if (data.mode === "chat") state.chatMessages[session.id] = data.messages || [];
  const nextAgentState = data.pending_control ? "needs_input" : data.agent_state;
  const stateChanged = nextAgentState && state.sessionStates[session.id] !== nextAgentState;
  const pendingChanged = session.pending_control?.id !== data.pending_control?.id;
  if (nextAgentState) {
    playAgentTransition(state.sessionStates[session.id], nextAgentState);
    state.sessionStates[session.id] = nextAgentState;
  }
  session.pending_control = data.pending_control || null;
  if (data.codex_state?.model) session.codex_state = data.codex_state;
  if (data.codex_usage) session.codex_usage = data.codex_usage;
  state.captures[session.id] = data;
  state.lastCapture = data;
  renderSessionRuntime(session);
  renderCodexFooter();
  renderCapture();
  if (stateChanged || pendingChanged) renderSidebar();
  setStatus("Connected");
  clearError();
}

async function recoverMissingSession(session) {
  stopPolling();
  stopTerminalStream();
  const deviceId = session.tmux_device_id || session.device_id;
  if (Array.isArray(state.tmux[deviceId])) {
    state.tmux[deviceId] = state.tmux[deviceId].filter((tmux) => tmux.name !== session.tmux_name);
  }
  showError("This tmux session stopped. Its history is safe; use Resume to continue it.");
  renderSidebar();
  renderMain();
}

function renderCapture() {
  const data = state.lastCapture;
  const session = activeSession();
  const keepParsedBottom = state.forceBottomSessionId === session?.id || isNearBottom(els.parsed);
  const keepRawBottom = isNearBottom(els.output);
  if (session && data?.tool && session.tool !== data.tool) {
    session.tool = data.tool;
    session.title = data.title || session.title;
    renderSidebar();
  }
  const mode = data?.mode || (session?.tool && session.tool !== "terminal" ? "chat" : "terminal");
  if (mode !== "chat" && state.view !== "parsed") {
    state.view = "parsed";
    localStorage.setItem(VIEW_KEY, state.view);
    els.defaultView.value = state.view;
  }
  const storedMessages = state.chatMessages[session?.id] || [];
  const wantsLiveTerminal = shouldUseLiveTerminal(session, mode);
  const useLiveTerminal = wantsLiveTerminal && startTerminalStream(session);
  els.output.hidden = state.view !== "raw" || useLiveTerminal;
  els.xterm.hidden = !useLiveTerminal;
  els.parsed.hidden = state.view !== "parsed" || useLiveTerminal;
  els.sessionPanel.classList.toggle("live-terminal", useLiveTerminal);
  if (!useLiveTerminal) stopTerminalStream();
  if (useLiveTerminal || mode !== "chat" || state.view !== "parsed") hideControlSheet();
  els.sessionPanel.dataset.mode = mode;
  updateQuickActions(session, mode);
  updateViewLabels(mode);
  els.parsed.classList.toggle("chat-output", mode === "chat");
  els.parsed.classList.toggle("terminal-view", mode !== "chat");
  if (useLiveTerminal) {
    hideMessageNav();
    els.output.textContent = data?.text || "(live terminal active)";
    if (keepRawBottom) scrollToBottom(els.output);
    return;
  }
  if (!data && mode === "chat" && storedMessages.length) {
    els.output.textContent = "(messages loaded)";
    renderChatCapture({ messages: storedMessages }, session, keepParsedBottom);
    return;
  }
  if (!data) {
    hideMessageNav();
    els.output.textContent = "No session selected.";
    const device = activeDevice();
    els.parsed.innerHTML = `
      <div class="empty-session">
        <span>No session open</span>
        <strong>${escapeHtml(device?.label || "Pick a machine")}</strong>
        <p>Use the + beside a machine to start Codex, a terminal, OpenCode, or Claude. Existing tmux sessions show under each machine.</p>
      </div>
    `;
    return;
  }
  els.output.textContent = data.text || "(empty)";
  if (keepRawBottom) scrollToBottom(els.output);
  if (mode === "chat") {
    renderControlSheet(data.controls || []);
    renderChatCapture(data, session, keepParsedBottom);
    return;
  }
  hideControlSheet();
  renderTerminalCapture(data, keepParsedBottom);
}

function renderTerminalCapture(data, keepBottom) {
  hideMessageNav();
  els.parsed.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "terminal-screen";
  for (const row of data.lines || data.parsed || []) {
    const line = document.createElement("div");
    line.className = `terminal-line ${row.kind || "text"}`;
    line.dataset.kind = row.kind === "prompt" ? "prompt" : "out";
    line.textContent = row.text;
    screen.append(line);
  }
  els.parsed.append(screen.childElementCount ? screen : emptySurface("No captured output yet."));
  if (keepBottom) scrollToBottom(els.parsed);
}

function renderChatCapture(data, session, keepBottom) {
  els.parsed.innerHTML = "";
  const stream = document.createElement("div");
  stream.className = "chat-stream";
  const messages = mergeLocalChatMessages(state.chatMessages[session?.id] || data.messages || [], state.sentChat[session?.id] || [])
    .filter((message) => !isChatJunk(message));
  let previousRole = "";
  for (const message of messages) {
    const card = document.createElement("article");
    card.className = `chat-message ${message.role || "assistant"}${message.pending ? " pending" : ""}`;
    const continued = message.role === previousRole;
    if (continued) card.classList.add("continued");
    card.setAttribute("aria-label", message.role === "user" ? "You" : message.role === "system" ? "System" : toolLabel(session?.tool || "assistant"));
    const role = document.createElement("div");
    role.className = "message-role";
    if (message.role === "user" || message.role === "system") {
      role.textContent = message.role === "user" ? "You" : "System";
    } else {
      role.innerHTML = toolIcon(session?.tool || "terminal");
      role.title = toolLabel(session?.tool || "assistant");
    }
    role.hidden = continued;
    const text = document.createElement("div");
    text.className = "message-text";
    text.innerHTML = renderMarkdown(message.text);
    for (const link of text.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    for (const image of text.querySelectorAll("img")) {
      image.classList.add("message-image");
      image.loading = "lazy";
      let link = image.closest("a");
      if (!link) {
        link = document.createElement("a");
        link.href = image.src;
        link.rel = "noopener noreferrer";
        link.title = "Open full image";
        image.replaceWith(link);
        link.append(image);
      }
      link.removeAttribute("target");
      link.dataset.imageViewer = "";
    }
    card.append(role, text);
    const images = messageImages(message, session);
    if (images.length) {
      const gallery = document.createElement("div");
      gallery.className = "message-images";
      gallery.innerHTML = images.map((image) => `
        <a href="${escapeHtml(image.url)}" rel="noopener noreferrer" title="Open full image" data-image-viewer>
          <img class="message-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}" loading="lazy" />
        </a>
      `).join("");
      card.append(gallery);
    }
    const files = (message.attachments || []).filter((attachment) => !isImageAttachment(attachment));
    if (files.length) {
      const attachments = document.createElement("div");
      attachments.className = "message-attachments";
      attachments.innerHTML = files.map((attachment) => `
        <span title="${escapeHtml(attachment.path || "")}">${escapeHtml(attachment.name || attachment.path || "attachment")}</span>
      `).join("");
      card.append(attachments);
    }
    stream.append(card);
    previousRole = message.role;
  }
  els.parsed.append(stream.childElementCount ? stream : emptySurface("No chat output yet."));
  if (keepBottom) scrollToBottom(els.parsed);
  if (state.forceBottomSessionId === session?.id) state.forceBottomSessionId = null;
  updateMessageNav();
}

function hideMessageNav() {
  els.messageNav.hidden = true;
  els.sessionPanel.classList.remove("has-message-nav");
}

function updateMessageNav() {
  const messages = [...els.parsed.querySelectorAll(".chat-message.user")];
  const visible = els.parsed.classList.contains("chat-output") && !els.parsed.hidden && messages.length > 1;
  els.messageNav.hidden = !visible;
  els.sessionPanel.classList.toggle("has-message-nav", visible);
  if (!visible) return;
  const positions = messages.map(messageOffset);
  const threshold = els.parsed.scrollTop + 32;
  const previous = positions.findLastIndex((top) => top < threshold);
  els.messagePrevious.disabled = previous <= 0 && (previous < 0 || Math.abs(positions[previous] - els.parsed.scrollTop) < 56);
  els.messageNext.disabled = !positions.some((top) => top > threshold);
}

function navigateUserMessage(direction) {
  const messages = [...els.parsed.querySelectorAll(".chat-message.user")];
  if (!messages.length) return;
  const positions = messages.map(messageOffset);
  const threshold = els.parsed.scrollTop + 32;
  let index;
  if (direction < 0) {
    index = positions.findLastIndex((top) => top < threshold);
    if (index >= 0 && Math.abs(positions[index] - els.parsed.scrollTop) < 56) index--;
  } else {
    index = positions.findIndex((top) => top > threshold);
  }
  if (index < 0) return updateMessageNav();
  els.parsed.scrollTo({ top: Math.max(0, positions[index] - 12), behavior: "smooth" });
}

function messageOffset(message) {
  return message.getBoundingClientRect().top - els.parsed.getBoundingClientRect().top + els.parsed.scrollTop;
}

function isChatJunk(message) {
  const text = String(message.text || "").trim();
  if (text.startsWith("ARK_CONTROL:")) return true;
  if (/^bash:\s+.*:\s+command not found$/i.test(text)) return true;
  if (/Working with untrusted contents|Press enter to continue/i.test(text)) return true;
  if (/^gpt-[\w.-]+\s+(?:low|medium|high|xhigh|extra\s*high)\b.*(?:\/|~)/i.test(text)) return true;
  if (message.role !== "system") return false;
  if (/^Started\s+\w+\s+session\b/i.test(text)) return true;
  return /^[\w.@~-]+:.*[$#](\s+.*)?$/i.test(text);
}

function mergeLocalChatMessages(messages, local) {
  const seen = new Set(messages.map((message) => `${message.role}:${message.text.trim()}`));
  const merged = [...messages];
  for (const message of local) {
    const key = `${message.role}:${message.text.trim()}`;
    if (!seen.has(key)) merged.push(message);
  }
  return merged;
}

function emptySurface(text) {
  const empty = document.createElement("div");
  empty.className = "surface-empty";
  empty.textContent = text;
  return empty;
}

function isNearBottom(element) {
  return !element || element.hidden || element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

function scrollToBottom(element) {
  element.scrollTop = element.scrollHeight;
}

async function sendInput() {
  const session = activeSession();
  if (!session) return showError("Select a session first.");
  if (els.input.dataset.sessionId !== session.id) {
    bindComposerToSession(session.id);
    return showError("Chat changed before send. Your draft was kept in its original chat.");
  }
  const attachments = [...attachmentQueue(session.id)];
  const typed = els.input.value.trimEnd();
  const attachmentText = attachments.map((item) => attachmentLine(item, session)).join("\n");
  const text = [typed, attachmentText].filter(Boolean).join("\n");
  if (!text.trim()) return;
  if (session.tool !== "terminal") {
    state.sessionStates[session.id] = "working";
    renderSidebar();
  }
  els.input.value = "";
  state.drafts[session.id] = "";
  clearAttachmentQueue(session.id);
  const pendingId = `pending-${Date.now()}`;
  if (session.tool !== "terminal") {
    (state.sentChat[session.id] ||= []).push({ id: pendingId, role: "user", text, attachments, pending: true });
    renderCapture();
  }
  setStatus("Sending");
  try {
    const sent = await api(`/api/sessions/${session.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text, submit: true, attachments }),
    });
    if (session.tool !== "terminal") {
      state.sentChat[session.id] = (state.sentChat[session.id] || []).filter((message) => message.id !== pendingId);
      if (sent.message) state.chatMessages[session.id] = mergeLocalChatMessages(state.chatMessages[session.id] || [], [sent.message]);
      renderCapture();
    }
    await capture();
  } catch (error) {
    state.sentChat[session.id] = (state.sentChat[session.id] || []).filter((message) => message.id !== pendingId);
    state.drafts[session.id] = [typed, state.drafts[session.id]].filter(Boolean).join("\n");
    state.attachmentQueues[session.id] = [...attachments, ...attachmentQueue(session.id)];
    if (activeSession()?.id === session.id) {
      els.input.value = state.drafts[session.id];
      renderAttachmentQueue();
    }
    renderCapture();
    setStatus("Disconnected");
    showError(error.message);
  }
}

async function sendQuickCommand(event) {
  if (event.target.closest("[data-control-close]")) {
    await closeControlSheet();
    return;
  }
  if (event.target.closest("[data-open-terminal]")) {
    hideControlSheet();
    setView("raw");
    requestAnimationFrame(() => state.terminal?.focus());
    return;
  }
  const button = event.target.closest("[data-command], [data-key]");
  if (!button) return;
  event.preventDefault();
  const command = button.dataset.command || "";
  const key = button.dataset.key || "";
  if (!command && !key) return;
  const owner = button.closest("#quick-actions, #control-sheet")?.dataset.sessionId || "";
  if (!owner || owner !== activeSession()?.id) {
    hideControlSheet();
    return showError("That control belonged to another chat. Nothing was sent.");
  }
  if (els.quickActions.contains(button)) {
    delete state.dismissedControls[owner];
    const pending = activeSession()?.pending_control;
    const requested = command.replace(/^\//, "");
    if (pending && (pending.kind === requested || requested === "model" && pending.kind === "reasoning")) {
      renderControlSheet([pending]);
      return;
    }
  }
  const controlKind = button.closest("#control-sheet")?.dataset.controlKind || "";
  if (key === "Escape") {
    state.controlFlow = { sessionId: owner, expected: "__done__", until: Date.now() + 3000 };
    renderControlLoading("Closing Codex menu…");
  } else if (controlKind === "model") {
    state.controlFlow = { sessionId: owner, expected: "reasoning", until: Date.now() + 6000 };
    renderControlLoading("Loading reasoning options…");
  } else if (controlKind === "reasoning") {
    state.controlFlow = { sessionId: owner, expected: "__done__", until: Date.now() + 3500 };
    renderControlLoading("Applying model and reasoning…");
  } else if (controlKind) {
    state.controlFlow = { sessionId: owner, expected: "__done__", until: Date.now() + 3000 };
    renderControlLoading("Sending choice…");
  }
  const menuIndex = ["approval", "model", "reasoning", "permissions"].includes(controlKind) && /^\d+$/.test(command) ? Number(command) : 0;
  await sendControlCommand(menuIndex ? "" : command, key, owner, menuIndex);
}

async function sendControlCommand(command, key = "", sessionId = activeSession()?.id, menuIndex = 0) {
  const session = activeSession();
  if (!session) return showError("Select a session first.");
  if (!sessionId || session.id !== sessionId) return showError("Chat changed before send. Nothing was sent.");
  setStatus("Sending");
  try {
    await api(`/api/sessions/${session.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: command, key, menu_index: menuIndex || undefined, submit: true, attachments: [], control: true }),
    });
    await capture();
    for (const delay of [350, 900, 1800]) setTimeout(() => capture().catch(() => {}), delay);
  } catch (error) {
    state.controlFlow = null;
    setStatus("Disconnected");
    showError(error.message);
  }
}

function renderControlSheet(controls) {
  const control = controls.find((item) => item && item.kind);
  const sessionId = activeSession()?.id;
  const flow = state.controlFlow?.sessionId === sessionId && state.controlFlow.until > Date.now() ? state.controlFlow : null;
  if (state.controlFlow && !flow) state.controlFlow = null;
  if (flow?.expected === "__done__" && !control) {
    state.controlFlow = null;
    return hideControlSheet();
  }
  if (flow && control?.kind !== flow.expected) return renderControlLoading(flow.expected === "reasoning" ? "Loading reasoning options…" : "Applying choice…");
  if (flow && control?.kind === flow.expected) state.controlFlow = null;
  if (!control) return hideControlSheet();
  els.controlSheet.dataset.sessionId = sessionId || "";
  els.controlSheet.dataset.controlKind = control.kind || "";
  const controlKey = control.kind === "status" ? "status" : JSON.stringify(control);
  state.activeControlKey = controlKey;
  if (sessionId && state.dismissedControls[sessionId] === controlKey) return hideControlSheet();
  els.controlSheet.hidden = false;
  els.controlKind.textContent = control.kind;
  els.controlTitle.textContent = control.title || "Choose";
  els.controlPrompt.textContent = control.prompt || "";
  const cancel = ["model", "reasoning", "permissions"].includes(control.kind) ? `
    <button type="button" class="control-choice control-secondary" data-key="Escape">
      <span>Cancel menu</span>
      <small>Explicitly send Escape to Codex.</small>
    </button>
  ` : "";
  const terminal = `
    <button type="button" class="control-choice control-secondary" data-open-terminal>
      <span>Open terminal</span>
      <small>Use the full keyboard if this prompt was not mapped correctly.</small>
    </button>
  `;
  if (Array.isArray(control.choices) && control.choices.length) {
    els.controlBody.innerHTML = control.choices.map((choice, index) => `
      <button type="button" class="control-choice ${choice.current ? "current" : ""}" ${choice.key ? `data-key="${escapeHtml(choice.key)}"` : `data-command="${escapeHtml(choice.value)}"`}>
        <span class="control-choice-title"><b>${index + 1}</b>${escapeHtml(choice.label)}${choice.current ? " <em>Current</em>" : choice.default ? " <em>Default</em>" : ""}</span>
        <small>${escapeHtml(choice.description || "")}</small>
      </button>
    `).join("") + cancel + terminal;
    return;
  }
  els.controlBody.innerHTML = (control.fields || []).map((field) => `
    <div class="control-field">
      <span>${escapeHtml(field.label)}</span>
      <strong>${escapeHtml(field.value)}</strong>
    </div>
  `).join("") + (control.kind === "status" ? "" : terminal);
}

function renderControlLoading(message) {
  const sessionId = activeSession()?.id || "";
  els.controlSheet.dataset.sessionId = sessionId;
  els.controlSheet.dataset.controlKind = "loading";
  els.controlSheet.hidden = false;
  els.controlKind.textContent = "Codex";
  els.controlTitle.textContent = message;
  els.controlPrompt.textContent = "The next Codex menu will appear here automatically.";
  els.controlBody.innerHTML = '<div class="control-loading">Waiting for Codex…</div>';
}

function hideControlSheet(dismiss = false) {
  const sessionId = els.controlSheet.dataset.sessionId;
  if (dismiss && sessionId && state.activeControlKey) state.dismissedControls[sessionId] = state.activeControlKey;
  els.controlSheet.hidden = true;
  els.controlBody.innerHTML = "";
  els.controlSheet.dataset.sessionId = "";
  els.controlSheet.dataset.controlKind = "";
  state.activeControlKey = null;
}

function closeControlSheet() {
  hideControlSheet(true);
}

async function loadChatMessages(session) {
  if (!session || session.tool === "terminal") return;
  try {
    const data = await api(`/api/sessions/${session.id}/messages`);
    state.chatMessages[session.id] = data.messages || [];
    if (activeSession()?.id === session.id) renderCapture();
  } catch {}
}

async function attachImages() {
  const session = activeSession();
  const files = [...els.imageInput.files];
  els.imageInput.value = "";
  await attachImageFiles(files, session);
}

async function pasteImages(event) {
  const files = [...(event.clipboardData?.files || [])];
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!files.length && text) files.push(new File([text], "clipboard.txt", { type: "text/plain" }));
  if (!files.length) return;
  event.preventDefault();
  await attachImageFiles(files, activeSession());
}

async function attachImageFiles(files, session) {
  if (!session || !files.length) return;
  clearError();
  setStatus("Uploading");
  try {
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      const upload = await api(`/api/sessions/${session.id}/attachments`, { method: "POST", body: form });
      attachmentQueue(session.id).push(upload);
    }
    if (activeSession()?.id === session.id) {
      renderAttachmentQueue();
      setStatus(attachmentQueueStatus(session.id));
    }
  } catch (error) {
    setStatus("Disconnected");
    showError(error.message);
  }
}

async function dropFiles(event) {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  await attachImageFiles(files, activeSession());
}

function dragFiles(event) {
  if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
}

function attachmentQueue(sessionId = activeSession()?.id) {
  if (!sessionId) return [];
  return state.attachmentQueues[sessionId] ||= [];
}

function attachmentQueueStatus(sessionId = activeSession()?.id) {
  const count = attachmentQueue(sessionId).length;
  return `${count} attachment${count === 1 ? "" : "s"} queued`;
}

function renderAttachmentQueue() {
  const attachments = attachmentQueue();
  if (!attachments.length) {
    els.attachmentQueue.hidden = true;
    els.attachmentQueue.innerHTML = "";
    return;
  }
  els.attachmentQueue.hidden = false;
  els.attachmentQueue.innerHTML = attachments.map((attachment, index) => {
    const name = attachment.name || attachment.path || "attachment";
    if (isImageAttachment(attachment)) return `
      <div class="attachment-preview">
        <img class="message-image" src="${escapeHtml(attachment.url || attachmentUrl(activeSession(), attachment))}" alt="${escapeHtml(name)}" />
        <span>${escapeHtml(name)}</span>
        <button type="button" data-remove-attachment="${index}" aria-label="Remove ${escapeHtml(name)}">×</button>
      </div>
    `;
    return `
      <button type="button" class="attachment-file" data-remove-attachment="${index}" aria-label="Remove ${escapeHtml(name)}">
        <span>${escapeHtml(name)}</span><small aria-hidden="true">×</small>
      </button>
    `;
  }).join("");
  for (const button of els.attachmentQueue.querySelectorAll("[data-remove-attachment]")) {
    button.onclick = () => {
      attachments.splice(Number(button.dataset.removeAttachment), 1);
      renderAttachmentQueue();
      setStatus(attachments.length ? attachmentQueueStatus() : "Ready");
    };
  }
}

function clearAttachmentQueue(sessionId = activeSession()?.id) {
  if (sessionId) state.attachmentQueues[sessionId] = [];
  if (!sessionId || activeSession()?.id === sessionId) renderAttachmentQueue();
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

function canQueryTmux(device) {
  return device.local || device.status !== "offline";
}

function deviceSummary(device) {
  if (device.status === "offline") return "offline";
  if (state.tmuxLoading.has(device.id) && !state.tmux[device.id]) return "...";
  if (state.tmuxErrors[device.id]) return "unreachable";
  const count = (state.tmux[device.id] || []).length;
  return `${count} session${count === 1 ? "" : "s"}`;
}

function deviceDetails(device) {
  const details = [];
  if (device.source) details.push(device.source);
  if (device.os) details.push(device.os);
  if (device.user && device.host) details.push(`${device.user}@${device.host}`);
  else if (device.host) details.push(device.host);
  if (device.dns_name && device.dns_name !== device.host) details.push(device.dns_name);
  if (device.last_seen) details.push(`seen ${formatDate(device.last_seen)}`);
  return details;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(state.sidebarCollapsed));
  applySidebarCollapsed();
}

function collapseSidebarOnMobile() {
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  state.sidebarCollapsed = true;
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "true");
  applySidebarCollapsed();
}

function closeSidebarFromMain(event) {
  if (!window.matchMedia("(max-width: 760px)").matches || state.sidebarCollapsed) return;
  event.preventDefault();
  event.stopPropagation();
  collapseSidebarOnMobile();
}

function applySidebarCollapsed() {
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.sidebarOpen.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  els.sidebarToggle.textContent = state.sidebarCollapsed ? "Open" : "Collapse";
  els.sidebarToggle.title = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
}

function positionComposer(anchor) {
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const maxTop = Math.max(76, window.innerHeight - 620);
  const top = Math.max(76, Math.min(rect.top - 28, maxTop));
  document.documentElement.style.setProperty("--composer-top", `${Math.round(top)}px`);
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { "content-type": "application/json" };
  const response = await fetch(path, {
    headers,
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
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
  els.defaultView.value = state.view;
  els.viewParsed.classList.toggle("active", state.view === "parsed");
  els.viewRaw.classList.toggle("active", state.view === "raw");
  renderCapture();
}

function updateViewLabels(mode) {
  els.viewParsed.parentElement.hidden = mode !== "chat";
  const label = mode === "chat" ? "Chat" : "Terminal";
  els.viewParsed.textContent = label;
  els.viewRaw.textContent = "Terminal";
  els.input.placeholder = mode === "chat" ? `Message ${toolLabel(activeSession()?.tool || "Codex")}...` : "Run command... Enter sends.";
}

function setSessionControls(enabled, stopped = false) {
  els.workspace.classList.toggle("has-session", enabled);
  els.sessionPanel.classList.toggle("has-session", enabled);
  for (const control of [els.input, els.send, els.attachImage, els.interrupt, els.restart, els.resume, els.forget, els.kill]) {
    control.disabled = !enabled;
  }
  for (const control of [els.input, els.send, els.attachImage, els.interrupt]) control.disabled = !enabled || stopped;
  for (const control of els.quickActions.querySelectorAll("button")) control.disabled = !enabled;
}

function updateQuickActions(session, mode) {
  els.quickActions.dataset.sessionId = session?.id || "";
  els.quickActions.hidden = !(session && mode === "chat" && session.tool === "codex" && state.view === "parsed");
}

async function setAdding(next) {
  state.adding = Boolean(next);
  els.workspace.classList.toggle("is-adding", state.adding);
  els.closeAdd.hidden = false;
  if (!state.adding) {
    state.startupImages = [];
    renderStartupImages();
  }
  if (state.adding) {
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

function toolLabel(tool) {
  return {
    codex: "Codex",
    terminal: "Terminal",
    opencode: "OpenCode",
    claude: "Claude",
  }[tool] || tool;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  if (state.terminal) state.terminal.options.theme = terminalTheme();
}

function toggleSettings(event) {
  event.stopPropagation();
  const open = els.settingsMenu.hidden;
  els.settingsMenu.hidden = !open;
  els.settingsToggle.setAttribute("aria-expanded", String(open));
}

function closeSettingsOutside(event) {
  if (els.settingsMenu.hidden) return;
  if (els.settingsMenu.contains(event.target) || els.settingsToggle.contains(event.target)) return;
  els.settingsMenu.hidden = true;
  els.settingsToggle.setAttribute("aria-expanded", "false");
}

function setStatus(status) {
  els.status.textContent = status;
  els.status.dataset.status = status.toLowerCase();
}

function agentSoundKind(previous, next) {
  if (previous === "working" && next === "ready") return "done";
  if (previous && previous !== "needs_input" && next === "needs_input") return "input";
  return "";
}

function armSounds() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  state.audio ||= new AudioContext();
  if (state.audio.state === "suspended") state.audio.resume().catch(() => {});
}

function playAgentTransition(previous, next) {
  const kind = agentSoundKind(previous, next);
  if (!kind || !state.audio) return;
  const play = () => {
    const now = state.audio.currentTime;
    const notes = kind === "done" ? [[659, 0, 0.12], [880, 0.11, 0.18]] : [[220, 0, 0.1], [165, 0.12, 0.16]];
    for (const [frequency, delay, duration] of notes) {
      const oscillator = state.audio.createOscillator();
      const gain = state.audio.createGain();
      oscillator.type = kind === "done" ? "sine" : "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(kind === "done" ? 0.09 : 0.12, now + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
      oscillator.connect(gain).connect(state.audio.destination);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + duration);
    }
  };
  if (state.audio.state === "suspended") state.audio.resume().then(play).catch(() => {});
  else play();
}

async function registerNotificationWorker() {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js").catch(() => {});
  renderNotificationSetting();
}

function renderNotificationSetting() {
  const available = window.isSecureContext && "Notification" in window && "serviceWorker" in navigator;
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  els.enableNotifications.disabled = !available || permission === "granted";
  els.enableNotifications.textContent = permission === "granted" ? "Input notifications enabled" : "Enable input notifications";
  els.notificationStatus.textContent = !available
    ? "Notifications require HTTPS or localhost. The in-app input inbox still works."
    : permission === "denied"
      ? "Notifications are blocked in this browser's site settings."
      : permission === "granted"
        ? "This device will alert you when a session needs input."
        : "Ark can notify this device when a session needs you.";
}

async function enableNotifications() {
  if (!(window.isSecureContext && "Notification" in window)) return renderNotificationSetting();
  await Notification.requestPermission();
  renderNotificationSetting();
  if (Notification.permission === "granted") for (const session of state.sessions.filter((item) => item.pending_control)) notifyPendingControl(session);
}

async function notifyPendingControl(session) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const token = `${session.id}:${session.pending_control.id}:${session.pending_control.first_seen_at || ""}`;
  if (state.notifiedControls.has(token)) return;
  state.notifiedControls.add(token);
  const recent = [...state.notifiedControls].slice(-100);
  state.notifiedControls = new Set(recent);
  localStorage.setItem(NOTIFIED_CONTROLS_KEY, JSON.stringify(recent));
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  const options = {
    body: `${sessionDisplayName(session)}: ${session.pending_control.prompt || session.pending_control.title || "Input needed"}`,
    tag: `ark-input-${session.id}`,
    data: { url: `/?session=${encodeURIComponent(session.id)}` },
    icon: "/static/ark-logo.svg?v=3",
  };
  if (registration) await registration.showNotification("Ark needs input", options);
  else new Notification("Ark needs input", options);
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.textContent = "";
  els.error.hidden = true;
}

function appendInput(text) {
  const prefix = els.input.value && !els.input.value.endsWith("\n") ? "\n" : "";
  els.input.value += `${prefix}${text}\n`;
  saveComposerDraft();
  els.input.focus();
}

function messageImages(message, session) {
  const attachments = [...(Array.isArray(message.attachments) ? message.attachments : [])];
  const known = new Set(attachments.map((attachment) => attachment.path).filter(Boolean));
  for (const line of String(message.text || "").split("\n")) {
    const path = line.match(/^\s*(?:#\s*)?Attached file:\s+(.+?)\s*$/i)?.[1];
    if (path && !known.has(path)) attachments.push({ path });
  }
  return attachments.filter(isImageAttachment).map((attachment) => ({
    name: attachment.name || attachmentFilename(attachment) || "Attached image",
    url: attachment.url || attachmentUrl(session, attachment),
  })).filter((attachment) => attachment.url);
}

function openImageViewer(event) {
  const image = event.target.closest("img.message-image") || event.target.closest("[data-image-viewer]")?.querySelector("img");
  if (!image) return;
  event.preventDefault();
  els.imageViewerImage.src = image.src;
  els.imageViewerImage.alt = image.alt || "Full-size image";
  if (!els.imageViewer.open) els.imageViewer.showModal();
}

function isImageAttachment(attachment) {
  return String(attachment?.type || "").startsWith("image/")
    || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(attachmentFilename(attachment));
}

function attachmentFilename(attachment) {
  return String(attachment?.path || attachment?.name || "").split(/[\\/]/).pop();
}

function sessionDisplayName(session) {
  const title = String(session?.title || session?.tmux_name || "Session");
  return title.replace(/^(?:codex|terminal|opencode|claude)\s*-\s*/i, "");
}

async function renameSession(session) {
  const title = prompt("Rename session", sessionDisplayName(session));
  if (title === null || !title.trim() || title.trim() === sessionDisplayName(session)) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: title.trim() }),
    });
    Object.assign(session, data.session);
    renderSidebar();
    renderMain();
  } catch (error) {
    showError(error.message);
  }
}

function dropSession(sourceId, targetId, after) {
  if (!sourceId || sourceId === targetId) return;
  const target = state.sessions.find((item) => item.id === targetId);
  const sessions = state.sessions.filter((item) => item.device_id === target?.device_id);
  const source = sessions.find((item) => item.id === sourceId);
  if (!target || !source) return;
  sessions.splice(sessions.indexOf(source), 1);
  sessions.splice(sessions.indexOf(target) + Number(after), 0, source);
  saveSessionOrder(target.device_id, sessions);
}

async function saveSessionOrder(deviceId, sessions) {
  sessions.forEach((session, index) => { session.sort_order = index; });
  let index = 0;
  state.sessions = state.sessions.map((session) => session.device_id === deviceId ? sessions[index++] : session);
  renderSidebar();
  try {
    state.sessions = (await api("/api/sessions/order", {
      method: "PUT",
      body: JSON.stringify({ device_id: deviceId, ids: sessions.map((session) => session.id) }),
    })).sessions;
    renderSidebar();
  } catch (error) {
    state.sessions = (await api("/api/sessions")).sessions;
    renderSidebar();
    showError(error.message);
  }
}

function toolIcon(tool) {
  const name = ["codex", "terminal", "opencode", "claude"].includes(tool) ? tool : "terminal";
  return `<svg class="tool-icon" role="img" aria-label="${escapeHtml(toolLabel(name))}"><use href="#tool-${name}"></use></svg>`;
}

function attachmentUrl(session, attachment) {
  const filename = attachmentFilename(attachment);
  if (!session?.id || !filename) return "";
  return `/api/sessions/${encodeURIComponent(session.id)}/attachments/${encodeURIComponent(filename)}`;
}

function saveComposerDraft() {
  const sessionId = els.input.dataset.sessionId;
  if (sessionId) state.drafts[sessionId] = els.input.value;
}

function bindComposerToSession(sessionId) {
  const next = sessionId || "";
  const current = els.input.dataset.sessionId || "";
  if (current === next) return;
  if (current) state.drafts[current] = els.input.value;
  els.input.dataset.sessionId = next;
  els.input.value = next ? state.drafts[next] || "" : "";
  renderAttachmentQueue();
}

function attachmentLine(upload, session) {
  const path = upload.path || upload.text || "";
  if (session.tool === "terminal") return `# Attached file: ${path}`;
  return `Attached file: ${path}`;
}

function shouldUseLiveTerminal(session, mode) {
  return Boolean(session && !sessionIsStopped(session) && window.Terminal && (
    (session.tool === "terminal" && mode === "terminal" && state.view === "parsed")
    || (session.tool !== "terminal" && state.view === "raw")
  ));
}

function startTerminalStream(session) {
  if (state.terminal && state.terminalSessionId === session.id) return true;
  stopTerminalStream();
  try {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: window.matchMedia("(max-width: 760px)").matches ? 11 : 13,
      lineHeight: 1.15,
      scrollback: 100000,
      theme: terminalTheme(),
    });
    const FitCtor = window.FitAddon?.FitAddon || window.FitAddon;
    const fit = FitCtor ? new FitCtor() : null;
    if (fit) terminal.loadAddon(fit);
    els.xterm.innerHTML = "";
    terminal.open(els.xterm);
    terminal.onData((data) => {
      data = stripTerminalProbeResponses(data);
      if (!data) return;
      api(`/api/sessions/${session.id}/terminal/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      }).catch((error) => showError(error.message));
    });
    const source = new EventSource(`/api/sessions/${session.id}/terminal/stream`);
    source.onopen = () => setStatus("Connected");
    source.onmessage = (event) => terminal.write(JSON.parse(event.data));
    source.onerror = () => setStatus("Terminal stream retrying");
    state.terminal = terminal;
    state.terminalFit = fit;
    state.terminalSource = source;
    state.terminalSessionId = session.id;
    state.terminalResize = () => resizeTerminal(session.id);
    window.addEventListener("resize", state.terminalResize);
    window.visualViewport?.addEventListener("resize", state.terminalResize);
    state.terminalObserver = new ResizeObserver(state.terminalResize);
    state.terminalObserver.observe(els.xterm);
    requestAnimationFrame(state.terminalResize);
    setTimeout(state.terminalResize, 120);
    return true;
  } catch (error) {
    showError(error.message);
    return false;
  }
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim() || "#02070a",
    foreground: styles.getPropertyValue("--terminal-fg").trim() || "#cfe3e7",
    cursor: styles.getPropertyValue("--terminal-cursor").trim() || "#5ed0c5",
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim() || "rgba(94, 208, 197, 0.28)",
  };
}

function resizeTerminal(sessionId) {
  if (!state.terminal || state.terminalSessionId !== sessionId) return;
  try {
    state.terminalFit?.fit();
    api(`/api/sessions/${sessionId}/terminal/resize`, {
      method: "POST",
      body: JSON.stringify({ cols: state.terminal.cols, rows: state.terminal.rows }),
    }).catch(() => {});
  } catch {}
}

function stopTerminalStream() {
  if (state.terminalResize) window.removeEventListener("resize", state.terminalResize);
  if (state.terminalResize) window.visualViewport?.removeEventListener("resize", state.terminalResize);
  state.terminalObserver?.disconnect();
  state.terminalObserver = null;
  state.terminalResize = null;
  state.terminalSource?.close();
  state.terminalSource = null;
  state.terminal?.dispose();
  state.terminal = null;
  state.terminalFit = null;
  state.terminalSessionId = null;
  els.xterm.innerHTML = "";
}

function stripTerminalProbeResponses(data) {
  return String(data).replace(/\x1b\[(?:\?|>)?[0-9;]*c/g, "");
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

function deviceInitial(device) {
  return (device.label || device.id || "?").trim().slice(0, 1).toUpperCase();
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

function renderMarkdown(value) {
  const source = String(value || "");
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) return escapeHtml(source).replace(/\n/g, "<br>");
  return window.DOMPurify.sanitize(window.marked.parse(source, { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
  });
}
