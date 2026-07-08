import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(ROOT, "hub", "static");
const DATA = process.env.ARK_DATA || path.join(os.homedir(), ".local", "share", "ark");
const STORE = path.join(DATA, "sessions.json");
const PORT = Number(process.env.PORT || 4873);
const HOST = process.env.HOST || "0.0.0.0";

const TOOL_COMMANDS = {
  terminal: "",
  codex: "codex --no-alt-screen",
  opencode: "opencode",
  claude: "claude",
};

const RESUME_COMMANDS = {
  terminal: "",
  codex: "codex --no-alt-screen resume --last",
  opencode: "opencode",
  claude: "claude",
};

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    json(res, error?.status || 500, { detail: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ark listening on http://${HOST}:${PORT}`);
});

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/") {
    return file(res, path.join(STATIC, "index.html"));
  }
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const requested = pathname.slice("/static/".length);
    const target = path.resolve(STATIC, requested);
    if (!target.startsWith(STATIC + path.sep)) return json(res, 403, { detail: "forbidden" });
    return file(res, target);
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
  if (req.method === "POST" && pathname === "/api/sessions") {
    const body = await readJson(req);
    const device = await deviceOr404(body.device_id);
    const tool = body.tool || "codex";
    if (!(tool in TOOL_COMMANDS)) return json(res, 400, { detail: "unknown tool" });
    if (!body.cwd || typeof body.cwd !== "string") return json(res, 400, { detail: "cwd is required" });

    const tmuxName = String(body.tmux_name || "").trim() || newTmuxName();
    const result = await startTmux(device, tmuxName, body.cwd, TOOL_COMMANDS[tool]);
    if (result.code !== 0) return json(res, 502, { detail: result.output });

    const session = await upsertSession({
      device_id: device.id,
      device_label: device.label,
      tmux_name: tmuxName,
      cwd: body.cwd,
      tool,
      title: `${tool} - ${path.basename(body.cwd) || body.cwd}`,
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
      title: body.tmux_name,
    });
    return json(res, 200, { session });
  }

  const tmuxMatch = pathname.match(/^\/api\/devices\/([^/]+)\/tmux$/);
  if (req.method === "GET" && tmuxMatch) {
    const device = await deviceOr404(tmuxMatch[1]);
    const result = await listTmux(device);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    return json(res, 200, { sessions: result.sessions });
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
    const session = await sessionOr404(captureMatch[1]);
    const device = await deviceOr404(session.device_id);
    const result = await captureTmux(device, session.tmux_name);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await touchSession(session.id);
    return json(res, 200, { text: result.output, parsed: parseCapture(result.output) });
  }

  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
  if (req.method === "POST" && sendMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(sendMatch[1]);
    const device = await deviceOr404(session.device_id);
    const result = await sendText(device, session.tmux_name, String(body.text || ""), body.submit !== false);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const restartMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
  if (req.method === "POST" && restartMatch) {
    const body = await readJson(req);
    const session = await sessionOr404(restartMatch[1]);
    const device = await deviceOr404(session.device_id);
    const commands = body.resume ? RESUME_COMMANDS : TOOL_COMMANDS;
    const result = await startTmux(device, session.tmux_name, session.cwd, commands[session.tool] || "");
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const interruptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const session = await sessionOr404(interruptMatch[1]);
    const device = await deviceOr404(session.device_id);
    const result = await runOnDevice(device, `tmux send-keys -t ${q(session.tmux_name)} C-c`, 10000);
    if (result.code !== 0) return json(res, 502, { detail: result.output });
    await touchSession(session.id);
    return json(res, 200, { ok: true });
  }

  const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const session = await sessionOr404(deleteMatch[1]);
    if (url.searchParams.get("kill") === "true") {
      const device = await deviceOr404(session.device_id);
      await runOnDevice(device, `tmux kill-session -t ${q(session.tmux_name)} 2>/dev/null || true`, 10000);
    }
    await deleteSession(session.id);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { detail: "not found" });
}

async function loadDevices() {
  const devices = new Map();
  const add = (device) => {
    if (!devices.has(device.id)) devices.set(device.id, device);
  };

  add({
    id: "local",
    label: `${os.hostname()} (local)`,
    host: "localhost",
    local: true,
    source: "local",
    status: "online",
  });

  for (const device of await sshConfigDevices()) add(device);
  for (const device of await tailscaleDevices()) add(device);

  return [...devices.values()].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.label.localeCompare(b.label);
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
      const name = peer.HostName || peer.DNSName || "";
      const host = peer.TailscaleIPs?.[0] || String(peer.DNSName || "").replace(/\.$/, "");
      if (!name || !host) return null;
      return {
        id: `ts-${slug(name)}`,
        label: name,
        host,
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

async function startTmux(device, tmuxName, cwd, command) {
  const cmdArg = command ? ` ${q(command)}` : "";
  const script = [
    "command -v tmux >/dev/null 2>&1 || { echo 'tmux is not installed'; exit 127; }",
    `tmux has-session -t ${q(tmuxName)} 2>/dev/null || tmux new-session -d -s ${q(tmuxName)} -c ${qPath(cwd)}${cmdArg}`,
    `tmux set-option -t ${q(tmuxName)} history-limit 20000`,
  ].join("; ");
  return runOnDevice(device, script, 30000);
}

async function listDirs(device, dir) {
  const script = [
    `cd ${qPath(dir)} 2>/dev/null || { echo 'cannot open directory'; exit 2; }`,
    `printf '__ARK_CWD__%s\\n' "$PWD"`,
    `{ for d in */ .*/; do [ -d "$d" ] || continue; name=\${d%/}; [ "$name" = "." ] && continue; [ "$name" = ".." ] && continue; printf '__ARK_DIR__%s\\n' "$name"; done; } | sort`,
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

async function captureTmux(device, tmuxName) {
  return runOnDevice(device, `tmux capture-pane -pt ${q(tmuxName)} -S -240 -e`, 15000);
}

async function sendText(device, tmuxName, text, submit) {
  let script = `tmux send-keys -t ${q(tmuxName)} -l ${q(text)}`;
  if (submit) script += `; tmux send-keys -t ${q(tmuxName)} Enter`;
  return runOnDevice(device, script, 15000);
}

async function runOnDevice(device, command, timeout) {
  if (device.local) return exec("bash", ["-lc", command], timeout);
  const target = device.user ? `${device.user}@${device.host}` : device.host;
  return exec(
    "ssh",
    [
      "-o", "ConnectTimeout=6",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      target,
      `bash -lc ${q(command)}`,
    ],
    timeout,
  );
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
  return data.sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

async function upsertSession(patch) {
  const data = await readStore();
  const now = Math.floor(Date.now() / 1000);
  const existing = data.sessions.find((item) => item.device_id === patch.device_id && item.tmux_name === patch.tmux_name);
  const session = {
    id: existing?.id || crypto.randomUUID(),
    created_at: existing?.created_at || now,
    updated_at: now,
    ...existing,
    ...patch,
  };
  data.sessions = data.sessions.filter((item) => item.id !== session.id);
  data.sessions.push(session);
  await writeStore(data);
  return session;
}

async function touchSession(id) {
  const data = await readStore();
  const session = data.sessions.find((item) => item.id === id);
  if (!session) return;
  session.updated_at = Math.floor(Date.now() / 1000);
  await writeStore(data);
}

async function deleteSession(id) {
  const data = await readStore();
  data.sessions = data.sessions.filter((item) => item.id !== id);
  await writeStore(data);
}

async function readStore() {
  try {
    const data = JSON.parse(await readFile(STORE, "utf8"));
    return Array.isArray(data.sessions) ? data : { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

async function writeStore(data) {
  await mkdir(DATA, { recursive: true });
  const tmp = `${STORE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, STORE);
}

async function deviceOr404(id) {
  const device = (await loadDevices()).find((item) => item.id === id);
  if (!device) throw Object.assign(new Error(`Unknown device: ${id}`), { status: 404 });
  return device;
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

function parseCapture(text) {
  return stripAnsi(text).split(/\r?\n/).filter((line) => line.trim()).slice(-120).map((line) => ({
    kind: /^[\w.@~-]+:.*[$#]\s*/.test(line) ? "prompt" : "text",
    text: line,
  }));
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
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

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  }[path.extname(filePath)] || "application/octet-stream";
}
