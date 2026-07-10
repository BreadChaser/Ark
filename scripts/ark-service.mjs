import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const UNIT_PATH = path.join(UNIT_DIR, "ark.service");

const unit = `[Unit]
Description=Ark local session hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=HOST=0.0.0.0
Environment=PORT=4873
ExecStart=/usr/bin/env node ${path.join(ROOT, "server.mjs")}
KillMode=process
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

const command = process.argv[2] || "unit";

if (command === "unit") {
  process.stdout.write(unit);
} else if (command === "install") {
  await mkdir(UNIT_DIR, { recursive: true });
  await writeFile(UNIT_PATH, unit);
  await systemctl("daemon-reload");
  await systemctl("enable", "--now", "ark.service");
  console.log(`Installed and started ${UNIT_PATH}`);
} else if (command === "restart") {
  await systemctl("restart", "ark.service");
} else if (command === "stop") {
  await systemctl("stop", "ark.service");
} else if (command === "status") {
  await systemctl("status", "--no-pager", "ark.service");
} else if (command === "uninstall") {
  await systemctl("disable", "--now", "ark.service").catch(() => {});
  await rm(UNIT_PATH, { force: true });
  await systemctl("daemon-reload");
  console.log(`Removed ${UNIT_PATH}`);
} else {
  console.error("Usage: node scripts/ark-service.mjs [unit|install|restart|stop|status|uninstall]");
  process.exitCode = 2;
}

function systemctl(...args) {
  return new Promise((resolve, reject) => {
    const child = execFile("systemctl", ["--user", ...args], (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
    child.on("error", reject);
  });
}
