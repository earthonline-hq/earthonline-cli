#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PATHS, HARNESSES, USER_AGENT, SESSION_ID_RE, readJson, readKey, origin, log, pidAlive, identityFile, pidFile, readIdentity, writeIdentity, agentHeaders, agentIdent, isMain } from './common.mjs';
import { formatMessage, formatGroupEvent, truncateUtf8 } from './format.mjs';
import { deliverHostEvent, recoverHostDelivery, stopHook, codexNotify } from './receipt.mjs';

const SELF = fileURLToPath(import.meta.url);
// (Task 15b) reconnect waits: "Full Jitter", a random wait up to min(cap, base * 2 ** attempt) (AWS Architecture Blog,
// "Exponential Backoff And Jitter", 2015-03-04), capped at 30 s
const BACKOFF_BASE_MS = 1000, BACKOFF_CAP_MS = 30000;
export const fullJitter = (attempt, random = Math.random) => random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30));
// (Task 15b) a stream's lease kept by beats: at most every BEAT_MS (the server's `lease` event may ask for less), each given
// BEAT_TIMEOUT_MS; BEAT_FAILURES in a row, or a lease the server says ended, end the stream so the loop opens a new one
const BEAT_MS = 5000, BEAT_TIMEOUT_MS = 4000, BEAT_FAILURES = 2;
// SIGUSR2 asks the running beats for a beat now. Its handler is installed once and kept, so that the signal between two
// streams (no beats running) is ignored rather than ending the process (Node's default for SIGUSR2)
const nudges = new Set();
let nudgeHandler = false;
function onNudge(fn) {
  if (process.platform === 'win32') return () => {};
  if (!nudgeHandler) { nudgeHandler = true; process.on('SIGUSR2', () => { for (const nudge of nudges) nudge(); }); }
  nudges.add(fn);
  return () => nudges.delete(fn);
}
const closedError = () => Object.assign(new Error('Sink closed'), { code: 'CLOSED' });
const fatal = code => Object.assign(new Error(code), { code });

/** Owner-key settings API: the schema distinguishes a legacy account without
 * guessing from an error or silently enabling delivery after a network failure. */
export async function deliverySettings() {
  const key = readKey();
  if (!key) throw fatal('NO_KEY');
  const response = await fetch(`${origin()}/api/tools`, { redirect: 'error',
    headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || !body.ok || !Array.isArray(body.result?.tools)) throw fatal('SETTINGS_UNAVAILABLE');
  const profile = body.result.tools.find(t => t.name === 'eol_update_profile');
  if (!profile?.inputSchema?.properties?.delivery) return null;
  return ownerSettings({});
}

export async function ownerSettings(args) {
  const response = await fetch(`${origin()}/api/tools/eol_update_profile`, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${readKey()}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || !body.ok || !Array.isArray(body.result?.endpoints)) throw fatal('SETTINGS_UNAVAILABLE');
  return body.result;
}

export async function endpointDelivery(harness, identity, { register = false } = {}) {
  // The installer discovers this account's schema. Existing installations keep
  // their legacy runtime until upgraded; no extra requests on their hot path.
  if ((readJson(PATHS.config) ?? {}).delivery === undefined) return { core: false, delivery: 'fast' };
  let settings = await deliverySettings();
  if (!settings) return { core: false, delivery: 'fast' };
  const endpoint = agentIdent(harness, identity.session_id);
  if (register && !settings.endpoints.some(e => e.endpointId === endpoint)) {
    const response = await fetch(`${origin()}/api/tools/eol_whoami`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${readKey()}`, ...agentHeaders(harness, identity), 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: '{}', signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw fatal('SETTINGS_UNAVAILABLE');
    settings = await ownerSettings({});
  }
  if (harness === 'claude-code') settings = await syncClaudeDelivery(settings, endpoint);
  return { core: true, endpoint, delivery: settings.endpoints.find(e => e.endpointId === endpoint)?.delivery ?? 'off' };
}

/** Claude's settings are shared across sessions; each listener still checks its
 * own endpoint. A locally removed hook is never recreated automatically.
 * (0.2.1, Bonan 10-29 "对，默认改成fast") With no Claude Code session known yet the hooks are installed (fast), so the first
 * session binds itself; the server starts a new session's endpoint fast. Sessions the owner set off keep the hooks off. */
export async function syncClaudeDelivery(settings, endpoint = null) {
  const cli = await import('./cli.mjs');
  const config = readJson(PATHS.config) ?? {};
  config.claudeEndpoints = [...new Set([...(config.claudeEndpoints ?? []), ...(endpoint ? [endpoint] : [])])]
    .filter(id => settings.endpoints.some(e => e.endpointId === id));
  const fast = settings.endpoints.filter(e => config.claudeEndpoints.includes(e.endpointId) && e.delivery === 'fast');
  config.delivery = fast.length || !config.claudeEndpoints.length ? 'fast' : 'off';
  cli.installHooks(cli.settings(), config);
  if (config.claudeHooksRemoved) {
    for (const end of fast) settings = await ownerSettings({ endpoint: end.endpointId, delivery: 'off' });
  }
  return settings;
}

/** One serial queue for either harness. No message ever passes through a shell. */
export function makeSink(harness, opts = {}) {
  const env = opts.env ?? process.env;
  const lifetime = new AbortController();
  let tail = Promise.resolve(), socket = null, child = null;
  function close() {
    lifetime.abort();
    socket?.destroy(closedError());
    child?.kill();
  }
  async function sendClaude(text) {
    if (!env.CLAUDE_CODE_MESSAGING_SOCKET || !env.CLAUDE_CODE_MESSAGING_TOKEN) throw fatal('NO_INBOX');
    await new Promise((resolve, reject) => {
      const current = net.connect(env.CLAUDE_CODE_MESSAGING_SOCKET);
      socket = current;
      let failure;
      const timeout = setTimeout(() => current.destroy(fatal('INBOX_TIMEOUT')), 10000);
      current.on('error', err => { failure = err; });
      current.once('close', () => {
        clearTimeout(timeout);
        if (socket === current) socket = null;
        if (failure) reject(failure); else resolve();
      });
      current.once('connect', () => {
        current.end(`${JSON.stringify({ type: 'auth', token: env.CLAUDE_CODE_MESSAGING_TOKEN })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      });
    });
  }
  async function sendCodex(text, retry = opts.retry) {
    const codexJs = opts.codexJs ?? env.EOL_CODEX_JS;
    const command = opts.codexCommand ?? (codexJs && path.isAbsolute(codexJs) ? { file: process.execPath, prefix: [codexJs] } : null);
    if (!command || !path.isAbsolute(command.file) || !opts.threadId) throw fatal('NO_CODEX_TARGET');
    const until = Date.now() + 10 * 60_000;
    while (!lifetime.signal.aborted) {
      const threadId = opts.threadId;
      const result = await new Promise(resolve => {
        const current = execFile(command.file, [...command.prefix, 'queue', ...(opts.remote ? ['--remote', opts.remote, '--remote-auth-token-env', 'EOL_CODEX_TOKEN'] : []), '--thread', threadId, '--message', text],
          // without --remote, `codex queue` opens CODEX_HOME's own app-server first: give it longer
          { env, windowsHide: true, timeout: Math.min(opts.remote ? 10000 : 30000, Math.max(1, until - Date.now())), maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
            if (child === current) child = null;
            resolve({ err, output: `${stdout}\n${stderr}` });
          });
        child = current;
      });
      if (lifetime.signal.aborted) throw closedError();
      if (!result.err) return;
      if (retry === false) throw fatal('QUEUE_FAILED');
      // Only inspect the queue command's diagnostic; never copy it into the log.
      if (/thread[^\n]*(?:not found|does not exist|doesn't exist|nonexistent)|(?:no such|unknown) thread/i.test(result.output)) throw fatal('THREAD_GONE');
      if (Date.now() >= until) throw fatal('QUEUE_EXPIRED');
      await sleep(Math.min(3000, until - Date.now()), undefined, { signal: lifetime.signal });
    }
    throw closedError();
  }
  return {
    deliver(value, delivery = {}) {
      const text = truncateUtf8(value);
      const task = tail.then(() => {
        if (lifetime.signal.aborted) throw closedError();
        return harness === 'claude-code' ? sendClaude(text) : harness === 'codex' ? sendCodex(text, delivery.retry ?? opts.retry) : Promise.reject(fatal('UNKNOWN_HARNESS'));
      });
      // A broken inbox must stop the queue before the next pending delivery starts.
      tail = task.catch(() => { close(); });
      return task;
    },
    close,
  };
}

function exec(command, args, timeout = 650) {
  return new Promise(resolve => execFile(command, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)));
}

async function claudePid() {
  const explicit = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  if (process.platform === 'win32') {
    const output = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress']);
    let rows; try { rows = JSON.parse(output); } catch { return null; }
    const table = new Map((Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(p => [p.ProcessId, p]));
    let pid = process.ppid;
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      seen.add(pid); const row = table.get(pid); if (!row) break;
      if (/^claude(?:\.exe)?$/i.test(row.Name)) return pid;
      pid = row.ParentProcessId;
    }
    return null;
  }
  const output = await exec('ps', ['-axo', 'pid=,ppid=,comm=']);
  const table = new Map(String(output ?? '').split('\n').map(row => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)).filter(Boolean).map(m => [Number(m[1]), { parent: Number(m[2]), name: path.basename(m[3]) }]));
  let pid = process.ppid;
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    seen.add(pid); const row = table.get(pid); if (!row) break;
    if (row.name === 'claude') return pid;
    pid = row.parent;
  }
  return null;
}

function removeOwnPid(file, pid = process.pid) {
  if (readJson(file)?.pid === pid) { try { fs.unlinkSync(file); } catch {} }
}

/** An empty, just-created lock is a hook still publishing its child pid. Never steal it. */
function claim(file) {
  fs.mkdirSync(PATHS.live, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return fs.openSync(file, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const record = readJson(file);
      if (pidAlive(record?.pid)) return null;
      let reaper;
      const reaperFile = `${file}.reap`;
      try {
        // Serialize stale-lock recovery: two hooks must not unlink each other's new lock.
        reaper = fs.openSync(reaperFile, 'wx', 0o600);
        const now = readJson(file);
        if (pidAlive(now?.pid)) return null;
        if (!now && Date.now() - fs.statSync(file).mtimeMs < 2000) return null;
        fs.unlinkSync(file);
      } catch { return null; }
      finally {
        if (reaper !== undefined) { fs.closeSync(reaper); try { fs.unlinkSync(reaperFile); } catch {} }
      }
    }
  }
  return null;
}

/** The marker SessionEnd leaves for the listener of that process: it stops within a second (no process is ever killed by pid). */
const endFile = (harness, parentPid) => pidFile(harness, parentPid).replace(/.pid$/, '.end');

/** SessionEnd is the only explicit retire signal here. A lost process or stream remains resumable/offline. */
async function retireSession(harness, identity) {
  try {
    const key = readKey();
    if (!key || !identity?.session_id) return;
    const response = await fetch(`${origin()}/api/agent/retire`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, ...agentHeaders(harness, identity), 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(600), redirect: 'error',
    });
    response.body?.cancel().catch(() => {});
    // An account with msg-core off has no retirement route; its existing local shutdown is unchanged.
    if (!response.ok && response.status !== 404) log('retire_failed');
  } catch { log('retire_failed'); }
}

/** Starts the listener of this session's process unless one runs already (the post-tool hook, and mcp.mjs as a second way in). */
export function ensureListener(harness, parentPid, thread) {
  // Called after tools as well as hooks: off has no resident worker to poll for
  // a later owner change. The next tool call reconciles it without injection.
  // -> a promise that settles once the listener is started or not: a hook must await it before it exits
  const identity = readIdentity(harness, parentPid);
  if (!identity) return Promise.resolve();
  return endpointDelivery(harness, identity).then(policy => {
    if (policy.delivery === 'fast') startListener(harness, parentPid, thread);
  }).catch(() => log('delivery_settings_failed'));
}

/**
 * (0.2.0, design 1026 §2 step 6, probe P1) Binds a listener to the Claude Code session this command runs in, before any
 * restart: `npx earthonline login --code` run from the session's Bash tool inherits the session's messaging socket, token,
 * CLAUDE_PID and CLAUDE_CODE_SESSION_ID (P1, seen 2026-10-26 in a Bash tool on Windows; a detached child there outlives
 * the command), so the listener a hook would start is started now, from EOL_HOME/app (never the npx cache), and the first
 * message to the owner arrives as a turn of this very session. 抄自 0.1.0's own PostToolUse path (ensureListener above);
 * the push itself is Claude Code cross-session messaging (v2.1.224+, Windows v2.1.234+; viewed 2026-10-26).
 * -> { bound: true, pid } or { bound: false, reason }: 'not_in_claude_code', 'no_messaging_socket' (a session without
 * cross-session messaging: too old a Claude Code), 'no_session_id', 'delivery_off' (the owner's choice for new sessions),
 * 'delivery_settings_failed', 'listener_not_started'.
 */
export async function bindSession(env = process.env) {
  const inside = Boolean(env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE === '1');
  if (!env.CLAUDE_CODE_MESSAGING_SOCKET || !env.CLAUDE_CODE_MESSAGING_TOKEN) return { bound: false, reason: inside ? 'no_messaging_socket' : 'not_in_claude_code' };
  const parentPid = Number(env.CLAUDE_PID), session = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !pidAlive(parentPid) || !SESSION_ID_RE.test(session)) return { bound: false, reason: 'no_session_id' };
  const identity = writeIdentity('claude-code', parentPid, { session_id: session, cwd: process.cwd(), used_eol: true });
  let policy;
  try { policy = await endpointDelivery('claude-code', identity, { register: true }); } catch { log('delivery_settings_failed'); return { bound: false, reason: 'delivery_settings_failed' }; }
  if (policy.delivery !== 'fast') return { bound: false, reason: 'delivery_off' };
  const installed = path.join(PATHS.app, 'live.mjs');
  startListener('claude-code', parentPid, null, { script: fs.existsSync(installed) ? installed : SELF, env });
  const record = readJson(pidFile('claude-code', parentPid));
  return pidAlive(record?.pid) ? { bound: true, pid: record.pid } : { bound: false, reason: 'listener_not_started' };
}

function startListener(harness, parentPid, thread, { script = SELF, env = process.env } = {}) {
  if (harness === 'claude-code' && !env.CLAUDE_CODE_MESSAGING_SOCKET) { log('no_inbox'); return; }
  const file = pidFile(harness, parentPid);
  const fd = claim(file);
  if (fd === null) return;
  let cp;
  try {
    cp = spawn(process.execPath, [script, 'run', '--harness', harness, '--pid', String(parentPid), ...(thread ? ['--thread', thread] : [])], { detached: true, stdio: 'ignore', windowsHide: true, env });
    if (!cp.pid) { fs.closeSync(fd); fs.unlinkSync(file); cp.on('error', () => log('spawn_failed')); return; }
    fs.writeFileSync(fd, JSON.stringify({ pid: cp.pid, harness, parent_pid: parentPid, started_at: new Date().toISOString() }));
    fs.closeSync(fd);
    cp.on('error', () => { removeOwnPid(file, cp.pid); log('spawn_failed'); });
    cp.unref();
  } catch {
    try { fs.closeSync(fd); } catch {}
    if (cp?.pid) { try { cp.kill(); } catch {} }
    try { fs.unlinkSync(file); } catch {}
    log('spawn_failed');
  }
}

async function hook(kind, opts) {
  // A broken hook must never delay or add text to the harness's context.
  const deadline = setTimeout(() => process.exit(0), 900);
  try {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return; }
    const input = JSON.parse(raw);
    const harness = opts.harness ?? 'claude-code';
    if (!HARNESSES[harness]) return;
    // Codex discovery is deliberately deferred; an explicit process/thread pair is supported for the next lane.
    const parentPid = harness === 'claude-code' ? await claudePid() : Number(opts.pid);
    if (!Number.isInteger(parentPid) || parentPid <= 0) { log(harness === 'claude-code' ? 'no_claude_pid' : 'no_codex_pid'); return; }
    // A stale, already-started hook must not retire an endpoint switched off.
    if (kind === 'session-end') {
      const identity = readIdentity(harness, parentPid);
      if (identity && (await endpointDelivery(harness, identity)).delivery !== 'fast') return;
    }
    if (kind === 'session-end') {
      if (input.reason === 'clear') return;
      // (10-17, codex-spike: a hook's process tree may be killed or waited on) no killing from a hook: the listener reads the marker
      fs.mkdirSync(PATHS.live, { recursive: true, mode: 0o700 });
      fs.writeFileSync(endFile(harness, parentPid), new Date().toISOString(), { mode: 0o600 });
      const file = pidFile(harness, parentPid), record = readJson(file);
      if (record && !pidAlive(record.pid)) removeOwnPid(file, record.pid);
      await retireSession(harness, readIdentity(harness, parentPid));
      return;
    }
    // a session starting or using EOL in this process again: an earlier SessionEnd's marker no longer applies
    try { fs.unlinkSync(endFile(harness, parentPid)); } catch {}
    if (kind !== 'session-start' && kind !== 'post-tool') return;
    if (kind === 'post-tool' && !/^mcp__(eol|earthonline|earthonline-local)__/.test(String(input.tool_name ?? ''))) return; // backstop; the installed matcher already filters
    const identity = writeIdentity(harness, parentPid, {
      session_id: opts.thread ?? input.session_id, cwd: input.cwd,
      ...(kind === 'session-start' ? { source: input.source, title: input.session_title } : { used_eol: true }),
    });
    // awaited: the finally below exits the process, which would drop a decision still pending (the hook's deadline bounds it)
    if (identity?.used_eol) await ensureListener(harness, parentPid, opts.thread);
  } catch { log('hook_failed'); }
  finally { clearTimeout(deadline); process.exit(0); }
}

/** (msg-core G02) Claude Code's Stop hook: the finished turn's receipt (receipt.mjs). A network call, so its own deadline,
    still well inside the hook's; it prints nothing (a Stop hook's output could steer the session). */
async function receiptHook() {
  const deadline = setTimeout(() => process.exit(0), 5000);
  try {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return; }
    await stopHook(JSON.parse(raw));
  } catch { log('hook_failed'); }
  finally { clearTimeout(deadline); process.exit(0); }
}

/**
 * (Task 15b) Beats for one stream's lease (its SSE `lease` event: { generation, beat_ms }): POST /api/agent/beat every beat_ms
 * (at most BEAT_MS), on its own connection, so that a lost network ends the lease on the server within its 20 s. `onAlive` on
 * each beat taken (the stream is alive: its watchdog), `onLost(reason)` once when the lease ended ('lease_lost': the server
 * said so; 'unreachable': BEAT_FAILURES beats in a row failed), after which it beats no more. `beatNow()` beats at once (SIGUSR2
 * asks for it too, where there are POSIX signals: a test's or an operator's nudge). -> { beatNow, stop }
 */
export function startBeats({ base, key, headers, generation, beatMs = BEAT_MS, onAlive = () => {}, onLost = () => {} }) {
  let stopped = false, failures = 0, inFlight = null;
  const lost = reason => { if (stopped) return; stop(); onLost(reason); };
  const beat = () => {
    if (stopped) return Promise.resolve('stopped');
    return inFlight ??= (async () => {
      try {
        const response = await fetch(`${base}/api/agent/beat`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(BEAT_TIMEOUT_MS),
          headers: { authorization: `Bearer ${key}`, ...headers, 'content-type': 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify({ generation }) });
        response.body?.cancel().catch(() => {});
        if (response.ok) { failures = 0; if (!stopped) onAlive(); return 'ok'; }
        // the lease ended (409), the key or the switch is gone (401, 403, 404): the stream is opened again, which says why
        if ([401, 403, 404, 409].includes(response.status)) { lost('lease_lost'); return 'lost'; }
        throw new Error(`HTTP ${response.status}`);
      } catch {
        if (!stopped && ++failures >= BEAT_FAILURES) lost('unreachable');
        return 'failed';
      } finally { inFlight = null; }
    })();
  };
  const every = Math.min(BEAT_MS, Math.max(1000, Number(beatMs) || BEAT_MS));
  const timer = setInterval(() => { void beat(); }, every);
  timer.unref?.();
  const unNudge = onNudge(() => { void beat(); });
  function stop() { stopped = true; clearInterval(timer); unNudge(); }
  return { beatNow: beat, stop };
}

/** SSE parsing also observes comment pings and split CRLF/UTF-8 chunks. */
export async function* readEvents(body, activity, signal) {
  const reader = body.getReader(), decoder = new TextDecoder();
  // (e2e 10-17, Node 20's fetch) aborting the request took up to 4.5 s to end a pending read: cancelling the reader ends it at
  // once (a pending read then resolves done); one listener, removed when the stream ends
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  let buffer = '', type = '', data = [], id = null;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) return;
      activity(); buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const at = buffer.search(/\r\n|\r|\n/);
        if (at < 0 || (buffer[at] === '\r' && at === buffer.length - 1)) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1));
        if (!line) {
          // (msg-core D05) `id` only when the event had one: the core's stream gives each message `m:<thread>:<seq>`
          if (data.length) yield { type: type || 'message', data: data.join('\n'), ...(id ? { id } : {}) };
          type = ''; data = []; id = null;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') type = value;
          if (field === 'data') data.push(value);
          if (field === 'id' && !value.includes('\0')) id = value;
        }
      }
    }
  } finally { signal?.removeEventListener('abort', onAbort); reader.cancel().catch(() => {}); }
}

function retryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function run(opts) {
  const harness = opts.harness ?? 'claude-code', parentPid = Number(opts.pid);
  if (!HARNESSES[harness] || !Number.isInteger(parentPid) || parentPid <= 0) { log('invalid_target'); return; }
  const file = pidFile(harness, parentPid);
  // Detached startup may race the hook writing the lock's contents.
  for (let i = 0; fs.existsSync(file) && !readJson(file) && i < 20; i++) await sleep(25);
  const existing = readJson(file);
  if (existing?.pid !== process.pid) {
    const fd = claim(file);
    if (fd === null) { log('already_running'); return; }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, harness, parent_pid: parentPid, started_at: new Date().toISOString() }));
    fs.closeSync(fd);
  }
  let sink, current, watcher, hookWatcher, hookSettingsFile, parentTimer, stopped = false, generation = 0;
  const stop = reason => {
    if (stopped) return;
    stopped = true; log('exit', { reason }); current?.abort(); sink?.close();
    // (e2e 10-17: an aborted stream sometimes held the process for seconds) the listener process itself never lingers
    if (opts.exitOnStop) setTimeout(() => { removeOwnPid(file); process.exit(0); }, 1000).unref();
  };
  const terminate = () => stop('signal');
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
  try {
    let base;
    try { base = origin(); } catch { stop('invalid_origin'); return; }
    const key = readKey(); if (!key) { stop('no_key'); return; }
    let identity = readIdentity(harness, parentPid); if (!identity) { stop('no_identity'); return; }
    const initialPolicy = await endpointDelivery(harness, identity);
    if (initialPolicy.delivery !== 'fast') { stop('delivery_off'); return; }
    if (initialPolicy.core && harness === 'claude-code') {
      const cli = await import('./cli.mjs');
      hookSettingsFile = cli.settingsFile;
      hookWatcher = () => {
        void endpointDelivery(harness, identity).then(policy => {
          if (policy.delivery !== 'fast') stop('delivery_off');
        }).catch(() => stop('delivery_settings_failed'));
      };
      fs.watchFile(hookSettingsFile, { interval: 1000 }, hookWatcher);
    }
    if (!pidAlive(parentPid)) { stop('parent_gone'); return; }
    // The queue follows the process across /clear. Keep messages already accepted into it.
    sink = makeSink(harness, { get threadId() { return identity.session_id; } });
    const seen = new Set(), previousSent = new Set();
    const deliver = (text, event = {}, sseId = null) => {
      const began = Date.now(), sessionId = identity.session_id;
      const attempt = sseId
        ? deliverHostEvent(harness, sessionId, { event: event.event ?? sseId, data: event, text }, sink, { base })
        : sink.deliver(text);
      return attempt.then(result => {
        if (sseId && !result.injected) { log('host_delivery_suppressed', { thread_id: event.thread_id, seq: event.seq }); return; }
        log('pushed', { thread_id: event.thread_id, seq: event.seq, bytes: Buffer.byteLength(text), ms: Date.now() - began });
      }).catch(err => {
        if (stopped) return;
        const known = ['ENOENT', 'EPIPE', 'ECONNREFUSED', 'EPERM', 'EACCES', 'NO_INBOX', 'INBOX_TIMEOUT', 'NO_CODEX_TARGET', 'THREAD_GONE', 'QUEUE_EXPIRED'];
        stop(known.includes(err?.code) ? err.code : 'delivery_failed');
      });
    };
    watcher = () => {
      const next = readIdentity(harness, parentPid);
      if (!next || next.session_id === identity.session_id) return;
      identity = next; generation++;
      current?.abort();
      log('identity_changed');
    };
    fs.watchFile(identityFile(harness, parentPid), { interval: 1000 }, watcher);
    // the session's process gone, or its SessionEnd hook left the marker: stop (checked every second; cheap)
    parentTimer = setInterval(() => {
      if (!pidAlive(parentPid)) stop('parent_gone');
      else if (fs.existsSync(endFile(harness, parentPid))) {
        try { fs.unlinkSync(endFile(harness, parentPid)); } catch {}
        stop('session_end');
        void retireSession(harness, identity);
      }
    }, 1000);
    let attempt = 0;
    while (!stopped) {
      const ctl = new AbortController(); current = ctl;
      const version = generation;
      let lastActivity = Date.now(), connectedAt = null, wait = null, beats = null;
      const watchdog = setInterval(() => { if (Date.now() - lastActivity >= 70000) ctl.abort(); }, 1000);
      try {
        const policy = await endpointDelivery(harness, identity);
        if (policy.delivery !== 'fast') { stop('delivery_off'); break; }
        if (policy.core) await recoverHostDelivery(harness, identity.session_id, { base });
        const pair = identity.previous_session_id ? `${identity.previous_session_id}:${identity.session_id}` : null;
        const previous = pair && !previousSent.has(pair) ? { 'x-eol-agent-previous': agentIdent(harness, identity.previous_session_id) } : {};
        const response = await fetch(`${base}/api/agent/stream`, {
          // (Task 15b) X-EOL-Beat: this listener keeps its lease by its own beats once the stream says so (`lease`)
          headers: { authorization: `Bearer ${key}`, ...agentHeaders(harness, identity), ...previous, 'x-eol-beat': '1', accept: 'text/event-stream', 'user-agent': USER_AGENT },
          signal: ctl.signal, redirect: 'error',
        });
        lastActivity = Date.now();
        if (response.status === 401 || response.status === 403) {
          response.body?.cancel().catch(() => {});
          await deliver(`[EarthOnline] Access refused (HTTP ${response.status}). Your owner needs to check this connection's key and permissions before messages can arrive here.`);
          if (version === generation) stop('unauthorized');
          continue;
        }
        if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
          if (response.status === 429) wait = retryAfter(response.headers.get('retry-after'));
          response.body?.cancel().catch(() => {});
          log('disconnected', { status: response.status });
        } else {
          connectedAt = Date.now();
          if (pair) previousSent.add(pair);
          log('connected');
          for await (const event of readEvents(response.body, () => { lastActivity = Date.now(); }, ctl.signal)) {
            if (stopped || version !== generation) break;
            if (event.type === 'lease') {
              let lease; try { lease = JSON.parse(event.data); } catch { continue; }
              if (!Number.isSafeInteger(lease?.generation)) continue;
              beats?.stop();
              attempt = 0; // a lease granted: the next reconnect starts its backoff afresh
              beats = startBeats({ base, key, headers: agentHeaders(harness, identity), generation: lease.generation, beatMs: lease.beat_ms,
                onAlive: () => { lastActivity = Date.now(); },
                onLost: reason => { log('beat_lost', { reason }); ctl.abort(); } });
              log('leased', { generation: lease.generation });
              continue;
            }
            if (event.type === 'prefs') {
              let prefs; try { prefs = JSON.parse(event.data); } catch { continue; }
              if (Array.isArray(prefs?.endpoints)) {
                prefs = await syncClaudeDelivery(prefs, agentIdent(harness, identity.session_id));
                if (prefs.endpoints.find(e => e.endpointId === agentIdent(harness, identity.session_id))?.delivery !== 'fast') {
                  stop('delivery_off'); break;
                }
              }
              continue;
            }
            if (!['message', 'group', 'steer', 'removed'].includes(event.type)) continue;
            if (event.type === 'removed') {
              await deliver('[EarthOnline] Your owner removed this session from EarthOnline.');
              if (version === generation) stop('removed');
              break;
            }
            let data; try { data = JSON.parse(event.data); } catch { continue; }
            if (!data || typeof data !== 'object') continue;
            let id, text;
            if (event.type === 'message') {
              if (!data.from || typeof data.text !== 'string') continue;
              id = data.seq != null ? `message:${data.thread_id ?? (data.from.handle ?? data.from)}:${data.seq}` : null;
              text = event.id && data.needs_owner ? truncateUtf8(data.fact ?? data.text) : formatMessage(data, { origin: base, self: readJson(PATHS.config)?.handle });
            } else if (event.type === 'group') {
              // one id per event instance (the server's event_id): the same person can join, leave and join again
              id = data.event_id ? `group:${data.event_id}` : `group:${data.kind}:${data.group?.id}:${data.note_id ?? data.member?.handle ?? ''}`;
              text = formatGroupEvent(data, { origin: base });
            } else {
              if (typeof data.text !== 'string') continue;
              id = data.steer_id ? `steer:${data.steer_id}` : null;
              text = truncateUtf8(`[EarthOnline] Another of your owner's agents wants this said in a conversation you are handling: ${data.text.replace(/[\r\n]/g, ' ').slice(0, 2000)}\n(Call eol_read to take it as a steer; it is only handed over then.)`);
            }
            const durable = event.type === 'message' && event.id;
            if (!text || (!durable && id && seen.has(id))) continue;
            if (!durable && id) { seen.add(id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
            if (durable) await deliver(text, data, event.id);
            else void deliver(text, data);
          }
          log('disconnected');
        }
      } catch { if (!stopped) log('disconnected'); }
      finally { clearInterval(watchdog); beats?.stop(); }
      if (stopped) break;
      if (generation !== version) { attempt = 0; continue; }
      if (connectedAt && Date.now() - connectedAt >= 30000) attempt = 0;
      wait ??= fullJitter(attempt++);
      log('reconnect_wait', { ms: Math.round(wait) });
      // A fresh controller lets identity changes interrupt even a heartbeat-triggered backoff.
      current = new AbortController();
      await sleep(wait, undefined, { signal: current.signal }).catch(() => {});
    }
  } finally {
    stop('finished'); clearInterval(parentTimer);
    if (watcher) fs.unwatchFile(identityFile(harness, parentPid), watcher);
    if (hookWatcher) fs.unwatchFile(hookSettingsFile, hookWatcher);
    process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
    removeOwnPid(file);
  }
}

export { retireSession };

function status() {
  let files; try { files = fs.readdirSync(PATHS.live); } catch { files = []; }
  const rows = files.filter(name => /^run-(?:cc|codex)-\d+\.pid$/.test(name)).map(name => {
    const record = readJson(path.join(PATHS.live, name));
    const harness = name.startsWith('run-cc-') ? 'claude-code' : 'codex';
    const parentPid = Number(/-(\d+)\.pid$/.exec(name)[1]);
    const identity = readIdentity(harness, parentPid);
    return { file: name, pid: Number.isInteger(record?.pid) ? record.pid : null, alive: pidAlive(record?.pid), ident: identity ? agentIdent(harness, identity.session_id) : null };
  });
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
  if (command === 'hook' && args[0] === 'stop') await receiptHook();
  else if (command === 'hook') await hook(args[0], opts);
  // (msg-core G02) Codex's notify program (codex.mjs sets it for the launched session): the JSON is the last argument
  else if (command === 'codex-notify') { await codexNotify(args.at(-1)).catch(() => log('notify_failed')); process.exit(0); }
  else if (command === 'run') { await run({ ...opts, exitOnStop: true }).catch(() => log('run_failed')); process.exit(0); }
  else if (command === 'status') status();
}
