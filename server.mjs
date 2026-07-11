import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pty from "node-pty";
import YAML from "yaml";
import { agentStateFromScreen, codexStateFromScreen, modelControl, parseAgentControls, parseCodexControls, parseTerminalLines, stripAnsi } from "./lib/control-parser.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(ROOT, "hub", "static");
const VENDOR = new Map([
  ["/vendor/xterm/xterm.js", path.join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js")],
  ["/vendor/xterm/xterm.css", path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css")],
  ["/vendor/xterm/addon-fit.js", path.join(ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")],
  ["/vendor/marked/marked.js", path.join(ROOT, "node_modules", "marked", "lib", "marked.umd.js")],
  ["/vendor/dompurify/purify.js", path.join(ROOT, "node_modules", "dompurify", "dist", "purify.min.js")],
]);
const DATA = process.env.ARK_DATA || path.join(os.homedir(), ".local", "share", "ark");
const STORE = path.join(DATA, "sessions.json");
const CONFIG = path.join(DATA, "config.yml");
const LEGACY_SETTINGS = path.join(DATA, "settings.json");
const PROFILES = path.join(DATA, "profiles.yml");
const SECRETS = path.join(DATA, "secrets.yml");
const DEVICES = path.join(DATA, "devices.yml");
const SESSIONS_DIR = path.join(DATA, "sessions");
const UPLOADS = path.join(DATA, "uploads");
const UPLOAD_LIMIT = 64 * 1024 * 1024;
const PORT = Number(process.env.PORT || 4873);
const HOST = process.env.HOST || "0.0.0.0";
const TERMINAL_STREAMS = new Map();
const CAPTURE_STREAMS = new Map();
const STATE_STREAM = { clients: new Set(), timer: null, busy: false, last: "" };
const MUTATIONS = new Map();
const CODEX_ROLLOUTS = new Map();
const CODEX_TRANSCRIPTS = new Map();
const CONTROL_MISSES = new Map();
let DEVICE_ALIAS_SIGNATURE = "";
let AUTO_RESUME_BUSY = false;
const CONTROL_KEYS = new Set(["Enter", "Escape"]);

const DEFAULT_TOOL_COMMANDS = {
  terminal: "",
  codex: "codex --no-alt-screen",
  opencode: "opencode",
  claude: "claude",
};

const TOOL_ALIASES = {
  codex: ["codex"],
  opencode: ["opencode"],
  claude: ["claude", "claude-code"],
};

const RESUME_COMMANDS = {
  terminal: "",
  codex: "codex --no-alt-screen resume --last",
  opencode: "opencode",
  claude: "claude",
};

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrustedRemote(req.socket?.remoteAddress)) {
      return json(res, 403, { detail: "Ark only accepts local, private-network, or Tailscale clients." });
    }
    await route(req, res);
  } catch (error) {
    json(res, error?.status || 500, { detail: error?.message || String(error) });
  }
});

if (process.env.ARK_SELF_CHECK === "trusted-remote") {
  selfCheckTrustedRemote();
} else if (process.env.ARK_SELF_CHECK === "core") {
  selfCheckCore();
} else {
  server.listen(PORT, HOST, () => {
    console.log(`Ark listening on http://${HOST}:${PORT}`);
  });
  setInterval(() => autoResumeGoals().catch(() => {}), 15000).unref();
  setTimeout(() => autoResumeGoals().catch(() => {}), 2000).unref();
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/") {
    return file(res, path.join(STATIC, "index.html"));
  }
  if (req.method === "GET" && ["/manifest.webmanifest", "/sw.js"].includes(pathname)) {
    return file(res, path.join(STATIC, path.basename(pathname)));
  }
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const requested = pathname.slice("/static/".length);
    const target = path.resolve(STATIC, requested);
    if (!target.startsWith(STATIC + path.sep)) return json(res, 403, { detail: "forbidden" });
    return file(res, target);
  }
  if (req.method === "GET" && VENDOR.has(pathname)) {
    return file(res, VENDOR.get(pathname));
  }
  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/devices") {
    return json(res, 200, { devices: await loadDevices() });
  }
  if (req.method === "GET" && pathname === "/api/sessions") {
    return json(res, 200, { sessions: await listStoredSessions() });
  }
  const autoResumeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/auto-resume$/);
  if (req.method === "POST" && autoResumeMatch) {
    const session = await sessionOr404(autoResumeMatch[1]);
    if (session.tool !== "codex") return json(res, 400, { detail: "auto-resume is only available for Codex sessions" });
    const updated = await setGoalAutoResume(session.id, (await readJson(req)).enabled === true);
    autoResumeGoals().catch(() => {});
    return json(res, 200, { session: publicSession(updated) });
  }
  if (req.method === "GET" && pathname === "/api/session-states") {
    return json(res, 200, { states: await listAgentStates() });
  }
  if (req.method === "GET" && pathname === "/api/session-states/stream") {
    return streamSessionStates(req, res);
  }
  if (req.method === "GET" && pathname === "/api/settings") {
    return json(res, 200, await readSettings());
  }
  if (req.method === "PUT" && pathname === "/api/settings") {
    return json(res, 200, await writeSettings(await readJson(req)));
  }
  if (req.method === "GET" && pathname === "/api/diagnostics") {
    return json(res, 200, await diagnostics());
  }
  if (req.method === "GET" && pathname === "/api/profiles") {
    return json(res, 200, await profileDiagnostics());
  }
  if (req.method === "GET" && pathname === "/api/secrets") {
    return json(res, 200, await publicSecrets());
  }
  if (req.method === "POST" && pathname === "/api/secrets") {
    return json(res, 200, await createSecret(await readJson(req)));
  }
  const secretTestMatch = pathname.match(/^\/api\/secrets\/([^/]+)\/test$/);
  if (req.method === "POST" && secretTestMatch) {
    return json(res, 200, await testSecret(secretTestMatch[1]));
  }
  const secretMatch = pathname.match(/^\/api\/secrets\/([^/]+)$/);
  if (req.method === "DELETE" && secretMatch) {
    return json(res, 200, await removeSecret(secretMatch[1]));
  }
  if (req.method === "POST" && pathname === "/api/profiles") {
    return json(res, 200, await createCodexProfile(await readJson(req)));
  }
  const profileLoginMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/login$/);
  if (req.method === "POST" && profileLoginMatch) {
    return json(res, 200, await startCodexProfileLogin(profileLoginMatch[1]));
  }
  const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (req.method === "DELETE" && profileMatch) {
    return json(res, 200, await removeProfile(profileMatch[1]));
  }
  const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === "GET" && messagesMatch) {
    const session = await sessionOr404(messagesMatch[1]);
    const stored = await readSessionMessages(session.id);
    const device = await tmuxDeviceForSession(session);
    const transcript = await readCodexTranscript(session, device, "");
    const messages = transcript === null ? stored : await writeAuthoritativeMessages(session, transcript, stored);
    return json(res, 200, { messages });
  }
  const filesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
  if (req.method === "GET" && filesMatch) {
    const session = await sessionOr404(filesMatch[1]);
    return json(res, 200, await sessionFiles(session));
  }
  if (req.method === "POST" && pathname === "/api/sessions") {
    const body = await readJson(req);
    const device = await deviceOr404(body.device_id);
    const localDevice = await localDeviceOr404();
    const tool = body.tool || "codex";
    const settings = await readSettings();
    if (!(tool in settings.tool_commands)) return json(res, 400, { detail: "unknown tool" });
    if (!body.cwd || typeof body.cwd !== "string") return json(res, 400, { detail: "cwd is required" });

    const tmuxName = String(body.tmux_name || "").trim() || newTmuxName();
    const images = sessionImages(body.images);
    const centralRunner = tool !== "terminal" && !device.local;
    const tmuxDevice = centralRunner ? localDevice : device;
    const runner = tool === "terminal" ? terminalRunner() : await selectToolRunner(tmuxDevice, tool, body.profile_id, settings);
    const launchCommand = withProfileEnv(commandForSession(tool, runner.command, images), await resolveLaunchEnv(runner.env, runner.env_from_secrets));
    const result = await startTmux(tmuxDevice, tmuxName, sessionTmuxCwd({ central_runner: centralRunner, cwd: body.cwd }), launchCommand);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    const session = await upsertSession({
      device_id: device.id,
      device_label: device.label,
      tmux_name: tmuxName,
      cwd: body.cwd,
      tool,
      runner_id: runner.id,
      runner_label: runner.label,
      runner_source: runner.source,
      runner_command: runner.command,
      runner_path: runner.path,
      runner_env: runner.env || {},
      runner_env_from_secrets: runner.env_from_secrets || {},
      runner_account_home: runner.account_home || "",
      runner_device_id: tmuxDevice.id,
      runner_device_label: tmuxDevice.label,
      tmux_device_id: tmuxDevice.id,
      tmux_device_label: tmuxDevice.label,
      central_runner: centralRunner,
      target_ssh: sshTarget(device),
      pipe_log: true,
      title: `${tool} - ${path.basename(body.cwd) || body.cwd}`,
    });
    await enableTmuxPipeLog(tmuxDevice, session);
    const contextPrompt = centralRunnerContext(device, body.cwd, tool);
    if (contextPrompt) {
      const contextResult = await sendText(tmuxDevice, tmuxName, contextPrompt, true);
      if (contextResult.code !== 0) return json(res, 502, { detail: contextResult.output });
    }
    const imagePrompt = startupImagePrompt(tool, images);
    if (imagePrompt) {
      const imageResult = await sendText(tmuxDevice, tmuxName, imagePrompt, true);
      if (imageResult.code !== 0) return json(res, 502, { detail: imageResult.output });
    }
    await writeSessionEvent(session, {
      role: "system",
      text: `Started ${toolLabel(tool)} session ${tmuxName} in ${body.cwd}${runner.source === "profile" ? ` using ${runner.label}` : ""}${centralRunner ? ` on ${tmuxDevice.label} for ${device.label}` : ""}`,
    });
    return json(res, 200, { session });
  }
  if (req.method === "POST" && pathname === "/api/sessions/adopt") {
    const body = await readJson(req);
    const device = await deviceOr404(body.device_id);
    if (!body.tmux_name) return json(res, 400, { detail: "tmux_name is required" });
    const session = await upsertSession({
      device_id: device.id,
      device_label: device.label,
      tmux_name: body.tmux_name,
      cwd: body.cwd || "~",
      tool: body.tool || "terminal",
      pipe_log: true,
      title: body.tmux_name,
    });
    await importSessionScrollback(device, session);
    return json(res, 200, { session });
  }

  const tmuxMatch = pathname.match(/^\/api\/devices\/([^/]+)\/tmux$/);
  if (req.method === "GET" && tmuxMatch) {
    const device = await deviceOr404(tmuxMatch[1]);
    const result = await listTmux(device);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await adoptDiscoveredTmux(device, result.sessions);
    return json(res, 200, { sessions: result.sessions });
  }

  const toolsMatch = pathname.match(/^\/api\/devices\/([^/]+)\/tools$/);
  if (req.method === "GET" && toolsMatch) {
    const device = await deviceOr404(toolsMatch[1]);
    return json(res, 200, { tools: await listTools(device) });
  }

  const deviceImageMatch = pathname.match(/^\/api\/devices\/([^/]+)\/(?:images|attachments)$/);
  if (req.method === "POST" && deviceImageMatch) {
    const device = await deviceOr404(deviceImageMatch[1]);
    const upload = await readFileUpload(req);
    const image = await storeImageUpload(upload);
    const targetPath = await makeImageAvailable(device, image);
    return json(res, 200, {
      name: upload.filename,
      path: targetPath,
      text: `Use this image: ${targetPath}`,
    });
  }

  const dirsMatch = pathname.match(/^\/api\/devices\/([^/]+)\/dirs$/);
  if (req.method === "GET" && dirsMatch) {
    const device = await deviceOr404(dirsMatch[1]);
    const result = await listDirs(device, url.searchParams.get("path") || "~");
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    return json(res, 200, result);
  }

  const captureMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/capture$/);
  if (req.method === "GET" && captureMatch) {
    return json(res, 200, await captureSession(captureMatch[1]));
  }

  const captureStreamMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/capture\/stream$/);
  if (req.method === "GET" && captureStreamMatch) {
    await sessionOr404(captureStreamMatch[1]);
    return streamSessionCapture(req, res, captureStreamMatch[1]);
  }

  const terminalStreamMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/stream$/);
  if (req.method === "GET" && terminalStreamMatch) {
    const session = await sessionOr404(terminalStreamMatch[1]);
    const device = await tmuxDeviceForSession(session);
    return streamTerminal(req, res, session, device);
  }

  const terminalInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/input$/);
  if (req.method === "POST" && terminalInputMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(terminalInputMatch[1]);
    const device = await tmuxDeviceForSession(session);
    const stream = await terminalStreamOrError(session, device);
    const input = String(body.data || "");
    stream.pty.write(input);
    if (/[\r\n]/.test(input)) await clearPendingControl(session.id);
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const terminalResizeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/resize$/);
  if (req.method === "POST" && terminalResizeMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(terminalResizeMatch[1]);
    const device = await tmuxDeviceForSession(session);
    const stream = await terminalStreamOrError(session, device);
    stream.pty.resize(clampNumber(body.cols, 20, 500), clampNumber(body.rows, 8, 200));
    return json(res, 200, { ok: true });
  }

  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
  if (req.method === "POST" && sendMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(sendMatch[1]);
    const device = await tmuxDeviceForSession(session);
    const text = String(body.text || "");
    const key = String(body.key || "");
    const menuIndex = Number(body.menu_index || 0);
    if (key && !CONTROL_KEYS.has(key)) return json(res, 400, { detail: "unsupported control key" });
    if (menuIndex && (!Number.isInteger(menuIndex) || menuIndex < 1 || menuIndex > 50 || body.control !== true)) return json(res, 400, { detail: "invalid menu index" });
    const suppressMessage = body.control === true || await isCodexControlInput(device, session, text);
    const result = menuIndex
      ? await sendMenuChoice(device, session.tmux_name, menuIndex)
      : key
      ? await sendKey(device, session.tmux_name, key)
      : await sendText(device, session.tmux_name, text, body.submit !== false);
    if (result.code !== 0 && isMissingTmux(result.output)) {
      return json(res, 410, { detail: "This tmux session is stopped. Use Resume or Restart." });
    }
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await clearPendingControl(session.id);
    let message = null;
    if (!suppressMessage && session.tool !== "terminal" && text.trim()) {
      message = await writeSessionEvent(session, {
        role: "user",
        text,
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
      });
    }
    await touchSession(session.id);
  return json(res, 200, { ok: true, message });
  }

  const imageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(?:images|attachments)$/);
  const attachmentMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
  if (req.method === "GET" && attachmentMatch) {
    const session = await sessionOr404(attachmentMatch[1]);
    const filename = attachmentMatch[2];
    if (path.basename(filename) !== filename) return json(res, 403, { detail: "forbidden" });
    return file(res, path.join(sessionDir(session.id), "attachments", filename));
  }
  if (req.method === "POST" && imageMatch) {
    const session = await sessionOr404(imageMatch[1]);
    const device = await tmuxDeviceForSession(session);
    const upload = await readFileUpload(req);
    const image = await storeImageUpload(upload, session);
    const targetPath = await makeImageAvailable(device, image);
    await touchSession(session.id);
    return json(res, 200, {
      name: upload.filename,
      path: targetPath,
      url: `/api/sessions/${encodeURIComponent(session.id)}/attachments/${encodeURIComponent(image.filename)}`,
      text: `Use this image: ${targetPath}`,
      type: upload.type,
      size: upload.data.length,
    });
  }

  const restartMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
  if (req.method === "POST" && restartMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(restartMatch[1]);
    const device = await tmuxDeviceForSession(session);
    closeTerminalStream(session.id);
    CODEX_ROLLOUTS.delete(session.id);
    const toolCommands = (await readSettings()).tool_commands;
    const command = commandForRestart(session, Boolean(body.resume), toolCommands);
    const resolved = await resolveToolCommand(device, session.tool, command);
    await runOnDevice(device, `tmux kill-session -t ${q(session.tmux_name)} 2>/dev/null || true`, 10000);
    const result = await startTmux(device, session.tmux_name, sessionTmuxCwd(session), withProfileEnv(resolved.command, await resolveLaunchEnv(session.runner_env, session.runner_env_from_secrets)));
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await clearPendingControl(session.id);
    await enableTmuxPipeLog(device, session);
    if (session.central_runner) {
      const target = await deviceOr404(session.device_id);
      const context = centralRunnerContext(target, session.cwd, session.tool);
      if (context) await sendText(device, session.tmux_name, context, true);
    }
    await writeSessionEvent(session, {
      role: "system",
      text: `${body.resume ? "Resumed" : "Restarted"} ${toolLabel(session.tool)} session ${session.tmux_name}`,
    });
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const interruptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const session = await sessionOr404(interruptMatch[1]);
    const device = await tmuxDeviceForSession(session);
    const result = await runOnDevice(device, `tmux send-keys -t ${q(session.tmux_name)} C-c`, 10000);
    if (result.code !== 0 && isMissingTmux(result.output)) {
      return json(res, 410, { detail: "This tmux session is stopped. Use Resume or Restart." });
    }
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await clearPendingControl(session.id);
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const session = await sessionOr404(deleteMatch[1]);
    closeTerminalStream(session.id);
    if (url.searchParams.get("kill") === "true") {
      const device = await tmuxDeviceForSession(session);
      await runOnDevice(device, `tmux kill-session -t ${q(session.tmux_name)} 2>/dev/null || true`, 10000);
    }
    await deleteSession(session.id);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { detail: "not found" });
}

async function isCodexControlInput(device, session, text) {
  if (session.tool !== "codex") return false;
  const input = String(text || "").trim();
  if (/^\/(model|status|permissions|personality|usage)\b/i.test(input)) return true;
  const result = await captureTmuxScreen(device, session.tmux_name);
  if (result.code !== 0) return false;
  const output = stripAnsi(result.output);
  if (/^(1)?$/.test(input) && /Do you trust the contents of this directory/i.test(output)) return true;
  return /^(?:\d+|y|n|yes|no)$/i.test(input)
    && parseCodexControls(output, parseTerminalLines(output)).length > 0;
}

async function captureSession(id) {
  let session = await sessionOr404(id);
  const device = await tmuxDeviceForSession(session);
  session = await promoteRunningChatSession(device, session);
  const result = await captureTmux(device, session.tmux_name);
  if (result.code !== 0 && isMissingTmux(result.output)) {
    throw Object.assign(new Error("This tmux session is stopped. Use Resume or Restart."), { status: 410 });
  }
  if (result.code !== 0) throw Object.assign(new Error(result.output), { status: 502 });
  await touchSession(session.id);
  const pipeSynced = await syncTmuxPipeLog(device, session).catch(() => false);
  const storedMessages = await readSessionMessages(session.id);
  const screen = session.tool === "codex" ? await captureTmuxScreen(device, session.tmux_name) : result;
  const payload = capturePayload(result.output, session, storedMessages, screen.code === 0 ? screen.output : result.output);
  const transcript = await readCodexTranscript(session, device, result.output);
  if (transcript !== null) {
    payload.messages = await writeAuthoritativeMessages(session, transcript, storedMessages);
    payload.transcript_source = "codex-rollout";
    const settings = cachedCodexSettings(session);
    if (settings) payload.codex_state = { ...(payload.codex_state || {}), ...settings, source: "codex-rollout" };
    payload.codex_usage = cachedCodexUsage(session) || session.codex_usage || null;
  } else if (payload.mode === "chat") {
    payload.messages = await writeMessagesSnapshot(session, payload.messages);
    payload.transcript_source = "terminal-fallback";
  }
  session = await syncPendingControl(session.id, payload.controls, payload.agent_state, payload.codex_state, payload.codex_usage);
  payload.pending_control = session.pending_control || null;
  if (payload.pending_control && !payload.controls.some(actionableControl)) payload.controls.unshift(payload.pending_control);
  await writeSessionCapture(session, result.output, payload, { forceTerminalLog: session.pipe_log && !device.local && !pipeSynced });
  return payload;
}

async function loadDevices() {
  const local = {
    id: "local",
    label: `${os.hostname()} (local)`,
    host: "localhost",
    user: os.userInfo().username,
    os: os.platform(),
    local: true,
    source: "local",
    status: "online",
  };
  const list = [local, ...mergeDiscoveredDevices(await sshConfigDevices(), await tailscaleDevices())].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  await migrateDeviceAliases(list);
  await writeDeviceInventory(list).catch(() => {});
  return list;
}

function mergeDiscoveredDevices(sshDevices, tailscaleDevices) {
  const remaining = new Set(tailscaleDevices);
  const merged = sshDevices.map((ssh) => {
    const match = tailscaleDevices.find((tailscale) => remaining.has(tailscale) && devicesMatch(ssh, tailscale));
    if (!match) return ssh;
    remaining.delete(match);
    const label = match.host_name || match.label || ssh.label;
    return {
      ...match,
      ...ssh,
      id: `device-${slug(label)}`,
      label,
      os: match.os || ssh.os,
      status: match.status,
      source: "ssh-config+tailscale",
      alias_ids: [ssh.id, match.id],
      routes: [
        { source: "ssh-config", host: ssh.host, user: ssh.user || null },
        { source: "tailscale", host: match.host, user: ssh.user || null },
      ],
      tailscale_host: match.host,
      tailscale_ips: match.tailscale_ips,
      dns_name: match.dns_name,
      last_seen: match.last_seen,
    };
  });
  return [...merged, ...remaining];
}

function devicesMatch(left, right) {
  const keys = (device) => new Set([
    device.label,
    device.host,
    device.host_name,
    device.dns_name,
    String(device.dns_name || "").split(".")[0],
    ...(device.tailscale_ips || []),
  ].filter(Boolean).map((value) => String(value).toLowerCase().replace(/\.$/, "")));
  const rightKeys = keys(right);
  return [...keys(left)].some((key) => rightKeys.has(key));
}

async function migrateDeviceAliases(devices) {
  const aliases = new Map(devices.flatMap((device) => (device.alias_ids || []).map((id) => [id, device])));
  if (!aliases.size) return;
  const signature = JSON.stringify([...aliases].map(([alias, device]) => [alias, device.id]));
  if (signature === DEVICE_ALIAS_SIGNATURE) return;
  await withMutation("store", async () => {
    const data = await readStore();
    const changed = [];
    for (const session of data.sessions) {
      let dirty = false;
      for (const [idKey, labelKey] of [["device_id", "device_label"], ["tmux_device_id", "tmux_device_label"], ["runner_device_id", "runner_device_label"]]) {
        const device = aliases.get(session[idKey]);
        if (!device) continue;
        session[idKey] = device.id;
        session[labelKey] = device.label;
        dirty = true;
      }
      if (dirty) changed.push(session);
    }
    if (!changed.length) return;
    await writeStore(data);
    await Promise.all(changed.map(writeSessionFiles));
  });
  DEVICE_ALIAS_SIGNATURE = signature;
}

async function writeDeviceInventory(devices) {
  await writeYamlAtomic(DEVICES, {
    updated_at: new Date().toISOString(),
    devices: devices.map((device) => ({
      id: device.id,
      label: device.label,
      host: device.host,
      user: device.user || null,
      os: device.os || null,
      source: device.source || null,
      status: device.status || null,
      local: Boolean(device.local),
      dns_name: device.dns_name || null,
      last_seen: device.last_seen || null,
      alias_ids: device.alias_ids || [],
      routes: device.routes || [],
    })),
  });
}

async function sshConfigDevices() {
  const configPath = path.join(os.homedir(), ".ssh", "config");
  let text = "";
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return [];
  }

  const devices = [];
  let hosts = [];
  let options = {};
  const flush = () => {
    for (const alias of hosts) {
      if (/[*?!]/.test(alias)) continue;
      devices.push({
        id: `ssh-${slug(alias)}`,
        label: alias,
        host: options.hostname || alias,
        user: options.user || null,
        os: null,
        dns_name: null,
        local: false,
        source: "ssh-config",
        status: "unknown",
      });
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyRaw, ...rest] = line.split(/\s+/);
    const key = keyRaw.toLowerCase();
    const value = rest.join(" ");
    if (key === "host") {
      flush();
      hosts = rest;
      options = {};
    } else if (hosts.length) {
      options[key] = value;
    }
  }
  flush();
  return devices;
}

async function tailscaleDevices() {
  const result = await exec("tailscale", ["status", "--json"], 2000);
  if (result.code !== 0) return [];
  let data;
  try {
    data = JSON.parse(result.output);
  } catch {
    return [];
  }

  return Object.values(data.Peer || {})
    .map((peer) => {
      const dnsName = String(peer.DNSName || "").replace(/\.$/, "");
      const dnsLabel = dnsName.split(".")[0];
      const hostName = peer.HostName || dnsLabel;
      const label = (!hostName || hostName === "localhost") && dnsLabel ? dnsLabel : hostName;
      const ips = peer.TailscaleIPs || [];
      const host = ips[0] || dnsName;
      if (!label || !host) return null;
      return {
        id: `ts-${slug(label)}`,
        label,
        host,
        host_name: hostName || null,
        dns_name: dnsName || null,
        tailscale_ips: ips,
        os: peer.OS || null,
        last_seen: peer.LastSeen && !String(peer.LastSeen).startsWith("0001-") ? peer.LastSeen : null,
        user_id: peer.UserID || null,
        local: false,
        source: "tailscale",
        status: peer.Online ? "online" : "offline",
      };
    })
    .filter(Boolean);
}

async function listTmux(device) {
  const format = "#S\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{pane_current_path}\t#{pane_current_command}";
  const result = await runOnDevice(device, `tmux list-sessions -F ${q(format)}`, 15000);
  if (result.code !== 0) {
    if (result.output.toLowerCase().includes("no server running")) return { code: 0, output: "", sessions: [] };
    return { ...result, sessions: [] };
  }

  const sessions = result.output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, windows, attached, created, cwd, command] = [...line.split("\t"), "", "", "", "", "", ""];
    return {
      name,
      windows: intOrNull(windows),
      attached: intOrNull(attached),
      created: intOrNull(created),
      cwd,
      command,
      ark: name.startsWith("Ark-"),
    };
  });
  return { code: 0, output: result.output, sessions };
}

async function listTools(device) {
  const toolCommands = (await readSettings()).tool_commands;
  const localDevice = await localDeviceOr404();
  const tools = [];
  for (const [tool, command] of Object.entries(toolCommands)) {
    if (tool === "terminal") {
      tools.push({ tool, command: "", available: true, path: "", runner_source: "builtin" });
      continue;
    }
    const runnerDevice = device.local ? device : localDevice;
    const resolved = await selectToolRunner(runnerDevice, tool, "", { tool_commands: toolCommands }, { quiet: true });
    tools.push({
      tool,
      command: commandName(resolved?.command || command),
      available: Boolean(resolved),
      path: resolved?.path || "",
      resolved_command: resolved?.command || "",
      runner_id: resolved?.id || "",
      runner_label: resolved?.label || "",
      runner_account_home: resolved?.account_home || "",
      runner_source: resolved?.source || "",
      runner_device_id: runnerDevice.id,
      runner_device_label: runnerDevice.label,
      central_runner: !device.local,
    });
  }
  return tools;
}

async function resolveToolCommand(device, tool, command, options = {}) {
  const name = commandName(command);
  if (!name) return { command: "", path: "" };
  const names = [...new Set([name, ...(TOOL_ALIASES[tool] || [])])];
  for (const candidate of names) {
    const result = await runOnDevice(device, `command -v ${q(candidate)}`, 10000);
    if (result.code === 0) {
      const resolved = candidate === name ? command : replaceCommandName(command, candidate);
      return { command: resolved, path: result.output };
    }
  }
  if (options.quiet) return null;
  throw Object.assign(new Error(`${name} is not installed`), { status: 502 });
}

function terminalRunner() {
  return { id: "terminal", label: "Terminal", source: "builtin", command: "", path: "", env: {}, account_home: "" };
}

async function selectToolRunner(device, tool, profileId = "", settings = null, options = {}) {
  const data = await readProfiles();
  const wanted = String(profileId || "").trim();
  const profiles = data.profiles.filter((profile) => profile.tool === tool && profile.enabled !== false);
  const candidates = wanted ? profiles.filter((profile) => profile.id === wanted) : profiles;
  if (wanted && !candidates.length && !options.quiet) {
    throw Object.assign(new Error(`Unknown ${toolLabel(tool)} profile: ${wanted}`), { status: 404 });
  }
  const sessions = (await readStore()).sessions;
  for (const profile of candidates) {
    const auth = await profileAuth(profile);
    const running = sessions.filter((session) => session.runner_id === profile.id).length;
    if (auth.signed_in === false || profile.max_concurrent !== null && running >= profile.max_concurrent) continue;
    const resolved = await resolveToolCommand(device, tool, profile.command, { quiet: true });
    if (resolved) {
      return {
        id: profile.id,
        label: profile.label,
        source: "profile",
        command: resolved.command,
        path: resolved.path,
        env: profileEnv(profile.env),
        env_from_secrets: profileEnvFromSecrets(profile.env_from_secrets),
        account_home: profileAccountHome(profile),
        routing: data.routing,
      };
    }
  }
  if (wanted && !options.quiet) {
    throw Object.assign(new Error(`${toolLabel(tool)} profile is unavailable, signed out, or at its session limit: ${wanted}`), { status: 409 });
  }

  const fallbackCommand = (settings || await readSettings()).tool_commands?.[tool] || "";
  const fallback = await resolveToolCommand(device, tool, fallbackCommand, { quiet: true });
  if (fallback) {
    return {
      id: `settings-${tool}`,
      label: `${toolLabel(tool)} settings command`,
      source: "settings",
      command: fallback.command,
      path: fallback.path,
      env: {},
      account_home: "",
      routing: data.routing,
    };
  }
  if (options.quiet) return null;
  const command = commandName(candidates[0]?.command || fallbackCommand || tool);
  throw Object.assign(new Error(`${command} is not installed`), { status: 502 });
}

function replaceCommandName(command, name) {
  return String(command).trim().replace(/^\S+/, name);
}

function profileEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== null && value !== undefined)
    .map(([key, value]) => [key, expandArkValue(String(value))]));
}

function profileEnvFromSecrets(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== null && value !== undefined)
    .map(([key, value]) => [key, slug(String(value))]));
}

async function resolveLaunchEnv(env, envFromSecrets) {
  const out = profileEnv(env);
  const refs = profileEnvFromSecrets(envFromSecrets);
  for (const [name, secretId] of Object.entries(refs)) {
    const secret = (await readSecrets()).secrets.find((item) => item.id === secretId);
    if (secret?.value) out[name] = secret.value;
  }
  return out;
}

function profileAccountHome(profile) {
  return profileEnv(profile.env).CODEX_HOME || "";
}

function withProfileEnv(command, env) {
  const clean = profileEnv(env);
  const exports = Object.entries(clean).map(([key, value]) => `export ${key}=${q(value)};`).join(" ");
  const setup = clean.CODEX_HOME ? `mkdir -p ${q(clean.CODEX_HOME)} && ` : "";
  return exports ? `${setup}${exports} ${command}` : command;
}

function expandArkValue(value) {
  return value.replace(/\$\{ARK_DATA\}|\$ARK_DATA/g, DATA);
}

async function publicSecrets() {
  const data = await readSecrets();
  return { secrets: data.secrets.map(publicSecret), path: SECRETS };
}

async function createSecret(body) {
  const data = await readSecrets();
  const label = String(body.label || "").trim();
  const value = String(body.value || "").trim();
  if (!label) throw Object.assign(new Error("Secret name is required"), { status: 400 });
  if (!value) throw Object.assign(new Error("Secret value is required"), { status: 400 });
  const now = new Date().toISOString();
  const id = uniqueSecretId(data.secrets, slug(body.id || label));
  data.secrets.push({
    id,
    label,
    provider: String(body.provider || "openai").trim() || "openai",
    value,
    base_url: String(body.base_url || "").trim(),
    created_at: now,
    updated_at: now,
    last_status: "untested",
    last_checked: "",
    last_error: "",
  });
  await writeSecrets(data);
  return publicSecrets();
}

async function removeSecret(id) {
  const data = await readSecrets();
  const target = data.secrets.find((item) => item.id === id);
  if (!target) throw Object.assign(new Error("Secret not found"), { status: 404 });
  const profiles = await readProfiles();
  const inUse = profiles.profiles.some((profile) => Object.values(profile.env_from_secrets || {}).includes(id));
  if (inUse) throw Object.assign(new Error("Secret is used by a profile. Remove the profile reference first."), { status: 409 });
  data.secrets = data.secrets.filter((item) => item.id !== id);
  await writeSecrets(data);
  return publicSecrets();
}

async function testSecret(id) {
  const data = await readSecrets();
  const secret = data.secrets.find((item) => item.id === id);
  if (!secret) throw Object.assign(new Error("Secret not found"), { status: 404 });
  const result = await checkSecret(secret);
  Object.assign(secret, {
    last_status: result.ok === true ? "ok" : result.ok === false ? "failed" : "stored",
    last_checked: new Date().toISOString(),
    last_error: result.ok === false ? result.detail : "",
    updated_at: new Date().toISOString(),
  });
  await writeSecrets(data);
  return { secret: publicSecret(secret) };
}

async function checkSecret(secret) {
  if (secret.provider !== "openai") return { ok: null, detail: "Stored; live test not implemented for this provider yet." };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${secret.base_url || "https://api.openai.com/v1"}/models`, {
      headers: { Authorization: `Bearer ${secret.value}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) return { ok: true, detail: "OK" };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error.message || String(error) };
  }
}

async function readSecrets() {
  try {
    const data = YAML.parse(await readFile(SECRETS, "utf8")) || {};
    return { secrets: Array.isArray(data.secrets) ? data.secrets.map(normalizeSecret).filter(Boolean) : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { secrets: [] };
    throw dataReadError("secrets.yml", error);
  }
}

async function writeSecrets(data) {
  await mkdir(DATA, { recursive: true });
  await writeYamlAtomic(SECRETS, { secrets: data.secrets.map(normalizeSecret).filter(Boolean) }, 0o600);
}

function normalizeSecret(secret) {
  const value = String(secret?.value || "");
  if (!value) return null;
  const id = slug(secret.id || secret.label || "secret");
  return {
    id,
    label: String(secret.label || id),
    provider: String(secret.provider || "openai"),
    value,
    base_url: String(secret.base_url || ""),
    created_at: String(secret.created_at || ""),
    updated_at: String(secret.updated_at || ""),
    last_status: String(secret.last_status || "untested"),
    last_checked: String(secret.last_checked || ""),
    last_error: String(secret.last_error || ""),
  };
}

function publicSecret(secret) {
  return {
    id: secret.id,
    label: secret.label,
    provider: secret.provider,
    base_url: secret.base_url,
    mask: maskSecret(secret.value),
    last_status: secret.last_status,
    last_checked: secret.last_checked,
    last_error: secret.last_error,
  };
}

function maskSecret(value) {
  const text = String(value || "");
  return text.length <= 8 ? "stored" : `${text.slice(0, 3)}...${text.slice(-4)}`;
}

function uniqueSecretId(secrets, wanted) {
  const base = slug(wanted || "secret") || "secret";
  const used = new Set(secrets.map((secret) => secret.id));
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

async function diagnostics() {
  const devices = await loadDevices();
  const settings = await readSettings();
  const tool_devices = [];
  for (const device of devices.filter((item) => item.local || item.status !== "offline")) {
    try {
      tool_devices.push({ id: device.id, label: device.label, status: device.status, tools: await listTools(device) });
    } catch (error) {
      tool_devices.push({ id: device.id, label: device.label, status: "unreachable", error: error.message, tools: [] });
    }
  }
  return {
    ok: true,
    features: {
      local_tailscale_access_only: true,
      device_discovery: true,
      collapsible_sidebar: true,
      offline_device_collapse: true,
      idle_device_collapse: true,
      selected_session_highlight: true,
      theme_contrast_checks: true,
      settings_menu: true,
      last_active_session_restore: true,
      themes: ["dark", "light", "ark"],
      terminal_sessions: true,
      terminal_view: true,
      chat_layout: true,
      claude_chat_layout: true,
      mobile_chat_screenshot: true,
      mobile_sidebar_screenshot: true,
      chat_raw_debug_fallback: true,
      chat_message_api: true,
      persisted_chat_messages: true,
      assistant_message_capture: true,
      tmux_attach: true,
      auto_adopt_tmux: true,
      adopted_scrollback_import: true,
      adopted_history_limit: true,
      local_tmux_pipe_logging: true,
      remote_tmux_pipe_logging: true,
      stopped_tmux_restore: true,
      agent_state_sidebar: true,
      live_commentary_ordering: true,
      exact_codex_resume: true,
      central_runner_neutral_workspace: true,
      readable_yaml_config: true,
      readable_device_inventory: true,
      simple_user_service: true,
      session_file_history: true,
      session_files_endpoint: true,
      tool_profiles: true,
      readable_profile_config: true,
      multi_profile_yaml_config: true,
      gui_managed_codex_accounts: true,
      codex_account_login_terminal: true,
      api_key_secrets: true,
      secret_env_injection: true,
      profile_routing: true,
      profile_picker: true,
      start_picker_scoped_to_add: true,
      clean_project_browser: true,
      central_tool_runner: true,
      live_terminal: true,
      live_terminal_log_append: true,
      remote_live_terminal: true,
      queued_attachments: true,
      drag_drop_attachments: true,
      clipboard_text_attachments: true,
      image_upload: true,
      codex_startup_images: true,
      role_header_chat_capture: true,
      codex_trust_prompt_filter: true,
      codex_chrome_filter: true,
      codex_trust_input_suppression: true,
      codex_bullet_reply_capture: true,
      tmux_submit_delay: true,
      keyboard_composer_send: true,
      generic_chat_image_prompt: true,
      gui_smoke: true,
    },
    device_inventory_path: DEVICES,
    profile_config_path: PROFILES,
    secret_config_path: SECRETS,
    device_count: devices.length,
    settings,
    sessions: await listStoredSessions(),
    profiles: (await profileDiagnostics()).profiles,
    tool_devices,
  };
}

function toolLabel(tool) {
  return ({ codex: "Codex", opencode: "OpenCode", claude: "Claude", terminal: "Terminal" })[tool] || tool;
}

async function adoptDiscoveredTmux(device, tmuxSessions) {
  const created = await withMutation("store", async () => {
    const data = await readStore();
    const found = [];
    const now = Math.floor(Date.now() / 1000);
    for (const tmux of tmuxSessions) {
      if (!tmux.name) continue;
      const existing = data.sessions.find((item) => (item.tmux_device_id || item.device_id) === device.id && item.tmux_name === tmux.name);
      if (existing) continue;
      const tool = inferToolFromCommand(tmux.command);
      const session = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        device_id: device.id,
        device_label: device.label,
        tmux_name: tmux.name,
        cwd: tmux.cwd || "~",
        tool,
        pipe_log: true,
        title: tool === "terminal" ? tmux.name : `${tool} - ${path.basename(tmux.cwd || "") || tmux.name}`,
      };
      data.sessions.push(session);
      found.push(session);
    }
    if (found.length) await writeStore(data);
    return found;
  });
  for (const session of created) {
    await writeSessionFiles(session);
    await importSessionScrollback(device, session);
  }
}

function isMissingTmux(output) {
  return /can't find (pane|session)|no server running/i.test(String(output || ""));
}

function inferToolFromCommand(command) {
  const name = commandName(command);
  if (name === "codex") return "codex";
  if (name === "opencode") return "opencode";
  if (name === "claude") return "claude";
  return "terminal";
}

async function promoteRunningChatSession(device, session) {
  if (session.tool !== "terminal") return session;
  const target = q(session.tmux_name);
  const result = await runOnDevice(device, [
    `root=$(tmux display-message -p -t ${target} '#{pane_pid}') || exit 1`,
    'pids="$root"',
    'frontier="$root"',
    'while [ -n "$frontier" ]; do next=""; for pid in $frontier; do children=$(pgrep -P "$pid" 2>/dev/null || true); [ -n "$children" ] && { pids="$pids $children"; next="$next $children"; }; done; frontier="$next"; done',
    'ps -o comm=,args= -p $(printf "%s\\n" $pids | sort -nu)',
  ].join("\n"), 8000);
  if (result.code !== 0) return session;
  const processes = result.output.split("\n").map((line) => line.trim()).filter(Boolean);
  const detects = (name) => processes.some((line) => {
    const command = line.split(/\s+/, 1)[0];
    return command === name || line.includes(`/bin/${name} `);
  });
  const tool = processes.some((line) => /^(codex|codex-code-mode)\s/.test(line) || line.includes("/bin/codex "))
    ? "codex"
    : detects("opencode") ? "opencode" : detects("claude") ? "claude" : "terminal";
  if (tool === "terminal") return session;
  const currentTitle = String(session.title || "");
  return upsertSession({
    ...session,
    tool,
    title: /^terminal(?:\s+-|$)/i.test(currentTitle)
      ? `${tool} - ${path.basename(session.cwd || "session")}`
      : currentTitle,
  });
}

function resumeCommands(toolCommands) {
  return {
    ...toolCommands,
    terminal: "",
    codex: toolCommands.codex ? `${toolCommands.codex} resume --last` : "",
  };
}

function commandForRestart(session, resume, toolCommands) {
  const command = session.runner_command || toolCommands[session.tool] || "";
  if (!resume || session.tool !== "codex") return command;
  const selector = session.codex_session_id
    ? q(session.codex_session_id)
    : session.central_runner ? "--all" : "--last";
  return `${command || DEFAULT_TOOL_COMMANDS.codex} resume ${selector}`;
}

function commandForSession(tool, command, images) {
  if (tool !== "codex") return command;
  const imageArgs = images.map((image) => ` --image ${q(image)}`).join("");
  return `${command || "codex"}${imageArgs}`;
}

function sessionTmuxCwd(session) {
  return session.central_runner ? DATA : session.cwd;
}

function centralRunnerContext(device, cwd, tool) {
  if (tool === "terminal" || device.local) return "";
  return [
    `Ark context target=${device.label}`,
    `Ark context cwd=${cwd}`,
    `Ark context ssh=${sshTarget(device)}`,
    "Ark context use ssh for shell and file work",
  ].join("\n");
}

function sshTarget(device) {
  return device.user ? `${device.user}@${device.host}` : device.host;
}

function startupImagePrompt(tool, images) {
  if (!images.length || tool === "codex") return "";
  const lines = images.map((image) => tool === "terminal" ? `# Use this image: ${image}` : `Use this image: ${image}`);
  return lines.join("\n");
}

function sessionImages(images) {
  return Array.isArray(images) ? images.filter(Boolean).map(String) : [];
}

async function startTmux(device, tmuxName, cwd, command) {
  const cmdArg = command ? ` ${q(command)}` : "";
  const script = [
    "command -v tmux >/dev/null 2>&1 || { echo 'tmux is not installed'; exit 127; }",
    command ? `command -v ${q(commandName(command))} >/dev/null 2>&1 || { echo ${q(`${commandName(command)} is not installed`)}; exit 127; }` : "",
    `tmux has-session -t ${q(tmuxName)} 2>/dev/null || tmux new-session -d -s ${q(tmuxName)} -c ${qPath(cwd)}${cmdArg}`,
    `tmux set-option -t ${q(tmuxName)} history-limit 100000`,
  ].filter(Boolean).join("; ");
  return runOnDevice(device, script, 30000);
}

function commandName(command) {
  return String(command).trim().split(/\s+/)[0] || "";
}

async function listDirs(device, dir) {
  const script = [
    `cd ${qPath(dir)} 2>/dev/null || { echo 'cannot open directory'; exit 2; }`,
    `printf '__ARK_CWD__%s\\n' "$PWD"`,
    `{ for d in */ .*/; do [ -d "$d" ] || continue; name=\${d%/}; case "$name" in .* ) continue ;; esac; printf '__ARK_DIR__%s\\n' "$name"; done; } | sort`,
  ].join("; ");
  const result = await runOnDevice(device, script, 15000);
  if (result.code !== 0) return { code: result.code, output: result.output, cwd: dir, parent: "~", dirs: [] };

  let cwd = dir;
  const dirs = [];
  for (const line of result.output.split(/\r?\n/)) {
    if (line.startsWith("__ARK_CWD__")) cwd = line.slice("__ARK_CWD__".length);
    if (line.startsWith("__ARK_DIR__")) {
      const name = line.slice("__ARK_DIR__".length);
      dirs.push({ name, path: joinRemotePath(cwd, name) });
    }
  }
  return { code: 0, output: "", cwd, parent: parentRemotePath(cwd), dirs };
}

async function captureTmux(device, tmuxName, history = 2000) {
  const lines = clampNumber(history, 100, 100000);
  return runOnDevice(device, `tmux capture-pane -pt ${q(tmuxName)} -S -${lines} -e`, 15000);
}

async function captureTmuxScreen(device, tmuxName) {
  return runOnDevice(device, `tmux capture-pane -pt ${q(tmuxName)} -e`, 15000);
}

async function sendText(device, tmuxName, text, submit) {
  let script = `tmux send-keys -t ${q(tmuxName)} -l ${q(text)}`;
  if (submit) script += `; sleep 0.5; tmux send-keys -t ${q(tmuxName)} Enter`;
  return runOnDevice(device, script, 15000);
}

async function sendKey(device, tmuxName, key) {
  return runOnDevice(device, `tmux send-keys -t ${q(tmuxName)} ${key}`, 15000);
}

async function sendMenuChoice(device, tmuxName, index) {
  const target = q(tmuxName);
  const down = index > 1 ? `; tmux send-keys -t ${target} -N ${index - 1} Down` : "";
  return runOnDevice(device, `tmux send-keys -t ${target} -N 50 Up${down}; sleep 0.15; tmux send-keys -t ${target} Enter`, 15000);
}

function openEventStream(req, res, clients, close) {
  res.writeHead(200, {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
    close?.();
  });
}

function sendEvent(clients, data, event = "message") {
  const frame = `${event === "message" ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) if (!client.writableEnded) client.write(frame);
}

function streamSessionStates(req, res) {
  openEventStream(req, res, STATE_STREAM.clients, () => {
    if (STATE_STREAM.clients.size) return;
    clearInterval(STATE_STREAM.timer);
    STATE_STREAM.timer = null;
    STATE_STREAM.last = "";
  });
  if (!STATE_STREAM.timer) STATE_STREAM.timer = setInterval(updateStateStream, 3000);
  updateStateStream();
}

async function updateStateStream() {
  if (STATE_STREAM.busy || !STATE_STREAM.clients.size) return;
  STATE_STREAM.busy = true;
  try {
    const states = await listAgentStates();
    const signature = JSON.stringify(states);
    if (signature !== STATE_STREAM.last) {
      STATE_STREAM.last = signature;
      sendEvent(STATE_STREAM.clients, { states });
    }
  } catch (error) {
    sendEvent(STATE_STREAM.clients, { detail: error.message || String(error) }, "ark-error");
  } finally {
    STATE_STREAM.busy = false;
  }
}

function streamSessionCapture(req, res, id) {
  let stream = CAPTURE_STREAMS.get(id);
  if (!stream) {
    stream = { clients: new Set(), timer: null, busy: false, last: "", payload: null };
    CAPTURE_STREAMS.set(id, stream);
  }
  openEventStream(req, res, stream.clients, () => {
    if (stream.clients.size) return;
    clearInterval(stream.timer);
    CAPTURE_STREAMS.delete(id);
  });
  if (!stream.timer) stream.timer = setInterval(() => updateCaptureStream(id, stream), 1800);
  updateCaptureStream(id, stream);
}

async function updateCaptureStream(id, stream) {
  if (stream.busy || !stream.clients.size) return;
  stream.busy = true;
  try {
    const payload = await captureSession(id);
    stream.payload = payload;
    const signature = JSON.stringify(payload);
    if (signature !== stream.last) {
      stream.last = signature;
      sendEvent(stream.clients, payload);
    }
  } catch (error) {
    sendEvent(stream.clients, { status: error.status || 500, detail: error.message || String(error) }, "ark-error");
  } finally {
    stream.busy = false;
  }
}

async function streamTerminal(req, res, session, device) {
  const stream = await terminalStreamOrError(session, device);
  res.writeHead(200, {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  stream.clients.add(send);
  if (stream.buffer) send(stream.buffer);
  req.on("close", () => {
    stream.clients.delete(send);
    scheduleTerminalClose(session.id, stream);
  });
}

async function terminalStreamOrError(session, device) {
  return getTerminalStream(session, device);
}

function getTerminalStream(session, device) {
  const existing = TERMINAL_STREAMS.get(session.id);
  if (existing) {
    clearTimeout(existing.closeTimer);
    return existing;
  }
  const command = terminalAttachCommand(session, device);
  const term = pty.spawn(command.file, command.args, {
    cols: 120,
    rows: 36,
    cwd: command.cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    name: "xterm-256color",
  });
  const stream = { pty: term, clients: new Set(), buffer: "", closeTimer: null };
  term.onData((data) => {
    stream.buffer = `${stream.buffer}${data}`.slice(-24000);
    appendTerminalLog(session, data).catch(() => {});
    for (const client of stream.clients) client(data);
  });
  term.onExit(() => {
    for (const client of stream.clients) client("\r\n[terminal detached]\r\n");
    TERMINAL_STREAMS.delete(session.id);
  });
  TERMINAL_STREAMS.set(session.id, stream);
  return stream;
}

async function appendTerminalLog(session, data) {
  await appendFile(path.join(sessionDir(session.id), "terminal.log"), data);
}

function terminalAttachCommand(session, device) {
  const script = withUserPath(`tmux set-option -t ${q(session.tmux_name)} status off >/dev/null 2>&1 || true; tmux attach-session -t ${q(session.tmux_name)}`);
  if (device.local) return { file: "bash", args: ["-lc", script], cwd: os.homedir() };
  const target = device.user ? `${device.user}@${device.host}` : device.host;
  return {
    file: "ssh",
    args: [
      "-tt",
      "-o", "ConnectTimeout=6",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      target,
      `bash -lc ${q(script)}`,
    ],
    cwd: os.homedir(),
  };
}

function scheduleTerminalClose(id, stream) {
  clearTimeout(stream.closeTimer);
  stream.closeTimer = setTimeout(() => {
    if (stream.clients.size) return;
    closeTerminalStream(id);
  }, 5000);
}

function closeTerminalStream(id) {
  const stream = TERMINAL_STREAMS.get(id);
  if (!stream) return;
  clearTimeout(stream.closeTimer);
  TERMINAL_STREAMS.delete(id);
  try {
    stream.pty.kill();
  } catch {}
}

async function storeImageUpload(upload, session = null) {
  const dir = session ? path.join(sessionDir(session.id), "attachments") : UPLOADS;
  await mkdir(dir, { recursive: true });
  const ext = imageExt(upload.filename, upload.type);
  const base = safeUploadName(path.basename(upload.filename, path.extname(upload.filename)) || "file");
  const filename = `${Date.now()}-${base}-${crypto.randomUUID()}${ext}`;
  const localPath = path.join(dir, filename);
  await writeFile(localPath, upload.data);
  return { filename, localPath };
}

async function makeImageAvailable(device, image) {
  if (device.local) return image.localPath;
  const dir = await runOnDevice(device, `mkdir -p "$HOME/.local/share/ark/uploads" && printf '%s' "$HOME/.local/share/ark/uploads"`, 15000);
  if (dir.code !== 0) throw Object.assign(new Error(dir.output), { status: 502 });
  const remoteDir = dir.output.trim();
  const remotePath = `${remoteDir}/${image.filename}`;
  const target = device.user ? `${device.user}@${device.host}` : device.host;
  const copied = await exec("scp", [
    "-q",
    "-o", "ConnectTimeout=6",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    image.localPath,
    `${target}:${remotePath}`,
  ], 30000);
  if (copied.code !== 0) throw Object.assign(new Error(copied.output), { status: 502 });
  return remotePath;
}

async function runOnDevice(device, command, timeout) {
  const script = withUserPath(command);
  if (device.local) return exec("bash", ["-lc", script], timeout);
  const target = device.user ? `${device.user}@${device.host}` : device.host;
  return exec(
    "ssh",
    [
      "-o", "ConnectTimeout=6",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      target,
      `bash -lc ${q(script)}`,
    ],
    timeout,
  );
}

function withUserPath(command) {
  return `export PATH="$HOME/.local/bin:$HOME/.local/npm/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"; for d in "$HOME"/.local/node-v*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH; ${command}`;
}

function exec(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`.trim();
      if (!error) return resolve({ code: 0, output });
      const code = error.killed || error.signal ? 124 : Number.isInteger(error.code) ? error.code : 1;
      resolve({ code, output: output || error.message });
    });
  });
}

async function listStoredSessions() {
  const data = await readStore();
  const sessions = data.sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  await Promise.all(sessions.map((session) => writeSessionFiles(session)));
  return sessions.map(publicSession);
}

async function listAgentStates() {
  const sessions = (await readStore()).sessions.filter((session) => session.tool !== "terminal");
  return Promise.all(sessions.map(async (session) => {
    try {
      const live = CAPTURE_STREAMS.get(session.id)?.payload;
      if (live) return { id: session.id, state: live.pending_control ? "needs_input" : live.agent_state, pending_control: live.pending_control || null };
      const device = await tmuxDeviceForSession(session);
      const screen = await captureTmuxScreen(device, session.tmux_name);
      if (screen.code !== 0) return { id: session.id, state: isMissingTmux(screen.output) ? "stopped" : "unknown" };
      const controls = parseAgentControls(session.tool, screen.output);
      const state = agentStateFromScreen(session, screen.output, controls);
      const current = await syncPendingControl(session.id, controls, state);
      return { id: session.id, state: current.pending_control ? "needs_input" : state, pending_control: current.pending_control || null };
    } catch {
      return { id: session.id, state: "unknown" };
    }
  }));
}

async function autoResumeGoals(now = Date.now()) {
  if (AUTO_RESUME_BUSY) return;
  AUTO_RESUME_BUSY = true;
  try {
    const sessions = (await readStore()).sessions.filter((session) => session.tool === "codex" && session.auto_resume_goal);
    for (const session of sessions) {
      const device = await tmuxDeviceForSession(session);
      const screen = await captureTmuxScreen(device, session.tmux_name);
      if (screen.code !== 0) continue;
      const resetAt = goalUsageResetAt(screen.output, now);
      const reset = Math.floor((resetAt || 0) / 1000);
      if (!reset || resetAt > now) continue;
      const current = (await readStore()).sessions.find((item) => item.id === session.id);
      if (!current?.auto_resume_goal || reset <= Number(current.auto_resume_last_reset || 0)) continue;
      const sent = await sendText(device, session.tmux_name, "/goal resume", true);
      if (sent.code !== 0) continue;
      await markGoalAutoResumed(session.id, reset);
      await clearPendingControl(session.id);
    }
  } finally {
    AUTO_RESUME_BUSY = false;
  }
}

function goalUsageResetAt(text, now = Date.now()) {
  const screen = stripAnsi(String(text || ""));
  if (!/You've hit your usage limit/i.test(screen) || !/Goal hit usage limits\s*\(\/goal resume\)/i.test(screen)) return null;
  const match = screen.match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  const target = new Date(now);
  target.setHours(hour, Number(match[2]), 0, 0);
  if (target.getTime() < now - 12 * 60 * 60 * 1000) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function actionableControl(control) {
  return Boolean(control && control.kind && control.kind !== "status");
}

function pendingControl(control, previous) {
  const value = {
    ...control,
    id: crypto.createHash("sha256").update(JSON.stringify({
      kind: control.kind,
      title: control.title,
      prompt: control.prompt,
      choices: (control.choices || []).map(({ value, key, label }) => ({ value, key, label })),
    })).digest("hex").slice(0, 16),
  };
  const now = new Date().toISOString();
  value.first_seen_at = previous?.id === value.id ? previous.first_seen_at : now;
  value.updated_at = now;
  return value;
}

async function syncPendingControl(id, controls, state, codexState = null, codexUsage = null) {
  const control = controls.find(actionableControl);
  const misses = control || state === "working" ? 0 : (CONTROL_MISSES.get(id) || 0) + 1;
  if (misses) CONTROL_MISSES.set(id, misses);
  else CONTROL_MISSES.delete(id);
  return withMutation("store", async () => {
    const data = await readStore();
    const session = data.sessions.find((item) => item.id === id);
    if (!session) throw Object.assign(new Error(`Unknown session: ${id}`), { status: 404 });
    const next = control ? pendingControl(control, session.pending_control) : misses >= 2 || state === "working" ? null : session.pending_control || null;
    const runtime = codexState?.model ? {
      model: String(codexState.model),
      reasoning_effort: String(codexState.reasoning_effort || ""),
      service_tier: String(codexState.service_tier || ""),
      source: String(codexState.source || ""),
    } : session.codex_state || null;
    const usage = codexUsage?.primary || codexUsage?.secondary ? codexUsage : session.codex_usage || null;
    const unchanged = next?.id === session.pending_control?.id
      && Boolean(next) === Boolean(session.pending_control)
      && JSON.stringify(runtime) === JSON.stringify(session.codex_state || null)
      && JSON.stringify(usage) === JSON.stringify(session.codex_usage || null);
    if (unchanged) return session;
    if (next) session.pending_control = next;
    else delete session.pending_control;
    if (runtime) session.codex_state = runtime;
    if (usage) session.codex_usage = usage;
    await writeStore(data);
    await writeSessionFiles(session);
    return session;
  });
}

async function clearPendingControl(id) {
  CONTROL_MISSES.delete(id);
  return withMutation("store", async () => {
    const data = await readStore();
    const session = data.sessions.find((item) => item.id === id);
    if (!session || !session.pending_control) return session || null;
    delete session.pending_control;
    await writeStore(data);
    await writeSessionFiles(session);
    return session;
  });
}

function publicSession(session) {
  return { ...session, storage_path: sessionDir(session.id) };
}

async function upsertSession(patch) {
  const session = await withMutation("store", async () => {
    const data = await readStore();
    const now = Math.floor(Date.now() / 1000);
    const existing = data.sessions.find((item) => item.device_id === patch.device_id && item.tmux_name === patch.tmux_name);
    const next = {
      id: existing?.id || crypto.randomUUID(),
      created_at: existing?.created_at || now,
      updated_at: now,
      ...existing,
      ...patch,
    };
    data.sessions = data.sessions.filter((item) => item.id !== next.id);
    data.sessions.push(next);
    await writeStore(data);
    return next;
  });
  await writeSessionFiles(session);
  return session;
}

async function touchSession(id) {
  const session = await withMutation("store", async () => {
    const data = await readStore();
    const found = data.sessions.find((item) => item.id === id);
    if (!found) return null;
    found.updated_at = Math.floor(Date.now() / 1000);
    await writeStore(data);
    return found;
  });
  if (session) await writeSessionFiles(session);
}

async function setGoalAutoResume(id, enabled) {
  const session = await withMutation("store", async () => {
    const data = await readStore();
    const found = data.sessions.find((item) => item.id === id);
    if (!found) throw Object.assign(new Error(`Unknown session: ${id}`), { status: 404 });
    if (enabled) found.auto_resume_goal = true;
    else delete found.auto_resume_goal;
    found.updated_at = Math.floor(Date.now() / 1000);
    await writeStore(data);
    return found;
  });
  await writeSessionFiles(session);
  return session;
}

async function markGoalAutoResumed(id, reset) {
  const session = await withMutation("store", async () => {
    const data = await readStore();
    const found = data.sessions.find((item) => item.id === id);
    if (!found) return null;
    found.auto_resume_last_reset = reset;
    found.updated_at = Math.floor(Date.now() / 1000);
    await writeStore(data);
    return found;
  });
  if (session) await writeSessionFiles(session);
}

async function deleteSession(id) {
  await withMutation("store", async () => {
    const data = await readStore();
    data.sessions = data.sessions.filter((item) => item.id !== id);
    await writeStore(data);
  });
}

async function readStore() {
  try {
    const data = JSON.parse(await readFile(STORE, "utf8"));
    return Array.isArray(data.sessions) ? data : { sessions: [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { sessions: [] };
    throw dataReadError("sessions.json", error);
  }
}

async function writeStore(data) {
  await mkdir(DATA, { recursive: true });
  const tmp = `${STORE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, STORE);
}

function withMutation(key, task) {
  const previous = MUTATIONS.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  MUTATIONS.set(key, next);
  return next.finally(() => {
    if (MUTATIONS.get(key) === next) MUTATIONS.delete(key);
  });
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, slug(id));
}

async function writeSessionFiles(session) {
  const dir = sessionDir(session.id);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "attachments"), { recursive: true });
  await writeYamlAtomic(path.join(dir, "session.yml"), session);
}

async function sessionFiles(session) {
  await writeSessionFiles(session);
  await syncTmuxPipeLog(await tmuxDeviceForSession(session), session).catch(() => {});
  const dir = sessionDir(session.id);
  const files = [];
  for (const name of ["session.yml", "messages.jsonl", "terminal.log", "attachments"]) {
    const target = path.join(dir, name);
    try {
      const info = await stat(target);
      files.push({
        name,
        path: target,
        type: info.isDirectory() ? "directory" : "file",
        size: info.isDirectory() ? 0 : info.size,
        child_count: info.isDirectory() ? (await readdir(target)).length : 0,
      });
    } catch {}
  }
  return { storage_path: dir, files };
}

async function writeSessionCapture(session, rawText, payload, options = {}) {
  await writeSessionFiles(session);
  const dir = sessionDir(session.id);
  const terminalLog = path.join(dir, "terminal.log");
  try {
    if (options.forceTerminalLog) throw new Error("fresh capture fallback");
    if (!session.pipe_log) throw new Error("capture owns terminal.log");
    await stat(terminalLog);
  } catch {
    await writeFile(terminalLog, rawText.endsWith("\n") ? rawText : `${rawText}\n`);
  }
}

async function importSessionScrollback(device, session) {
  await runOnDevice(device, `tmux set-option -t ${q(session.tmux_name)} history-limit 100000`, 15000);
  const result = await captureTmux(device, session.tmux_name, 100000);
  if (result.code !== 0) return;
  const payload = capturePayload(result.output, session, await readSessionMessages(session.id));
  if (payload.mode === "chat") payload.messages = await writeMessagesSnapshot(session, payload.messages);
  await writeSessionCapture(session, result.output, payload);
  await enableTmuxPipeLog(device, session);
}

async function enableTmuxPipeLog(device, session) {
  if (!session.pipe_log) return;
  if (device.local) {
    const terminalLog = path.join(sessionDir(session.id), "terminal.log");
    await mkdir(path.dirname(terminalLog), { recursive: true });
    await runOnDevice(device, `touch ${q(terminalLog)} && tmux pipe-pane -o -t ${q(session.tmux_name)} ${q(`cat >> ${q(terminalLog)}`)}`, 15000);
    return;
  }
  const remoteLog = remotePipeLogPath(session);
  const remoteDir = remoteLog.slice(0, remoteLog.lastIndexOf("/"));
  await runOnDevice(device, [
    `mkdir -p "$HOME/${remoteDir}"`,
    `(tmux capture-pane -pt ${q(session.tmux_name)} -S -100000 -e > "$HOME/${remoteLog}" 2>/dev/null || : > "$HOME/${remoteLog}")`,
    `tmux pipe-pane -o -t ${q(session.tmux_name)} ${q(`cat >> "$HOME/${remoteLog}"`)}`,
  ].join(" && "), 15000);
  await syncTmuxPipeLog(device, session).catch(() => {});
}

async function syncTmuxPipeLog(device, session) {
  if (!session.pipe_log || device.local) return true;
  const terminalLog = path.join(sessionDir(session.id), "terminal.log");
  await mkdir(path.dirname(terminalLog), { recursive: true });
  const tmp = `${terminalLog}.tmp-${process.pid}`;
  const target = device.user ? `${device.user}@${device.host}` : device.host;
  const copied = await exec("scp", [
    "-q",
    "-o", "ConnectTimeout=6",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    `${target}:${remotePipeLogPath(session)}`,
    tmp,
  ], 30000);
  if (copied.code !== 0) return false;
  await rename(tmp, terminalLog);
  return true;
}

function remotePipeLogPath(session) {
  return `.local/share/ark/sessions/${slug(session.id)}/terminal.log`;
}

async function readSessionMessages(id) {
  try {
    const text = await readFile(path.join(sessionDir(id), "messages.jsonl"), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw dataReadError(`messages.jsonl line ${index + 1}`, error);
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error?.status ? error : dataReadError("messages.jsonl", error);
  }
}

async function writeSessionEvent(session, message) {
  return withMutation(`messages:${session.id}`, async () => {
    const messages = await readSessionMessages(session.id);
    const normalized = normalizeMessage({ ...message, source: message.source || "ark" });
    messages.push(normalized);
    await writeMessagesFile(session, messages);
    return normalized;
  });
}

async function writeMessagesSnapshot(session, messages) {
  return withMutation(`messages:${session.id}`, async () => {
    const stored = (await readSessionMessages(session.id)).map(normalizeMessage);
    const merged = mergeChatMessages(messages, stored);
    if (JSON.stringify(merged) === JSON.stringify(stored)) return merged;
    await writeMessagesFile(session, merged);
    return merged;
  });
}

async function writeMessagesFile(session, messages) {
  await writeSessionFiles(session);
  const lines = messages.map((message) => JSON.stringify(normalizeMessage(message))).join("\n");
  await writeFile(path.join(sessionDir(session.id), "messages.jsonl"), lines ? `${lines}\n` : "");
}

async function writeAuthoritativeMessages(session, transcript, stored = []) {
  return withMutation(`messages:${session.id}`, async () => {
    const current = stored.length ? stored.map(normalizeMessage) : (await readSessionMessages(session.id)).map(normalizeMessage);
    const messages = mergeCodexTranscript(transcript, current);
    if (JSON.stringify(messages) !== JSON.stringify(current)) await writeMessagesFile(session, messages);
    return messages;
  });
}

function mergeCodexTranscript(transcript, stored) {
  const pending = stored.filter((message) => message.role === "user" && message.source === "ark");
  const messages = transcript.map((message) => {
    const normalized = normalizeMessage(message);
    if (normalized.role !== "user") return normalized;
    const index = pending.findIndex((candidate) => sameUserMessage(candidate.text, normalized.text));
    if (index === -1) return normalized;
    const [match] = pending.splice(index, 1);
    normalized.attachments = match.attachments;
    return normalized;
  });
  messages.push(...pending);
  return messages.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function sameUserMessage(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (a === b) return true;
  const length = Math.min(a.length, b.length, 120);
  return length >= 80 && a.slice(-length) === b.slice(-length);
}

function normalizeMessage(message) {
  return {
    id: message.id || crypto.randomUUID(),
    created_at: message.created_at || new Date().toISOString(),
    role: message.role || "assistant",
    text: String(message.text || ""),
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    source: String(message.source || ""),
    phase: String(message.phase || ""),
  };
}

function mergeChatMessages(parsed, stored) {
  const out = stored.map(normalizeMessage).filter((message) => message.text.trim());
  const counts = chatMessageCounts(out);
  const incoming = new Map();
  let turn = [...out].reverse().find((message) => message.role === "user")?.text.trim() || "";
  for (const message of parsed) {
    const normalized = normalizeMessage(message);
    normalized.text = normalized.text.trim();
    if (!normalized.text || isStoredChatJunk(normalized)) continue;
    if (normalized.role === "user") turn = normalized.text;
    const key = chatMessageKey(normalized, turn);
    const occurrence = (incoming.get(key) || 0) + 1;
    incoming.set(key, occurrence);
    if (occurrence <= (counts.get(key) || 0)) continue;
    if (normalized.role !== "user") {
      const start = out.findLastIndex((item) => item.role === "user" && item.text.trim() === turn);
      const tail = out.slice(start + 1).findLast((item) => item.role === normalized.role);
      if (tail && normalized.text.startsWith(tail.text.trim())) {
        tail.text = normalized.text;
        continue;
      }
      if (tail && tail.text.trim().startsWith(normalized.text)) continue;
    }
    out.push(normalized);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return out;
}

function chatMessageCounts(messages) {
  const counts = new Map();
  let turn = "";
  for (const message of messages) {
    if (message.role === "user") turn = message.text.trim();
    const key = chatMessageKey(message, turn);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function chatMessageKey(message, turn) {
  return `${turn}\0${message.role}\0${message.text.trim()}`;
}

function isStoredChatJunk(message) {
  const text = String(message.text || "").trim();
  return !text
    || text.startsWith("ARK_CONTROL:")
    || /\/permissions\s+choose|Ask for approval|Permissions updated|Select (Model and Effort|Reasoning Level)/i.test(text);
}

async function readCodexTranscript(session, device, rawText) {
  if (session.tool !== "codex" || !device.local) return null;
  const filePath = await codexRolloutPath(session, device, rawText);
  if (!filePath) return null;
  let info;
  try {
    info = await stat(filePath);
  } catch {
    CODEX_ROLLOUTS.delete(session.id);
    return null;
  }
  let cache = CODEX_TRANSCRIPTS.get(filePath);
  if (!cache || info.size < cache.offset) {
    cache = { offset: 0, remainder: "", messages: [], sequence: 0, settings: null, usage: null };
    CODEX_TRANSCRIPTS.set(filePath, cache);
  }
  if (info.size === cache.offset) return cache.messages.map(normalizeMessage);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, { start: cache.offset })) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  cache.offset += bytes;
  const lines = (cache.remainder + Buffer.concat(chunks).toString("utf8")).split(/\r?\n/);
  cache.remainder = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    updateCodexSettings(cache, row);
    const message = codexTranscriptMessage(row, cache.sequence++);
    if (message) cache.messages.push(message);
  }
  return cache.messages.map(normalizeMessage);
}

function updateCodexSettings(cache, row) {
  const limits = row?.type === "event_msg" && row.payload?.type === "token_count" ? row.payload.rate_limits : null;
  if (limits?.limit_id === "codex" && (limits.primary || limits.secondary)) cache.usage = codexUsage(limits);
  const settings = row?.type === "turn_context"
    ? { model: row.payload?.model, reasoning_effort: row.payload?.effort || row.payload?.reasoning_effort }
    : row?.type === "event_msg" && row.payload?.type === "thread_settings_applied"
      ? row.payload.thread_settings || {}
      : null;
  if (!settings?.model) return;
  cache.settings = {
    model: String(settings.model),
    reasoning_effort: String(settings.reasoning_effort || cache.settings?.reasoning_effort || ""),
    service_tier: String(settings.service_tier || cache.settings?.service_tier || ""),
    cwd: String(settings.cwd || cache.settings?.cwd || ""),
  };
}

function codexUsage(limits) {
  const normalize = (value) => value ? {
    used_percent: Math.max(0, Math.min(100, Number(value.used_percent) || 0)),
    window_minutes: Math.max(0, Number(value.window_minutes) || 0),
    resets_at: Math.max(0, Number(value.resets_at) || 0),
  } : null;
  return { plan_type: String(limits.plan_type || ""), primary: normalize(limits.primary), secondary: normalize(limits.secondary) };
}

function cachedCodexSettings(session) {
  const filePath = CODEX_ROLLOUTS.get(session.id);
  return filePath ? CODEX_TRANSCRIPTS.get(filePath)?.settings || null : null;
}

function cachedCodexUsage(session) {
  const filePath = CODEX_ROLLOUTS.get(session.id);
  return filePath ? CODEX_TRANSCRIPTS.get(filePath)?.usage || null : null;
}

function codexTranscriptMessage(row, sequence) {
  const payload = row?.payload || {};
  if (row?.type !== "event_msg" || !["user_message", "agent_message"].includes(payload.type)) return null;
  const text = String(payload.message || "").trim();
  if (!text || /^Ark context target=/i.test(text) || /^<environment_context>/i.test(text)) return null;
  const role = payload.type === "user_message" ? "user" : "assistant";
  const phase = role === "assistant" ? String(payload.phase || "") : "";
  const fingerprint = JSON.stringify([row.timestamp || "", payload.type, phase, text, sequence]);
  return {
    id: `codex-${crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 20)}`,
    created_at: String(row.timestamp || new Date().toISOString()),
    role,
    text,
    attachments: [],
    source: "codex-rollout",
    phase,
  };
}

async function codexRolloutPath(session, device, rawText) {
  const cached = CODEX_ROLLOUTS.get(session.id);
  if (cached) return cached;
  const home = session.runner_account_home || profileEnv(session.runner_env).CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionId = session.codex_session_id || (stripAnsi(String(rawText || "")).match(/Session:\s*([0-9a-f-]{36})/i) || [])[1];
  if (sessionId) {
    const exact = await runOnDevice(device, `find ${q(path.join(home, "sessions"))} -type f -name ${q(`*${sessionId}*.jsonl`)} -print -quit`, 5000);
    if (exact.code === 0 && exact.output.trim()) {
      return rememberCodexRollout(session, exact.output.trim());
    }
  }
  const script = `root=$(tmux display-message -p -t ${q(session.tmux_name)} '#{pane_pid}'); pids="$root"; frontier="$root"; while [ -n "$frontier" ]; do next=""; for p in $frontier; do kids=$(pgrep -P "$p" 2>/dev/null || true); pids="$pids $kids"; next="$next $kids"; done; frontier="$next"; done; for p in $pids; do for fd in /proc/$p/fd/*; do readlink "$fd" 2>/dev/null || true; done; done | grep -m1 '/rollout-.*[.]jsonl$'`;
  const open = await runOnDevice(device, script, 5000);
  if (open.code === 0 && open.output.trim()) {
    return rememberCodexRollout(session, open.output.trim());
  }
  const recent = await runOnDevice(device, `find ${q(path.join(home, "sessions"))} -type f -name 'rollout-*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -50`, 5000);
  const expectedCwd = session.central_runner ? DATA : expandHomePath(session.cwd);
  let nearest = null;
  for (const line of recent.output.split(/\r?\n/)) {
    const match = line.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!match) continue;
    const meta = await readCodexSessionMeta(match[2]);
    if (!meta) continue;
    const started = Date.parse(meta.timestamp || "") / 1000;
    const distance = Number.isFinite(started) ? Math.abs(started - Number(session.created_at || 0)) : Infinity;
    const cwdMatch = Boolean(meta.cwd && expectedCwd && path.resolve(meta.cwd) === path.resolve(expectedCwd));
    if (!cwdMatch || distance > 30) continue;
    const score = distance;
    if (!nearest || score < nearest.score) nearest = { score, path: match[2] };
  }
  return nearest ? rememberCodexRollout(session, nearest.path) : "";
}

async function rememberCodexRollout(session, filePath) {
  CODEX_ROLLOUTS.set(session.id, filePath);
  const codexSessionId = (path.basename(filePath).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i) || [])[1];
  if (!codexSessionId || session.codex_session_id === codexSessionId) return filePath;
  session.codex_session_id = codexSessionId;
  const stored = await withMutation("store", async () => {
    const data = await readStore();
    const found = data.sessions.find((item) => item.id === session.id);
    if (!found) return null;
    found.codex_session_id = codexSessionId;
    await writeStore(data);
    return found;
  });
  if (stored) await writeSessionFiles(stored);
  return filePath;
}

async function readCodexSessionMeta(filePath) {
  let text = "";
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: 8192 })) {
      text += chunk.toString("utf8");
      if (text.includes("\n") || text.length >= 65536) break;
    }
    const row = JSON.parse(text.split(/\r?\n/, 1)[0]);
    return row?.type === "session_meta" ? row.payload || null : null;
  } catch {
    return null;
  }
}

function expandHomePath(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

async function readSettings() {
  try {
    return normalizeSettings(YAML.parse(await readFile(CONFIG, "utf8")) || {});
  } catch (error) {
    if (error?.code !== "ENOENT") throw dataReadError("config.yml", error);
    let settings;
    try {
      settings = normalizeSettings(JSON.parse(await readFile(LEGACY_SETTINGS, "utf8")));
    } catch (legacyError) {
      if (legacyError?.code !== "ENOENT") throw dataReadError("settings.json", legacyError);
      settings = normalizeSettings({});
    }
    await writeYamlAtomic(CONFIG, settings).catch(() => {});
    return settings;
  }
}

async function writeSettings(data) {
  const settings = normalizeSettings(data);
  await writeYamlAtomic(CONFIG, settings);
  return settings;
}

function normalizeSettings(data) {
  const incoming = data?.tool_commands || {};
  const tool_commands = {};
  for (const [tool, fallback] of Object.entries(DEFAULT_TOOL_COMMANDS)) {
    const command = typeof incoming[tool] === "string" ? incoming[tool].trim() : "";
    tool_commands[tool] = command || fallback;
  }
  return { tool_commands };
}

async function readProfiles() {
  let existing = null;
  try {
    existing = YAML.parse(await readFile(PROFILES, "utf8")) || {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw dataReadError("profiles.yml", error);
  }
  const profiles = normalizeProfiles(existing, await readSettings());
  if (!existing) await writeYamlAtomic(PROFILES, profiles);
  return profiles;
}

function normalizeProfiles(data, settings) {
  const incoming = Array.isArray(data?.profiles) ? data.profiles : [];
  const defaults = ["codex", "opencode", "claude"].map((tool) => ({
    id: `${tool}-default`,
    label: `${toolLabel(tool)} default`,
    tool,
    command: settings.tool_commands[tool] || DEFAULT_TOOL_COMMANDS[tool],
    enabled: true,
    max_concurrent: null,
  }));
  const profiles = incoming.length ? incoming : defaults;
  return {
    routing: {
      strategy: data?.routing?.strategy || "availability",
    },
    profiles: profiles.map((profile) => {
      const tool = String(profile.tool || "codex");
      return {
        id: slug(profile.id || profile.label || tool),
        label: String(profile.label || profile.id || `${toolLabel(tool)} profile`),
        tool,
        command: String(profile.command || settings.tool_commands[tool] || DEFAULT_TOOL_COMMANDS[tool] || "").trim(),
        env: profileEnv(profile.env),
        env_from_secrets: profileEnvFromSecrets(profile.env_from_secrets),
        enabled: profile.enabled !== false,
        max_concurrent: Number.isFinite(profile.max_concurrent) ? profile.max_concurrent : null,
      };
    }),
  };
}

async function profileDiagnostics() {
  const data = await readProfiles();
  const local = (await loadDevices()).find((device) => device.local);
  const profiles = [];
  for (const profile of data.profiles) {
    const auth = await profileAuth(profile);
    profiles.push({ ...profile, account_home: profileAccountHome(profile), auth, ...(await profileAvailability(local, profile, auth)) });
  }
  return { routing: data.routing, profiles };
}

async function createCodexProfile(body) {
  const data = await readProfiles();
  const label = String(body.label || "").trim();
  if (!label) throw Object.assign(new Error("Account name is required"), { status: 400 });
  const id = uniqueProfileId(data.profiles, `codex-${slug(label)}`);
  const firstCodex = data.profiles.find((profile) => profile.tool === "codex");
  const accountHome = expandArkValue(String(body.account_home || path.join(DATA, "codex-accounts", slug(label))).trim());
  await mkdir(accountHome, { recursive: true });
  data.profiles.push({
    id,
    label,
    tool: "codex",
    command: String(body.command || firstCodex?.command || DEFAULT_TOOL_COMMANDS.codex).trim(),
    env: { CODEX_HOME: accountHome },
    enabled: true,
    max_concurrent: null,
  });
  await writeYamlAtomic(PROFILES, data);
  return profileDiagnostics();
}

async function removeProfile(id) {
  const data = await readProfiles();
  const target = data.profiles.find((profile) => profile.id === id);
  if (!target) throw Object.assign(new Error("Profile not found"), { status: 404 });
  const store = await readStore();
  if (store.sessions.some((session) => session.runner_id === id)) {
    throw Object.assign(new Error("That account is used by an existing session. Forget/kill those sessions first."), { status: 409 });
  }
  data.profiles = data.profiles.filter((profile) => profile.id !== id);
  await writeYamlAtomic(PROFILES, data);
  return profileDiagnostics();
}

async function startCodexProfileLogin(id) {
  const data = await readProfiles();
  const profile = data.profiles.find((item) => item.id === id && item.tool === "codex");
  if (!profile) throw Object.assign(new Error("Codex account not found"), { status: 404 });
  const local = await localDeviceOr404();
  const accountHome = profileAccountHome(profile);
  if (accountHome) await mkdir(accountHome, { recursive: true });
  const tmuxName = newTmuxName();
  const command = withProfileEnv(`${commandName(profile.command) || "codex"} login`, profile.env);
  const result = await startTmux(local, tmuxName, DATA, command);
  if (result.code !== 0) throw Object.assign(new Error(result.output), { status: 502 });
  const session = await upsertSession({
    device_id: local.id,
    device_label: local.label,
    tmux_name: tmuxName,
    cwd: DATA,
    tool: "terminal",
    runner_id: profile.id,
    runner_label: profile.label,
    runner_source: "profile",
    runner_command: profile.command,
    runner_path: "",
    runner_env: profile.env || {},
    runner_account_home: accountHome,
    runner_device_id: local.id,
    runner_device_label: local.label,
    tmux_device_id: local.id,
    tmux_device_label: local.label,
    central_runner: false,
    pipe_log: true,
    title: `Login - ${profile.label}`,
  });
  await enableTmuxPipeLog(local, session);
  await writeSessionEvent(session, { role: "system", text: `Started Codex login for ${profile.label}` });
  return { session };
}

function uniqueProfileId(profiles, wanted) {
  const base = slug(wanted || "codex-account") || "codex-account";
  const used = new Set(profiles.map((profile) => profile.id));
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

async function profileAvailability(device, profile, auth = null) {
  if (!profile.enabled) return { available: false, status: "disabled", checks: { configured: true } };
  if (auth?.signed_in === false) return { available: false, status: "needs-login", checks: { configured: true, authenticated: false } };
  const name = commandName(profile.command);
  if (!name) return { available: false, status: "missing-command", checks: { configured: false } };
  const found = await runOnDevice(device, `command -v ${q(name)}`, 10000);
  if (found.code !== 0) {
    return {
      available: false,
      status: "missing-executable",
      checks: { configured: true, executable: false },
    };
  }
  const running = (await readStore()).sessions.filter((session) => session.runner_id === profile.id).length;
  if (profile.max_concurrent !== null && running >= profile.max_concurrent) {
    return { available: false, status: "at-session-limit", path: found.output, checks: { configured: true, executable: true, authenticated: auth?.signed_in ?? "not-checked" } };
  }
  return {
    available: true,
    status: "available",
    path: found.output,
    checks: {
      configured: true,
      executable: true,
      authenticated: auth?.signed_in ?? "not-checked",
      start_success: "not-checked",
      rate_limit: "not-checked",
      concurrent_sessions_allowed: true,
    },
  };
}

async function profileAuth(profile) {
  if (profile.tool !== "codex") return { status: "not-checked", signed_in: "not-checked" };
  const home = profileAccountHome(profile);
  if (!home) return { status: "host-default", signed_in: "unknown" };
  try {
    const data = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"));
    const tokens = data.tokens || data;
    const claims = decodeJwt(tokens.id_token || tokens.idToken || data.id_token || data.idToken);
    return {
      status: tokens.access_token || data.access_token ? "signed-in" : "needs-login",
      signed_in: Boolean(tokens.access_token || data.access_token),
      email: claims?.email || "",
      account_id: claims?.sub || claims?.account_id || "",
      expires_at: claims?.exp ? new Date(claims.exp * 1000).toISOString() : "",
    };
  } catch {
    return { status: "needs-login", signed_in: false, email: "", account_id: "", expires_at: "" };
  }
}

function decodeJwt(token) {
  try {
    const payload = String(token || "").split(".")[1];
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null;
  } catch {
    return null;
  }
}

async function writeYamlAtomic(filePath, data, mode) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, YAML.stringify(data), mode ? { mode } : undefined);
  await rename(tmp, filePath);
}

function dataReadError(label, error) {
  return Object.assign(new Error(`${label} is unreadable; Ark will not overwrite it: ${error?.message || error}`), { status: 500 });
}

async function deviceOr404(id) {
  const device = (await loadDevices()).find((item) => item.id === id || item.alias_ids?.includes(id));
  if (!device) throw Object.assign(new Error(`Unknown device: ${id}`), { status: 404 });
  return device;
}

async function localDeviceOr404() {
  const device = (await loadDevices()).find((item) => item.local);
  if (!device) throw Object.assign(new Error("Local Ark device is unavailable"), { status: 500 });
  return device;
}

async function tmuxDeviceForSession(session) {
  return deviceOr404(session.tmux_device_id || session.device_id);
}

async function sessionOr404(id) {
  const session = (await readStore()).sessions.find((item) => item.id === id);
  if (!session) throw Object.assign(new Error(`Unknown session: ${id}`), { status: 404 });
  return session;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readFileUpload(req) {
  const type = String(req.headers["content-type"] || "");
  const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = match?.[1] || match?.[2];
  if (!boundary) throw Object.assign(new Error("multipart file upload required"), { status: 400 });

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > UPLOAD_LIMIT) throw Object.assign(new Error("file is too large"), { status: 413 });
    chunks.push(chunk);
  }

  const part = firstMultipartFile(Buffer.concat(chunks), boundary);
  if (!part) throw Object.assign(new Error("file is required"), { status: 400 });
  return part;
}

function firstMultipartFile(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  let start = body.indexOf(marker);
  while (start !== -1) {
    start += marker.length;
    if (body.slice(start, start + 2).toString() === "--") return null;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) return null;
    const headers = body.slice(start, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(marker, dataStart);
    if (next === -1) return null;
    const dataEnd = body[next - 2] === 13 && body[next - 1] === 10 ? next - 2 : next;
    const filename = headerParam(headers, "filename");
    if (filename) {
      const partType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || "application/octet-stream";
      return { filename, type: partType, data: body.slice(dataStart, dataEnd) };
    }
    start = next;
  }
  return null;
}

function headerParam(headers, name) {
  return headers.match(new RegExp(`${name}="([^"]+)"`, "i"))?.[1] || "";
}

function imageExt(filename, type) {
  const ext = path.extname(filename).toLowerCase();
  if (ext && ext.length <= 12) return ext;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return ext;
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" })[type] || ".bin";
}

function safeUploadName(name) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
}

async function file(res, target) {
  try {
    const info = await stat(target);
    if (!info.isFile()) return json(res, 404, { detail: "not found" });
  } catch {
    return json(res, 404, { detail: "not found" });
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType(target),
  });
  createReadStream(target).pipe(res);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isTrustedRemote(address) {
  const ip = String(address || "");
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (ip === "::1" || ip === "127.0.0.1" || v4 === "127.0.0.1") return true;
  if (/^(f[cd][0-9a-f]{0,2}|fe80):/i.test(ip)) return true;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  // ponytail: enough for Tailscale/local v1; add CIDR config when Ark needs public proxying.
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function selfCheckTrustedRemote() {
  const allowed = ["127.0.0.1", "::1", "::ffff:192.168.1.20", "10.0.0.2", "172.16.0.9", "100.64.0.1", "fd7a:115c:a1e0::1"];
  const denied = ["8.8.8.8", "1.2.3.4", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888"];
  for (const ip of allowed) if (!isTrustedRemote(ip)) throw new Error(`expected trusted remote: ${ip}`);
  for (const ip of denied) if (isTrustedRemote(ip)) throw new Error(`expected denied remote: ${ip}`);
}

function selfCheckCore() {
  if (contentType("ark-logo.svg") !== "image/svg+xml") throw new Error("SVG content type is not renderable");
  const mergedDevices = mergeDiscoveredDevices(
    [{ id: "ssh-work", label: "work", host: "work.tailnet.ts.net", user: "tony", source: "ssh-config", status: "unknown" }],
    [{ id: "ts-work", label: "work", host_name: "work", host: "100.64.0.8", dns_name: "work.tailnet.ts.net", tailscale_ips: ["100.64.0.8"], source: "tailscale", status: "online" }],
  );
  if (mergedDevices.length !== 1 || mergedDevices[0].id !== "device-work" || mergedDevices[0].routes.length !== 2) throw new Error("SSH and Tailscale device identities were not merged");
  const history = [
    { id: "u1", role: "user", text: "repeat" },
    { id: "a1", role: "assistant", text: "same answer" },
    { id: "u2", role: "user", text: "repeat" },
    { id: "a2", role: "assistant", text: "same answer" },
  ];
  if (mergeChatMessages([], history).length !== history.length) throw new Error("chat history was deduplicated");
  const parsed = parseChatMessages([{ text: "Codex" }, { text: "Updated server.mjs successfully." }]);
  if (!parsed.some((message) => message.text.includes("server.mjs"))) throw new Error("valid file response was filtered");
  const echoedHook = parseChatMessages([{ text: "pleted)\\nhook context: noisy startup\\n  … +12 lines (ctrl + t to view tr" }]);
  if (echoedHook.length) throw new Error("echoed shell hook command leaked into chat");
  if ((modelControl("Select Model and Effort").choices || []).length) throw new Error("unsafe model fallback returned choices");
  const transcript = codexTranscriptMessage({
    timestamp: "2026-07-09T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "final_answer", message: "Clean answer" },
  }, 1);
  if (transcript?.text !== "Clean answer" || transcript.role !== "assistant") throw new Error("structured Codex transcript parsing failed");
  if (codexTranscriptMessage({ type: "response_item", payload: { type: "function_call" } }, 2)) throw new Error("Codex tool call leaked into chat");
  const usage = codexUsage({ plan_type: "pro", primary: { used_percent: 15, window_minutes: 300, resets_at: 123 }, secondary: { used_percent: 36, window_minutes: 10080, resets_at: 456 } });
  if (usage.primary.used_percent !== 15 || usage.secondary.window_minutes !== 10080 || usage.plan_type !== "pro") throw new Error("Codex usage limits were not normalized");
  const resetNow = new Date(2026, 6, 11, 4, 10).getTime();
  const resetAt = goalUsageResetAt("You've hit your usage limit. Try again at 4:05 AM.\nGoal hit usage limits (/goal resume)", resetNow);
  if (resetAt !== new Date(2026, 6, 11, 4, 5).getTime()) throw new Error("Codex goal reset time was not detected");
  if (goalUsageResetAt("Goal completed normally", resetNow)) throw new Error("normal goal was classified as usage-limited");
  const exactResume = commandForRestart({ tool: "codex", runner_command: "codex --no-alt-screen", codex_session_id: "019f491a-b738-7462-8a3a-418e4532df67" }, true, {});
  if (exactResume !== "codex --no-alt-screen resume '019f491a-b738-7462-8a3a-418e4532df67'") throw new Error("Codex resume lost the exact session id");
  const remotePicker = commandForRestart({ tool: "codex", central_runner: true }, true, { codex: "codex --no-alt-screen" });
  if (!remotePicker.endsWith("resume --all")) throw new Error("remote Codex fallback can select the wrong workspace");
  if (sessionTmuxCwd({ central_runner: true, cwd: "/remote/repo" }) !== DATA) throw new Error("central runner leaked into the Ark source workspace");
  const mergedDrift = mergeCodexTranscript(
    [{ id: "u1", created_at: "2026-01-01T00:00:02Z", role: "user", text: `changed prefix ${"same tail ".repeat(12)}`, source: "codex-rollout" }, { id: "a1", created_at: "2026-01-01T00:00:03Z", role: "assistant", text: "live update", phase: "commentary" }],
    [{ id: "pending", created_at: "2026-01-01T00:00:01Z", role: "user", text: `original prefix ${"same tail ".repeat(12)}`, source: "ark" }],
  );
  if (mergedDrift.length !== 2 || mergedDrift.at(-1)?.text !== "live update") throw new Error("live commentary was hidden behind a pending user message");
  if (agentStateFromScreen({ tool: "codex" }, "• Working (2s • esc to interrupt)") !== "working") throw new Error("working Codex state was not detected");
  if (agentStateFromScreen({ tool: "codex" }, "Would you like to run this command?\n1. Yes\n2. No\nPress enter to confirm") !== "needs_input") throw new Error("Codex input state was not detected");
  const approval = parseCodexControls("Would you like to run the following command? 1. Yes, proceed 2. No, cancel Press enter to confirm or esc to cancel", parseTerminalLines("Would you like to run the following command?\n1. Yes, proceed\n2. No, cancel\nPress enter to confirm or esc to cancel"));
  if (approval[0]?.kind !== "approval" || approval[0].choices.length !== 3) throw new Error("Codex command approval prompt was not actionable");
  const statusThenApproval = "Context window: 80% left\nWould you like to run the following command?\n1. Yes\n2. No\nPress enter to confirm";
  if (parseCodexControls(statusThenApproval, parseTerminalLines(statusThenApproval))[0]?.kind !== "approval") throw new Error("stale status hid a newer input prompt");
  const confirmation = parseCodexControls("Update hooks now? Press enter to continue or esc to cancel", parseTerminalLines("Update hooks now?\nPress enter to continue or esc to cancel"));
  if (confirmation[0]?.choices?.[0]?.key !== "Enter") throw new Error("generic Codex confirmation keys were not actionable");
}

function capturePayload(text, session, storedMessages = [], controlText = text) {
  const lines = parseTerminalLines(text);
  const mode = session?.tool && session.tool !== "terminal" ? "chat" : "terminal";
  const parsedMessages = mode === "chat" ? parseChatMessages(lines) : [];
  const controls = mode === "chat" ? parseAgentControls(session?.tool, controlText) : [];
  return {
    text,
    parsed: lines,
    lines,
    messages: mode === "chat" ? mergeChatMessages(parsedMessages, storedMessages) : [],
    controls,
    agent_state: mode === "chat" ? agentStateFromScreen(session, controlText, controls) : "terminal",
    codex_state: session?.tool === "codex" ? codexStateFromScreen(controlText) : null,
    codex_usage: session?.tool === "codex" ? session.codex_usage || null : null,
    mode,
    tool: session?.tool || "terminal",
    title: session?.title || "",
  };
}

function parseCapture(text) {
  return parseTerminalLines(text);
}

function parseChatMessages(lines) {
  const messages = [];
  let current = null;
  let pendingRole = null;
  for (const line of lines) {
    if (codexControlMessage(line.text)) continue;
    const headerRole = chatHeaderRole(line.text);
    if (headerRole) {
      current = null;
      pendingRole = headerRole;
      continue;
    }
    let role = chatRole(line.text);
    if (role === "ignore" && pendingRole && canUsePendingChatRole(line.text)) role = pendingRole;
    if (role === "ignore") {
      current = null;
      pendingRole = null;
      continue;
    }
    const text = cleanChatLine(line.text, role);
    if (!text) continue;
    pendingRole = null;
    if (!current || current.role !== role) {
      current = { role, text };
      messages.push(current);
    } else {
      current.text += `\n${text}`;
    }
  }
  return messages.slice(-80);
}

function codexControlMessage(text) {
  const line = String(text || "");
  if (/\/model\b.*Select Model and Effort|Select Model and Effort.*\/model\b|\/model\s+choose what model/i.test(line)) return "ARK_CONTROL:model";
  const reasoning = line.match(/Select Reasoning Level(?: for ([\w.-]+))?/i);
  if (reasoning) return `ARK_CONTROL:reasoning:${reasoning[1] || ""}`;
  return "";
}

function chatHeaderRole(text) {
  const line = String(text || "").trim();
  if (/^(assistant|codex|claude|opencode)$/i.test(line)) return "assistant";
  if (/^(you|user|human)$/i.test(line)) return "user";
  if (/^(system|status)$/i.test(line)) return "system";
  return null;
}

function chatRole(text) {
  const line = text.trim();
  if (!line || isTerminalJunkLine(line)) return "ignore";
  if (/^(>|you:|user:|human:)\s*/i.test(line)) return "user";
  if (/^(assistant|codex|claude|opencode)\s*[:>]\s*/i.test(line)) return "assistant";
  if (/^(system|status)\s*[:>]\s*/i.test(line)) return "system";
  if (/^•\s+/.test(line)) return "assistant";
  if (isChatMetaLine(line)) return "ignore";
  // ponytail: heuristic until tool adapters expose structured transcripts.
  return looksLikeAssistantText(line) ? "assistant" : "ignore";
}

function canUsePendingChatRole(text) {
  const line = String(text || "").trim();
  return Boolean(line) && !isTerminalJunkLine(line) && !isChatMetaLine(line) && !chatHeaderRole(line);
}

function isChatMetaLine(text) {
  return /^(working|thinking|reasoning)(?:\.{3}|…)?$/i.test(String(text || "").trim())
    || /^(model|approval|sandbox|cwd|directory):\s/i.test(String(text || "").trim());
}

function cleanChatLine(text, role) {
  const line = text.trim();
  if (role === "user") return line.replace(/^(>|you:|user:|human:)\s*/i, "").trim();
  if (role === "assistant") return line.replace(/^(assistant|codex|claude|opencode)\s*[:>]\s*/i, "").replace(/^•\s+/, "").trim();
  if (role === "system") return line.replace(/^(system|status)\s*[:>]\s*/i, "").trim();
  return line;
}

function isTerminalJunkLine(text) {
  const line = String(text || "").trim();
  if (!line) return true;
  if (isCodexTrustPromptLine(line)) return true;
  if (isCodexControlScreenLine(line)) return true;
  if (isCodexChromeLine(line)) return true;
  if (/^#\s*Attached file:/i.test(line)) return true;
  if (/^Ark context\b/i.test(line)) return true;
  if (/^(Ark remote target|Repo path on remote target):/i.test(line)) return true;
  if (/^Use SSH target\b/i.test(line)) return true;
  if (/^bash:\s+.*:\s+command not found$/i.test(line)) return true;
  if (/^[\w.@~-]+:.*[$#](\s+.*)?$/i.test(line)) return true;
  if (/^\[[^\]]+\]0:[^\n]*\*/.test(line)) return true;
  return false;
}

function isCodexControlScreenLine(line) {
  return /^Select Model and Effort/i.test(line)
    || /^Access legacy models\b/i.test(line)
    || /^Use arrow keys\b/i.test(line)
    || /^Press enter to (select|confirm)\b/i.test(line)
    || /^\d+\.\s*(gpt-|Low|Medium|High|Extra)/i.test(line)
    || /^\/(permissions|personality)\s+choose\b/i.test(line)
    || /^\d+\.\s+(Ask for approval|Approve for me)\b/i.test(line)
    || /^(commands\. Approval is|required to access|requested to access|the internet or edit other files\.?|Only ask for actions|for approval\. Exercise caution)/i.test(line)
    || /^Permissions updated to\b/i.test(line)
    || /(Frontier model|Strong model|Small, fast|Ultra-fast coding|Fast responses|Balances speed|Greater reasoning|Extra high reasoning|real-world work|coding tasks)/i.test(line)
    || /^real-world work\.?$/i.test(line)
    || /^coding tasks\.?$/i.test(line)
    || /model selector/i.test(line);
}

function isCodexTrustPromptLine(line) {
  return /^>\s*You are in\b/i.test(line)
    || /^Do you trust the contents of this directory/i.test(line)
    || /this directory\? Working with untrusted contents/i.test(line)
    || /Working with untrusted contents/i.test(line)
    || /^(comes with higher risk|Trusting the directory allows|project-local config)/i.test(line)
    || /^[›>]\s*1\.\s*Yes, continue/i.test(line)
    || /^2\.\s*No, quit/i.test(line)
    || /Press enter to continue/i.test(line)
    || /^Press enter/i.test(line);
}

function isCodexChromeLine(line) {
  return /^[╭╰─╮╯]+$/.test(line)
    || /^│/.test(line)
    || /^›\s+/.test(line)
    || /^OpenAI Codex\b/i.test(line)
    || /^gpt-[\w.-]+\s+(?:low|medium|high|xhigh|extra\s*high)\b.*(?:\/|~)/i.test(line)
    || /Run \/review/i.test(line)
    || /Booting MCP server:/i.test(line)
    || /esc to interrupt/i.test(line)
    || /SessionStart hook/i.test(line)
    || /^(Explored|Ran|Edited|Read|Listed|Searched|Patched)\b/i.test(line)
    || /^\d{2,5}\s+[+-]\s/.test(line)
    || /^─+\s*Worked for\b/i.test(line)
    || /\\nhook context:/i.test(line)
    || /^hook context:/i.test(line)
    || /ctrl \+ t to view transcript/i.test(line)
    || /Codex can now generate/i.test(line)
    || /usage limit reset/i.test(line)
    || /^NEW:/i.test(line)
    || /^•\s+You have\b/i.test(line)
    || /^Run \/usage\b/i.test(line);
}

function looksLikeAssistantText(text) {
  const line = String(text || "").trim();
  if (isTerminalJunkLine(line)) return false;
  if (/^(printf|echo|cat|ls|pwd|cd|git|npm|node|tmux|ssh)\b/i.test(line)) return false;
  return /[.!?]$/.test(line) || line.split(/\s+/).length >= 4;
}

function newTmuxName() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return "Ark-" + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function q(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function qPath(value) {
  const text = String(value || "~");
  if (text === "~") return "$HOME";
  if (text.startsWith("~/")) return `$HOME/${q(text.slice(2))}`;
  return q(text);
}

function joinRemotePath(base, name) {
  if (!base || base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function parentRemotePath(value) {
  const text = String(value || "~").replace(/\/+$/, "") || "/";
  if (text === "/" || text === "~") return "~";
  const parent = text.slice(0, text.lastIndexOf("/")) || "/";
  return parent;
}

function slug(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "device";
}

function intOrNull(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".webmanifest": "application/manifest+json",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}
