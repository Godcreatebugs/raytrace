# Shared helpers for scripts/dev.sh and scripts/watch.sh.
#
# Deliberately bash 3.2 compatible: macOS still ships /bin/bash 3.2, so no
# associative arrays, no `declare -A`, no ${var^^}. Service attributes are
# looked up through case statements instead.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.raytace/logs"
RUN_DIR="$ROOT/.raytace/run"
VM=raytace-gvisor

# The three services this repo needs running. `dev` is the dashboard; `sandbox`
# is the manager on :8799 -- the one whose silent death leaves Codex talking to
# nothing and the dashboard merely empty, which is why it is watched at all.
SERVICES="proxy sandbox dev"

# The real binaries, NOT `npm run <script>`. npm forks the actual server as a
# child, so the pid we would record is the wrapper's: kill it and the server is
# orphaned onto pid 1, still holding its port, while our pid file points at
# something dead. Status then lies and the next restart fails with "port in
# use". Exec'ing the binary directly makes the recorded pid the server itself.
# Keep these in step with the matching scripts in package.json.
svc_cmd() {
  case "$1" in
    proxy)   echo "node --disable-warning=ExperimentalWarning proxy/raytace-proxy.mjs" ;;
    sandbox) echo "python3 worker/gvisor/project_manager.py serve" ;;
    dev)     echo "node_modules/.bin/vinext dev" ;;
  esac
}

svc_port() {
  case "$1" in
    proxy)   echo 8797 ;;
    sandbox) echo 8799 ;;
    dev)     echo 3000 ;;
  esac
}

# Health is an answered HTTP probe, never "a process exists": a proxy that is
# up but wedged, or a port held by something unrelated, both have a pid.
svc_url() {
  case "$1" in
    proxy)   echo "http://127.0.0.1:8797/raytace/models" ;;
    sandbox) echo "http://127.0.0.1:8799/api/projects" ;;
    # localhost, not 127.0.0.1: vinext binds [::1]:3000 only, so an IPv4-only
    # check reports the dashboard as down while it is serving fine.
    dev)     echo "http://localhost:3000" ;;
  esac
}

log_file() { echo "$LOG_DIR/$1.log"; }
pid_file() { echo "$RUN_DIR/$1.pid"; }

now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Everything the doctor prints goes to the terminal AND to doctor.log, so a run
# can be reconstructed after the scrollback is gone.
say() { printf '%s\n' "$*"; printf '%s %s\n' "$(now)" "$*" >> "$(log_file doctor)"; }

# Per-process lines land in that process's own log, next to its stdout -- the
# death and the restart sit in the same file as the crash that caused them.
note() { printf '%s %s\n' "$(now)" "$2" >> "$(log_file "$1")"; }

healthy() {
  curl -sf -o /dev/null -m 3 "$(svc_url "$1")" 2>/dev/null
}

running_pid() {
  local f; f="$(pid_file "$1")"
  [ -f "$f" ] || return 1
  local pid; pid="$(cat "$f" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

start_service() {
  local name="$1" log; log="$(log_file "$name")"
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  # Append, with a banner per run: history is the point of writing to files.
  printf '\n=== run %s === %s\n' "$(now)" "$(svc_cmd "$name")" >> "$log"
  ( cd "$ROOT" && exec $(svc_cmd "$name") >> "$log" 2>&1 ) &
  echo $! > "$(pid_file "$name")"
}

# Poll until the probe answers. Returns 1 on timeout so the caller can show the
# tail of that service's log instead of a bare "failed".
wait_healthy() {
  local name="$1" timeout="${2:-40}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    healthy "$name" && return 0
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# Kill a pid and anything it spawned, deepest first. Belt and braces: the
# services are exec'd directly so the pid is the server, but a service that
# forks a helper should not leave it behind holding a port.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null
}

stop_service() {
  local name="$1" pid
  if pid="$(running_pid "$name")"; then
    kill_tree "$pid" TERM
    for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill_tree "$pid" KILL
    note "$name" "*** stopped by dev.sh ***"
  fi
  rm -f "$(pid_file "$name")"
  # An earlier run (or a hand-started service) may still hold the port with a
  # pid we never recorded; a restart into an occupied port fails confusingly.
  local port orphan; port="$(svc_port "$name")"
  orphan="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$orphan" ]; then
    note "$name" "*** port $port still held by pid $orphan after stop; terminating it ***"
    kill_tree "$orphan" TERM; sleep 1; kill_tree "$orphan" KILL
  fi
}
