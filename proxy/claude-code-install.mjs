#!/usr/bin/env node
/**
 * Adds (or with `uninstall`, removes) RayTrace's hook in Claude Code's user
 * settings (~/.claude/settings.json), leaving every other setting and hook as
 * it was. The previous file is kept alongside as settings.json.raytace-backup.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// After each tool, when Claude finishes answering, and when the session ends.
const EVENTS = ['PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd'];
const hookScript = fileURLToPath(new URL('./claude-code-hook.mjs', import.meta.url));
const command = `node ${JSON.stringify(hookScript)}`;
const settingsFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
const isOurs = (hook) => typeof hook?.command === 'string' && hook.command.includes('claude-code-hook.mjs');

const uninstall = process.argv[2] === 'uninstall';
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
settings.hooks ??= {};
for (const event of EVENTS) {
  const groups = (settings.hooks[event] ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
    .filter((group) => group.hooks.length);
  if (!uninstall) groups.push({ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
  if (groups.length) settings.hooks[event] = groups; else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

mkdirSync(dirname(settingsFile), { recursive: true });
if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.raytace-backup`);
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
console.log(uninstall
  ? `Removed RayTrace's Claude Code hook from ${settingsFile}.`
  : `Added RayTrace's Claude Code hook to ${settingsFile} (${EVENTS.join(', ')}).\nKeep \`npm run proxy\` running; new Claude Code sessions appear in the dashboard.`);
