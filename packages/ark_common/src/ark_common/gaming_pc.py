"""Collect status from the local gaming PC (GPU, docker, llama)."""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


@dataclass
class GpuStatus:
    memory_used_mib: int | None = None
    utilization_pct: int | None = None
    temperature_c: int | None = None
    error: str | None = None


@dataclass
class DockerContainer:
    name: str
    status: str
    healthy: bool | None = None


@dataclass
class LlamaStatus:
    model_id: str | None = None
    n_ctx: int | None = None
    n_params: int | None = None
    reachable: bool = False
    error: str | None = None


@dataclass
class GamingPcReport:
    hostname: str
    gpu: GpuStatus = field(default_factory=GpuStatus)
    docker: list[DockerContainer] = field(default_factory=list)
    llama: LlamaStatus = field(default_factory=LlamaStatus)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "hostname": self.hostname,
            "gpu": self.gpu.__dict__,
            "docker": [c.__dict__ for c in self.docker],
            "llama": self.llama.__dict__,
            "errors": self.errors,
        }


def _run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def collect_gpu() -> GpuStatus:
    code, out, err = _run(
        [
            "nvidia-smi",
            "--query-gpu=memory.used,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]
    )
    if code != 0 or not out:
        return GpuStatus(error=err or "nvidia-smi failed")
    parts = [p.strip() for p in out.split(",")]
    try:
        return GpuStatus(
            memory_used_mib=int(parts[0]),
            utilization_pct=int(parts[1]),
            temperature_c=int(parts[2]) if len(parts) > 2 else None,
        )
    except (ValueError, IndexError):
        return GpuStatus(error=f"parse error: {out[:80]}")


def collect_docker(names: list[str] | None = None) -> list[DockerContainer]:
    code, out, _ = _run(
        ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}"]
    )
    if code != 0 or not out:
        return []
    containers: list[DockerContainer] = []
    for line in out.splitlines():
        if "\t" not in line:
            continue
        name, status = line.split("\t", 1)
        if names and name not in names:
            continue
        healthy = None
        if "(healthy)" in status.lower():
            healthy = True
        elif "unhealthy" in status.lower():
            healthy = False
        containers.append(DockerContainer(name=name, status=status, healthy=healthy))
    return containers


def collect_llama(base_url: str = "http://127.0.0.1:8080") -> LlamaStatus:
    url = f"{base_url.rstrip('/')}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        return LlamaStatus(error=str(e))
    models = data.get("data") or data.get("models") or []
    if not models:
        return LlamaStatus(reachable=True, error="no models in response")
    m = models[0]
    meta = m.get("meta") or {}
    return LlamaStatus(
        model_id=m.get("id") or m.get("name"),
        n_ctx=meta.get("n_ctx"),
        n_params=meta.get("n_params"),
        reachable=True,
    )


def collect_gaming_pc(
    hostname: str = "tony-gaming",
    llama_url: str = "http://127.0.0.1:8080",
    docker_names: list[str] | None = None,
) -> GamingPcReport:
    if docker_names is None:
        docker_names = ["llama-ornith", "llama-tiny"]
    report = GamingPcReport(hostname=hostname)
    report.gpu = collect_gpu()
    report.docker = collect_docker(docker_names)
    report.llama = collect_llama(llama_url)
    return report
