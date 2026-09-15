# Local gVisor prototype

Mac terminal → dedicated Lima Linux VM → Docker with gVisor → agent.
gVisor SecCheck → root-owned collector outside the agent → SQLite → local viewer.

## Use

Lima is required (`brew install lima`). From the repository:

```sh
npm run sandbox:setup
npm run sandbox:run -- -- /bin/ls -la
npm run sandbox:run -- --network raytace-egress -- /bin/bash
```

Inside that last shell, log in and start Codex:

```sh
mkdir -p "$CODEX_HOME"
codex login --device-auth
codex
```

Device login may require enabling device authentication in your account. See
[official authentication documentation](https://developers.openai.com/codex/auth/).
The image contains Codex CLI; Claude Code/Cursor adapters are not implemented.
The old `npm run codex` / `RAYTACE_CONTAINER` path is unchanged: use `sandbox:run`.
Only commands launched through this sandbox are monitored, not arbitrary Mac apps.

Open http://localhost:8798 for independently collected process events. The same
events also reach the main dashboard (localhost:3000): as a raw per-sandbox
timeline under each trace, and -- via the proxy's gVisor forwarder, see
`proxy/README.md` -- as per-tool-call "Sandbox-verified" verdicts on the
Decision Chain. Keep `npm run proxy` and `npm run sandbox:manager` running
for that; the forwarder discovers sandboxes through the manager.
`npm run sandbox:stop` releases VM CPU/RAM; `limactl start raytace-gvisor` resumes it.

## Isolation and persistence

- No Mac directories, host credentials, SSH agent, or Docker socket mounted into the workload.
- Non-root workload, no capabilities, no-new-privileges, memory/CPU/PID limits.
- Network off by default. Opt-in public egress blocks listed private IPv4 ranges
  and VM services, except TCP/UDP DNS port 53 at Lima's resolver 192.168.5.2.
  DNS uses the host resolver; this is not complete network separation or a domain allowlist.
- Egress mounts only a root-owned VM resolver configuration, read-only.
- Home and temporary directories are memory-backed and disappear when the job stops.
  Authentication must be repeated for a new sandbox. Do not pass secrets as argv:
  process evidence can include arguments.
- Workspace starts empty. Clone a repository inside the sandbox to work on it;
  changes do not automatically sync back to the Mac. Stopped containers are retained
  for deliberate artifact export. Avoid copying private data into an internet-enabled job.
- Evidence lives inside the VM at `/var/lib/raytace/runtime.db`; job manifests and
  `docker diff` summaries are in `/var/lib/raytace/jobs`. No retention limit yet:
  monitor VM disk usage. Do not delete a container until its work is exported.

## Evidence boundaries

`exec_succeeded` comes from gVisor's successful exec checkpoint, not agent output.
Attempts, clones, exits, raw packets and reported drop counts are also retained.
In release-20260817.0, the structured exec return reported zero for a missing
executable in our live test: **zero in that event is not treated as exec success**.
Raw syscall points did not provide additional events in that test.
Shell builtins do not create new executables. This prototype does not record all
file operations, network requests, or terminal output, and does not prove a command
achieved its intended effect. Missing evidence is unknown, not proof of a lie.
Collector loss prevents new sandbox startup; a mid-job disconnect does not guarantee
the workload stops. Drop counters and disconnects do not certify complete coverage.
No false-claim percentage is computed. No isolation technology guarantees no escape.

The collector is outside the workload but not an external immutable audit service;
a VM administrator can change evidence. The loopback viewer is unauthenticated and
available to local users. gVisor is pinned; Ubuntu/Node/Codex image inputs are not yet
fully digest-pinned. This is a development prototype, not a hardened product.

## Tests

```sh
python3 -B -m unittest discover -s worker/gvisor -p 'test_*.py'
limactl copy worker/gvisor/smoke.py raytace-gvisor:/tmp/raytace-smoke.py
limactl shell raytace-gvisor sudo python3 /tmp/raytace-smoke.py
```

The smoke test temporarily stops the collector; run it with no other jobs active.
