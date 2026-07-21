import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const config = {
  running: true,
  loaded: { name: "Ternary-Bonsai-27B-Q2_0.gguf", ctx: "131072", ngl: "40", reasoning: "high" },
  selected: "qwen/Ternary-Bonsai-27B-Q2_0.gguf",
  settings: { context: 131072, kv: "q4_0", ngl: 40, reasoning: "high", mlock: false },
  models: [
    { key: "qwen/Ternary-Bonsai-27B-Q2_0.gguf", name: "Ternary-Bonsai-27B-Q2_0.gguf", size: "6.7G", preset: { label: "Ternary Bonsai 27B 2-bit", ctx: 131072, kv: "q4_0", ngl: 40, reasoning: "high" } },
    { key: "future/TomorrowBest-42B-Q3_K_M.gguf", name: "TomorrowBest-42B-Q3_K_M.gguf", size: "18G", preset: { label: "TomorrowBest 42B", ctx: 49152, kv: "q8_0", ngl: 77, reasoning: "medium" } },
    { key: "future/Same Model.gguf", name: "Same Model.gguf", size: "1G", preset: { label: "Same Model One", ctx: 8192, kv: "q4_0", ngl: 1, reasoning: "off" } },
    { key: "future/Same-Model.gguf", name: "Same-Model.gguf", size: "1G", preset: { label: "Same Model Two", ctx: 8192, kv: "q4_0", ngl: 1, reasoning: "off" } },
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
    config.loaded = selected ? { name: selected.name, ctx: form.get("context"), ngl: form.get("ngl"), reasoning: form.get("reasoning") } : null;
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
    config.loaded = config.running ? { name: "Ternary-Bonsai-27B-Q2_0.gguf", ctx: "131072", ngl: "40", reasoning: "high" } : null;
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
  assert(loaded.models.some((model) => model.name === "TomorrowBest-42B-Q3_K_M.gguf"));
  assert.equal(loaded.gpu.loaded_model_id, "ternary-bonsai-27b-q2-0");
  assert(loaded.gpu.models.some((model) => model.id === "tomorrowbest-42b-q3-k-m"));
  const collisionIds = localGpuIds(loaded.gpu.models).filter(([key]) => key.startsWith("future/Same"));
  assert.equal(new Set(collisionIds.map(([, id]) => id)).size, 2);
  assert(collisionIds.every(([, id]) => /^same-model-[a-f0-9]{8}$/.test(id)));
  config.models.reverse();
  const reordered = await request(arkPort, "/api/local-gpu");
  assert.deepEqual(localGpuIds(reordered.models), localGpuIds(loaded.gpu.models));
  config.models.reverse();
  await request(arkPort, "/api/local-llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config.settings, model: config.selected }),
  });
  const form = applied.at(-1);
  assert.equal(form.get("model"), config.selected);
  assert.equal(form.get("context"), "131072");
  assert.equal(form.get("mlock"), "off");
  const first = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "first" } }) }, 202);
  assert.equal(first.lease.state, "active");
  assert.equal(first.lease.model.id, "ternary-bonsai-27b-q2-0");
  assert.equal(first.lease.model.context, 131072);
  assert.equal(first.lease.model.reasoning, "high");
  const second = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "second" } }) }, 202);
  assert.equal(second.lease.state, "queued");
  const busy = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "tomorrowbest-42b-q3-k-m" }) }, 409);
  assert.deepEqual(busy.choices, ["use active model", "wait", "use hosted model"]);
  const waiting = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "tomorrowbest-42b-q3-k-m", wait: true, owner: { tmux_name: "third" } }) }, 202);
  assert.equal(waiting.lease.state, "queued");
  await request(arkPort, `/api/local-gpu/leases/${first.lease.id}`, { method: "DELETE" });
  const secondActive = await request(arkPort, `/api/local-gpu/leases/${second.lease.id}`);
  assert.equal(secondActive.lease.state, "active");
  assert.equal(applied.length, 1);
  await request(arkPort, `/api/local-gpu/leases/${second.lease.id}`, { method: "DELETE" });
  const thirdActive = await request(arkPort, `/api/local-gpu/leases/${waiting.lease.id}`);
  assert.equal(thirdActive.lease.model.id, "tomorrowbest-42b-q3-k-m");
  assert.equal(thirdActive.lease.state, "active");
  assert.equal(thirdActive.lease.model.key, "future/TomorrowBest-42B-Q3_K_M.gguf");
  assert.equal(thirdActive.lease.model.kv, "q8_0");
  assert.equal(thirdActive.lease.model.ngl, 77);
  assert.equal(config.loaded.name, "TomorrowBest-42B-Q3_K_M.gguf");
  assert.equal(applied.at(-1).get("model"), "future/TomorrowBest-42B-Q3_K_M.gguf");
  assert.equal(applied.at(-1).get("context"), "49152");
  assert.equal(applied.at(-1).get("kv"), "q8_0");
  assert.equal(applied.at(-1).get("ngl"), "77");
  assert.equal(applied.at(-1).get("reasoning"), "medium");
  const isolated = JSON.parse(await readFile(path.join(thirdActive.lease.opencode.config_home, "opencode", "opencode.json"), "utf8"));
  assert.deepEqual(Object.keys(isolated.provider.llamacpp.models), ["tomorrowbest-42b-q3-k-m"]);
  assert.equal(isolated.provider.llamacpp.models["tomorrowbest-42b-q3-k-m"].name, "TomorrowBest 42B (TomorrowBest-42B-Q3_K_M.gguf)");
  assert.deepEqual(isolated.compaction, { auto: true, prune: true, reserved: 4096 });
  const expired = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "active", owner: { tmux_name: "expired" } }) }, 202);
  await request(arkPort, `/api/local-gpu/leases/${thirdActive.lease.id}`, { method: "DELETE" });
  const afterExpiry = await requestStatus(arkPort, "/api/local-gpu/leases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ternary-bonsai-27b-q2-0", wait: true, owner: { tmux_name: "after-expiry" } }) }, 202);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await request(arkPort, `/api/local-gpu/leases/${afterExpiry.lease.id}/heartbeat`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const recovered = await request(arkPort, `/api/local-gpu/leases/${afterExpiry.lease.id}`);
  assert.equal(recovered.lease.state, "active");
  assert.equal(recovered.lease.model.id, "ternary-bonsai-27b-q2-0");
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

function localGpuIds(models) {
  return models.map((model) => [model.key, model.id]).sort(([a], [b]) => a.localeCompare(b));
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
