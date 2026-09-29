#!/usr/bin/env bash
# One command from a cold machine to a Codex prompt with evidence capture live.
#
#   npm run dev:all                 doctor, start services, open Codex
#   npm run dev:all -- --status     what is alive
#   npm run dev:all -- --stop       stop the services and the watcher
#   npm run dev:all -- --no-codex   services only; print the sandbox:open line
#   npm run dev:all -- --claude     open Claude Code instead of Codex
#   npm run dev:all -- rtp-<id>     open a specific sandbox
#
# Services run detached and write to .raytace/logs/<name>.log. The terminal you
# run this from becomes your agent session.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

OPEN_CODEX=1
AGENT=codex
WANT_SANDBOX=""
ACTION=start
for arg in "$@"; do
  case "$arg" in
    --status)    ACTION=status ;;
    --stop)      ACTION=stop ;;
    --no-codex)  OPEN_CODEX=0 ;;
    --claude)    AGENT=claude ;;
    rtp-*)       WANT_SANDBOX="$arg" ;;
    -h|--help)   sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOG_DIR" "$RUN_DIR"

# ---------------------------------------------------------------- status/stop

if [ "$ACTION" = status ]; then
  for name in $SERVICES watch; do
    pid="$(running_pid "$name" || true)"
    if [ "$name" = watch ]; then
      printf '  %-8s %-6s %s\n' "$name" "" "$([ -n "$pid" ] && echo "up (pid $pid)" || echo down)"
    else
      state=down; healthy "$name" && state=healthy
      [ "$state" = down ] && [ -n "$pid" ] && state="pid $pid, not answering"
      printf '  %-8s :%-5s %s\n' "$name" "$(svc_port "$name")" "$state"
    fi
  done
  exit 0
fi

if [ "$ACTION" = stop ]; then
  if pid="$(running_pid watch)"; then kill "$pid" 2>/dev/null; rm -f "$(pid_file watch)"; fi
  for name in $SERVICES; do stop_service "$name"; done
  echo "stopped. logs kept in .raytace/logs/"
  exit 0
fi

# -------------------------------------------------------------- phase 1 doctor

printf '\n=== doctor %s ===\n' "$(now)" >> "$(log_file doctor)"
say "[doctor] --- checks ---"
FATAL=0

# node:sqlite needs >= 22.13. Compare major and minor separately -- gluing
# them into one number makes 26.8 ("268") sort below 22.13 ("2213").
node_ok="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>22||(a===22&&b>=13))?1:0' 2>/dev/null || echo 0)"
if [ "${node_ok:-0}" = 1 ]; then say "[doctor] node .................... $(node -v)"
else say "[doctor] node .................... $(node -v 2>/dev/null || echo missing) -- need >= 22.13"; FATAL=1; fi

if [ -f "$ROOT/.env" ]; then say "[doctor] .env .................... found"
else say "[doctor] .env .................... missing (native routing only; sandbox Codex needs OpenRouter)"; fi

if ! command -v limactl >/dev/null 2>&1; then
  say "[doctor] lima ..................... not installed -- brew install lima"; FATAL=1
else
  vm_status="$(limactl list --format '{{.Status}}' "$VM" 2>/dev/null | head -1)"
  if [ -z "$vm_status" ]; then
    say "[doctor] lima VM $VM ... absent -- run: npm run sandbox:setup"; FATAL=1
  elif [ "$vm_status" = Running ]; then
    say "[doctor] lima VM $VM ... already running"
  else
    say "[doctor] lima VM $VM ... $vm_status -> starting (this takes a minute)"
    t0=$(date +%s)
    if limactl start "$VM" >> "$(log_file doctor)" 2>&1; then
      say "[doctor] lima VM $VM ... Running (took $(( $(date +%s) - t0 ))s)"
    else
      say "[doctor] lima VM $VM ... FAILED to start -- see .raytace/logs/doctor.log"; FATAL=1
    fi
  fi
fi

if [ "$FATAL" -eq 0 ]; then
  units="$(limactl shell "$VM" -- systemctl is-active raytace-collector raytace-viewer 2>/dev/null | tr '\n' ' ')"
  case "$units" in
    "active active "*) say "[doctor] collector + viewer ...... active" ;;
    *) say "[doctor] collector + viewer ...... $units-- run: npm run sandbox:setup"; FATAL=1 ;;
  esac
  if limactl shell "$VM" -- sudo docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q raytace-gvisor; then
    say "[doctor] gVisor runtime .......... registered"
  else
    say "[doctor] gVisor runtime .......... MISSING -- run: npm run sandbox:setup"; FATAL=1
  fi

  # The VM keeps its own copies of the collector/viewer under /opt/raytace.
  # They are deployed by hand (see proxy/README.md), so they drift silently --
  # a viewer without the `after` cursor makes the forwarder re-read the whole
  # log on every poll while looking perfectly healthy.
  for unit in viewer collector; do
    local_sum="$(shasum -a 256 "$ROOT/worker/gvisor/$unit.py" 2>/dev/null | cut -d' ' -f1)"
    vm_sum="$(limactl shell "$VM" -- sudo shasum -a 256 "/opt/raytace/$unit.py" 2>/dev/null | cut -d' ' -f1)"
    if [ -n "$local_sum" ] && [ "$local_sum" = "$vm_sum" ]; then
      say "[doctor] VM $unit.py .......... matches repo"
    else
      say "[doctor] VM $unit.py ............ DIFFERS from repo -- deploy it:"
      say "[doctor]     limactl copy worker/gvisor/$unit.py $VM:/tmp/$unit.py"
      say "[doctor]     limactl shell $VM sudo cp /tmp/$unit.py /opt/raytace/$unit.py"
      say "[doctor]     limactl shell $VM sudo systemctl restart raytace-$unit"
    fi
  done

  # gVisor's remote sink dials the collector's socket once, when a sandbox
  # starts, and never re-dials. Restarting the collector recreates that socket
  # (ExecStartPre=rm -f ...events.sock) and silently orphans every sandbox
  # already running: they keep working, record nothing, and every tool call
  # renders as UNVERIFIED. One ESTAB connection per connected sandbox.
  live_boxes="$(limactl shell "$VM" -- sudo docker ps --filter name=rtp- --format '{{.Names}}' 2>/dev/null | grep -c . || echo 0)"
  connected="$(limactl shell "$VM" -- sudo ss -xp 2>/dev/null | grep -c 'events.sock' || echo 0)"
  if [ "$live_boxes" -eq 0 ]; then
    say "[doctor] sandbox evidence ........ no sandbox running"
  elif [ "$connected" -ge "$live_boxes" ]; then
    say "[doctor] sandbox evidence ........ $connected/$live_boxes sandbox(es) reporting"
  else
    say "[doctor] sandbox evidence ........ ONLY $connected of $live_boxes reporting -- the rest are"
    say "[doctor]     evidence-blind (collector restarted after they started). Their commands"
    say "[doctor]     will run and record NOTHING. Restart them:"
    say "[doctor]     limactl shell $VM sudo docker restart <rtp-id>"
  fi
fi

# A port in use is not automatically a problem -- if the thing holding it
# answers its health probe it is the service we were about to start.
ADOPT=""
for name in $SERVICES; do
  port="$(svc_port "$name")"
  if healthy "$name"; then
    ADOPT="$ADOPT $name"
    say "[doctor] port $port ................ in use and healthy -> reusing"
  elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    holder="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    say "[doctor] port $port ................ held by pid $holder but not answering -- stop it first"
    FATAL=1
  else
    say "[doctor] port $port ................ free"
  fi
done

if curl -sf -o /dev/null -m 3 "http://localhost:8798/events?limit=1" 2>/dev/null; then
  say "[doctor] evidence viewer :8798 ... reachable"
else
  say "[doctor] evidence viewer :8798 ... not reachable (Lima port-forward) -- gVisor evidence will not flow"
fi

if [ "$FATAL" -ne 0 ]; then say "[doctor] --- aborting, see above ---"; exit 1; fi

# ------------------------------------------------------ phase 2 start services

say "[start ] --- services ---"
for name in $SERVICES; do
  case " $ADOPT " in
    *" $name "*) say "[start ] $name ... already healthy, left alone"; continue ;;
  esac
  start_service "$name"
  if wait_healthy "$name" 45; then
    say "[start ] $name ... up on :$(svc_port "$name") (pid $(cat "$(pid_file "$name")"))"
  else
    say "[start ] $name ... did NOT come up; last lines of $(log_file "$name"):"
    tail -5 "$(log_file "$name")" | sed 's/^/           /' | tee -a "$(log_file doctor)"
    exit 1
  fi
done

if ! running_pid watch >/dev/null; then
  ( exec "$ROOT/scripts/watch.sh" >> "$(log_file watch)" 2>&1 ) &
  echo $! > "$(pid_file watch)"
  say "[start ] watcher ... up (restarts a service that dies; see its own log)"
fi

# ------------------------------------------------------- phase 3 pick sandbox

# Workspace identity is the repo root. Records are read from disk rather than
# the manager's API so this works even when the manager is the thing that died.
WORKSPACE="$(cd "$ROOT" && git rev-parse --show-toplevel 2>/dev/null || pwd)"
say "[box   ] --- sandbox ---"
say "[box   ] workspace ................ $WORKSPACE"

pick="$(WORKSPACE="$WORKSPACE" WANT="$WANT_SANDBOX" python3 - "$ROOT" <<'PY'
import json, glob, os, sys
root = sys.argv[1]
want = os.environ.get('WANT') or ''
workspace = os.environ['WORKSPACE']
records = []
for path in glob.glob(os.path.join(root, '.raytace/projects/*.json')):
    try: r = json.load(open(path))
    except Exception: continue
    if r.get('status') == 'deleted': continue
    records.append(r)
if want:
    hit = [r for r in records if r['id'] == want]
    print(('use ' if hit and 'proxy_token_hash' in hit[0] else 'approve ' if hit else 'missing ') + want)
    raise SystemExit
mine = [r for r in records if r.get('repo') == workspace]
newest = lambda rs: sorted(rs, key=lambda r: r.get('last_activity') or r.get('created') or '')[-1]
approved = [r for r in mine if 'proxy_token_hash' in r]
if approved:   print('use ' + newest(approved)['id'])
elif mine:     print('approve ' + newest(mine)['id'])
else:          print('create -')
PY
)"
verb="${pick%% *}"; sandbox_id="${pick##* }"

case "$verb" in
  missing) say "[box   ] $sandbox_id not found in .raytace/projects/"; exit 1 ;;
  create)
    # No record for THIS repo -- a genuinely new workspace, so import it.
    say "[box   ] no sandbox for this workspace -> importing"
    out="$(cd "$ROOT" && npm run --silent sandbox:import -- "$WORKSPACE" 2>&1 | tee -a "$(log_file doctor)")"
    sandbox_id="$(printf '%s' "$out" | grep -oE 'rtp-[a-f0-9]{32}' | tail -1)"
    [ -n "$sandbox_id" ] || { say "[box   ] import failed -- see .raytace/logs/doctor.log"; exit 1; }
    say "[box   ] imported .................. $sandbox_id"
    verb=approve ;;
esac

if [ "$verb" = approve ]; then
  # A record without a token is not a new workspace -- approve in place rather
  # than importing a second copy of the same repo.
  say "[box   ] approving proxy access .... $sandbox_id"
  (cd "$ROOT" && npm run --silent sandbox:approve -- "$sandbox_id" >> "$(log_file doctor)" 2>&1) \
    || { say "[box   ] approve failed -- see .raytace/logs/doctor.log"; exit 1; }
fi

say "[box   ] sandbox ................... $sandbox_id"
state="$(limactl shell "$VM" -- sudo docker inspect -f '{{.State.Status}}' "$sandbox_id" 2>/dev/null)"
if [ "$state" = running ]; then
  say "[box   ] container ................. already running"
else
  say "[box   ] container ................. $state -> starting"
  limactl shell "$VM" -- sudo docker start "$sandbox_id" >> "$(log_file doctor)" 2>&1 \
    || { say "[box   ] container failed to start"; exit 1; }
fi

# --------------------------------------------------------------- phase 4 hand over

say ""
say "[ready ] dashboard  http://localhost:3000"
say "[ready ] evidence   http://localhost:8798"
say "[ready ] logs       .raytace/logs/{proxy,sandbox,dev,watch}.log"

if [ "$OPEN_CODEX" -eq 0 ]; then
  say "[ready ] open it with:  npm run sandbox:open -- $sandbox_id"
  exit 0
fi

if [ "$AGENT" = claude ]; then
  # Claude Code signs in with your own account inside the sandbox and talks to
  # Anthropic directly; RayTrace reads its transcript (claude-hook.mjs, sent
  # through the sandbox manager) instead of its traffic. Hooks are reinstalled
  # every time so the sandbox always runs the repo's current version.
  if ! limactl shell "$VM" -- sudo python3 /opt/raytace/projects.py enable-claude "$sandbox_id" \
      < "$ROOT/worker/gvisor/claude-hook.mjs" >> "$(log_file doctor)" 2>&1; then
    say "[box   ] Claude Code hooks ......... FAILED -- the VM's projects.py may be older than the repo:"
    say "[box   ]     limactl copy worker/gvisor/projects.py $VM:/tmp/projects.py"
    say "[box   ]     limactl shell $VM sudo cp /tmp/projects.py /opt/raytace/projects.py"
    exit 1
  fi
  say "[box   ] Claude Code hooks ......... installed"
  say "[ready ] opening Claude Code in $sandbox_id ..."
  say ""
  # Installed once into the sandbox's persistent home, not the image, so an
  # existing sandbox gets it too. --dangerously-skip-permissions for the same
  # reason Codex skips its own sandbox: gVisor is the sandbox here.
  exec limactl shell "$VM" -- sudo docker exec -it "$sandbox_id" /bin/bash -lc \
    'export PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin; if ! command -v claude >/dev/null; then echo "Installing Claude Code in this sandbox (first time only)..."; npm install -g --prefix /home/node/.local @anthropic-ai/claude-code || exit 1; fi; exec claude --dangerously-skip-permissions'
fi

say "[ready ] opening Codex in $sandbox_id ..."
say ""
# Codex's own bwrap sandbox cannot initialise inside gVisor (--cap-drop=ALL,
# no-new-privileges); its help text names this case exactly: "Intended solely
# for running in environments that are externally sandboxed."
exec limactl shell "$VM" -- sudo docker exec -it "$sandbox_id" /bin/bash -lc \
  'if [ -f /home/node/.raytace-codex/config.toml ]; then export CODEX_HOME=/home/node/.raytace-codex; fi; exec codex --dangerously-bypass-approvals-and-sandbox'
