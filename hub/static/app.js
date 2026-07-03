const REFRESH_MS = 15_000;

function fmtParams(n) {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  return String(n);
}

function renderLaunch(services) {
  const el = document.getElementById("launch-tiles");
  el.innerHTML = "";
  for (const svc of services || []) {
    if (!svc.url) continue;
    const a = document.createElement("a");
    a.className = "tile";
    a.href = svc.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = svc.name || svc.id;
    el.appendChild(a);
  }
}

function renderGaming(gp) {
  const body = document.getElementById("gaming-body");
  if (!gp) {
    body.innerHTML = '<p class="placeholder">Not hub host</p>';
    return;
  }

  const gpu = gp.gpu || {};
  const llama = gp.llama || {};
  const docker = gp.docker || [];

  let html = "";

  if (gpu.error) {
    html += `<div class="error">GPU: ${gpu.error}</div>`;
  } else {
    html += `
      <div class="stat-row"><span class="stat-label">VRAM</span><span class="stat-value">${gpu.memory_used_mib ?? "—"} MiB</span></div>
      <div class="stat-row"><span class="stat-label">GPU util</span><span class="stat-value">${gpu.utilization_pct ?? "—"}%</span></div>
      <div class="stat-row"><span class="stat-label">Temp</span><span class="stat-value">${gpu.temperature_c ?? "—"}°C</span></div>`;
  }

  if (llama.reachable) {
    html += `
      <div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">${llama.model_id || "local"}</span></div>
      <div class="stat-row"><span class="stat-label">Context</span><span class="stat-value">${llama.n_ctx ? (llama.n_ctx / 1024).toFixed(0) + "k" : "—"}</span></div>
      <div class="stat-row"><span class="stat-label">Params</span><span class="stat-value">${fmtParams(llama.n_params)}</span></div>`;
  } else {
    html += `<div class="error">llama: ${llama.error || "unreachable"}</div>`;
  }

  for (const c of docker) {
    const cls = c.status?.toLowerCase().includes("up") ? "ok" : "bad";
    html += `<div class="stat-row"><span class="stat-label">${c.name}</span><span class="badge ${cls}">${c.status?.split(" ")[0] || "?"}</span></div>`;
  }

  body.innerHTML = html;
}

async function refresh() {
  try {
    const res = await fetch("/api/v1/status");
    const data = await res.json();
    document.getElementById("host-meta").textContent =
      `${data.hostname} · ${new Date().toLocaleTimeString()}`;
    const services = data.config?.services || [];
    renderLaunch(services);
    renderGaming(data.gaming_pc);
  } catch (e) {
    document.getElementById("gaming-body").innerHTML =
      `<div class="error">${e.message}</div>`;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
