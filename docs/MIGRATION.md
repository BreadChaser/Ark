# Proxmox migration

## Current deployment

ARK runs in one Debian VM, not on the Proxmox host.

| Item | Value |
| --- | --- |
| Proxmox VM | 100 (`ark-hub`) |
| CPU / memory | 4 vCPU / 6 GB initially |
| Disk | 100 GB thin-provisioned `local-lvm` |
| Network | VirtIO on `vmbr0` |
| Guest agent | enabled |
| Service | user `ark.service` with user lingering |
| Access | LAN and Tailscale only; port 4873 is not public |

The laptop installation is retained as a recovery source. Its ARK user service
is stopped, while pre-cutover laptop tmux sessions remain alive and are reached
remotely through the hub.

## Migrated state

The cutover copied app-owned ARK state and Codex history over SSH with modes
preserved. The migration deliberately excluded unrelated scratch files at the
ARK data root. Existing remote tmux processes were not moved: processes cannot
be migrated safely; their stored sessions are reattached over SSH instead.

## Verification record

The 2026-07-12 audit verified VM/QEMU-agent health, service enablement,
LAN/Tailscale health endpoints, private firewall rules, device/tmux discovery,
structured Codex transcript parsing, persistent-state parsing, source checks,
and the isolated browser smoke suite. See
[ark-vm-audit-2026-07-12.html](ark-vm-audit-2026-07-12.html) for the concise
operator handoff.
