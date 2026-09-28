/**
 * Turns raw gVisor process events into something a person can read: one line
 * per command the agent actually ran, in plain English, with the noise folded
 * away and counted.
 *
 * Why this is needed: the collector records every exec faithfully, and that is
 * the point -- but faithfully includes Codex's own machinery. A single
 * `npm test` produces four exec events in one pid:
 *
 *   /bin/bash -c __CODEX_SNAPSHOT_OVERRIDE_SET_0=...   16,027 characters
 *   /bin/bash -c cd /workspace/demo && npm test        the command as written
 *   /usr/local/bin/npm test                            re-exec, same pid
 *   node /usr/local/bin/npm test                       re-exec, same pid
 *
 * Rendered verbatim that is unreadable, and the 16k preamble collapses any
 * table it lands in. So events are folded -- never dropped. `fold()` returns
 * the commands plus a count of exactly what it folded, and callers are
 * expected to show that count and offer the raw events. A tool that claims to
 * show what really happened does not get to quietly hide two thirds of it.
 */

const CODEX_PREAMBLE = /__CODEX_SNAPSHOT_(?:OVERRIDE|PROXY)/;
/** npm probes the architecture before running a script; it says nothing about
 * what the agent asked for. Matched exactly, never by prefix. */
const MACHINERY = [/^getconf (?:LONG_BIT|_NPROCESSORS_ONLN)$/];

/** Codex wraps every tool call as `/bin/bash -c <cmd>` (or -lc). Stripping the
 * wrapper leaves the command the agent actually wrote -- the same normalisation
 * execution-correlation.mjs does before matching. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh|dash)\s+-[a-z]*c\s+/;

/** Quoting differs between a shell's argv and its child's, so compare on the
 * text alone: `node -e "x"` and `node -e x` are the same work. */
function normalizeForCompare(command) {
  return String(command).replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

export function commandText(argv) {
  return (Array.isArray(argv) ? argv : []).join(' ').trim();
}

export function isPreamble(argv) { return CODEX_PREAMBLE.test(commandText(argv)); }

export function isMachinery(argv) {
  const text = commandText(argv);
  return MACHINERY.some((pattern) => pattern.test(text));
}

/** The command without Codex's shell wrapper, for display and for the rules. */
export function bareCommand(argv) {
  return commandText(argv).replace(SHELL_WRAPPER, '').trim();
}

/**
 * Folds a page of collector events into one entry per command.
 *
 * Same-pid re-execs collapse onto the FIRST non-preamble exec in that pid:
 * `/bin/bash -c cd … && npm test` is what the agent asked for, and
 * `npm test` -> `node …/npm test` are that command implementing itself. Keeping
 * the first is what makes the line match the tool call above it.
 *
 * @param {Array<object>} events - raw viewer events (any order)
 * @returns {{commands: Array<object>, folded: {preamble: number, machinery: number, reexec: number, exits: number, preambleChars: number}}}
 */
export function fold(events) {
  const folded = { preamble: 0, machinery: 0, reexec: 0, exits: 0, preambleChars: 0 };
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(Number(event?.event_id)))
    .sort((a, b) => Number(a.event_id) - Number(b.event_id));

  const byPid = new Map();   // pid -> the command entry that owns it
  // pid -> ppid for EVERY process seen, whether or not it became a command.
  // Two kinds of process are missing from `byPid` but still sit between a
  // command and its real parent: ones we folded (machinery, preamble), and
  // ones that forked without ever exec'ing -- a shell running `a | b | c`
  // forks a subshell per stage, and a subshell inherits its parent's image, so
  // gVisor has no exec to report for it. Without their ppid the stages below
  // them look parentless and float to the top level as though nothing had
  // started them. `process_exit` names the ppid even when no exec did.
  const lineage = new Map();
  const remember = (pid, ppid) => { if (!lineage.has(pid) && ppid != null) lineage.set(pid, ppid); };
  const commands = [];

  for (const event of ordered) {
    const pid = Number(event.pid);
    const eventPpid = Number.isFinite(Number(event.ppid)) ? Number(event.ppid) : null;
    remember(pid, eventPpid);
    if (event.kind === 'process_exit') {
      folded.exits += 1;
      const owner = byPid.get(pid);
      if (owner) {
        owner.exit_code = typeof event.exit_code === 'number' ? event.exit_code : null;
        owner.signal = typeof event.signal === 'number' && event.signal > 0 ? event.signal : null;
        owner.ended_ns = event.timestamp_ns ?? null;
      }
      continue;
    }
    if (event.kind !== 'exec_succeeded') continue;

    const argv = Array.isArray(event.argv) ? event.argv : [];
    if (isPreamble(argv)) { folded.preamble += 1; folded.preambleChars += commandText(argv).length; continue; }
    if (isMachinery(argv)) { folded.machinery += 1; continue; }

    // A pid that already has a command is re-execing: same job, new image.
    if (byPid.has(pid)) { folded.reexec += 1; continue; }

    const entry = {
      event_id: Number(event.event_id),
      pid,
      ppid: eventPpid,
      argv,
      command: bareCommand(argv),
      started_ns: event.timestamp_ns ?? null,
      // The process's own start time: with pid, the identity the dashboard
      // uses to find which tool call this process belongs to. Stable across
      // the re-execs this entry absorbs, unlike the event id kept above.
      process_start_ns: typeof event.process_start_ns === 'string' ? event.process_start_ns : null,
      ended_ns: null,
      exit_code: null,
      signal: null,
      // Set by the caller once parents are known; a child of a command the
      // agent ran is shown nested under it rather than as its own step.
      parent_event_id: null,
    };
    byPid.set(pid, entry);
    commands.push(entry);
  }

  // Nest: a command whose ppid belongs to another command in this window is a
  // consequence of it, not a separate thing the agent did. Walk the lineage
  // upward rather than taking a single hop, so a folded parent hands its
  // children to the nearest ancestor that survived. A process whose parent ran
  // outside this window is genuinely unattributed and stays at the top level.
  for (const entry of commands) {
    let ancestor = entry.ppid;
    const seen = new Set([entry.pid]);
    while (ancestor != null && !seen.has(ancestor)) {
      const parent = byPid.get(ancestor);
      if (parent && parent !== entry) { entry.parent_event_id = parent.event_id; break; }
      seen.add(ancestor);
      ancestor = lineage.has(ancestor) ? lineage.get(ancestor) : null;
    }
  }

  // `sh -c "node -e X"` forks a `node -e X`. Two processes, one action -- the
  // shell is doing precisely what it was handed, so showing both reads as the
  // agent having deleted the same file twice. Collapse the child onto the
  // parent when their commands are the same once quoting is ignored, keeping
  // the child's outcome (it is the process that actually did the work).
  const sameWork = (a, b) => a && b && normalizeForCompare(a) === normalizeForCompare(b);
  const byEventId = new Map(commands.map((entry) => [entry.event_id, entry]));
  const collapsed = commands.filter((entry) => {
    const parent = entry.parent_event_id != null ? byEventId.get(entry.parent_event_id) : null;
    if (!parent || !sameWork(entry.command, parent.command)) return true;
    parent.exit_code = entry.exit_code ?? parent.exit_code;
    parent.signal = entry.signal ?? parent.signal;
    parent.ended_ns = entry.ended_ns ?? parent.ended_ns;
    byEventId.set(entry.event_id, parent);   // re-point any grandchildren
    folded.reexec += 1;
    return false;
  });
  for (const entry of collapsed) {
    const parent = entry.parent_event_id != null ? byEventId.get(entry.parent_event_id) : null;
    entry.parent_event_id = parent && parent !== entry ? parent.event_id : null;
  }

  return { commands: collapsed, folded };
}

// --- plain-English rules -----------------------------------------------------
//
// Deterministic, in the spirit of describeCall() in experiment-engine.mjs.
// A rule may only say what the command text already proves. Anything else
// falls through to `null`, and the caller either shows the command verbatim or
// asks a model -- clearly marked as a model's reading, never as observation.

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
/** Last two path segments: enough to recognise, short enough to read. */
const shortPath = (value) => {
  const parts = String(value).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length <= 2 ? String(value) : '…/' + parts.slice(-2).join('/');
};

const RULES = [
  [/^ls(\s|$)/, (c) => `listed files in ${shortPath(lastPath(c) || '.')}`],
  [/^mkdir(\s|$)/, (c) => `created folder ${shortPath(lastPath(c) || '')}`],
  [/^rmdir(\s|$)/, (c) => `removed folder ${shortPath(lastPath(c) || '')}`],
  [/^rm(\s|$)/, (c) => `deleted ${shortPath(lastPath(c) || '')}`],
  [/^touch(\s|$)/, (c) => `created empty file ${shortPath(lastPath(c) || '')}`],
  [/^cp(\s|$)/, (c) => `copied ${twoPaths(c)}`],
  [/^mv(\s|$)/, (c) => `moved ${twoPaths(c)}`],
  [/^chmod(\s|$)/, (c) => `changed permissions on ${shortPath(lastPath(c) || '')}`],
  [/^cat\s*>{1,2}\s*(\S+)/, (c) => `wrote ${shortPath(c.match(/>{1,2}\s*(\S+)/)?.[1] || '')}`],
  [/^echo\b[^>]*>{1,2}\s*(\S+)/, (c) => `wrote ${shortPath(c.match(/>{1,2}\s*(\S+)/)?.[1] || '')}`],
  [/^cat(\s|$)/, (c) => (lastPath(c) ? `read ${shortPath(lastPath(c))}` : null)],
  [/^(?:grep|rg)(\s|$)/, (c) => `searched for ${clip(quoted(c) || 'a pattern', 40)}`],
  [/^find(\s|$)/, () => 'searched the filesystem'],
  [/^git\s+(\w[\w-]*)/, (c) => `ran git ${c.match(/^git\s+(\w[\w-]*)/)[1]}`],
  [/^(?:npm|yarn|pnpm)\s+(?:run\s+)?(\w[\w:-]*)/, (c) => {
    const script = c.match(/^(?:npm|yarn|pnpm)\s+(?:run\s+)?(\w[\w:-]*)/)[1];
    if (script === 'install' || script === 'i' || script === 'ci') return 'installed dependencies';
    if (script === 'test') return 'ran the test script';
    return `ran the ${script} script`;
  }],
  [/^node\s+-e\b/, (c) => describeInlineNode(c)],
  [/^(?:python3?|node)\s+(\S+\.(?:py|js|mjs|cjs|ts))/, (c) => `ran ${shortPath(c.match(/\s(\S+\.(?:py|js|mjs|cjs|ts))/)[1])}`],
  [/^(?:curl|wget)(\s|$)/, (c) => `fetched ${clip(firstUrl(c) || 'a URL', 50)}`],
  [/^(?:pwd|whoami|id|uname|date)(\s|$)/, (c) => `checked ${c.split(/\s/)[0]}`],
  [/^sh\s+-c\b/, (c) => describeShellC(c)],
];

function lastPath(command) {
  const args = command.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'));
  return args.length ? args[args.length - 1] : '';
}
function twoPaths(command) {
  const args = command.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'));
  return args.length >= 2 ? `${shortPath(args[0])} to ${shortPath(args[args.length - 1])}` : shortPath(args[0] || '');
}
function quoted(command) { return command.match(/["']([^"']{2,})["']/)?.[1] ?? null; }
function firstUrl(command) { return command.match(/https?:\/\/\S+/)?.[0] ?? null; }

/** `node -e "<script>"` is common enough to be worth reading into, but only
 * for operations the script text states outright. */
function describeInlineNode(command) {
  // The script usually arrives still wrapped in the quotes the shell saw
  // (`node -e "console.log('x')"`); strip them so anchored patterns match.
  const script = command.replace(/^node\s+-e\s*/, '').replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  const unlink = script.match(/unlinkSync\(\s*["']([^"']+)["']/);
  if (unlink) return `deleted ${shortPath(unlink[1])}`;
  const write = script.match(/writeFileSync\(\s*["']([^"']+)["']/);
  if (write) return `wrote ${shortPath(write[1])}`;
  const mkdir = script.match(/mkdirSync\(\s*["']([^"']+)["']/);
  if (mkdir) return `created folder ${shortPath(mkdir[1])}`;
  const log = script.match(/^\s*console\.log\(\s*["']([^"']*)["']\s*\)\s*$/);
  if (log) return `printed "${clip(log[1], 40)}"`;
  return null;   // an inline script doing something else: show it verbatim
}

/** `sh -c "<inner>"` -- describe the inner command, so a wrapper does not
 * hide what it wrapped. */
function describeShellC(command) {
  const inner = command.replace(/^sh\s+-c\s*/, '').replace(/^["']|["']$/g, '').trim();
  return inner ? describeCommand(inner) : null;
}

/**
 * A sentence for one command, or null when no rule applies with certainty.
 * Null is a real answer: it means "show the command itself", which is always
 * honest, rather than inventing a description that might be wrong.
 */
export function describeCommand(command) {
  // Strip the shell wrapper, then any quotes it left behind: `sh -c "npm test"`
  // becomes `npm test`, so the rules see the command rather than the quoting.
  const text = String(command ?? '')
    .replace(SHELL_WRAPPER, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .trim();
  if (!text) return null;
  // A compound command (`cd x && npm test`) is described by its last real
  // step; `cd` alone is navigation, not work.
  const parts = text.split(/\s*&&\s*/).map((p) => p.trim()).filter(Boolean);
  const meaningful = parts.filter((p) => !/^cd(\s|$)/.test(p));
  const target = meaningful.length ? meaningful[meaningful.length - 1] : parts[parts.length - 1];
  for (const [pattern, render] of RULES) {
    if (pattern.test(target)) {
      const described = render(target);
      if (described) return described;
    }
  }
  return null;
}

/** Every command in `commands` that no rule could describe, deduplicated --
 * the batch a caller sends to a model in ONE request rather than per line. */
export function undescribed(commands) {
  const seen = new Set();
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (entry.description) continue;
    if (describeCommand(entry.command)) continue;
    if (entry.command) seen.add(entry.command);
  }
  return [...seen];
}

/**
 * Attaches a `description` and `description_source` to each command.
 * `lookup` maps a command string to a model-written sentence (cache or fresh);
 * anything it does not cover keeps `source: 'raw'` and is rendered verbatim.
 */
export function describeAll(commands, lookup = () => null) {
  for (const entry of Array.isArray(commands) ? commands : []) {
    const rule = describeCommand(entry.command);
    if (rule) { entry.description = rule; entry.description_source = 'rule'; continue; }
    const model = lookup(entry.command);
    if (model) { entry.description = model; entry.description_source = 'model'; continue; }
    entry.description = null; entry.description_source = 'raw';
  }
  return commands;
}

// --- model fallback for commands no rule can describe ------------------------
//
// Batched: every unknown command in a turn goes in ONE request, deduplicated,
// and the result is cached by command text (migration 006). A per-line call
// would be both slow and a real cost on every trace view.

const MAX_BATCH = 25;
const MAX_COMMAND_CHARS = 300;

export const DESCRIBE_INSTRUCTIONS = [
  'You are labelling shell commands that were observed running inside a sandbox.',
  'For each numbered command, reply with the same number and one short phrase saying what the command does.',
  'Use plain past tense, under 10 words, no trailing period. Example: 3. compiled the native addon',
  'Describe only what the command text itself shows. If you cannot tell, reply exactly: unclear.',
  'Never guess at intent, outcome, or whether it succeeded.',
].join(' ');

/** Request for a batch of unknown commands. Shape mirrors summaryRequest() in
 * summaries.mjs so both go through the same provider path. */
export function describeRequest(commands, model) {
  const batch = [...new Set(commands)].slice(0, MAX_BATCH)
    .map((command) => String(command).slice(0, MAX_COMMAND_CHARS));
  return {
    commands: batch,
    payload: {
      model, store: false, stream: false,
      max_output_tokens: 40 * batch.length + 120,
      // A labelling task, not a reasoning one -- and reasoning tokens compete
      // with the output budget, which is what broke summaries at v3.
      reasoning: { effort: 'low' },
      instructions: DESCRIBE_INSTRUCTIONS,
      input: batch.map((command, index) => `${index + 1}. ${command}`).join('\n'),
    },
  };
}

/**
 * Parses the numbered reply back into command -> sentence.
 * A line the model marked `unclear`, or did not answer at all, is left out
 * entirely: the caller then shows the raw command, which is always honest.
 */
export function parseDescriptions(text, commands) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(\d{1,2})[.)]\s*(.+?)\s*$/);
    if (!match) continue;
    const command = commands[Number(match[1]) - 1];
    const description = match[2].replace(/\s+/g, ' ').replace(/\.$/, '').slice(0, 120);
    if (!command || !description || /^unclear$/i.test(description)) continue;
    out.set(command, description);
  }
  return out;
}
