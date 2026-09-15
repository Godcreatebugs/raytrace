# Workload image: runs the Codex CLI itself, so its whole process tree
# lives inside one container's pid namespace and cgroup -- that's what lets
# docker/tracer/ scope to it with a single cgroup filter instead of the
# machine-wide, unfilterable eslogger firehose this replaced (see
# proxy/container-tracer.mjs).
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
