import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const config = {
  running: true,
  loaded: { name: "Bonsai-27B-Q1_0.gguf", ctx: "65536", reasoning: "on" },
  selected: "models/Bonsai-27B-Q1_0.gguf",
  settings: { context: 65536, kv: "q4_0", ngl: 99, reasoning: "medium", mlock: false },
  models: [
    { key: "models/Bonsai-27B-Q1_0.gguf", name: "Bonsai-27B-Q1_0.gguf", size: "3.5G", preset: { label: "Bonsai 27B", ctx: 65536, kv: "q4_0", ngl: 99, reasoning: "high" } },
    { key: "models/ornith-9b-q4_k_m.gguf", name: "ornith-9b-q4_k_m.gguf", size: "5.2G", preset: { label: "Ornith 9B", ctx: 32768, kv: "q4_0", ngl: 99, reasoning: "high" } },
    { key: "models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf", name: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf", size: "4.4G", preset: { label: "Coder 7B", ctx: 32768, kv: "q4_0", ngl: 99, reasoning: "off" } },
  ],
};
const applied = [];
const controller = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(config));
  }
  if (req.method === "POST" && req.url === "/apply") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    applied.push(form);
    const selected = config.models.find((model) => model.key === form.get("model"));
    config.running = true;
    config.loaded = selected ? { name: selected.name, ctx: form.get("context"), reasoning: form.get("reasoning") === "off" ? "off" : "on" } : null;
    res.writeHead(303, { location: "/" });
    return res.end();
  }
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ running: config.running, loaded: config.loaded }));
  }
  if (req.method === "GET" && req.url === "/health") return res.writeHead(config.running ? 200 : 503).end();
  if (req.method === "POST" && req.url === "/toggle") {
    config.running = !config.running;
    config.loaded = config.running ? { name: "Bonsai-27B-Q1_0.gguf", ctx: "65536", reasoning: "on" } : null;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  res.writeHead(404).end();
});

const data = await mkdtemp(path.join(os.tmpdir(), "ark-local-llm-check-"));
const benchmarks = path.join(data, "benchmarks");
await mkdir(path.join(benchmarks, "sample"), { recursive: true });
await writeFile(path.join(benchmarks, "sample", "results.json"), JSON.stringify({ model: "Test Model", created: "now", results: [{ passed: true }] }));
await writeFile(path.join(benchmarks, "sample", "report.html"), "<!doctype html><title>Test report</title>");
const controllerPort = await listen(controller);
const arkPort = await freePort();
const ark = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    ARK_DATA: data,
    ARK_LOCAL_LLM_URL: `http://127.0.0.1:${controllerPort}`,
    ARK_LOCAL_LLM_HEALTH_URL: `http://127.0.0.1:${controllerPort}/health`,
    ARK_LOCAL_LLM_OPENAI_URL: "http://127.0.0.1:8080/v1",
    ARK_LOCAL_LLM_BENCHMARKS: benchmarks,
    ARK_LOCAL_GPU_LEASE_MS: "100",
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
  const form = applied.at(-1);
  assert.equal(form.get("model"), config.selected);
  assert.equal(form.get("context"), "65536");
  assert.equal(form.get("mlock"), "off");
  const first = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "first" } }) }, 202);
  assert.equal(first.lease.state, "active");
  assert.equal(first.lease.model.id, "bonsai-27b");
  const second = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "second" } }) }, 202);
  assert.equal(second.lease.state, "queued");
  const busy = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ornith-9b" }) }, 409);
  assert.deepEqual(busy.choices, ["use active model", "wait", "use hosted model"]);
  const waiting = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ornith-9b", wait: true, owner: { tmux_name: "third" } }) }, 202);
  assert.equal(waiting.lease.state, "queued");
  await request(arkPort, `/api/local-gpu/leases/${first.lease.id}`, { method: "DELETE" });
  const secondActive = await request(arkPort, `/api/local-gpu/leases/${second.lease.id}`);
  assert.equal(secondActive.lease.state, "active");
  assert.equal(applied.length, 1);
  await request(arkPort, `/api/local-gpu/leases/${second.lease.id}`, { method: "DELETE" });
  const thirdActive = await request(arkPort, `/api/local-gpu/leases/${waiting.lease.id}`);
  assert.equal(thirdActive.lease.model.id, "ornith-9b");
  assert.equal(thirdActive.lease.state, "active");
  assert.equal(config.loaded.name, "ornith-9b-q4_k_m.gguf");
  const isolated = JSON.parse(await readFile(path.join(thirdActive.lease.opencode.config_home, "opencode", "opencode.json"), "utf8"));
  assert.deepEqual(Object.keys(isolated.provider.llamacpp.models), ["ornith-9b"]);
  assert.deepEqual(isolated.compaction, { auto: true, prune: true, reserved: 4096 });
  const expired = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "expired" } }) }, 202);
  await request(arkPort, `/api/local-gpu/leases/${thirdActive.lease.id}`, { method: "DELETE" });
  const afterExpiry = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "coder-7b", wait: true, owner: { tmux_name: "after-expiry" } }) }, 202);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await request(arkPort, `/api/local-gpu/leases/${afterExpiry.lease.id}/heartbeat`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const recovered = await request(arkPort, `/api/local-gpu/leases/${afterExpiry.lease.id}`);
  assert.equal(recovered.lease.state, "active");
  assert.equal(recovered.lease.model.id, "coder-7b");
  await request(arkPort, `/api/local-gpu/leases/${afterExpiry.lease.id}`, { method: "DELETE" });
  const toggled = await request(arkPort, "/api/local-llm/toggle", { method: "POST" });
  assert.equal(toggled.running, false);
  assert.equal(toggled.loaded, null);
  const benchmarkIndex = await fetch(`http://127.0.0.1:${arkPort}/local-llm/benchmarks`).then((response) => response.text());
  assert.match(benchmarkIndex, /Test Model/);
  const benchmarkReport = await fetch(`http://127.0.0.1:${arkPort}/local-llm/benchmarks/sample/report.html`).then((response) => response.text());
  assert.match(benchmarkReport, /Test report/);
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
  return requestStatus(port, pathname, options, 200);
}

async function requestStatus(port, pathname, options, status) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.json();
  assert.equal(response.status, status, body.detail);
  return body;
}
