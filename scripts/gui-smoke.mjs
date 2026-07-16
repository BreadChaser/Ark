import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let BASE_URL = process.env.ARK_URL || "";
const OUT = process.env.ARK_GUI_OUT || path.join(os.tmpdir(), `ark-gui-smoke-${Date.now()}`);
const PORT = Number(process.env.ARK_MARIONETTE_PORT || 2828);
const screenshots = [];

let firefox;
let firefoxProfile;
let arkServer;
let arkData;
let arkServerLog = "";
let socket;
let nextId = 0;
let originalSettings;
let disposableSession;
const disposableTmuxNames = new Set();

try {
  if (!BASE_URL) await startIsolatedServer();
  await assertServer();
  originalSettings = await api("/api/settings");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  firefoxProfile = await mkdtemp(path.join(os.tmpdir(), "ark-firefox-"));
  await writeFile(path.join(firefoxProfile, "user.js"), `user_pref("marionette.port", ${PORT});\n`);
  firefox = spawn("firefox", ["--headless", "--marionette", "--profile", firefoxProfile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  firefox.stderr.on("data", () => {});
  socket = await connectMarionette();
  socket.setMaxListeners(0);
  await hello();
  await command("WebDriver:NewSession", { capabilities: { alwaysMatch: { unhandledPromptBehavior: "accept" } } });
  await command("WebDriver:SetWindowRect", { width: 1440, height: 1000 });
  await command("WebDriver:Navigate", { url: BASE_URL });

  await wait('document.querySelectorAll("#devices .device-group").length >= 1');
  await wait('document.querySelector("#session-panel").classList.contains("has-session") || document.querySelectorAll("#devices .session").length === 0', 30000);
  await assertCentralRunnerDoesNotCreateLocalDevice();
  await wait('document.querySelector(".brand-logo").complete && document.querySelector(".brand-logo").naturalWidth > 0');
  assert((await api("/manifest.webmanifest")).name === "Ark", "PWA manifest is unavailable");
  const sampleSound = await fetch(`${BASE_URL}/static/sounds/yaru-complete.mp3?v=7`);
  assert(sampleSound.headers.get("content-type") === "audio/mpeg" && (await sampleSound.arrayBuffer()).byteLength > 1000, "sample sound is not browser-playable");
  assert((await fetch(`${BASE_URL}/sw.js`)).ok && await js('return "serviceWorker" in navigator;'), "notification service worker is unavailable");
  assert(await js('return document.body.dataset.sessionStateTransport === "stream";'), "session states still use browser polling");
  await sleep(200);
  await shot("main");
  await assertOfflineCollapse();
  await assertOtherMachinesCollapse();

  await js('document.querySelector("#settings-toggle").click(); return true;');
  await wait('document.querySelectorAll("#tool-status .tool-card").length === 4');
  assert(await js('return document.querySelectorAll("[data-sound-preview]").length === 8 && document.querySelectorAll("[data-sound-use]").length === 8 && Boolean(document.querySelector("#sound-volume"));'), "sound choices are missing from settings");
  await js('document.querySelector("[data-sound-use=\\"done:message\\"]").click(); return true;');
  assert(await js('return localStorage.getItem("ark-done-sound") === "message" && document.querySelector("[data-sound-use=\\"done:message\\"]").disabled;'), "sound choice did not persist");
  await wait('document.querySelector("#account-form") && document.querySelectorAll("#profile-status .account-card").length >= 1');
  await wait('[...document.querySelectorAll("#profile-status [data-profile-login]")].some((button) => button.textContent.trim() === "Login")');
  await wait('/Signed in as|Needs login/.test(document.querySelector("#profile-status").textContent)');
  await wait('document.querySelector("#secret-form") && document.querySelector("#secret-status")');
  await wait('document.querySelectorAll(".diagnostic-row").length >= 1', 45000);
  await assertDiagnostics();
  await assertProfileYamlConfig();
  await assertToolDisableState();
  await shot("settings");

  await setTheme("light");
  await assertThemeContrast("light");
  await assertThemeEffects("light");
  await shot("theme-light");
  await setTheme("ark");
  await assertThemeContrast("ark");
  await assertThemeEffects("ark");
  await shot("theme-ark");
  await setTheme("dark");
  await assertThemeContrast("dark");
  await assertThemeEffects("dark");

  assert(!(await js('return Boolean(document.querySelector("#settings-sidebar-toggle"));')), "settings still duplicates the sidebar control");
  await js('document.querySelector("#sidebar-toggle").click(); return true;');
  await wait('document.body.classList.contains("sidebar-collapsed")');
  await shot("sidebar-collapsed");
  await js('document.querySelector("#sidebar-open").click(); return true;');
  await wait('!document.body.classList.contains("sidebar-collapsed")');

  await saveToolCommands({ codex: "bash", opencode: "bash", claude: "bash" });
  await wait('[...document.querySelectorAll("#tool-status .tool-card.missing")].length === 0');
  const enabled = await js('return [...document.querySelector("#tool").options].filter(o => o.disabled).map(o => o.value);');
  assert(enabled.length === 0, `expected all tools enabled after override, got ${enabled.join(",")}`);
  await shot("tool-overrides");

  await saveToolCommands(originalSettings.tool_commands);
  await wait('[...document.querySelectorAll("#tool-status .tool-card.missing")].length >= 0');

  await js('document.querySelector("#settings-toggle").click(); return true;');
  await setTheme("light");
  await shot("theme-light-main");
  await setTheme("ark");
  await shot("theme-ark-main");
  await setTheme("dark");
  await shot("theme-dark-main");
  await openComposer();
  await assertProfilePicker();
  await shot("composer");
  await startDisposableTerminal();
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)} && document.querySelector("#session-panel").classList.contains("has-session") && document.querySelector("#session-detail").textContent.includes(${JSON.stringify(disposableSession.tmux_name)})`);
  await assertStartPickerBoundary();
  await assertSelectedSessionChrome();
  await assertComposerSessionIsolation();

  const keyboard = await js(`
    const input = document.querySelector("#input");
    input.value = "printf 'keyboard-send-smoke\\\\n'";
    const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shift);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    return { shiftPrevented: shift.defaultPrevented, enterPrevented: enter.defaultPrevented };
  `);
  assert(!keyboard.shiftPrevented, "Shift+Enter was blocked instead of reserved for multiline input");
  assert(keyboard.enterPrevented, "Enter did not send from the composer");
  await wait('!document.querySelector("#xterm").hidden && document.querySelector("#xterm .xterm")');
  await setTheme("ark");
  await sleep(250);
  const crtTerminalColors = await js('return { host: getComputedStyle(document.querySelector("#xterm")).backgroundColor, viewport: getComputedStyle(document.querySelector("#xterm .xterm-viewport")).backgroundColor };');
  assert(crtTerminalColors.host === "rgb(5, 4, 2)" && crtTerminalColors.viewport === "rgb(5, 4, 2)", `CRT terminal is still blue: ${JSON.stringify(crtTerminalColors)}`);
  await shot("theme-ark-terminal");
  await setTheme("dark");
  await wait('(document.querySelector("#output").innerText + document.querySelector("#parsed").innerText + document.querySelector("#xterm").innerText).includes("keyboard-send-smoke")');
  const terminalText = await js('return document.querySelector("#xterm").innerText;');
  assert(!/0;276;0c|1;2c/.test(terminalText), "terminal probe response leaked into the shell");
  assert(!/\\[[^\\]]+\\]0:[^\\n]*\\*/.test(terminalText), "tmux status bar leaked into the app terminal");
  await assertLiveTerminalLog(disposableSession.id, "keyboard-send-smoke");
  await assertSessionFiles(disposableSession.id, { terminal: true });
  await shot("send");

  const terminalViewSwitch = await js('return { hidden: document.querySelector("#view-raw").parentElement.hidden, rawHidden: document.querySelector("#output").hidden };');
  assert(terminalViewSwitch.hidden, "terminal session still exposes the raw debug switch");
  assert(terminalViewSwitch.rawHidden, "terminal session rendered the duplicate raw debug view");

  const inserted = await attachImageInBrowser();
  assert(inserted.queue.includes("gui-smoke.svg"), "attached file did not queue");
  assert(!inserted.input.includes("# Attached file:"), "attached file should not write directly to composer");
  await wait('document.querySelector("#attachment-queue img")?.complete && document.querySelector("#attachment-queue img").naturalWidth > 0');
  const queuedPreview = await js('return { name: document.querySelector("#attachment-queue .attachment-preview span")?.textContent, close: document.querySelector("#attachment-queue .attachment-preview button")?.textContent, text: document.querySelector("#attachment-queue .attachment-preview")?.innerText };');
  assert(queuedPreview.name === "gui-smoke.svg" && queuedPreview.close === "×" && !queuedPreview.text.includes("remove"), "image preview still uses the old remove label");
  const queuedImageViewer = await js('document.querySelector("#attachment-queue img").click(); return { open: document.querySelector("#image-viewer").open, count: state.imageViewerImages.length, previous: document.querySelector("#image-viewer-previous").disabled, next: document.querySelector("#image-viewer-next").disabled };');
  assert(queuedImageViewer.open && queuedImageViewer.count === 1 && queuedImageViewer.previous && queuedImageViewer.next, "queued attachment opened the chat image gallery");
  await js('document.querySelector("#image-viewer-close").click(); return true;');
  await assertSessionFiles(disposableSession.id, { attachment: true });
  await shot("attachment-queued");
  const dropped = await dropFileInBrowser();
  assert(dropped.queue.includes("notes.txt"), "dropped text file did not queue");
  await shot("attachment-drop");
  await js('document.querySelector("#send").click(); return true;');
  await waitForTerminalLogText(disposableSession.id, "notes");
  await shot("attachment-send");
  const pendingUpload = await sendImmediatelyWithAttachment();
  assert(pendingUpload.includes("send-race.txt") && pendingUpload.includes("Uploading"), "in-progress attachment was not visible in the composer");
  await waitForTerminalLogText(disposableSession.id, "send-race");
  const pasted = await pasteImageInBrowser();
  assert(pasted.queue.includes("pasted.png"), "pasted file did not queue");
  await shot("attachment-paste");
  const pastedText = await pasteTextInBrowser();
  assert(pastedText.input.includes("clipboard text smoke"), "normal pasted text did not stay in the composer");
  assert(!pastedText.queue.includes("clipboard.txt"), "normal pasted text unexpectedly became a file");
  const pastedLongText = await pasteLongTextInBrowser();
  assert(pastedLongText.queue.includes("clipboard.txt"), "very long pasted text did not become a file");
  await shot("attachment-paste-text");
  await js('document.querySelector("#send").click(); return true;');
  await waitForTerminalLogText(disposableSession.id, "pasted");
  await waitForTerminalLogText(disposableSession.id, "clipboard");

  await js('document.querySelector("#restart").click(); return true;');
  await wait('document.querySelector("#status").textContent !== "Restarting"');
  await shot("restart");

  await js('window.confirm = () => true; document.querySelector("#forget").click(); return true;');
  await wait(`localStorage.getItem("ark-active-session") !== ${JSON.stringify(disposableSession.id)}`);
  await shot("forget");
  await killTmux(disposableSession.tmux_name);
  disposableSession = null;

  await openComposer();
  await startDisposableTerminal();
  await js('window.confirm = () => true; document.querySelector("#kill").click(); return true;');
  await wait(`localStorage.getItem("ark-active-session") !== ${JSON.stringify(disposableSession.id)}`);
  await shot("kill");
  disposableTmuxNames.delete(disposableSession.tmux_name);
  disposableSession = null;

  await testSessionOrganization();
  await testStoppedTmuxRestore();
  await testAdoptedScrollbackImport();
  await testCodexControlPrompts();
  await saveToolCommands(originalSettings.tool_commands);
  await testGenericStartupImage();
  await testChatLayout();
  await testClaudeChatLayout();
  await testCentralRunnerRemoteChat();
  await testRemoteTerminalPipeLog();
  await maybeTestRemoteCodexCentralRunner();
  await maybeTestCodexTrustInput();
  await maybeTestCodexStartupImage();
  const leftovers = await api("/api/sessions");
  assert(!leftovers.sessions.some((session) => session.id === disposableSession?.id), "disposable session still stored");
  await openComposer();
  await startDisposableTerminal();
  await command("WebDriver:SetWindowRect", { width: 390, height: 900 });
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait('document.querySelectorAll("#devices .device-group").length >= 1');
  await wait('document.querySelector("#session-panel").classList.contains("has-session")');
  await js('if (document.body.classList.contains("sidebar-collapsed")) document.querySelector("#sidebar-toggle").click(); return true;');
  await wait('!document.body.classList.contains("sidebar-collapsed") && [...document.querySelectorAll("#devices .tool-icon use")].some((icon) => icon.getAttribute("href") === "#tool-terminal")');
  const mobileSessionText = await js('return document.querySelector("#devices").innerText.toLowerCase();');
  assert(!/\b(codex|opencode|terminal|claude)\b/.test(mobileSessionText), `mobile sidebar still spells out provider names: ${mobileSessionText}`);
  await shot("mobile-sidebar");
  await js('document.querySelector(".main").click(); return true;');
  await wait('document.body.classList.contains("sidebar-collapsed")');
  await wait('!document.querySelector("#xterm").hidden && document.querySelector("#xterm .xterm")', 15000);
  await wait('document.querySelector("#status").textContent === "Connected"', 15000);
  await shot("mobile");
  await attachImageInBrowser();
  await shot("mobile-attachment");
  await js('document.querySelector("[data-remove-attachment]")?.click(); return true;');
  const report = await writeReport(await api("/api/diagnostics"), await api("/api/sessions"));
  await cleanupDisposable();
  console.log(JSON.stringify({ ok: true, screenshots: OUT, report }, null, 2));
} catch (error) {
  await cleanupDisposables().catch(() => {});
  if (originalSettings) await saveSettings(originalSettings).catch(() => {});
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  socket?.destroy();
  firefox?.kill();
  arkServer?.kill();
  if (firefoxProfile) await rm(firefoxProfile, { recursive: true, force: true }).catch(() => {});
  if (arkData) await rm(arkData, { recursive: true, force: true }).catch(() => {});
}

async function startIsolatedServer() {
  arkData = await mkdtemp(path.join(os.tmpdir(), "ark-data-"));
  process.env.TMUX_TMPDIR = path.join(arkData, "tmux");
  await mkdir(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
  const port = await freePort();
  BASE_URL = `http://127.0.0.1:${port}`;
  arkServer = spawn(process.execPath, [path.resolve("server.mjs")], {
    cwd: path.resolve("."),
    env: { ...process.env, ARK_DATA: arkData, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remember = (chunk) => { arkServerLog = `${arkServerLog}${chunk}`.slice(-4000); };
  arkServer.stdout.on("data", remember);
  arkServer.stderr.on("data", remember);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return;
    } catch {}
    if (arkServer.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`isolated Ark server did not start: ${arkServerLog}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function assertServer() {
  const health = await api("/health");
  assert(health.ok, `${BASE_URL} is not healthy`);
}

async function api(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, options);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.detail || response.statusText);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function saveSettings(settings) {
  return api("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
}

async function saveToolCommands(toolCommands) {
  await saveSettings({ tool_commands: { ...originalSettings.tool_commands, ...toolCommands } });
  await js(`
    return (async () => {
      const data = await (await fetch("/api/settings")).json();
      for (const input of document.querySelectorAll("[data-tool-command]")) {
        input.value = data.tool_commands[input.dataset.toolCommand] || "";
      }
      await loadTools(localStorage.getItem("ark-active-device") || "local");
      return true;
    })();
  `);
}

async function assertToolDisableState() {
  const state = await js(`
    return {
      missing: [...document.querySelectorAll(".tool-card.missing span")].map((item) => item.textContent.toLowerCase()),
      disabled: [...document.querySelector("#tool").options].filter((option) => option.disabled).map((option) => option.value),
    };
  `);
  for (const tool of state.missing) assert(state.disabled.includes(tool), `${tool} is missing but not disabled`);
}

async function assertCentralRunnerDoesNotCreateLocalDevice() {
  const hidden = await js('return !sidebarDeviceHasSession("local", [{ device_id: "remote", tmux_device_id: "local", tmux_name: "Ark-central" }], [{ name: "Ark-central" }]);');
  assert(hidden, "central-runner tmux created an empty local device in the sidebar");
}

async function assertOfflineCollapse() {
  const hasOffline = await js('return Boolean(document.querySelector(".offline-section .device-section-toggle"));');
  if (!hasOffline) return;
  const collapsed = await js('return document.querySelector(".offline-section .device-group.offline") === null;');
  assert(collapsed, "offline machines were expanded by default");
  const leaked = await js('return [...document.querySelectorAll("#devices > .device-group.offline")].map((item) => item.innerText.trim()).join(", ");');
  assert(!leaked, `offline/unreachable machines leaked into main list: ${leaked}`);
  await js('document.querySelector(".offline-section .device-section-toggle").click(); return true;');
  await wait('document.querySelector(".offline-section .device-group.offline")');
  await shot("offline-expanded");
  await js('document.querySelector(".offline-section .device-section-toggle").click(); return true;');
  await wait('document.querySelector(".offline-section .device-group.offline") === null');
}

async function assertOtherMachinesCollapse() {
  const hasOther = await js('return Boolean(document.querySelector(".other-section .device-section-toggle"));');
  if (!hasOther) return;
  assert(await js('return document.querySelector(".other-section .device-group") === null;'), "zero-session machines were expanded by default");
  await js('document.querySelector(".other-section .device-section-toggle").click(); return true;');
  await wait('document.querySelector(".other-section .device-group")');
  const maxHeight = await js('return Math.max(...[...document.querySelectorAll(".other-section .device-toggle")].map((item) => item.getBoundingClientRect().height));');
  assert(maxHeight <= 42, `machine rows are still oversized: ${maxHeight}px`);
  await js('document.querySelector(".other-section .device-section-toggle").click(); return true;');
  await wait('document.querySelector(".other-section .device-group") === null');
}

async function assertSelectedSessionChrome() {
  await wait('document.querySelectorAll("#devices .session.active[aria-current=page]").length === 1');
  assert(await js('return sessionIsDone({ ready_at: 20, viewed_at: 10 }, "ready") && !sessionIsDone({ ready_at: 20, viewed_at: 20 }, "ready");'), "done state does not behave like an unread completion");
  assert(await js('return agentSoundKind("working", "ready") === "" && agentSoundKind("working", "ready", true) === "done" && agentSoundKind("ready", "needs_input") === "input";'), "agent sounds do not require a confirmed completion");
  assert(await js(`
    const host = document.createElement("div");
    host.innerHTML = '<button class="session agent-working"><small class="session-state">working</small></button><button class="session agent-ready"><small class="session-state">ready</small></button>';
    document.body.append(host);
    const colors = [...host.querySelectorAll(".session-state")].map((item) => getComputedStyle(item).color);
    host.remove();
    return colors[0] !== colors[1];
  `), "working and ready use the same color");
  assert(await js('return sessionStateLabel({}, "usage") === "usage";'), "usage-limited session state is unavailable");
  const chrome = await js(`
    const active = document.querySelector("#devices .session.active[aria-current=page]");
    return {
      activeText: active?.innerText || "",
      activeIcon: active?.querySelector(".tool-icon use")?.getAttribute("href") || "",
      titleIcon: document.querySelector("#title .tool-icon use")?.getAttribute("href") || "",
      activeBackground: getComputedStyle(active).backgroundColor,
      activeShadow: getComputedStyle(active).boxShadow,
      summaryDisplay: getComputedStyle(document.querySelector(".session-summary")).display,
      meta: document.querySelector("#meta").textContent,
      headerHeight: document.querySelector(".topbar").getBoundingClientRect().height,
      titleCenter: Math.round((document.querySelector("#title").getBoundingClientRect().top + document.querySelector("#title").getBoundingClientRect().bottom) / 2),
      metaCenter: Math.round((document.querySelector("#meta").getBoundingClientRect().top + document.querySelector("#meta").getBoundingClientRect().bottom) / 2),
      machineHeight: Math.max(...[...document.querySelectorAll(".device-toggle")].map((item) => item.getBoundingClientRect().height)),
    };
  `);
  const displayName = (disposableSession.title || disposableSession.tmux_name).replace(/^(codex|terminal|opencode|claude)\s*-\s*/i, "");
  assert(chrome.activeText.includes(displayName), "selected chat is not identified in the sidebar");
  assert(chrome.activeIcon === `#tool-${disposableSession.tool}` && chrome.titleIcon === `#tool-${disposableSession.tool}`, "selected tool is not represented by its SVG icon");
  assert(!/^(codex|terminal|opencode|claude)\s*-\s*/i.test(chrome.activeText), "sidebar still spells out the tool prefix");
  assert(chrome.activeBackground !== "rgba(0, 0, 0, 0)", "selected chat has no visible background");
  assert(!chrome.activeShadow.includes("inset"), "selected chat still has the side highlight");
  assert(chrome.summaryDisplay === "none", "session identity is repeated inside the session panel");
  assert(!chrome.meta.includes(disposableSession.tmux_name), "top header repeats tmux implementation detail");
  assert(chrome.headerHeight <= 46 && Math.abs(chrome.titleCenter - chrome.metaCenter) <= 2, "session header is not compacted to one row");
  assert(chrome.machineHeight <= 42, `machine rows are still oversized: ${chrome.machineHeight}px`);
}

async function assertThemeContrast(theme) {
  const contrast = await js(`
    const style = getComputedStyle(document.documentElement);
    const parse = (name) => {
      const value = style.getPropertyValue(name).trim().replace("#", "");
      return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
    };
    const luminance = (rgb) => {
      const values = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const ratio = (left, right) => {
      const a = luminance(parse(left));
      const b = luminance(parse(right));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return { text: ratio("--text", "--bg"), muted: ratio("--muted", "--bg"), faint: ratio("--faint", "--bg") };
  `);
  for (const [name, value] of Object.entries(contrast)) assert(value >= 4.5, `${theme} ${name} contrast is only ${value.toFixed(2)}:1`);
}

async function assertThemeEffects(theme) {
  const effects = await js(`
    const grid = getComputedStyle(document.querySelector(".background-grid"), "::before");
    const diagonal = getComputedStyle(document.querySelector(".background-grid"), "::after");
    const overlay = getComputedStyle(document.body, "::before");
    const message = document.querySelector(".message-text");
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().replace("#", "");
    const rgb = [0, 2, 4].map((offset) => parseInt(bg.slice(offset, offset + 2), 16) / 255);
    const luminance = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return {
      grid: grid.backgroundImage.includes("linear-gradient"),
      diagonalGrid: diagonal.backgroundImage.includes("135deg"),
      gridAnimation: grid.animationName,
      diagonalAnimation: diagonal.animationName,
      gridDuration: grid.animationDuration,
      gridWillChange: grid.willChange,
      gridBloom: grid.filter,
      diagonalBloom: diagonal.filter,
      scanlines: Number(overlay.opacity),
      overlayAnimation: overlay.animationName,
      textAnimation: message ? getComputedStyle(message).animationName : "none",
      buttonRadius: getComputedStyle(document.querySelector("#settings-refresh")).borderRadius,
      panelRadius: getComputedStyle(document.querySelector("#session-panel")).borderRadius,
      backgroundLuminance: 0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2],
    };
  `);
  assert(effects.grid, `${theme} theme lost its grid texture`);
  assert(effects.diagonalGrid, `${theme} theme lost its diagonal grid layer`);
  assert(effects.gridAnimation === "grid-drift", `${theme} grid is not drifting slowly`);
  assert(effects.diagonalAnimation === "diagonal-drift", `${theme} diagonal grid is not drifting independently`);
  assert(effects.gridDuration === "180s", `${theme} grid drift is not slow: ${effects.gridDuration}`);
  assert(effects.gridWillChange === "transform", `${theme} grid is not compositor animated`);
  assert(effects.gridBloom !== "none" && effects.diagonalBloom !== "none", `${theme} grid bloom is missing`);
  assert(effects.buttonRadius === "11px", `${theme} changed button shape to ${effects.buttonRadius}`);
  assert(effects.panelRadius === "24px", `${theme} changed panel shape to ${effects.panelRadius}`);
  if (theme === "ark") assert(effects.scanlines > 0, "Amber CRT scanlines are disabled");
  if (theme === "ark") assert(effects.overlayAnimation === "none", "Amber CRT overlay still flickers");
  if (theme === "ark") assert(effects.textAnimation === "none", "Amber CRT still flashes individual text nodes");
  if (theme === "light") assert(effects.backgroundLuminance < 0.6, `light theme is still glaring at ${effects.backgroundLuminance.toFixed(2)} luminance`);
}

async function assertDiagnostics() {
  const diagnostics = await api("/api/diagnostics");
  assert(diagnostics.ok, "diagnostics endpoint did not return ok");
  if (arkData) assert(diagnostics.secret_config_path.startsWith(arkData), "GUI smoke escaped its isolated data directory");
  assert(diagnostics.features.settings_menu, "diagnostics missing settings_menu feature");
  assert(diagnostics.features.last_active_session_restore, "diagnostics missing last_active_session_restore feature");
  assert(diagnostics.features.collapsible_sidebar, "diagnostics missing collapsible_sidebar feature");
  assert(diagnostics.features.offline_device_collapse, "diagnostics missing offline_device_collapse feature");
  assert(diagnostics.features.idle_device_collapse, "diagnostics missing idle_device_collapse feature");
  assert(diagnostics.features.selected_session_highlight, "diagnostics missing selected_session_highlight feature");
  assert(diagnostics.features.theme_contrast_checks, "diagnostics missing theme_contrast_checks feature");
  assert(diagnostics.features.terminal_view, "diagnostics missing terminal_view feature");
  assert(diagnostics.features.chat_layout, "diagnostics missing chat_layout feature");
  assert(diagnostics.features.claude_chat_layout, "diagnostics missing claude_chat_layout feature");
  assert(diagnostics.features.mobile_chat_screenshot, "diagnostics missing mobile_chat_screenshot feature");
  assert(diagnostics.features.mobile_sidebar_screenshot, "diagnostics missing mobile_sidebar_screenshot feature");
  assert(diagnostics.features.chat_raw_debug_fallback, "diagnostics missing chat_raw_debug_fallback feature");
  assert(diagnostics.features.chat_message_api, "diagnostics missing chat_message_api feature");
  assert(diagnostics.features.persisted_chat_messages, "diagnostics missing persisted_chat_messages feature");
  assert(diagnostics.features.assistant_message_capture, "diagnostics missing assistant_message_capture feature");
  assert(diagnostics.features.auto_adopt_tmux, "diagnostics missing auto_adopt_tmux feature");
  assert(diagnostics.features.adopted_scrollback_import, "diagnostics missing adopted_scrollback_import feature");
  assert(diagnostics.features.stopped_tmux_restore, "diagnostics missing stopped_tmux_restore feature");
  assert(diagnostics.features.agent_state_sidebar, "diagnostics missing agent_state_sidebar feature");
  assert(diagnostics.features.live_commentary_ordering, "diagnostics missing live_commentary_ordering feature");
  assert(diagnostics.features.readable_yaml_config, "diagnostics missing readable_yaml_config feature");
  assert(diagnostics.features.readable_device_inventory, "diagnostics missing readable_device_inventory feature");
  assert(diagnostics.features.simple_user_service, "diagnostics missing simple_user_service feature");
  assert(diagnostics.features.session_file_history, "diagnostics missing session_file_history feature");
  assert(diagnostics.features.session_files_endpoint, "diagnostics missing session_files_endpoint feature");
  assert(diagnostics.features.tool_profiles, "diagnostics missing tool_profiles feature");
  assert(diagnostics.features.readable_profile_config, "diagnostics missing readable_profile_config feature");
  assert(diagnostics.features.multi_profile_yaml_config, "diagnostics missing multi_profile_yaml_config feature");
  assert(diagnostics.features.profile_routing, "diagnostics missing profile_routing feature");
  assert(diagnostics.features.profile_picker, "diagnostics missing profile_picker feature");
  assert(diagnostics.features.start_picker_scoped_to_add, "diagnostics missing start_picker_scoped_to_add feature");
  assert(diagnostics.features.clean_project_browser, "diagnostics missing clean_project_browser feature");
  assert(diagnostics.features.central_tool_runner, "diagnostics missing central_tool_runner feature");
  assert(diagnostics.features.live_terminal, "diagnostics missing live_terminal feature");
  assert(diagnostics.features.live_terminal_log_append, "diagnostics missing live_terminal_log_append feature");
  assert(diagnostics.features.remote_live_terminal, "diagnostics missing remote_live_terminal feature");
  assert(diagnostics.features.queued_attachments, "diagnostics missing queued_attachments feature");
  assert(diagnostics.features.drag_drop_attachments, "diagnostics missing drag_drop_attachments feature");
  assert(diagnostics.features.large_clipboard_text_attachments, "diagnostics missing large_clipboard_text_attachments feature");
  assert(diagnostics.features.codex_startup_images, "diagnostics missing codex_startup_images feature");
  assert(diagnostics.features.role_header_chat_capture, "diagnostics missing role_header_chat_capture feature");
  assert(diagnostics.features.codex_trust_prompt_filter, "diagnostics missing codex_trust_prompt_filter feature");
  assert(diagnostics.features.codex_chrome_filter, "diagnostics missing codex_chrome_filter feature");
  assert(diagnostics.features.codex_trust_input_suppression, "diagnostics missing codex_trust_input_suppression feature");
  assert(diagnostics.features.codex_bullet_reply_capture, "diagnostics missing codex_bullet_reply_capture feature");
  assert(diagnostics.features.tmux_atomic_submit, "diagnostics missing tmux_atomic_submit feature");
  assert(diagnostics.features.keyboard_composer_send, "diagnostics missing keyboard_composer_send feature");
  assert(diagnostics.features.generic_chat_image_prompt, "diagnostics missing generic_chat_image_prompt feature");
  assert(Array.isArray(diagnostics.tool_devices) && diagnostics.tool_devices.length, "diagnostics missing tool_devices");
  assert(diagnostics.device_inventory_path, "diagnostics missing device_inventory_path");
  assert(diagnostics.device_count >= 1, "diagnostics missing device_count");
  const inventory = await readFile(diagnostics.device_inventory_path, "utf8");
  assert(inventory.includes("devices:"), "devices.yml missing devices list");
  assert(inventory.includes("id: local"), "devices.yml missing local device");
  assert(diagnostics.profile_config_path, "diagnostics missing profile_config_path");
  const profileConfig = await readFile(diagnostics.profile_config_path, "utf8");
  assert(profileConfig.includes("profiles:"), "profiles.yml missing profiles list");
  assert(Array.isArray(diagnostics.profiles) && diagnostics.profiles.length, "diagnostics missing profiles");
  const profiles = await api("/api/profiles");
  assert(profiles.routing?.strategy === "availability", "profiles routing is not availability-based");
  assert(Array.isArray(profiles.profiles) && profiles.profiles.length, "profiles endpoint missing profiles");
}

async function assertProfileYamlConfig() {
  const diagnostics = await api("/api/diagnostics");
  const target = diagnostics.profile_config_path;
  assert(target, "profile_config_path missing");
  let original = null;
  try {
    original = await readFile(target, "utf8");
  } catch {}
  const custom = [
    "routing:",
    "  strategy: availability",
    "profiles:",
    "  - id: codex-default",
    "    label: Codex default",
    "    tool: codex",
    "    command: codex --no-alt-screen",
    "    enabled: true",
    "  - id: codex-high-limit",
    "    label: Codex high limit",
    "    tool: codex",
    "    command: codex --no-alt-screen",
    "    enabled: true",
    "",
  ].join("\n");
  try {
    await writeFile(target, custom);
    const profiles = await api("/api/profiles");
    const codexProfiles = profiles.profiles.filter((profile) => profile.tool === "codex");
    assert(profiles.routing?.strategy === "availability", "custom profiles.yml did not preserve availability routing");
    assert(codexProfiles.some((profile) => profile.id === "codex-high-limit"), "custom profiles.yml profile was not loaded");
    assert(codexProfiles.length >= 2, "multiple codex profiles were not loaded");
  } finally {
    if (original === null) await rm(target, { force: true });
    else await writeFile(target, original);
  }
}

async function openComposer() {
  await js(`
    document.querySelector(".device-add:not([disabled])").click();
    document.querySelector("#repo").value = "/tmp";
    const tool = document.querySelector("#tool");
    tool.value = "terminal";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  await wait('document.querySelector(".setup-column") && getComputedStyle(document.querySelector(".setup-column")).display !== "none"');
  await wait('document.querySelectorAll("#dirs .dir-row").length >= 1');
  const hiddenDirs = await js('return [...document.querySelectorAll("#dirs .dir-row strong")].map((node) => node.textContent.trim()).filter((name) => name.startsWith("."));');
  assert(hiddenDirs.length === 0, `project browser leaked hidden directories: ${hiddenDirs.join(", ")}`);
}

async function assertStartPickerBoundary() {
  await wait('document.querySelector(".setup-column") && getComputedStyle(document.querySelector(".setup-column")).display === "none"');
  await js('document.querySelector(".device-add:not([disabled])").click(); return true;');
  await wait('document.querySelector(".workspace").classList.contains("is-adding") && getComputedStyle(document.querySelector(".setup-column")).display !== "none"');
  await shot("start-picker-active-session");
  await js('document.querySelector("#close-add").click(); return true;');
  await wait('!document.querySelector(".workspace").classList.contains("is-adding") && getComputedStyle(document.querySelector(".setup-column")).display === "none"');
}

async function assertProfilePicker() {
  const profiles = await api("/api/profiles");
  const codex = profiles.profiles.find((profile) => profile.tool === "codex");
  assert(codex, "profiles endpoint missing codex profile");
  const picker = await js(`
    const tool = document.querySelector("#tool");
    const profile = document.querySelector("#profile");
    tool.value = "codex";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    const state = {
      disabled: profile.disabled,
      values: [...profile.options].map((option) => option.value),
      labels: [...profile.options].map((option) => option.textContent),
    };
    profile.value = "";
    tool.value = "terminal";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    return state;
  `);
  assert(!picker.disabled, "profile picker disabled for codex");
  assert(picker.values.includes(""), "profile picker missing Auto option");
  assert(picker.values.includes(codex.id), `profile picker missing ${codex.id}`);
}

async function startDisposableTerminal() {
  const before = new Set((await api("/api/sessions")).sessions.map((session) => session.id));
  await js('document.querySelector("#repo").value = "/tmp"; return true;');
  await js('document.querySelector("#start").click(); return true;');
  disposableSession = await waitForNewDisposable(before);
  disposableTmuxNames.add(disposableSession.tmux_name);
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('!document.querySelector("#input").disabled && !document.querySelector("#kill").disabled');
}

async function assertComposerSessionIsolation() {
  const first = disposableSession;
  await js(`
    const input = document.querySelector("#input");
    input.value = "draft for first chat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    attachmentQueue(${JSON.stringify(first.id)}).push({ name: "first-chat.txt", path: "/tmp/first-chat.txt" });
    renderAttachmentQueue();
    return true;
  `);

  await openComposer();
  await startDisposableTerminal();
  const second = disposableSession;
  const secondInitial = await js('return { value: document.querySelector("#input").value, queue: document.querySelector("#attachment-queue").innerText };');
  assert(secondInitial.value === "", "first chat draft leaked into second chat");
  assert(!secondInitial.queue.includes("first-chat.txt"), "first chat attachment leaked into second chat");

  await js(`
    const input = document.querySelector("#input");
    input.value = "draft for second chat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    openSession(${JSON.stringify(first.id)});
    return true;
  `);
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(first.id)}`);
  const firstRestored = await js('return { value: document.querySelector("#input").value, queue: document.querySelector("#attachment-queue").innerText };');
  assert(firstRestored.value === "draft for first chat", "first chat draft was not restored");
  assert(firstRestored.queue.includes("first-chat.txt"), "first chat attachment was not restored");

  await js(`openSession(${JSON.stringify(second.id)}); return true;`);
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(second.id)}`);
  assert(await js('return document.querySelector("#input").value === "draft for second chat";'), "second chat draft was not restored");
  const staleSendError = await js(`
    const input = document.querySelector("#input");
    input.dataset.sessionId = ${JSON.stringify(first.id)};
    input.value = "wrong-chat-send-smoke";
    document.querySelector("#send").click();
    return document.querySelector("#error").textContent;
  `);
  assert(staleSendError.includes("Chat changed before send"), "stale chat send was not blocked");

  await js(`
    openSession(${JSON.stringify(first.id)});
    document.querySelector("#input").value = "";
    document.querySelector("#input").dispatchEvent(new Event("input", { bubbles: true }));
    clearAttachmentQueue(${JSON.stringify(first.id)});
    openSession(${JSON.stringify(second.id)});
    document.querySelector("#input").value = "";
    document.querySelector("#input").dispatchEvent(new Event("input", { bubbles: true }));
    clearAttachmentQueue(${JSON.stringify(second.id)});
    clearError();
    return true;
  `);
  await api(`/api/sessions/${second.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(second.tmux_name);
  disposableSession = first;
  await js(`return refresh().then(() => { openSession(${JSON.stringify(first.id)}); return true; });`);
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(first.id)}`);
}

async function testStoppedTmuxRestore() {
  await openComposer();
  await startDisposableTerminal();
  const dead = disposableSession;
  await runLocal("tmux", ["kill-session", "-t", dead.tmux_name]);
  disposableTmuxNames.delete(dead.tmux_name);
  let ended = false;
  const end = Date.now() + 5000;
  while (!ended && Date.now() < end) {
    try {
      await api(`/api/sessions/${dead.id}/capture`);
    } catch (error) {
      ended = error.status === 410;
    }
    if (!ended) await sleep(250);
  }
  assert(ended, "dead tmux session did not return 410");
  const sessions = await api("/api/sessions");
  assert(sessions.sessions.some((session) => session.id === dead.id), "stopped tmux session was not retained for restore");
  await fetch(`${BASE_URL}/api/sessions/${dead.id}`, { method: "DELETE" });
  await js(`if (localStorage.getItem("ark-active-session") === ${JSON.stringify(dead.id)}) localStorage.removeItem("ark-active-session"); return true;`);
  disposableSession = null;
}

async function testSessionOrganization() {
  const names = [`Ark-name-smoke-a-${Date.now()}`, `Ark-name-smoke-b-${Date.now()}`];
  const sessions = [];
  try {
    for (const tmux_name of names) {
      const created = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ device_id: "local", cwd: "/tmp", tool: "terminal", tmux_name }),
      });
      sessions.push(created.session);
      disposableTmuxNames.add(tmux_name);
    }
    await tmuxSendLine(names[0], "sleep 30");
    let automatic;
    for (let attempt = 0; attempt < 20; attempt++) {
      await api("/api/devices/local/tmux");
      automatic = (await api("/api/sessions")).sessions.find((session) => session.id === sessions[0].id);
      if (automatic?.title === "sleep") break;
      await sleep(100);
    }
    assert(automatic?.title === "sleep" && !automatic.title_overridden, `terminal did not adopt its running command name: ${JSON.stringify(automatic)}`);

    await js(`localStorage.setItem("ark-active-session", ${JSON.stringify(sessions[0].id)}); return true;`);
    await command("WebDriver:Navigate", { url: BASE_URL });
    await wait(`document.querySelector('[data-session-id="${sessions[0].id}"] [data-session-rename]')`);
    await js(`window.prompt = () => "Pinned monitor"; document.querySelector('[data-session-id="${sessions[0].id}"] [data-session-rename]').click(); return true;`);
    await wait(`document.querySelector('[data-session-id="${sessions[0].id}"] .session-label').textContent.includes("Pinned monitor")`);
    await api("/api/devices/local/tmux");
    const renamed = (await api("/api/sessions")).sessions.find((session) => session.id === sessions[0].id);
    assert(renamed?.title === "Pinned monitor" && renamed.title_overridden === true, "automatic naming overwrote a renamed session");
    const editSwap = await js(`
      const row = document.querySelector('[data-session-id="${sessions[0].id}"]');
      const edit = row.querySelector('[data-session-rename]');
      edit.focus();
      const icon = row.querySelector('.tool-icon');
      const editBox = edit.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      return { background: getComputedStyle(edit).backgroundColor, icon: getComputedStyle(icon).visibility, offset: Math.abs((editBox.left + editBox.width / 2) - (iconBox.left + iconBox.width / 2)), state: row.querySelector('.session-state').getBoundingClientRect().width };
    `);
    assert(editSwap.background === "rgba(0, 0, 0, 0)" && editSwap.icon === "hidden" && editSwap.offset < 2 && editSwap.state > 0, `rename did not replace the tool icon cleanly: ${JSON.stringify(editSwap)}`);
    await shot("session-edit-hover");

    const before = (await api("/api/sessions")).sessions.filter((session) => session.device_id === "local");
    const alphabetical = [...before].sort((a, b) => String(a.title || a.tmux_name).replace(/^(codex|terminal|opencode|claude)\s*-\s*/i, "").localeCompare(String(b.title || b.tmux_name).replace(/^(codex|terminal|opencode|claude)\s*-\s*/i, ""), undefined, { sensitivity: "base" }));
    assert(before.length >= 2 && before.map((session) => session.id).join() === alphabetical.map((session) => session.id).join(), "sessions are not alphabetical by default");
    await js(`
      const source = document.querySelector('[data-session-id="${before[0].id}"]');
      const target = document.querySelector('[data-session-id="${before[1].id}"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().bottom }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().bottom }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
      return true;
    `);
    let after;
    for (let attempt = 0; attempt < 20; attempt++) {
      after = (await api("/api/sessions")).sessions.filter((session) => session.device_id === "local");
      if (after[1]?.id === before[0].id) break;
      await sleep(100);
    }
    const expected = [...before];
    [expected[0], expected[1]] = [expected[1], expected[0]];
    assert(after.map((session) => session.id).join() === expected.map((session) => session.id).join(), "manual session order was not persisted");
    await shot("session-organization");
  } finally {
    for (const session of sessions) await fetch(`${BASE_URL}/api/sessions/${session.id}?kill=true`, { method: "DELETE" }).catch(() => {});
    for (const name of names) disposableTmuxNames.delete(name);
  }
}

async function testAdoptedScrollbackImport() {
  const tmuxName = `Ark-adopt-smoke-${Date.now()}`;
  const marker = `ARK_ADOPT_SCROLLBACK_${Date.now()}`;
  await runLocal("tmux", ["new-session", "-d", "-s", tmuxName, "-c", "/tmp", "bash"]);
  disposableTmuxNames.add(tmuxName);
  await tmuxSendLine(tmuxName, `printf '${marker}\\n'`);
  await sleep(500);
  const adopted = await api("/api/sessions/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", tmux_name: tmuxName, cwd: "/tmp", tool: "terminal" }),
  });
  disposableSession = adopted.session;
  const files = await api(`/api/sessions/${disposableSession.id}/files`);
  const terminalLog = files.files.find((file) => file.name === "terminal.log");
  assert(terminalLog?.path, "adopted session terminal.log path missing");
  const log = await readFile(terminalLog.path, "utf8");
  assert(log.includes(marker), "adopted tmux scrollback was not imported into terminal.log");
  await runLocal("bash", ["-lc", `tmux show-options -t ${JSON.stringify(tmuxName)} history-limit | grep -q '100000'`]);
  await cleanupDisposable();
}

async function testCodexControlPrompts() {
  const tmuxName = `Ark-control-smoke-${Date.now()}`;
  await runLocal("tmux", ["new-session", "-d", "-s", tmuxName, "-c", "/tmp", "bash"]);
  disposableTmuxNames.add(tmuxName);
  const adopted = await api("/api/sessions/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", tmux_name: tmuxName, cwd: "/tmp", tool: "codex" }),
  });
  disposableSession = adopted.session;
  await js(`localStorage.setItem("ark-active-session", ${JSON.stringify(disposableSession.id)}); return true;`);
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait('!document.querySelector("#codex-footer").hidden && document.querySelector("#codex-footer strong").textContent.length > 0');
  await wait('!document.querySelector("#agent-controls").hidden');
  const agentControls = await js(`
    document.querySelector("#agent-controls").click();
    return {
      visible: !document.querySelector("#quick-actions").hidden,
      labels: [...document.querySelectorAll("#quick-actions button")].map((button) => button.textContent.trim()).join("|"),
      interrupt: Boolean(document.querySelector("#interrupt")),
    };
  `);
  assert(agentControls.visible && agentControls.labels === "Status|Model & reasoning|Permissions" && !agentControls.interrupt, `agent controls popover is incorrect: ${JSON.stringify(agentControls)}`);
  await js('document.querySelector("#agent-controls").click(); return true;');
  await wait('document.querySelector("#quick-actions").hidden');
  await js('activeSession().codex_usage = { plan_type: "pro", primary: { used_percent: 91, window_minutes: 10080, resets_at: 1784310183 }, secondary: { used_percent: 36, window_minutes: 10080, resets_at: 1784914983 } }; renderCodexFooter(); return true;');
  assert(await js('return document.querySelector("#codex-footer").textContent.includes("Weekly") && document.querySelector("#codex-footer").textContent.includes("GPT-5.3 Codex Spark") && document.querySelector("#codex-footer").textContent.includes("91% used") && document.querySelector("#codex-footer").textContent.includes("36% used") && document.querySelectorAll("#codex-footer progress").length === 2 && document.querySelector(".codex-usage-warning")?.textContent.includes("nearly exhausted") && !document.querySelector("[data-auto-resume]");'), "Codex weekly usage footer is incorrect");
  await shot("codex-usage-warning");
  await tmuxSendLine(tmuxName, "printf 'Model: gpt-5.6-sol\\nDirectory: /tmp\\nPermissions: workspace-write\\nContext window: 80%% left\\n'; read -r");
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "status"');
  assert((await api(`/api/sessions/${disposableSession.id}/capture`)).agent_state === "ready", "status was classified as needs input");
  await js('document.querySelector("[data-control-close]").click(); return true;');
  await wait('document.querySelector("#control-sheet").hidden');
  await runLocal("tmux", ["respawn-pane", "-k", "-t", tmuxName, "bash"]);
  await tmuxSendLine(tmuxName, "printf 'Model: gpt-5.6-sol\\nDirectory: /tmp\\nPermissions: workspace-write\\nContext window: 79%% left\\n'; read -r");
  await sleep(2200);
  await js(`openSession(${JSON.stringify(disposableSession.id)}); return true;`);
  assert(await js('return document.querySelector("#control-sheet").hidden;'), "dismissed status control reopened during polling");

  await runLocal("tmux", ["respawn-pane", "-k", "-t", tmuxName, "bash"]);
  await tmuxSendLine(tmuxName, "printf 'Working (2s - esc to interrupt)\\n'");
  await wait(`[...document.querySelectorAll("#devices .session")].some((item) => item.textContent.includes(${JSON.stringify(tmuxName)}) && item.textContent.includes("working"))`);
  await runLocal("tmux", ["respawn-pane", "-k", "-t", tmuxName, "bash"]);
  await tmuxSendLine(tmuxName, `bash ${JSON.stringify(path.resolve("test/fixtures/controls/menu-harness.sh"))} approval`);
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "approval" && document.querySelectorAll("#control-body [data-command]").length === 3');
  await wait(`[...document.querySelectorAll("#devices .session")].some((item) => item.textContent.includes(${JSON.stringify(tmuxName)}) && item.textContent.includes("needs input"))`);
  await wait(`!document.querySelector("#input-inbox").hidden && document.querySelector("#input-inbox").textContent.includes(${JSON.stringify(tmuxName)})`);
  const pending = (await api("/api/sessions")).sessions.find((session) => session.id === disposableSession.id)?.pending_control;
  assert(pending?.kind === "approval" && pending.id, "input prompt was not persisted on the session");
  const pendingFiles = await api(`/api/sessions/${disposableSession.id}/files`);
  const pendingYaml = await readFile(pendingFiles.files.find((file) => file.name === "session.yml").path, "utf8");
  assert(pendingYaml.includes("pending_control:") && pendingYaml.includes(pending.id), "input prompt was not durable on disk");
  assert(await js('return document.querySelector("#session-panel").dataset.captureTransport === "stream";'), "active chat still uses browser polling");
  assert(await js('return Boolean(document.querySelector("#control-body [data-open-terminal]"));'), "interactive prompt has no full-terminal fallback");
  assert(await js('return document.querySelector("#control-prompt").textContent.includes("Reason: Verify Ark") && document.querySelector("#control-prompt").textContent.includes("Command: npm run check") && !document.querySelector("#control-body").textContent.includes("32.26");'), "interactive prompt lost its request context or parsed command numbers as choices");
  assert(await js('return getComputedStyle(document.querySelector("#control-body")).display === "flex";'), "interactive choices are not horizontal");
  await wait('Number(getComputedStyle(document.querySelector(".control-panel")).opacity) > 0.99');
  await shot("input-needed");
  await js('document.querySelector("[data-control-close]").click(); return true;');
  await wait('document.querySelector("#control-sheet").hidden');
  await sleep(700);
  assert(!/(?:^|\n)picked:[^\n]*$/m.test((await api(`/api/sessions/${disposableSession.id}/capture`)).text), "closing an input card sent a terminal key");
  await js('document.querySelector("#input-inbox [data-pending-session]").click(); return true;');
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "approval"');
  await js('document.querySelector("#control-body [data-command=\\"1\\"]").click(); return true;');
  await wait('document.querySelector("#control-sheet").hidden');
  await wait('document.querySelector("#input-inbox").hidden');
  const capture = await api(`/api/sessions/${disposableSession.id}/capture`);
  assert(capture.text.includes("picked:1"), "interactive prompt choice did not reach tmux");
  assert(!capture.pending_control, "answered input prompt remained pending");

  await runLocal("tmux", ["respawn-pane", "-k", "-t", tmuxName, "bash"]);
  await tmuxSendLine(tmuxName, `bash ${JSON.stringify(path.resolve("test/fixtures/controls/menu-harness.sh"))}`);
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "model" && document.querySelectorAll("#control-body [data-command]").length === 7');
  assert(await js('return [...document.querySelectorAll("#control-body [data-command] .control-choice-title")].map((item) => item.textContent.replace(/Current|Default/g, "").trim()).join("|");') === "1gpt-5.5|2gpt-5.6-sol|3gpt-5.6-terra|4gpt-5.6-luna|5gpt-5.4|6gpt-5.4-mini|7gpt-5.3-codex-spark", "model picker lost or mangled options");
  await sleep(250);
  await shot("model-picker");
  await js('document.querySelector("#control-body [data-command=\\"4\\"]").click(); return true;');
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "reasoning" && document.querySelectorAll("#control-body [data-command]").length === 6');
  await sleep(250);
  await shot("reasoning-picker");
  await js('document.querySelector("#control-body [data-command=\\"6\\"]").click(); return true;');
  await wait('document.querySelector("#session-runtime").textContent.includes("gpt-5.6-luna") && document.querySelector("#session-runtime").textContent.includes("ultra reasoning") && document.querySelector("#session-runtime").textContent.includes("fast speed")');
  await runLocal("tmux", ["respawn-pane", "-k", "-t", tmuxName, "bash"]);
  await sleep(250);
  await tmuxSendLine(tmuxName, `bash ${JSON.stringify(path.resolve("test/fixtures/controls/menu-harness.sh"))} permissions`);
  await wait('!document.querySelector("#control-sheet").hidden && document.querySelector("#control-kind").textContent === "permissions" && document.querySelectorAll("#control-body [data-command]").length === 3', 30000);
  assert(await js('return document.querySelector("#control-body [data-command=\\"3\\"]").textContent.includes("Full Access");'), "Full Access permission is missing");
  await wait('Number(getComputedStyle(document.querySelector(".control-panel")).opacity) > 0.99');
  await shot("permissions-picker");
  await js('document.querySelector("#control-body [data-command=\\"3\\"]").click(); return true;');
  await waitForTerminalLogText(disposableSession.id, "permissions:3");
  await cleanupDisposable();
}

async function testChatLayout() {
  await saveToolCommands({ opencode: "bash" });
  const tmuxName = `Ark-chat-smoke-${Date.now()}`;
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", tmux_name: tmuxName, cwd: "/tmp", tool: "opencode" }),
  });
  disposableSession = created.session || created;
  assert(disposableSession.runner_source === "settings", `expected settings runner fallback, got ${disposableSession.runner_source || "missing"}`);
  assert(disposableSession.runner_id === "settings-opencode", `expected settings-opencode runner, got ${disposableSession.runner_id || "missing"}`);
  disposableTmuxNames.add(disposableSession.tmux_name);
  await js(`localStorage.setItem("ark-active-session", ${JSON.stringify(disposableSession.id)}); return true;`);
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('document.querySelector("#parsed").classList.contains("chat-output")');
  await wait('document.querySelector("#devices .session.active .tool-icon use")?.getAttribute("href") === "#tool-opencode" && document.querySelector("#title .tool-icon use")?.getAttribute("href") === "#tool-opencode"');
  await attachImageInBrowser();
  await js('document.querySelector("#attachment-queue .attachment-preview button").focus(); return true;');
  await wait('getComputedStyle(document.querySelector("#attachment-queue .attachment-preview span")).opacity === "1" && getComputedStyle(document.querySelector("#attachment-queue .attachment-preview button")).opacity === "1"');
  await shot("chat-attachment-hover");
  await js('document.querySelector("#attachment-queue .attachment-preview button").click(); return true;');
  await wait('document.querySelector("#attachment-queue").hidden');
  await js(`document.querySelector("#input").value = "hello from chat smoke"; document.querySelector("#send").click(); return true;`);
  await wait('document.querySelector("#parsed").innerText.includes("hello from chat smoke") && document.querySelector(".chat-message.user")');
  const history = await waitForPersistedMessage(disposableSession.id, "hello from chat smoke");
  assert(history.messages.some((message) => message.role === "user" && message.text.includes("hello from chat smoke")), "chat message was not persisted");
  const imageForm = new FormData();
  imageForm.append("file", new Blob([await readFile(path.join(OUT, "main.png"))], { type: "image/png" }), "chat-image.png");
  const imageUpload = await api(`/api/sessions/${disposableSession.id}/attachments`, { method: "POST", body: imageForm });
  const nextImageForm = new FormData();
  nextImageForm.append("file", new Blob([await readFile(path.join(OUT, "main.png"))], { type: "image/png" }), "chat-image-next.png");
  const nextImageUpload = await api(`/api/sessions/${disposableSession.id}/attachments`, { method: "POST", body: nextImageForm });
  assert(imageUpload.url, "image upload did not return a browser URL");
  const imageResponse = await fetch(`${BASE_URL}${imageUpload.url}`);
  assert(imageResponse.ok && imageResponse.headers.get("content-type") === "image/png", "stored chat image is not browser-renderable");
  await api(`/api/sessions/${disposableSession.id}/send`, {
    method: "POST",
    body: JSON.stringify({ text: `echo image-chat-smoke\n# Attached file: ${imageUpload.path}\n# Attached file: ${nextImageUpload.path}`, submit: true, attachments: [imageUpload, nextImageUpload] }),
  });
  await waitForPersistedMessage(disposableSession.id, "image-chat-smoke");
  await js('return loadChatMessages(activeSession(), true);');
  await wait('document.querySelector(".message-image")?.complete && document.querySelector(".message-image").naturalWidth > 0');
  assert(await js(`return document.querySelector(".message-images a")?.href.endsWith(${JSON.stringify(imageUpload.url)});`), "chat image does not link to its full-size file");
  const thumbnail = await js('return { width: document.querySelector(".message-image").clientWidth, height: document.querySelector(".message-image").clientHeight, target: document.querySelector(".message-image").closest("a")?.target };');
  assert(thumbnail.width <= 240 && thumbnail.height <= 180, `chat image is not a thumbnail: ${thumbnail.width}x${thumbnail.height}`);
  assert(!thumbnail.target, "chat image still targets a new tab");
  await js('document.querySelector(".message-image").click(); return true;');
  await wait('document.querySelector("#image-viewer").open && document.querySelector("#image-viewer-image").complete && document.querySelector("#image-viewer-image").naturalWidth > 0');
  await js('document.querySelector("#image-viewer-next").click(); return true;');
  await wait(`document.querySelector("#image-viewer-image").src.endsWith(${JSON.stringify(nextImageUpload.url)}) && document.querySelector("#image-viewer-position").textContent === "2 / 2"`);
  await shot("chat-image-open");
  await js('document.querySelector("#image-viewer-close").click(); return true;');
  await wait('!document.querySelector("#image-viewer").open && getComputedStyle(document.querySelector("#image-viewer")).display === "none"');
  const markdownImageWrapped = await js(`renderChatCapture({ messages: [{ role: "assistant", text: ${JSON.stringify(`![image markdown smoke](${imageUpload.url})`)} }] }, { id: "markdown-image-smoke", tool: "opencode" }, false); return Boolean(document.querySelector(".chat-message.assistant .message-text .message-image")?.closest("a")?.hasAttribute("data-image-viewer"));`);
  assert(markdownImageWrapped, "Markdown image was not wired to the in-app viewer");
  await js('return loadChatMessages(activeSession(), true);');
  await shot("chat-image");
  await tmuxSendLine(disposableSession.tmux_name, "printf 'assistant: hello from assistant smoke\\n'");
  const assistantHistory = await waitForPersistedMessage(disposableSession.id, "hello from assistant smoke", "assistant");
  assert(assistantHistory.messages.some((message) => message.role === "assistant" && message.text.includes("hello from assistant smoke")), "assistant message was not persisted");
  await wait('document.querySelector(".chat-message.assistant .message-role .tool-icon use")?.getAttribute("href") === "#tool-opencode"');
  await tmuxSendLine(disposableSession.tmux_name, "printf 'Codex\\nShort reply\\n'");
  const headerHistory = await waitForPersistedMessage(disposableSession.id, "Short reply", "assistant");
  assert(headerHistory.messages.some((message) => message.role === "assistant" && message.text.includes("Short reply")), "role-header assistant message was not persisted");
  await tmuxSendLine(disposableSession.tmux_name, "printf '• Bullet reply\\n• SessionStart hook (completed)\\nhook context: noisy startup\\n  … +12 lines (ctrl + t to view transcript)\\n'");
  const bulletHistory = await waitForPersistedMessage(disposableSession.id, "Bullet reply", "assistant");
  assert(bulletHistory.messages.some((message) => message.role === "assistant" && message.text.includes("Bullet reply")), "Codex bullet assistant reply was not persisted");
  const hookLeak = bulletHistory.messages.filter((message) => message.text.includes("SessionStart hook") || message.text.includes("noisy startup"));
  assert(!hookLeak.length, `Codex hook noise leaked into chat history: ${JSON.stringify(hookLeak)}`);
  await tmuxSendLine(disposableSession.tmux_name, "printf '> You are in /tmp\\nDo you trust the contents of this directory? Working with untrusted contents\\n› 1. Yes, continue\\nPress enter to continue\\n'");
  await api(`/api/sessions/${disposableSession.id}/capture`);
  const trustHistory = await api(`/api/sessions/${disposableSession.id}/messages`);
  assert(!trustHistory.messages.some((message) => message.text.includes("Do you trust the contents")), "Codex trust prompt leaked into chat history");
  await tmuxSendLine(disposableSession.tmux_name, "printf '╭────────╮\\n│ >_ OpenAI Codex (v0.143.0) │\\n│ model: gpt-5.5 xhigh fast │\\n╰────────╯\\n› Run /review on my current changes\\ngpt-5.5 xhigh fast · /tmp\\nTip: NEW: Codex can now generate and use memories.\\n• You have 1 usage limit reset available. Run /usage to use one.\\n• Booting MCP server: codex_apps (0s • esc to interrupt)\\n◦ Booting MCP server: codex_apps (0s • esc to interrupt)\\n'");
  await api(`/api/sessions/${disposableSession.id}/capture`);
  const chromeHistory = await api(`/api/sessions/${disposableSession.id}/messages`);
  assert(!chromeHistory.messages.some((message) => message.text.includes("OpenAI Codex") || message.text.includes("Run /review") || message.text.includes("usage limit reset") || message.text.includes("Booting MCP server")), "Codex chrome leaked into chat history");
  await tmuxSendLine(disposableSession.tmux_name, "printf 'Codex\\n/permissions   choose what Codex is allowed to do\\n/personality   choose a communication style for Codex\\n1. Ask for approval (current)  Codex can read and edit files in the current workspace, and run\\ncommands. Approval is\\nrequired to access the internet or edit other files.\\n2. Approve for me              Only ask for actions detected as potentially unsafe.\\nfor approval. Exercise caution when using.\\nPermissions updated to Full Access\\n'");
  await api(`/api/sessions/${disposableSession.id}/capture`);
  const controlHistory = await api(`/api/sessions/${disposableSession.id}/messages`);
  assert(!controlHistory.messages.some((message) => message.text.includes("/permissions") || message.text.includes("Ask for approval") || message.text.includes("Permissions updated")), "Codex control screen leaked into chat history");
  await runLocal("tmux", ["respawn-pane", "-k", "-t", disposableSession.tmux_name, "bash"]);
  await runLocal("tmux", ["send-keys", "-t", disposableSession.tmux_name, "C-l"]);
  await api(`/api/sessions/${disposableSession.id}/capture`);
  await wait('document.querySelector("#control-sheet").hidden');
  await assertSessionFiles(disposableSession.id, { messages: true });
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('document.querySelector("#parsed").innerText.includes("hello from chat smoke") && document.querySelector("#parsed").innerText.includes("hello from assistant smoke") && document.querySelector("#parsed").innerText.includes("Short reply") && document.querySelector(".chat-message.user") && document.querySelector(".chat-message.assistant")', 30000);
  const longChat = await js(`
    renderChatCapture({ messages: Array.from({ length: 260 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: "long chat message " + index })) }, { id: "long-chat-smoke", tool: "opencode" }, false);
    return { cards: document.querySelectorAll(".chat-message").length, more: document.querySelector("[data-show-earlier]")?.textContent || "" };
  `);
  assert(longChat.cards === 120 && longChat.more.includes("140 hidden"), `long chat was fully rendered: ${JSON.stringify(longChat)}`);
  const evidenceColumns = await js(`
    renderChatCapture({ messages: [{ role: "assistant", text: "- Validation is green:\\n    - synthetic tests\\n    - network tests\\n    - map probe\\n    - ASan run\\n    - Windows viewer\\n    - structure hygiene" }] }, { id: "evidence-grid-smoke", tool: "codex" }, false);
    return {
      columns: getComputedStyle(document.querySelector(".message-text li > ul")).gridTemplateColumns.split(" ").length,
      structured: document.querySelector(".chat-message.assistant").classList.contains("structured"),
    };
  `);
  assert(evidenceColumns.columns > 1 && evidenceColumns.structured, "nested evidence list did not use the available width");
  await shot("evidence-grid");
  const attachmentOnly = await js(`
    renderChatCapture({ messages: [
      { role: "assistant", text: "", attachments: [{ name: "attachment-only.png", filename: "attachment-only.png", type: "image/png" }] },
      { role: "assistant", text: "" },
    ] }, { id: "attachment-only-smoke", tool: "codex" }, false);
    return {
      cards: document.querySelectorAll(".chat-message").length,
      emptyText: document.querySelectorAll(".chat-message .message-text").length,
      images: document.querySelectorAll(".chat-message .message-images img").length,
    };
  `);
  assert(attachmentOnly.cards === 1 && attachmentOnly.emptyText === 0 && attachmentOnly.images === 1, `attachment-only message rendered an empty bubble: ${JSON.stringify(attachmentOnly)}`);
  const updateStack = await js(`
    renderChatCapture({ messages: [
      { role: "assistant", text: "First progress update." },
      { role: "assistant", text: "Second progress update." },
      { role: "assistant", text: "Final progress update." },
    ] }, { id: "update-stack-smoke", tool: "codex" }, false);
    const continued = document.querySelector(".chat-message.assistant.continued");
    return { margin: getComputedStyle(continued).marginTop, rail: getComputedStyle(continued).borderLeftStyle, bubble: getComputedStyle(continued.querySelector(".message-text")).backgroundColor };
  `);
  assert(updateStack.margin === "-11px" && updateStack.rail === "none" && updateStack.bubble !== "rgba(0, 0, 0, 0)", `assistant updates did not form compact chat bubbles: ${JSON.stringify(updateStack)}`);
  await shot("update-stack");
  await js('return loadChatMessages(activeSession(), true);');
  await sleep(250);
  const navStart = await js(`
    stopPolling();
    renderChatCapture({ messages: [
      { role: "user", text: "nav first message" },
      { role: "assistant", text: "first response" },
      { role: "user", text: "nav second message" },
      { role: "assistant", text: "second response" },
    ] }, { id: "nav-smoke", tool: "opencode" }, false);
    for (const message of document.querySelectorAll(".chat-message.assistant")) message.style.minHeight = "1200px";
    document.querySelector("#parsed").scrollTop = 200;
    updateMessageNav();
    return document.querySelector("#parsed").scrollTop;
  `);
  assert(await js('return !document.querySelector("#message-nav").hidden && document.querySelectorAll("#message-nav button").length === 2;'), "user-message navigator is unavailable");
  await js('document.querySelector("#message-previous").click(); return true;');
  await wait(`document.querySelector("#parsed").scrollTop < ${navStart - 50}`);
  await sleep(500);
  const firstTop = await js('return document.querySelector("#parsed").scrollTop;');
  assert(firstTop < navStart, "previous-message arrow did not scroll upward");
  await js('document.querySelector("#message-next").click(); return true;');
  await wait(`document.querySelector("#parsed").scrollTop > ${firstTop + 50}`);
  await shot("message-navigation");
  await tmuxSendLine(disposableSession.tmux_name, "printf 'assistant: scroll-bottom-smoke '; yes long | head -n 1000 | tr '\\n' ' '; printf '\\n'");
  await waitForPersistedMessage(disposableSession.id, "scroll-bottom-smoke", "assistant");
  await js('return loadChatMessages(activeSession(), true);');
  await wait('document.querySelector("#parsed").innerText.includes("scroll-bottom-smoke")');
  const reopenedAtBottom = await js(`
    document.querySelector("#parsed").scrollTop = 100;
    openSession(activeSession().id);
    stopPolling();
    return new Promise((resolve) => setTimeout(() => resolve({
      top: document.querySelector("#parsed").scrollTop,
      max: document.querySelector("#parsed").scrollHeight - document.querySelector("#parsed").clientHeight,
    }), 250));
  `);
  assert(reopenedAtBottom.max > 500 && reopenedAtBottom.top >= reopenedAtBottom.max - 2, `opening a chat did not land at the bottom: ${JSON.stringify(reopenedAtBottom)}`);
  await js('startPolling(); return loadChatMessages(activeSession(), true);');
  await wait('document.querySelector("#parsed").innerText.includes("hello from chat smoke")');
  await tmuxSendLine(disposableSession.tmux_name, "printf 'bash: raw-debug-smoke: command not found\\n'");
  await api(`/api/sessions/${disposableSession.id}/capture`);
  const chatText = await js('return document.querySelector("#parsed").innerText;');
  assert(!chatText.includes("command not found"), "chat view leaked shell command errors");
  assert(!/[$#]\s+hello from chat smoke/.test(chatText), "chat view leaked shell prompt input");
  await shot("chat");
  await js('document.querySelector("#view-raw").click(); return true;');
  await wait('document.querySelector("#view-raw").innerText === "Terminal" && !document.querySelector("#xterm").hidden && document.querySelector("#session-panel").classList.contains("live-terminal") && getComputedStyle(document.querySelector(".composer")).display === "none"');
  await shot("chat-terminal");
  await js('document.querySelector("#view-parsed").click(); return true;');
  await wait('document.querySelector("#parsed").classList.contains("chat-output") && document.querySelector("#parsed").innerText.includes("Short reply")');
  const terminalReturnAtBottom = await js('return new Promise((resolve) => setTimeout(() => resolve({ top: document.querySelector("#parsed").scrollTop, max: document.querySelector("#parsed").scrollHeight - document.querySelector("#parsed").clientHeight }), 250));');
  assert(terminalReturnAtBottom.top >= terminalReturnAtBottom.max - 2, `returning from Terminal did not land at the bottom: ${JSON.stringify(terminalReturnAtBottom)}`);
  const resizedAtBottom = await js('document.querySelector("#parsed").scrollTop = 100; window.dispatchEvent(new Event("resize")); return new Promise((resolve) => setTimeout(() => resolve({ top: document.querySelector("#parsed").scrollTop, max: document.querySelector("#parsed").scrollHeight - document.querySelector("#parsed").clientHeight }), 250));');
  assert(resizedAtBottom.top >= resizedAtBottom.max - 2, `resizing a chat did not return to the bottom: ${JSON.stringify(resizedAtBottom)}`);
  await command("WebDriver:SetWindowRect", { width: 2048, height: 1152 });
  const wideLayout = await js(`
    const chat = document.querySelector(".chat-stream").getBoundingClientRect();
    const composer = document.querySelector(".composer").getBoundingClientRect();
    const nav = document.querySelector("#message-nav").getBoundingClientRect();
    return {
      chat: Math.round(chat.width),
      composer: document.querySelector(".composer").clientWidth,
      navLeft: Math.round(nav.left),
      navTop: Math.round(nav.top),
      composerTop: Math.round(composer.top),
      composerBottom: Math.round(composer.bottom),
    };
  `);
  assert(wideLayout.chat >= 1500 && wideLayout.composer >= 1500 && wideLayout.navTop >= wideLayout.composerTop && wideLayout.navTop < wideLayout.composerBottom, `fullscreen chat lane or navigator is misplaced: ${JSON.stringify(wideLayout)}`);
  await shot("wide-chat");
  await command("WebDriver:SetWindowRect", { width: 390, height: 900 });
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('document.querySelector("#parsed").classList.contains("chat-output") && document.querySelector("#parsed").innerText.includes("hello from chat smoke") && document.querySelector("#parsed").innerText.includes("Short reply") && document.querySelector(".chat-message.user") && document.querySelector(".chat-message.assistant")', 15000);
  await shot("mobile-chat");
  await command("WebDriver:SetWindowRect", { width: 1440, height: 1000 });
  await command("WebDriver:Navigate", { url: BASE_URL });
  await api(`/api/sessions/${disposableSession.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(disposableSession.tmux_name);
  disposableSession = null;
  await saveToolCommands(originalSettings.tool_commands);
}

async function testClaudeChatLayout() {
  await saveToolCommands({ claude: "bash" });
  const tmuxName = `Ark-claude-smoke-${Date.now()}`;
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", tmux_name: tmuxName, cwd: "/tmp", tool: "claude" }),
  });
  disposableSession = created.session || created;
  assert(disposableSession.runner_source === "settings", `expected settings runner fallback, got ${disposableSession.runner_source || "missing"}`);
  assert(disposableSession.runner_id === "settings-claude", `expected settings-claude runner, got ${disposableSession.runner_id || "missing"}`);
  disposableTmuxNames.add(disposableSession.tmux_name);
  await js(`localStorage.setItem("ark-active-session", ${JSON.stringify(disposableSession.id)}); return true;`);
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('document.querySelector("#parsed").classList.contains("chat-output") && document.querySelector("#session-kind").textContent.toLowerCase().includes("claude")');
  await js(`document.querySelector("#input").value = "hello from claude smoke"; document.querySelector("#send").click(); return true;`);
  const userHistory = await waitForPersistedMessage(disposableSession.id, "hello from claude smoke");
  assert(userHistory.messages.some((message) => message.role === "user" && message.text.includes("hello from claude smoke")), "Claude user message was not persisted");
  await tmuxSendLine(disposableSession.tmux_name, "printf 'claude: hello from claude assistant smoke\\n'");
  const assistantHistory = await waitForPersistedMessage(disposableSession.id, "hello from claude assistant smoke", "assistant");
  assert(assistantHistory.messages.some((message) => message.role === "assistant" && message.text.includes("hello from claude assistant smoke")), "Claude assistant message was not persisted");
  await wait('document.querySelector("#parsed").innerText.includes("hello from claude smoke") && document.querySelector("#parsed").innerText.includes("hello from claude assistant smoke") && document.querySelector(".chat-message.user") && document.querySelector(".chat-message.assistant")', 15000);
  await shot("claude-chat");
  await api(`/api/sessions/${disposableSession.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(disposableSession.tmux_name);
  disposableSession = null;
  await saveToolCommands(originalSettings.tool_commands);
}

async function testCentralRunnerRemoteChat() {
  const remote = (await api("/api/devices")).devices.find((device) => !device.local && device.status !== "offline");
  if (!remote) return;
  await saveToolCommands({ opencode: "bash" });
  const tmuxName = `Ark-central-smoke-${Date.now()}`;
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: remote.id, tmux_name: tmuxName, cwd: "/tmp", tool: "opencode" }),
  });
  disposableSession = created.session || created;
  assert(disposableSession.device_id === remote.id, "central runner session lost target device");
  assert(disposableSession.central_runner, "remote chat session did not use central runner");
  assert(disposableSession.tmux_device_id === "local", `expected local tmux device, got ${disposableSession.tmux_device_id || "missing"}`);
  assert(disposableSession.runner_device_id === "local", `expected local runner device, got ${disposableSession.runner_device_id || "missing"}`);
  disposableTmuxNames.add(disposableSession.tmux_name);
  const form = new FormData();
  form.append("file", new Blob(["central runner attachment smoke"], { type: "text/plain" }), "central-runner.txt");
  const upload = await api(`/api/sessions/${disposableSession.id}/attachments`, { method: "POST", body: form });
  assert(upload.path.includes(`/sessions/${disposableSession.id}/attachments/`), `central runner attachment did not stay in Ark session storage: ${upload.path}`);
  await assertSessionFiles(disposableSession.id, { attachment: true });
  await js(`localStorage.setItem("ark-active-session", ${JSON.stringify(disposableSession.id)}); return true;`);
  await command("WebDriver:Navigate", { url: BASE_URL });
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await wait('document.querySelector("#session-detail").textContent.includes("controller on")');
  await wait(`!document.querySelector('[data-session-id="${disposableSession.id}"] .session').classList.contains("stopped")`);
  await wait('document.querySelector("#status").textContent === "Connected"', 15000);
  await shot("central-runner-remote");
  await api(`/api/sessions/${disposableSession.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(disposableSession.tmux_name);
  disposableSession = null;
  await saveToolCommands(originalSettings.tool_commands);
}

async function testRemoteTerminalPipeLog() {
  const devices = (await api("/api/devices")).devices.filter((device) => !device.local && device.status !== "offline");
  let remote = null;
  for (const device of devices) {
    try {
      await api(`/api/devices/${encodeURIComponent(device.id)}/tmux`);
      remote = device;
      break;
    } catch {}
  }
  if (!remote) return;
  const marker = `ARK_REMOTE_PIPE_${Date.now()}`;
  const tmuxName = `Ark-remote-pipe-${Date.now()}`;
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: remote.id, tmux_name: tmuxName, cwd: "/tmp", tool: "terminal" }),
  });
  disposableSession = created.session || created;
  try {
    assert(disposableSession.tmux_device_id === remote.id, "remote terminal did not run tmux on remote device");
    await api(`/api/sessions/${disposableSession.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `printf '${marker}\\n'`, submit: true }),
    });
    await sleep(1000);
    await api(`/api/sessions/${disposableSession.id}/capture`).catch(() => {});
    const data = await api(`/api/sessions/${disposableSession.id}/files`);
    const terminalLog = data.files.find((file) => file.name === "terminal.log");
    assert(terminalLog?.path, "remote terminal.log path missing");
    const log = await readFile(terminalLog.path, "utf8");
    assert(log.includes(marker), "remote tmux pipe log did not sync into Ark terminal.log");
  } finally {
    await api(`/api/sessions/${disposableSession.id}?kill=true`, { method: "DELETE" }).catch(() => {});
    disposableSession = null;
  }
}

async function maybeTestRemoteCodexCentralRunner() {
  const devices = (await api("/api/devices")).devices.filter((device) => !device.local && device.status !== "offline");
  let remote = null;
  for (const device of devices) {
    const tools = await api(`/api/devices/${encodeURIComponent(device.id)}/tools`).catch(() => null);
    if (tools?.tools.some((tool) => tool.tool === "codex" && tool.available)) {
      remote = device;
      break;
    }
  }
  if (!remote) return;
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: remote.id, cwd: "/tmp", tool: "codex", profile_id: "codex-default" }),
  });
  disposableSession = created.session || created;
  disposableTmuxNames.add(disposableSession.tmux_name);
  try {
    assert(disposableSession.device_id === remote.id, "real Codex remote session lost target device");
    assert(disposableSession.central_runner, "remote Codex session did not use the central runner");
    assert(disposableSession.tmux_device_id === "local", `expected local tmux device, got ${disposableSession.tmux_device_id || "missing"}`);
    assert(disposableSession.runner_device_id === "local", `expected local runner device, got ${disposableSession.runner_device_id || "missing"}`);
    await waitForCodexReady(disposableSession.id);
    await api(`/api/sessions/${disposableSession.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "Say ARK_REMOTE_CODEX_SMOKE_OK only." }),
    });
    const history = await waitForPersistedMessage(disposableSession.id, "ARK_REMOTE_CODEX_SMOKE_OK", "assistant", 120000);
    assert(history.messages.some((message) => message.role === "assistant" && message.text.includes("ARK_REMOTE_CODEX_SMOKE_OK")), "real remote Codex response was not captured");
  } finally {
    await cleanupDisposable();
  }
}

async function waitForCodexReady(sessionId) {
  for (let i = 0; i < 90; i += 1) {
    const capture = (await api(`/api/sessions/${sessionId}/capture`)).text || "";
    if (capture.includes("Do you trust the contents")) {
      await api(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        body: JSON.stringify({ text: "1" }),
      });
      await sleep(2500);
    }
    if (capture.includes("OpenAI Codex") && /gpt-[\w.-]+/i.test(capture) && !capture.includes("Booting MCP server")) return;
    await sleep(1000);
  }
  throw new Error("Codex did not become ready");
}

async function waitForPersistedMessage(sessionId, text, role = "user", timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await api(`/api/sessions/${sessionId}/capture`).catch(() => {});
    const history = await api(`/api/sessions/${sessionId}/messages`);
    if (history.messages.some((message) => message.role === role && message.text.includes(text))) return history;
    await sleep(250);
  }
  return api(`/api/sessions/${sessionId}/messages`);
}

async function assertSessionFiles(sessionId, checks = {}) {
  await api(`/api/sessions/${sessionId}/capture`).catch(() => {});
  const data = await api(`/api/sessions/${sessionId}/files`);
  assert(data.storage_path && data.storage_path.includes("/sessions/"), "session storage path missing");
  const files = new Map(data.files.map((file) => [file.name, file]));
  assert(files.get("session.yml")?.size > 0, "session.yml was not written");
  assert(files.get("attachments")?.type === "directory", "attachments directory missing");
  if (checks.terminal) assert(files.get("terminal.log")?.size > 0, "terminal.log was not written");
  if (checks.messages) assert(files.get("messages.jsonl")?.size > 0, "messages.jsonl was not written");
  if (checks.attachment) assert(files.get("attachments")?.child_count > 0, "attachment file was not copied into session storage");
}

async function assertLiveTerminalLog(sessionId, text = "") {
  const data = await api(`/api/sessions/${sessionId}/files`);
  const files = new Map(data.files.map((file) => [file.name, file]));
  assert(files.get("terminal.log")?.size > 0, "live terminal output was not appended to terminal.log");
  if (text) {
    const log = await readFile(files.get("terminal.log").path, "utf8");
    assert(log.includes(text), `terminal.log missing ${text}`);
  }
}

async function waitForTerminalLogText(sessionId, text) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const data = await api(`/api/sessions/${sessionId}/files`);
    const terminal = data.files.find((file) => file.name === "terminal.log");
    if (terminal?.path && (await readFile(terminal.path, "utf8")).includes(text)) return;
    await sleep(200);
  }
  throw new Error(`terminal.log missing ${text}`);
}

async function waitForNewDisposable(before) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const sessions = (await api("/api/sessions")).sessions;
    const created = sessions.find((session) => !before.has(session.id) && session.cwd === "/tmp");
    if (created) return created;
    await sleep(250);
  }
  throw new Error("disposable terminal did not create a new /tmp session");
}

async function maybeTestCodexStartupImage() {
  const tools = await api("/api/devices/local/tools");
  if (!tools.tools.find((tool) => tool.tool === "codex" && tool.available)) return;
  const profiles = await api("/api/profiles");
  const codexProfile = profiles.profiles.find((profile) => profile.tool === "codex" && profile.available);
  if (!codexProfile) return;
  await openComposer();
  const before = new Set((await api("/api/sessions")).sessions.map((session) => session.id));
  await js(`
    const tool = document.querySelector("#tool");
    tool.value = "codex";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#profile").value = ${JSON.stringify(codexProfile.id)};
    document.querySelector("#repo").value = "/tmp";
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l1hC4QAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    const file = new File([bytes], "codex-startup.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#startup-image-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  await wait('document.querySelector("#startup-images").innerText.includes("codex-startup.png")');
  await shot("codex-startup-image-queued");
  await js('document.querySelector("#start").click(); return true;');
  const sessions = await waitForNewSession(before, (session) => session.cwd === "/tmp" && session.tool === "codex");
  disposableSession = sessions;
  assert(disposableSession.runner_id === codexProfile.id, `expected ${codexProfile.id} runner, got ${disposableSession.runner_id || "missing"}`);
  disposableTmuxNames.add(disposableSession.tmux_name);
  await wait(`localStorage.getItem("ark-active-session") === ${JSON.stringify(disposableSession.id)}`);
  await shot("codex-startup-image");
  await cleanupDisposable();
}

async function maybeTestCodexTrustInput() {
  const tools = await api("/api/devices/local/tools");
  if (!tools.tools.find((tool) => tool.tool === "codex" && tool.available)) return;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ark-codex-trust-"));
  const created = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", cwd, tool: "codex", profile_id: "codex-default" }),
  });
  disposableSession = created.session || created;
  disposableTmuxNames.add(disposableSession.tmux_name);
  try {
    let captured = "";
    for (let i = 0; i < 20; i += 1) {
      captured = (await api(`/api/sessions/${disposableSession.id}/capture`)).text || "";
      if (captured.includes("Do you trust the contents")) break;
      await sleep(500);
    }
    if (!captured.includes("Do you trust the contents")) return;
    const sent = await api(`/api/sessions/${disposableSession.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "1" }),
    });
    assert(sent.message === null, "Codex trust input was stored as a chat message");
    const history = await api(`/api/sessions/${disposableSession.id}/messages`);
    assert(!history.messages.some((message) => message.role === "user" && message.text.trim() === "1"), "Codex trust input leaked into chat history");
  } finally {
    await cleanupDisposable();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function testGenericStartupImage() {
  await saveToolCommands({ opencode: "cat" });
  await openComposer();
  const before = new Set((await api("/api/sessions")).sessions.map((session) => session.id));
  await js(`
    const tool = document.querySelector("#tool");
    tool.value = "opencode";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#repo").value = "/tmp";
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l1hC4QAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    const file = new File([bytes], "opencode-startup.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#startup-image-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  await wait('document.querySelector("#startup-images").innerText.includes("opencode-startup.png")');
  await shot("generic-startup-image-queued");
  await js('document.querySelector("#start").click(); return true;');
  disposableSession = await waitForNewSession(before, (session) => session.cwd === "/tmp" && session.tool === "opencode");
  disposableTmuxNames.add(disposableSession.tmux_name);
  await wait('(document.querySelector("#output").innerText + document.querySelector("#parsed").innerText).includes("Use this image:")');
  await shot("generic-startup-image");
  await cleanupDisposable();
  await saveToolCommands(originalSettings.tool_commands);
}

async function waitForNewSession(before, predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const sessions = (await api("/api/sessions")).sessions;
    const created = sessions.find((session) => !before.has(session.id) && predicate(session));
    if (created) return created;
    await sleep(250);
  }
  throw new Error("expected new session was not created");
}

async function attachImageInBrowser() {
  return js(`
    return (async () => {
      const source = await (await fetch("/static/ark-logo.svg?v=3")).blob();
      const file = new File([source], "gui-smoke.svg", { type: "image/svg+xml" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector("#image-input");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const output = document.querySelector("#output").innerText + document.querySelector("#parsed").innerText;
        const inputText = document.querySelector("#input").value;
        const queue = document.querySelector("#attachment-queue").innerText;
        if (queue.includes("gui-smoke.svg")) return { output, input: inputText, queue };
      }
      return {
        output: document.querySelector("#output").innerText + document.querySelector("#parsed").innerText,
        input: document.querySelector("#input").value,
        queue: document.querySelector("#attachment-queue").innerText,
      };
    })();
  `);
}

async function sendImmediatelyWithAttachment() {
  await js(`
    return (async () => {
      const originalFetch = window.fetch;
      window.fetch = async (input, options) => {
        if (String(input).includes("/attachments") && options?.method === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return originalFetch(input, options);
      };
      try {
        const input = document.querySelector("#image-input");
        const file = new File(["race attachment"], "send-race.txt", { type: "text/plain" });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("#send").click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        window.fetch = originalFetch;
      }
      return document.querySelector(".attachment-uploading")?.textContent || "";
    })();
  `);
}

async function pasteImageInBrowser() {
  await js(`
    const input = document.querySelector("#input");
    const file = new File([Uint8Array.from([137,80,78,71,13,10,26,10])], "pasted.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file], getData: () => "" } });
    input.dispatchEvent(event);
    return true;
  `);
  await wait('document.querySelector("#attachment-queue").innerText.includes("pasted.png")');
  return js('return { input: document.querySelector("#input").value, output: document.querySelector("#parsed").innerText, queue: document.querySelector("#attachment-queue").innerText };');
}

async function pasteTextInBrowser() {
  return js(`
    const input = document.querySelector("#input");
    const text = "clipboard text smoke";
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type) => type === "text/plain" ? text : "" } });
    input.dispatchEvent(event);
    if (!event.defaultPrevented) input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    return { input: input.value, output: document.querySelector("#parsed").innerText, queue: document.querySelector("#attachment-queue").innerText };
  `);
}

async function pasteLongTextInBrowser() {
  await js(`
    const input = document.querySelector("#input");
    const text = "x".repeat(50001);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type) => type === "text/plain" ? text : "" } });
    input.dispatchEvent(event);
    return true;
  `);
  await wait('document.querySelector("#attachment-queue").innerText.includes("clipboard.txt")');
  return js('return { input: document.querySelector("#input").value, output: document.querySelector("#parsed").innerText, queue: document.querySelector("#attachment-queue").innerText };');
}

async function dropFileInBrowser() {
  await js(`
    const target = document.querySelector("#input");
    const file = new File(["hello from dropped file"], "notes.txt", { type: "text/plain" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(event);
    return true;
  `);
  await wait('document.querySelector("#attachment-queue").innerText.includes("notes.txt")');
  return js('return { input: document.querySelector("#input").value, output: document.querySelector("#parsed").innerText, queue: document.querySelector("#attachment-queue").innerText };');
}

async function activeSession() {
  const sessions = await api("/api/sessions");
  const id = await js('return localStorage.getItem("ark-active-session");');
  return sessions.sessions.find((session) => session.id === id);
}

async function cleanupDisposable() {
  if (!disposableSession?.id) return;
  if (!disposableTmuxNames.has(disposableSession.tmux_name)) return;
  await fetch(`${BASE_URL}/api/sessions/${disposableSession.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(disposableSession.tmux_name);
  disposableSession = null;
}

async function cleanupDisposables() {
  await cleanupDisposable();
  for (const tmuxName of disposableTmuxNames) await killTmux(tmuxName);
}

async function killTmux(tmuxName) {
  const adopted = await api("/api/sessions/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "local", tmux_name: tmuxName, cwd: "/tmp", tool: "terminal" }),
  });
  await fetch(`${BASE_URL}/api/sessions/${adopted.session.id}?kill=true`, { method: "DELETE" });
  disposableTmuxNames.delete(tmuxName);
}

async function tmuxSendLine(tmuxName, line) {
  await runLocal("tmux", ["send-keys", "-t", tmuxName, "-l", line]);
  await runLocal("tmux", ["send-keys", "-t", tmuxName, "Enter"]);
}

async function runLocal(commandName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      stderr = stderr.slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${commandName} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
}

async function setTheme(theme) {
  await js(`
    const theme = document.querySelector("#theme");
    theme.value = "${theme}";
    theme.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
}

async function shot(name) {
  const data = await command("WebDriver:TakeScreenshot");
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(data.value, "base64"));
  screenshots.push(file);
}

async function writeReport(diagnostics, sessions) {
  const report = path.join(OUT, "index.html");
  const features = Object.entries(diagnostics.features || {}).map(([key, value]) => `
    <tr><td>${escapeHtml(key)}</td><td>${escapeHtml(Array.isArray(value) ? value.join(", ") : value ? "yes" : "no")}</td></tr>
  `).join("");
  const tools = (diagnostics.tool_devices || []).map((device) => `
    <tr>
      <td>${escapeHtml(device.label)}</td>
      <td>${escapeHtml(device.status || "")}</td>
      <td>${escapeHtml((device.tools || []).filter((tool) => tool.available && tool.tool !== "terminal").map((tool) => tool.tool).join(", ") || "none")}</td>
    </tr>
  `).join("");
  const sessionRows = (sessions.sessions || []).map((session) => `
    <tr><td>${escapeHtml(session.title || session.tmux_name)}</td><td>${escapeHtml(session.tmux_name)}</td><td>${escapeHtml(session.cwd)}</td><td>${escapeHtml(session.tool)}</td></tr>
  `).join("");
  const images = screenshots.map((file) => `
    <figure>
      <img src="${escapeHtml(path.basename(file))}" alt="${escapeHtml(path.basename(file))}">
      <figcaption>${escapeHtml(path.basename(file))}</figcaption>
    </figure>
  `).join("");
  await writeFile(report, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ark GUI Smoke Report</title>
  <style>
    body{margin:0;background:#0b1118;color:#eaf2fb;font:14px/1.45 Avenir Next,Helvetica Neue,Arial,sans-serif}
    main{max-width:1200px;margin:0 auto;padding:32px}
    h1{font-size:32px;margin:0 0 4px}
    h2{margin-top:32px;color:#78c7f5}
    table{width:100%;border-collapse:collapse;background:#111821;border:1px solid #263446;border-radius:14px;overflow:hidden}
    td,th{padding:10px 12px;border-bottom:1px solid #263446;text-align:left;vertical-align:top}
    th{color:#9fb1c6;text-transform:uppercase;font-size:12px;letter-spacing:.08em}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
    figure{margin:0;background:#111821;border:1px solid #263446;border-radius:18px;overflow:hidden}
    img{display:block;width:100%;height:auto}
    figcaption{padding:10px 12px;color:#9fb1c6}
    .muted{color:#9fb1c6}
  </style>
</head>
<body>
  <main>
    <h1>Ark GUI Smoke Report</h1>
    <p class="muted">Generated ${escapeHtml(new Date().toISOString())} from ${escapeHtml(BASE_URL)}.</p>
    <h2>Feature coverage</h2>
    <table><thead><tr><th>Feature</th><th>Status</th></tr></thead><tbody>${features}</tbody></table>
    <h2>Reachable chat tools</h2>
    <table><thead><tr><th>Device</th><th>Status</th><th>Available tools</th></tr></thead><tbody>${tools}</tbody></table>
    <h2>Sessions after cleanup</h2>
    <table><thead><tr><th>Title</th><th>tmux</th><th>cwd</th><th>tool</th></tr></thead><tbody>${sessionRows}</tbody></table>
    <h2>Screenshots</h2>
    <div class="grid">${images}</div>
  </main>
</body>
</html>
`);
  return report;
}

async function wait(expression, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await js(`return Boolean(${expression});`)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function js(script) {
  return (await command("WebDriver:ExecuteScript", { script, args: [] })).value;
}

async function hello() {
  await readFrame();
}

async function command(name, params = {}) {
  nextId += 1;
  const payload = Buffer.from(JSON.stringify([0, nextId, name, params]));
  socket.write(`${payload.length}:`);
  socket.write(payload);
  const response = await readFrame();
  if (response[2]) throw new Error(`${name}: ${JSON.stringify(response[2])}`);
  return response[3];
}

async function readFrame() {
  let prefix = "";
  while (!prefix.endsWith(":")) prefix += (await readBytes(1)).toString();
  const size = Number(prefix.slice(0, -1));
  return JSON.parse((await readBytes(size)).toString());
}

function readBytes(size) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total < size) return;
      socket.off("data", onData);
      socket.pause();
      const buffer = Buffer.concat(chunks);
      const extra = buffer.subarray(size);
      if (extra.length) socket.unshift(extra);
      resolve(buffer.subarray(0, size));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.resume();
  });
}

async function connectMarionette() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      return await new Promise((resolve, reject) => {
        const client = net.createConnection({ host: "127.0.0.1", port: PORT }, () => resolve(client));
        client.once("error", reject);
      });
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Firefox Marionette did not start");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
