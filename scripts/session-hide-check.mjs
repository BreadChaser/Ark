import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const data = await mkdtemp(path.join(os.tmpdir(), "ark-session-hide-check-"));
const port = await freePort();
await writeFile(path.join(data, "sessions.json"), JSON.stringify({
  sessions: [{ id: "hide-check", title: "Hide check", tmux_name: "hide-check", device_id: "local", device_label: "local", cwd: "/tmp", tool: "terminal" }],
}));
const ark = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve("."),
  env: { ...process.env, ARK_DATA: data, HOST: "127.0.0.1", PORT: String(port) },
  stdio: "ignore",
});

try {
  await waitForArk(port);
  const hidden = await request(port, "/api/sessions/hide-check", { method: "PATCH", body: JSON.stringify({ hidden: true }) });
  assert.equal(hidden.session.hidden, true);
  assert.equal((await request(port, "/api/sessions")).sessions[0].hidden, true);
  assert.match(await readFile(path.join(data, "sessions", "hide-check", "session.yml"), "utf8"), /hidden: true/);
  const restored = await request(port, "/api/sessions/hide-check", { method: "PATCH", body: JSON.stringify({ hidden: false }) });
  assert.equal(restored.session.hidden, false);
  assert.equal((await request(port, "/api/sessions")).sessions[0].hidden, false);
  console.log("ok");
} finally {
  ark.kill("SIGTERM");
  await rm(data, { recursive: true, force: true });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForArk(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Ark did not start");
}

async function request(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.detail);
  return body;
}
