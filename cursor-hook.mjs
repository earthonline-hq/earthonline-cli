#!/usr/bin/env node
// Cursor command hook: https://cursor.com/docs/hooks (version 1).
// No host process, background listener, model call, or guessed HTTP route.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PATHS, USER_AGENT, readJson, readKey, origin, anySignal, writeFileAtomic, pidAlive, journalLoad, journalSeen, journalNote, journalRetire, journalSave } from './common.mjs';
import { readEvents } from './live.mjs';
import { formatMessage, truncateUtf8 } from './format.mjs';
import { cursorEndpoint, cursorDirectory, cursorHooksPresent, reconcileCursorHooks, LOOP_LIMIT, HOOK_LIMIT_MS } from './cursor.mjs';

const MAX_INPUT = 256 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_TRANSCRIPT = 4 * 1024 * 1024;
const MAX_BATCH = 50;
const MAX_FOLLOWUP = 128 * 1024;
const MAX_ITEMS = 300; // live (unread) items only; terminal ones leave the journal
const hash = value => createHash('sha256').update(value).digest('hex');
const line = value => truncateUtf8(String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' '), 200);

// cursor-agent 2026.10.22 keeps a trailing `{"type":"turn_ended",...}` row only while the chat is idle: the next turn
// rewrites the file in place (same inode) without it, then appends its own rows (10-26 test box probe). A mark taken
// after that row would land inside the next turn's user row, so the mark sits before any trailing turn_ended rows and
// what follows it always starts on a whole row (an appending transcript just shows that row again; it is skipped).
const IDLE_TAIL = /(?:^|\n)((?:\{[^\n]*"type"\s*:\s*"turn_ended"[^\n]*\}[ \t]*(?:\r?\n|$))+)$/;

function transcriptMark(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, 4096), tail = Buffer.alloc(length);
    if (length) fs.readSync(fd, tail, 0, length, stat.size - length);
    // latin1 keeps one character per byte, so the match length is a byte count
    const idle = IDLE_TAIL.exec(tail.toString('latin1'));
    const whole = idle && (idle.index > 0 || length === stat.size || tail.toString('latin1').startsWith('\n'));
    return { file, size: stat.size - (whole ? idle[1].length : 0), ino: stat.ino };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Inspect only bytes appended AFTER our followup, never an old occurrence or a
// tool result. A completed hook alone is not evidence that the prompt arrived.
export function cursorTurnConfirmed(input, pending) {
  if (input.status !== 'completed' || !input.generation_id || input.generation_id === pending.generation) return false;
  const mark = pending.transcript;
  if (!mark || input.transcript_path !== mark.file) return false;
  let fd, raw;
  try {
    fd = fs.openSync(mark.file, 'r');
    const stat = fs.fstatSync(fd), length = stat.size - mark.size;
    if (!stat.isFile() || stat.ino !== mark.ino || length <= 0 || length > MAX_TRANSCRIPT) return false;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, mark.size); raw = buffer.toString('utf8');
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  // Cursor 2026.10.22 opens every user turn with `<timestamp>...</timestamp>\n` before the query (10-25 test box
  // transcripts); only that one leading line is set aside, the rest must still be the whole delivered prompt.
  const query = text => typeof text === 'string' ? text.replace(/^<timestamp>[^<\n]*<\/timestamp>\r?\n/, '') : text;
  let current = null, answered = false;
  for (const row of raw.split('\n')) {
    let entry; try { entry = JSON.parse(row); } catch { continue; }
    const role = entry.role ?? entry.type;
    if (role === 'user') {
      const content = entry.message?.content ?? entry.content;
      current = query(typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : null);
      answered = false;
    } else if (role === 'assistant' && current !== null) answered = true;
  }
  if (current !== null) return answered && (current === pending.text || current === `<user_query>\n${pending.text}\n</user_query>`);
  // Cursor also exposes a plain-text transcript. Require the entire last user
  // prompt, not a substring in a quote, assistant answer or tool output.
  const turns = raw.split(/(?:^|\n)user:\r?\n/);
  const last = query(turns.at(-1));
  return turns.length > 1 && last.startsWith(`<user_query>\n${pending.text}\n</user_query>\n`) &&
    /\nassistant:\r?\n/.test(last.slice(pending.text.length));
}

// Old journals kept every item forever, read ones as stubs: migrate on read, never throw.
function legacyState(parsed) {
  const items = {}, retired = [];
  if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
    for (const [id, item] of Object.entries(parsed.items)) {
      if (!item || typeof item !== 'object') continue;
      if (item.status === 'read' || (item.gated && item.status === 'offered')) retired.push(id);
      else items[id] = item;
    }
  }
  return { items, retired };
}

export function loadCursorState(file) {
  const state = journalLoad(file, { legacy: legacyState });
  if (!state.items || typeof state.items !== 'object' || Array.isArray(state.items)) state.items = {};
  state.active ??= false;
  return state;
}

// Terminal (read, or a one-shot fact notice already offered): leave the journal, keep only dedup memory.
function settle(state, id) { delete state.items[id]; journalRetire(state, id); }

function trimItems(state) {
  const ids = Object.keys(state.items);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ITEMS))) settle(state, id);
}

export function remember(state, payload) {
  if (!payload || typeof payload.event !== 'string' || !payload.event.startsWith('message.created:') ||
      typeof payload.thread_id !== 'string' || !Number.isSafeInteger(payload.seq) || payload.seq < 1 || payload.deleted) return;
  if (journalSeen(state, payload.event, payload.thread_id, payload.seq)) return;
  const gated = payload.needs_owner === true;
  // Only the server's authenticated C3b projection can supply trusted content.
  if (!gated && (typeof payload.text !== 'string' || typeof payload.provenance?.owner !== 'string')) return;
  const text = gated
    ? `[EOL] ${line(payload.from?.handle ?? payload.from)} in ${line(payload.conv ?? payload.thread_id)} (#${payload.seq}).`
    : formatMessage(payload);
  state.items[payload.event] = { event: payload.event, thread_id: payload.thread_id, seq: payload.seq, text, gated, status: 'queued' };
  journalNote(state, payload.event, payload.thread_id, payload.seq);
  trimItems(state);
}

export async function runCursorHook(input, { configFile = path.join(cursorDirectory(), 'hooks.json'), event = input?.hook_event_name } = {}) {
  if (!['sessionStart', 'stop', 'sessionEnd'].includes(event) || input?.hook_event_name !== event) return null;
  if (input.session_id && input.session_id !== input.conversation_id) return null;
  const key = readKey(); if (!key) return null;
  const base = origin(), endpoint = cursorEndpoint(input.conversation_id);
  const directory = path.dirname(path.resolve(configFile));
  const config = readJson(PATHS.config) ?? {}, install = config.cursor?.[directory];
  if (!install) return null;
  const deadline = AbortSignal.timeout(2000);
  const identity = { 'x-eol-agent': endpoint, 'x-eol-agent-name': 'Cursor', 'x-eol-agent-push': 'turn-end' };
  async function request(route, body, owner = false) {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', redirect: 'error', signal: anySignal([deadline, AbortSignal.timeout(650)]),
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT, 'content-type': 'application/json', ...(owner ? {} : identity) },
      body: JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Cursor request failed.'); }
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > MAX_RESPONSE) throw new Error('Oversized response.'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bodyOut = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!bodyOut?.ok) throw new Error('Cursor request rejected.');
    return bodyOut.result;
  }

  // Bind identity through the existing tool route. Its catch_up is gated but
  // deliberately not a read receipt; never substitute eol_inbox/eol_read here.
  await request('/api/tools/eol_whoami', {});
  const settings = await request('/api/tools/eol_update_profile', {}, true);
  const policy = settings?.endpoints?.find(item => item.endpointId === endpoint);
  if (!policy) return null; // Legacy/unknown capabilities fail closed for injection.
  if (!cursorHooksPresent(directory, install)) {
    reconcileCursorHooks(directory, config, 'off');
    for (const id of new Set([endpoint, ...(install.endpoints ?? [])])) {
      const prior = settings.endpoints.find(item => item.endpointId === id);
      if (prior?.delivery === 'fast') await request('/api/tools/eol_update_profile', { endpoint: id, delivery: 'off' }, true);
    }
    return null;
  }
  if (install.delivery !== 'fast' || install.removed) return null;
  // A key/account change cannot replay somebody else's local journal.
  const file = path.join(PATHS.live, 'cursor', hash(`${base}\0${key}\0${endpoint}`) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock'; let locked = false;
  try {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) return null;
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true;
    }
    const state = loadCursorState(file);
    const save = () => journalSave(file, state);
    const forcedOff = input.is_background_agent === true || ['print', 'headless'].includes(process.env.EOL_CURSOR_MODE) ||
      (event === 'sessionEnd' && !state.active);
    if (forcedOff) {
      if (policy.delivery !== 'off') await request('/api/tools/eol_update_profile', { endpoint, delivery: 'off' }, true);
      state.active = false; state.mode = 'off'; save(); return null;
    }
    if (event === 'sessionStart' || event === 'stop') state.active = true;
    if (event === 'sessionEnd') state.active = false;
    if (policy.delivery !== 'fast' || policy.deliveryEditable !== true) { save(); return null; }
    if (!(install.endpoints ?? []).includes(endpoint)) {
      // Refresh shared config rather than overwriting unrelated harness updates.
      const fresh = readJson(PATHS.config) ?? config;
      const entry = fresh.cursor?.[directory];
      if (entry) { entry.endpoints = [...new Set([...(entry.endpoints ?? []), endpoint])]; writeFileAtomic(PATHS.config, JSON.stringify(fresh, null, 2) + '\n'); }
    }
    if (event === 'sessionEnd') {
      state.active = false; save();
      if (['user_close', 'window_close', 'completed'].includes(input.reason)) await request('/api/agent/retire', {});
      // aborted/error: no retirement. The bounded stream has already hung up;
      // its server-side close releases the lease and keeps the resumable queue.
      return null;
    }
    if (event === 'stop') {
      if (input.status !== 'completed' || !Number.isSafeInteger(input.loop_count) || input.loop_count < 0 || !input.generation_id) return null;
      if (state.pending && cursorTurnConfirmed(input, state.pending)) {
        const items = state.pending.events.map(id => state.items[id]).filter(item => item && !item.gated && item.status !== 'read');
        if (items.length) {
          const result = await request('/api/msg/receipt', { trigger: 'injected-turn-finished', items: items.map(({ thread_id, seq }) => ({ thread_id, seq })) });
          for (const item of items) if (result?.results?.some(r => r.thread_id === item.thread_id && !r.error && r.cursor >= item.seq)) {
            settle(state, item.event);
          }
          if (items.some(item => state.items[item.event])) { save(); return null; }
        }
        delete state.pending; save();
      }
      const definition = readJson(configFile)?.hooks?.stop?.find(hook => hook.command === install.entries.stop.command);
      const limit = Object.hasOwn(definition ?? {}, 'loop_limit') ? definition.loop_limit : LOOP_LIMIT;
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0 || input.loop_count >= limit)) return null;
      if (state.lastGeneration === input.generation_id) return null;
    }

    // Reuse the authenticated SSE queue and its lease/close semantics. This is
    // a short poll, never a resident stream. Journal every accepted event before
    // returning; sessionStart queues locally and only stop offers a followup.
    const poll = new AbortController();
    const signal = anySignal([deadline, poll.signal]);
    const timer = setTimeout(() => poll.abort(), 450);
    let response;
    try {
      response = await fetch(`${base}/api/agent/stream`, { redirect: 'error', signal,
        headers: { authorization: `Bearer ${key}`, ...identity, 'x-eol-live': '1', accept: 'text/event-stream', 'user-agent': USER_AGENT } });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Cursor queue unavailable.');
      let bytes = 0;
      const bounded = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE) throw new Error('Oversized queue.');
        controller.enqueue(chunk);
      } }));
      for await (const message of readEvents(bounded, () => {}, signal)) {
        if (message.type === 'message') { remember(state, JSON.parse(message.data)); save(); }
        if (message.type === 'removed') throw new Error('Endpoint removed.');
        if (message.type === 'prefs') {
          const prefs = JSON.parse(message.data);
          if (prefs.endpoints && prefs.endpoints.find(item => item.endpointId === endpoint)?.delivery !== 'fast') return null;
        }
      }
    } catch (error) {
      // Ending our polling window is normal; connection failures are not.
      if (!poll.signal.aborted || !response?.ok || deadline.aborted) throw error;
    } finally { clearTimeout(timer); poll.abort(); }
    save();
    if (event !== 'stop' || deadline.aborted) return null;
    // Reauthorize journaled bodies through C3b, including owner trust revocation,
    // deletion and membership changes since an earlier hook. Missing rows are
    // withheld; a bounded catch-up is not evidence of continued authorization.
    const fresh = await request('/api/tools/eol_whoami', {});
    const authorized = new Map((fresh?.catch_up?.messages ?? []).map(item => [item.event, item]));
    // Recheck policy after fetching; an off transition must not emit even a fact.
    const latest = await request('/api/tools/eol_update_profile', {}, true);
    if (latest?.endpoints?.find(item => item.endpointId === endpoint)?.delivery !== 'fast') return null;
    // A stream write may have been accepted before a crashed hook journaled it.
    // Recover authorized CONTENT from the retained endpoint queue; never rebuild
    // a fact notice this way, since the server may already have claimed it.
    for (const current of authorized.values()) if (current.needs_owner !== true) remember(state, current);
    const selected = []; let bytes = 0;
    for (const item of Object.values(state.items)) {
      if (item.status === 'read' || (item.gated && item.status === 'offered')) continue;
      const current = authorized.get(item.event);
      if (!current || current.deleted) continue;
      if (!item.gated && current.needs_owner) {
        item.gated = true;
        item.text = `[EOL] ${line(current.from?.handle ?? current.from)} in ${line(current.conv ?? current.thread_id)} (#${current.seq}).`;
      }
      if (!item.gated && (typeof current.text !== 'string' || typeof current.provenance?.owner !== 'string')) continue;
      if (!item.gated) item.text = formatMessage(current);
      const cost = Buffer.byteLength(item.text) + 2;
      if (selected.length >= MAX_BATCH || bytes + cost > MAX_FOLLOWUP) break;
      selected.push(item); bytes += cost;
    }
    if (!selected.length) return null;
    const text = `[EOL delivery ${randomUUID()}]\n` + selected.map(item => item.text).join('\n\n');
    state.pending = { generation: input.generation_id, text, events: selected.map(item => item.event), transcript: transcriptMark(input.transcript_path) };
    state.lastGeneration = input.generation_id;
    // A fact notice is never blindly retried: it is offered once, then terminal (its text already lives in the followup).
    for (const item of selected) { if (item.gated) settle(state, item.event); else item.status = 'offered'; }
    save();
    return { followup_message: text };
  } finally { if (locked) fs.unlinkSync(lock); }
}

async function main() {
  const timer = setTimeout(() => process.exit(0), HOOK_LIMIT_MS);
  try {
    const options = {}, args = process.argv.slice(2);
    while (args.length) {
      const arg = args.shift();
      if (arg === '--config' && args.length) options.configFile = args.shift();
      else if (arg === '--event' && args.length) options.event = args.shift();
      else return;
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_INPUT) return; chunks.push(chunk); }
    const result = await runCursorHook(JSON.parse(Buffer.concat(chunks).toString('utf8')), options);
    if (result) await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve));
  } catch { /* Hooks must fail silently, including malformed input and network errors. */ }
  finally { clearTimeout(timer); process.exit(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => process.exit(0));
  main().catch(() => process.exit(0));
}
