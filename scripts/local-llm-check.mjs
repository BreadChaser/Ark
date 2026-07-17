import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const config = {
  running: true,
  loaded: { name: "Bonsai-27B-Q1_0.gguf", ctx: "65536" },
  selected: "models/Bonsai-27B-Q1_0.gguf",
  settings: { context: 65536, kv: "q4_0", ngl: 99, reasoning: "medium", mlock: false },
  models: [{ key: "models/Bonsai-27B-Q1_0.gguf", name: "Bonsai-27B-Q1_0.gguf", size: "3.5G", preset: {} }],
};
let applied = "";
const controller = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(config));
  }
  if (req.method === "POST" && req.url === "/apply") {
    for await (const chunk of req) applied += chunk;
    res.writeHead(303, { location: "/" });
    return res.end();
  }
  res.writeHead(404).end();
});

const data = await mkdtemp(path.join(os.tmpdir(), "ark-local-llm-check-"));
const controllerPort = await listen(controller);
const arkPort = await freePort();
const ark = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    ARK_DATA: data,
    ARK_LOCAL_LLM_URL: `http://127.0.0.1:${controllerPort}`,
    HOST: "127.0.0.1",
    PORT: String(arkPort),
  },
  stdio: "ignore",
});

try {
  await waitForArk(arkPort);
  const loaded = await request(arkPort, "/api/local-llm");
  assert.equal(loaded.selected, config.selected);
  await request(arkPort, "/api/local-llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config.settings, model: config.selected }),
  });
  const form = new URLSearchParams(applied);
  assert.equal(form.get("model"), config.selected);
  assert.equal(form.get("context"), "65536");
  assert.equal(form.get("mlock"), "off");
  console.log("ok");
} finally {
  ark.kill("SIGTERM");
  controller.close();
  await rm(data, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForArk(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Ark did not start");
}

async function request(port, pathname, options) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.json();
  assert.equal(response.status, 200, body.detail);
  return body;
}
