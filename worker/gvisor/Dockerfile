FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
