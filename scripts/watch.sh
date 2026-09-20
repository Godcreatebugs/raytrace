#!/usr/bin/env bash
# Keeps the three services alive, and says so in their own logs.
#
# Why this exists: the sandbox manager died mid-session once and nothing
# anywhere said so. Codex kept running, its model calls went nowhere, and the
# dashboard was empty -- which looks exactly like a session where nothing
# happened. A dead service should never be something you discover by noticing
# an absence.
#
# Started detached by dev.sh; stopped by `dev.sh --stop`.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

INTERVAL="${RAYTACE_WATCH_INTERVAL:-5}"
MAX_RESTARTS=3
WINDOW=600          # ...within 10 minutes

# bash 3.2: no associative arrays, so counters live in plain vars per service.
proxy_fails=0;   proxy_first=0
sandbox_fails=0; sandbox_first=0
dev_fails=0;     dev_first=0

get_fails()  { eval "echo \${$1_fails}"; }
get_first()  { eval "echo \${$1_first}"; }
set_fails()  { eval "$1_fails=$2"; }
set_first()  { eval "$1_first=$2"; }

note_all() { for s in $SERVICES; do note "$s" "$1"; done; }
note_all "*** watcher started (pid $$, every ${INTERVAL}s) ***"

while :; do
  for name in $SERVICES; do
    if healthy "$name"; then
      # Recovered on its own, or never broke: forget the history.
      [ "$(get_fails "$name")" -gt 0 ] && { note "$name" "*** healthy again ***"; set_fails "$name" 0; }
      continue
    fi

    fails="$(get_fails "$name")"
    first="$(get_first "$name")"
    nowsec="$(date +%s)"

    # Restarts are capped per window, not forever: a service that crashes
    # instantly would otherwise spin and bury the real error under its own
    # restart spam.
    if [ "$fails" -gt 0 ] && [ $((nowsec - first)) -gt "$WINDOW" ]; then
      fails=0                       # outside the window: a fresh budget
    fi
    [ "$fails" -eq 0 ] && set_first "$name" "$nowsec"

    if [ "$fails" -ge "$MAX_RESTARTS" ]; then
      if [ "$fails" -eq "$MAX_RESTARTS" ]; then
        note "$name" "*** gave up after $MAX_RESTARTS restarts in $((nowsec - first))s -- fix it and rerun: npm run dev:all ***"
        set_fails "$name" $((fails + 1))
      fi
      continue
    fi

    fails=$((fails + 1)); set_fails "$name" "$fails"
    note "$name" "*** not responding on $(svc_url "$name"); restarting (attempt $fails/$MAX_RESTARTS) ***"
    stop_service "$name" >/dev/null 2>&1
    start_service "$name"
    if wait_healthy "$name" 30; then
      # Clear the counter here so the top-of-loop recovery branch does not log
      # a second "healthy again" for the same event. A service that dies again
      # later starts a fresh budget, so the cap catches a crash-loop (never
      # comes back) rather than punishing something that flaps once an hour.
      set_fails "$name" 0
      note "$name" "*** restarted, healthy again ***"
    else
      note "$name" "*** restart did not come up within 30s ***"
    fi
  done
  sleep "$INTERVAL"
done
