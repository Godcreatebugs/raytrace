# Raytace capture proxy

Run `npm run proxy`. Set a compatible client base URL to `http://127.0.0.1:8787`; exchanges are forwarded to OpenAI or Anthropic and appended to `.raytace/events.jsonl`.

Configure alternate endpoints with `RAYTACE_OPENAI_UPSTREAM` and `RAYTACE_ANTHROPIC_UPSTREAM`. JSON fields resembling credentials are redacted before storage. Production needs encrypted storage, stronger DLP rules, authenticated ingestion, and an object store for streaming payloads.
