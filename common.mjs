// earthonline (the connector, eol_chat/connect): what mcp.mjs (the tool proxy), live.mjs (the listener) and cli.mjs (the installer) share.
// Design: eol_research/agent-live-1017/DESIGN.md §2 "本机文件". Zero dependencies (Node >= 18), ESM.
//
// One folder per person, EOL_HOME (default ~/.earthonline):
//   key           the EarthOnline key, the only place it is stored (0600; on Windows an ACL of this user only). Never
//                 printed, never logged. EOL_KEY in the environment is used instead when set (CI).
//   config.json   { origin } when it is not https://lobby.earthonlines.com (another deployment, local development)
//   pending-login.json  the sign-in between `login --email` and `login --code` (pending.mjs): never the code, never a key
//   app/          mcp.mjs, live.mjs, format.mjs, common.mjs: a fixed path, never the npx cache
//   live/         one identity file per running session and one pid file per listener
//   live.log      one JSON line per event: ids, counts and milliseconds only, never a message text or a token
//
// A session's identity file (live/<harness>-<pid>.json) is written by the SessionStart / PostToolUse hooks and read by
// mcp.mjs and live.mjs alike, so a session's tool calls and its push stream are the same EarthOnline agent.
//   harness  'claude-code' | 'codex'
//   pid      Claude Code's own pid (CLAUDE_PID in a hook; process.ppid in its stdio MCP server); for Codex see live.mjs
//   { session_id, previous_session_id?, source?, title?, cwd?, used_eol?, written_at }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node 18 prints "ExperimentalWarning: The Fetch API is an experimental feature" on stderr the first time fetch is used,
// which would break `--json`'s one object on stderr and add noise to every hook. Only that warning is dropped; every
// other warning still prints. No precedent, ours: Node's --disable-warning (20.11, 21.3) does not exist on Node 18, and
// removing the 'warning' listener would hide all of them.
if (Number(process.versions.node.split('.')[0]) < 21) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning' && /\bFetch API\b/.test(String(warning?.message ?? warning))) return;
    return emitWarning.call(this, warning, ...rest);
  };
}

export const VERSION = '0.2.3'; // test/run.mjs checks it against package.json
/**
 * The files every harness runs from EOL_HOME/app (a fixed path, never the npx cache). cli.mjs is among them because
 * live.mjs and cursor.mjs import it, and cli.mjs imports detect.mjs and codex-config.mjs.
 */
export const APP_FILES = Object.freeze(['cli.mjs', 'contract.mjs', 'pending.mjs', 'device.mjs', 'rotate.mjs', 'call.mjs', 'embed.mjs', 'watch.mjs', 'setup.mjs', 'skills.mjs', 'mcp.mjs', 'live.mjs', 'format.mjs', 'common.mjs', 'detect.mjs', 'codex.mjs', 'codex-live.mjs', 'codex-config.mjs', 'receipt.mjs', 'cursor.mjs', 'cursor-hook.mjs']);

/**
 * Whether the module at `url` is the program node was started with. Real paths on both sides: npm's bin on macOS and Linux
 * is a symlink, so process.argv[1] is the link while import.meta.url is the file it points to.
 */
export function isMain(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(real(argv1), real(fileURLToPath(url)));
}
export const DEFAULT_ORIGIN = 'https://lobby.earthonlines.com';
export const EOL_HOME = path.resolve(process.env.EOL_HOME || path.join(os.homedir(), '.earthonline'));
export const PATHS = Object.freeze({
  home: EOL_HOME,
  key: path.join(EOL_HOME, 'key'),
  config: path.join(EOL_HOME, 'config.json'),
  app: path.join(EOL_HOME, 'app'),
  live: path.join(EOL_HOME, 'live'),
  log: path.join(EOL_HOME, 'live.log'),
  pending: path.join(EOL_HOME, 'pending-login.json'),
  pendingDevice: path.join(EOL_HOME, 'pending-device.json'),
  rotate: path.join(EOL_HOME, 'rotate.json'),
});

export const HARNESSES = Object.freeze({ 'claude-code': { short: 'cc', label: 'Claude Code' }, codex: { short: 'codex', label: 'Codex' } });
export const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes a file whole or not at all (a reader never sees half of it), private to this user. */
export function writeFileAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text, { mode }); // Windows refuses the rename while the file is open elsewhere
    fs.rmSync(tmp, { force: true });
  }
}

/** Delivery claims must survive a crash. Never fall back to an in-place write. */
export function writeFileDurableAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

/** Short synchronous journal transaction. Busy/unreadable locks fail closed.
 * A separate exclusive reaper serializes recovery after a process crash. */
export function withFileLock(file, work) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const reaper = `${lock}.reap`;
      const reap = fs.openSync(reaper, 'wx', 0o600);
      try {
        const prior = readJson(lock);
        if (!Number.isInteger(prior?.pid) || pidAlive(prior.pid)) throw new Error('DELIVERY_JOURNAL_BUSY');
        fs.unlinkSync(lock);
        fd = fs.openSync(lock, 'wx', 0o600);
      } finally { fs.closeSync(reap); fs.unlinkSync(reaper); }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return work();
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

// Bounded durable delivery journal. A journal object is { v: 2, marks, recent, ...caller fields }.
//   marks   thread -> highest seq ever accepted (events arrive per thread in seq order, so a seq at or below it is a replay)
//   recent  the last JOURNAL_RECENT event ids, for events that carry no thread/seq and for threads evicted from marks
// Dedup memory is therefore O(threads + JOURNAL_RECENT), never O(events). Callers keep only live (non-terminal) items in
// their own fields and drop each one when it reaches a terminal state; the file stays small forever and never fills up.
export const JOURNAL_RECENT = 200;
export const JOURNAL_THREADS = 256;

/** Normalizes anything read from disk into a journal object; an unknown or old shape never throws. */
export function journalNormalize(raw) {
  const journal = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const marks = {};
  if (journal.marks && typeof journal.marks === 'object' && !Array.isArray(journal.marks)) {
    for (const [thread, seq] of Object.entries(journal.marks)) if (Number.isSafeInteger(seq) && seq > 0) marks[thread] = seq;
  }
  const recent = Array.isArray(journal.recent) ? journal.recent.filter(id => typeof id === 'string' && id).slice(-JOURNAL_RECENT) : [];
  return { ...journal, v: 2, marks, recent };
}

/** Loads <file>. Missing file: a fresh journal. `legacy(parsed)` migrates an old shape (returns fields to merge, it may
 * pass retired ids in `retired`). Unreadable/corrupt content: a fresh journal, or a throw when `strict`. */
export function journalLoad(file, { strict = false, legacy = () => ({}), maxBytes = 4 * 1024 * 1024 } = {}) {
  let parsed;
  try {
    if (fs.statSync(file).size > maxBytes) throw new Error('INVALID_DELIVERY_JOURNAL');
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return journalNormalize(null);
    if (strict) throw err.message === 'INVALID_DELIVERY_JOURNAL' ? err : new Error('INVALID_DELIVERY_JOURNAL');
    return journalNormalize(null);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.v === 2) return journalNormalize(parsed);
  const { retired = [], ...fields } = legacy(parsed) ?? {};
  const journal = journalNormalize({ ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}), ...fields });
  for (const id of retired) journalRemember(journal, id);
  return journal;
}

/** True when this event was already accepted: at or below its thread's watermark, or among the recent ids. */
export function journalSeen(journal, id, thread, seq) {
  if (journal.recent.includes(id)) return true;
  return typeof thread === 'string' && Number.isSafeInteger(seq) && seq <= (journal.marks[thread] ?? 0);
}

function journalRemember(journal, id) {
  if (typeof id !== 'string' || !id) return;
  const at = journal.recent.indexOf(id);
  if (at !== -1) journal.recent.splice(at, 1);
  journal.recent.push(id);
  if (journal.recent.length > JOURNAL_RECENT) journal.recent.splice(0, journal.recent.length - JOURNAL_RECENT);
}

/** Records an accepted event: advances the thread watermark and the recent-id set (both bounded). */
export function journalNote(journal, id, thread, seq) {
  journalRemember(journal, id);
  if (typeof thread === 'string' && Number.isSafeInteger(seq)) {
    const prior = journal.marks[thread] ?? 0;
    delete journal.marks[thread]; // re-insert last: the key order is least-recently-updated first
    journal.marks[thread] = Math.max(prior, seq);
    const threads = Object.keys(journal.marks);
    for (const old of threads.slice(0, Math.max(0, threads.length - JOURNAL_THREADS))) delete journal.marks[old];
  }
}

/** A terminal item leaves the journal; its dedup memory stays in marks/recent. */
export function journalRetire(journal, id) { journalRemember(journal, id); }

export function journalSave(file, journal) { writeFileDurableAtomic(file, JSON.stringify(journal)); }

export const KEY_RE = /^eolc_[0-9A-Za-z]{40}$/;

/**
 * The key, or null: EOL_KEY when it is set (CI, a container), else the key file. Never from the command line, where the
 * process list shows it. An EOL_KEY that is set but not a key is no key: it is not silently replaced by the file's.
 * Copied from InsForge (INSFORGE_ACCESS_TOKEN over ~/.insforge/credentials.json), gh (GH_TOKEN, cli.github.com/manual/gh_help_environment)
 * and Neon (NEON_API_KEY): design 1026 §4.3.
 */
export function readKey() {
  if (keySource() === 'env') { const key = process.env.EOL_KEY.trim(); return KEY_RE.test(key) ? key : null; }
  try {
    const key = fs.readFileSync(PATHS.key, 'utf8').trim();
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** Where readKey looks: 'env' (EOL_KEY is set), 'file' (the key file exists) or null. */
export function keySource() {
  if (String(process.env.EOL_KEY ?? '').trim()) return 'env';
  return fs.existsSync(PATHS.key) ? 'file' : null;
}

let ownSid;
/** This user's SID on Windows (whoami /user), for an ACL that names nobody else; null when it cannot be read. */
function windowsSid() {
  if (ownSid !== undefined) return ownSid;
  try {
    const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    ownSid = /"(S-1-[0-9-]+)"/.exec(out)?.[1] ?? null;
  } catch { ownSid = null; }
  return ownSid;
}

/**
 * Writes a secret (the key, the pending sign-in) whole or not at all, readable by this user only: mode 0600 in a 0700
 * folder, and on Windows, where a mode changes nothing, an ACL with no inherited entries and one grant to this user
 * (icacls /inheritance:r /grant:r *<SID>:F; design 1026 §4.3, the rule OpenSSH for Windows holds private keys to; InsForge
 * leaves the inherited SYSTEM and Administrators entries, as seen on this machine 2026-10-26). Returns warnings, each
 * { step, error, fix }, when the ACL could not be set: the file is written either way.
 */
export function writeSecret(file, text) {
  writeFileAtomic(file, text, 0o600);
  return secureFile(file);
}

/** Makes an existing secret file this user's only (as writeSecret does after writing). -> warnings, as writeSecret's. */
export function secureFile(file) {
  fs.chmodSync(file, 0o600);
  if (process.platform !== 'win32') return [];
  const sid = windowsSid();
  const fix = `icacls "${file}" /inheritance:r /grant:r "%USERNAME%":F`;
  if (!sid) return [{ step: 'credential_acl', error: 'Could not read this Windows user\'s id, so the file keeps the folder\'s permissions.', fix }];
  try {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return [];
  } catch {
    return [{ step: 'credential_acl', error: 'Could not limit the file to this Windows user; it keeps the folder\'s permissions.', fix }];
  }
}

/** AbortSignal.any (Node 20.3 and 18.17), or the same made by hand on an earlier Node 18. */
export function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Refuses an origin a key must not be sent to: https only, plain http only for this machine (local development). */
export function checkOrigin(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error(`Not an address: ${String(value).slice(0, 80)}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`Refused ${u.origin}: the key is only sent over https (plain http only to this machine).`);
  if (u.username || u.password) throw new Error('Refused an address with a user name or password in it.');
  return u.origin;
}

/** EarthOnline's origin: EOL_ORIGIN, else config.json's `origin`, else the Lobby. Always checked. */
export function origin() {
  const fromEnv = String(process.env.EOL_ORIGIN ?? '').trim();
  // Test guard: EOL_REQUIRE_ORIGIN=1 (set by every test harness) means no fallback to config.json or the production Lobby.
  if (process.env.EOL_REQUIRE_ORIGIN === '1') {
    if (!fromEnv) throw new Error('EOL_REQUIRE_ORIGIN: EOL_ORIGIN is unset; refusing to fall back to the production Lobby');
    const u = checkOrigin(fromEnv);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname)) throw new Error('EOL_REQUIRE_ORIGIN: EOL_ORIGIN must be loopback, got ' + u);
    return u;
  }
  const fromFile = readJson(PATHS.config)?.origin;
  return checkOrigin(fromEnv || (typeof fromFile === 'string' && fromFile) || DEFAULT_ORIGIN);
}

/** One line of live.log. Only ids, counts and times: any field named like a text or a secret is dropped. */
const SECRET_FIELD = /text|body|content|message|token|key|auth|secret|password|history/i;
export function log(event, fields = {}) {
  const line = { t: new Date().toISOString(), pid: process.pid, event: String(event).slice(0, 60) };
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (SECRET_FIELD.test(k)) continue;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') line[k] = v;
    else line[k] = String(v).replace(/eolc_[0-9A-Za-z]+/g, 'eolc_[key]').slice(0, 200);
  }
  try {
    fs.mkdirSync(EOL_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(PATHS.log, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // a log that cannot be written is not worth stopping for
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// ---- a session's identity ---------------------------------------------------------------------------------------------

const shortOf = (harness) => HARNESSES[harness]?.short ?? (() => { throw new Error(`unknown harness ${harness}`); })();
export const identityFile = (harness, pid) => path.join(PATHS.live, `${shortOf(harness)}-${pid}.json`);
export const pidFile = (harness, pid) => path.join(PATHS.live, `run-${shortOf(harness)}-${pid}.pid`);
// a session that used EarthOnline, by its id: a resume in a new process (a new pid) starts its listener again at once
const usedFile = (harness, sessionId) => path.join(PATHS.live, `used-${shortOf(harness)}-${sessionId}`);

/** { session_id, previous_session_id?, source?, title?, cwd?, used_eol?, written_at } or null. */
export function readIdentity(harness, pid) {
  const data = readJson(identityFile(harness, pid));
  return data && SESSION_ID_RE.test(String(data.session_id ?? '')) ? data : null;
}

/**
 * Records the session a hook was told about. A new session_id in the same process (/clear, /resume inside it) keeps the
 * one before as previous_session_id, so the listener can ask the server to move that session's conversations over.
 * `used_eol` stays true once set (a PostToolUse on an eol tool sets it). -> the identity written.
 */
export function writeIdentity(harness, pid, { session_id, source = null, title = null, cwd = null, used_eol = false }) {
  if (!SESSION_ID_RE.test(String(session_id ?? ''))) return null;
  const before = readIdentity(harness, pid);
  const same = before?.session_id === session_id;
  const data = {
    session_id,
    ...(same ? (before.previous_session_id ? { previous_session_id: before.previous_session_id } : {}) : before ? { previous_session_id: before.session_id } : {}),
    source: typeof source === 'string' ? source : same ? before.source ?? null : null,
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : same ? before.title ?? null : null,
    cwd: typeof cwd === 'string' ? cwd : before?.cwd ?? null,
    used_eol: Boolean(used_eol || (same && before.used_eol) || (!same && before?.used_eol && source === 'clear') || fs.existsSync(usedFile(harness, session_id))),
    written_at: new Date().toISOString(),
  };
  writeFileAtomic(identityFile(harness, pid), JSON.stringify(data));
  if (data.used_eol && !fs.existsSync(usedFile(harness, session_id))) {
    try { fs.writeFileSync(usedFile(harness, session_id), data.written_at, { mode: 0o600 }); } catch { /* only a shortcut for the next resume */ }
  }
  return data;
}

/** The X-EOL-Agent value of a session: "claude-code:<session id>" or "codex:<thread id>". */
export const agentIdent = (harness, sessionId) => `${harness}:${sessionId}`;

/** What EarthOnline calls the session: "Claude Code · <title or project folder>". */
export function agentName(harness, identity) {
  const dir = String(identity?.cwd || process.cwd()).replace(/[\\/]+$/, '');
  const where = identity?.title || path.basename(dir) || dir || 'session';
  return `${HARNESSES[harness]?.label ?? harness} · ${where}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
}

/** Which Claude Code program runs this session, from what Claude Code puts in its hooks' and servers' environment. */
export function ccSurface(env = process.env) {
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT ?? '');
  if (/vscode/i.test(entry)) return 'vscode';
  if (/desktop|local-agent/i.test(entry)) return 'claude-desktop';
  if (/^sdk/i.test(entry)) return 'sdk';
  if (entry === 'cli') return /jetbrains/i.test(env.TERMINAL_EMULATOR ?? '') ? 'jetbrains' : 'cli';
  return 'unknown';
}

/**
 * The identity headers every request of this session carries (tool calls and the stream alike). x-eol-surface says
 * which program the session runs in (cli | vscode | jetbrains | claude-desktop | sdk | codex-cli | codex-desktop |
 * codex-ide | codex-launcher | unknown), for the session-level presence a group shows.
 */
export function agentHeaders(harness, identity) {
  if (!identity?.session_id) return {};
  const surface = identity.surface ?? (harness === 'claude-code' ? ccSurface() : null);
  return {
    'x-eol-agent': agentIdent(harness, identity.session_id),
    'x-eol-agent-name': encodeURIComponent(agentName(harness, identity)),
    'x-eol-live': '1',
    ...(surface ? { 'x-eol-surface': surface } : {}),
  };
}

export const USER_AGENT = `earthonline/${VERSION} (node ${process.version})`;
