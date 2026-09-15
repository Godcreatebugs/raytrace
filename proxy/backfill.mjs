#!/usr/bin/env node
/**
 * One-way import of .raytace/events.jsonl into the SQLite store.
 * Run once: `node proxy/backfill.mjs`. Idempotent — re-running replaces rows
 * by span_id rather than duplicating them. The JSONL file is never modified.
 */
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { openStore } from './store.mjs';

const source = process.env.RAYTACE_STORE || join(process.cwd(), '.raytace', 'events.jsonl');
const target = process.env.RAYTACE_DB || join(dirname(source), 'raytace.db');
const store = openStore(target);

let read = 0, imported = 0, errors = 0, skipped = 0;
const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  read++;
  let row; try { row = JSON.parse(line); } catch { skipped++; continue; }
  try {
    if (row.event_type === 'model.exchange' && row.span_id) { store.recordExchange(row); imported++; }
    else if (row.event_type === 'proxy.error') { store.recordProxyError(row); errors++; }
    else skipped++;
  } catch (error) { skipped++; console.error(`span ${row.span_id}: ${error.message}`); }
  if (read % 500 === 0) process.stdout.write(`\r${read} lines…`);
}

const stats = store.stats();
const sourceBytes = statSync(source).size;
const dbBytes = statSync(target).size;
console.log(`\nRead ${read} lines · imported ${imported} exchanges · ${errors} proxy errors · ${skipped} skipped`);
console.log(`Context items: ${stats.contextItems} rows -> ${stats.blobs.n} unique blobs`);
console.log(`Deduplicated context: ${(stats.logicalBytes / 1e6).toFixed(1)} MB of item text stored as ${(stats.blobs.bytes / 1e6).toFixed(1)} MB`);
console.log(`Source ${(sourceBytes / 1e6).toFixed(1)} MB -> database ${(dbBytes / 1e6).toFixed(1)} MB`);
store.close();
