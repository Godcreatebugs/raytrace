#!/bin/sh
# Usage: entrypoint.sh <container-id>
#
# Locates the target container's cgroup directory under the host's
# /sys/fs/cgroup (bind-mounted read-only into this sidecar), then runs a
# bpftrace program filtered to exactly that cgroup. This works regardless
# of Docker's cgroup driver (cgroupfs vs systemd) or cgroup version (v1 vs
# v2) because it discovers the real path by search instead of assuming a
# fixed layout -- those details vary across Docker Desktop versions and
# host configurations, and this sidecar has no way to know which one it's
# running under ahead of time.
set -eu

CONTAINER_ID="${1:-}"
if [ -z "$CONTAINER_ID" ]; then
  echo "[tracer] usage: entrypoint.sh <container-id>" >&2
  exit 1
fi

CGROUP_PATH=""
i=0
while [ "$i" -lt 40 ]; do
  CGROUP_PATH=$(find /sys/fs/cgroup -name "*${CONTAINER_ID}*" -type d 2>/dev/null | head -n1 || true)
  [ -n "$CGROUP_PATH" ] && break
  i=$((i + 1))
  sleep 0.25
done

if [ -z "$CGROUP_PATH" ]; then
  echo "[tracer] could not locate a cgroup for container ${CONTAINER_ID} after 10s -- is it running? (docker ps)" >&2
  exit 1
fi

echo "[tracer] scoping to cgroup: ${CGROUP_PATH}" >&2

# sys_enter_execve fires on syscall entry (before success/failure is known),
# which is fine here: a failed exec simply won't match any pending tool
# call in RayTrace's matcher and is silently dropped downstream, same as a
# candidate that never resolves for any other reason.
# join() is not a value -- it's its own statement that prints the array
# straight to stdout (with a trailing newline of its own), so the pid
# prefix has to be a separate printf with no \n, immediately before it.
# Both run within the same probe hit, so their output lands on one line.
exec bpftrace -e "
tracepoint:syscalls:sys_enter_execve
/cgroup == cgroupid(\"${CGROUP_PATH}\")/
{
  printf(\"EXEC\t%d\t\", pid);
  join(args->argv);
}
tracepoint:sched:sched_process_exit
/cgroup == cgroupid(\"${CGROUP_PATH}\")/
{
  printf(\"EXIT\t%d\n\", pid);
}
"
