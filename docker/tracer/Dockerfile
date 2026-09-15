# Sidecar tracer image: bpftrace scoped to one other container's cgroup.
# Deliberately separate from docker/codex/Dockerfile -- the elevated
# privileges this needs (see --privileged in proxy/container-tracer.mjs)
# have no business being available inside the workload container that
# actually runs Codex and executes its shell commands.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bpftrace ca-certificates findutils \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
