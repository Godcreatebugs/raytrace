# Workload image: runs the Codex CLI itself, so its shell commands can only
# touch what proxy/codex.mjs bind-mounts in (RAYTACE_CONTAINER=1). Captures
# model traffic only; observed execution evidence comes from the gVisor
# sandbox (worker/gvisor/).
#
# NOTE: verify the install line below matches how you actually install
# Codex locally -- we couldn't confirm this from your Mac. Check with
# `which codex` / `npm ls -g --depth=0 | grep -i codex` and adjust if the
# package name differs (e.g. a different npm package, or a Homebrew
# formula, in which case swap this RUN line for the right apt/curl steps).
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex

WORKDIR /workspace
