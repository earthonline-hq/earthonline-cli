// (msg-core-1025 G02) Turn receipts: a pushed message counts as the agent's read only once the host shows a finished turn
// that carried it. The listener journals each delivery it made (one file per message, so the hook never races an append);
// Claude Code's Stop hook checks the transcript, Codex's notify program the turn's input messages, and either posts the
// confirmed ones to POST /api/msg/receipt (apps/api/server.mjs apiMsgReceipt). Only the msg-core stream gives messages
// an SSE id (server.mjs apiAgentStream), so without the switch nothing is journaled and nothing here runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, HARNESSES, SESSION_ID_RE, USER_AGENT, readJson, readKey, origin, log, agentIdent, writeFileDurableAtomic, withFileLock, journalLoad, journalSeen, journalNote, journalRetire } from './common.mjs';
import { truncateUtf8 } from './format.mjs';

const MAX_CLAIMS = 2000; // only claims whose outcome report is still owed; a reported claim leaves the file
const MAX_JOURNAL_BYTES = 1024 * 1024;

/** Per-origin/endpoint event ledger, independent of host PID. Bounded forever: a claim is kept only while its outcome
 * report is owed; once reported it is dropped and dedup falls to the per-thread delivered-seq watermark plus a small
 * set of recent ids (common.mjs journal helper), so an old event still never injects twice. Only IDs/status live here.
 * An old file (a bare array of rows) is migrated on read. */
export function hostJournal(harness, sessionId, { base = origin(), stateDir = PATHS.live } = {}) {
  if (!HARNESSES[harness] || !SESSION_ID_RE.test(String(sessionId ?? ''))) throw new Error('INVALID_HOST_IDENTITY');
  const scope = crypto.createHash('sha256').update(JSON.stringify([base, harness, sessionId])).digest('hex');
  const file = path.join(stateDir, `delivery-${scope}.json`);
  const validRow = r => typeof r?.event === 'string' && r.event && r.event.length <= 300 && r.status === 'unknown' && typeof r.reported === 'boolean';
  const legacy = parsed => {
    if (!Array.isArray(parsed) || parsed.length > MAX_CLAIMS || !parsed.every(validRow)) throw new Error('INVALID_DELIVERY_JOURNAL');
    return { rows: parsed.filter(r => !r.reported), retired: parsed.filter(r => r.reported).map(r => r.event) };
  };
  const transaction = work => withFileLock(file, () => {
    const journal = journalLoad(file, { strict: true, legacy, maxBytes: MAX_JOURNAL_BYTES });
    journal.rows ??= [];
    if (!Array.isArray(journal.rows) || journal.rows.length > MAX_CLAIMS || !journal.rows.every(validRow)) throw new Error('INVALID_DELIVERY_JOURNAL');
    const result = work(journal);
    if (result.write) {
      const value = JSON.stringify(journal);
      if (Buffer.byteLength(value) > MAX_JOURNAL_BYTES) throw new Error('DELIVERY_JOURNAL_FULL');
      writeFileDurableAtomic(file, value);
    }
    return result.value;
  });
  return {
    file,
    claim(event, { thread_id, seq } = {}) {
      if (typeof event !== 'string' || !event || event.length > 300) throw new Error('INVALID_DELIVERY_EVENT');
      return transaction(journal => {
        if (journal.rows.some(r => r.event === event) || journalSeen(journal, event, thread_id, seq)) return { value: false };
        // The oldest owed report is given up before liveness is: an unreachable server must not stop delivery forever.
        while (journal.rows.length >= MAX_CLAIMS) journalRetire(journal, journal.rows.shift().event);
        journalNote(journal, event, thread_id, seq);
        journal.rows.push({ event, status: 'unknown', reported: false });
        return { write: true, value: true };
      });
    },
    pending: () => transaction(journal => ({ value: journal.rows.map(r => r.event) })),
    reported(events) {
      transaction(journal => {
        const before = journal.rows.length;
        journal.rows = journal.rows.filter(r => !events.includes(r.event));
        return { write: journal.rows.length !== before };
      });
    },
  };
}

/** Unknown is delivery evidence, never a read receipt. Reporting may retry;
 * injecting may not. A replay after a crash only reports the existing claim. */
export async function reportHostUnknown(harness, sessionId, events, { base = origin() } = {}) {
  const key = readKey();
  if (!key || !events.length) return false;
  try {
    const response = await fetch(`${base}/api/msg/receipt`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${key}`, 'x-eol-agent': agentIdent(harness, sessionId), 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ trigger: 'host-outcome-unknown', events }),
    });
    const answer = await response.json();
    return response.ok && answer?.ok === true;
  } catch { log('host_outcome_report_failed'); return false; }
}

export async function recoverHostDelivery(harness, sessionId, options = {}) {
  const journal = hostJournal(harness, sessionId, options);
  const report = options.report ?? ((events) => reportHostUnknown(harness, sessionId, events, options));
  const events = journal.pending();
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50);
    if (!await report(batch)) break;
    journal.reported(batch);
  }
}

/** Claim and receipt evidence precede injection, including the crash window
 * between host acceptance and queue/socket completion. A fact notice is never
 * evidence that its gated content was read. */
export async function deliverHostEvent(harness, sessionId, { event, data, text }, sink, options = {}) {
  const journal = hostJournal(harness, sessionId, options);
  const report = options.report ?? ((events) => reportHostUnknown(harness, sessionId, events, options));
  try {
    if (!journal.claim(event, { thread_id: data.thread_id, seq: data.seq })) return { injected: false, status: 'unknown' };
    if (!data.needs_owner) recordPending(harness, sessionId, {
      thread_id: data.thread_id, seq: data.seq, text: truncateUtf8(text),
    }, { durable: true });
    await sink.deliver(text, { retry: false });
    return { injected: true, status: 'unknown' };
  } finally {
    // Even successful transport completion cannot prove host consumption.
    if (await report([event])) journal.reported([event]);
  }
}

const KEEP_MS = 24 * 3600_000; // a turn that never finished in a day is not coming back for these
const MAX_PENDING = 200;
const TRANSCRIPT_TAIL = 4 * 1024 * 1024;

export const pendingDir = (harness, sessionId) => path.join(PATHS.live, `pending-${HARNESSES[harness].short}-${sessionId}`);

/** Journals one delivered message: { thread_id, seq, text } (text exactly as the host was given it). */
export function recordPending(harness, sessionId, { thread_id, seq, text }, { durable = false } = {}) {
  if (!HARNESSES[harness] || !SESSION_ID_RE.test(String(sessionId ?? '')) || typeof thread_id !== 'string' || !Number.isSafeInteger(seq)) {
    if (durable) throw new Error('INVALID_PENDING_RECEIPT');
    return;
  }
  try {
    const dir = pendingDir(harness, sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = crypto.createHash('sha256').update(`${thread_id}:${seq}`).digest('hex').slice(0, 32);
    const file = path.join(dir, `${name}.json`), value = JSON.stringify({ thread_id, seq, text, at: Date.now() });
    if (durable) writeFileDurableAtomic(file, value);
    else fs.writeFileSync(file, value, { mode: 0o600 });
  } catch (err) { log('pending_write_failed'); if (durable) throw err; }
}

/** The journal of a session: [{ file, thread_id, seq, text }]; stale entries are dropped on the way. */
export function readPending(harness, sessionId) {
  if (!HARNESSES[harness] || !SESSION_ID_RE.test(String(sessionId ?? ''))) return [];
  const dir = pendingDir(harness, sessionId);
  let names; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name), entry = readJson(file);
    if (!entry || typeof entry.text !== 'string' || Date.now() - (entry.at ?? 0) > KEEP_MS) { try { fs.unlinkSync(file); } catch {} continue; }
    out.push({ file, ...entry });
  }
  return out.sort((a, b) => a.at - b.at).slice(-MAX_PENDING);
}

/** The text of a transcript user entry (a string, or its text blocks; tool results are not something the host was told). */
function userText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  return '';
}

/**
 * The pending entries a Claude Code transcript shows as handled: the text arrived as a user entry and an assistant entry
 * followed it (the Stop hook runs when the turn has ended, so that reply is the turn that took it). Reads the tail only.
 */
export function confirmedByTranscript(transcriptPath, pending) {
  if (!pending.length) return [];
  let raw;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - TRANSCRIPT_TAIL);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const users = [];
  let answeredUpTo = -1;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'user') users.push(userText(entry));
    else if (entry.type === 'assistant') answeredUpTo = users.length - 1;
  }
  const answered = users.slice(0, answeredUpTo + 1);
  // the injected text is the content as the connector sent it (live.mjs sendClaude); a host may wrap it, so a user entry
  // that contains it counts
  return pending.filter(p => p.text && answered.some(u => u.includes(p.text)));
}

/** The pending entries a Codex agent-turn-complete notification names as that turn's input messages (exactly). */
export function confirmedByCodexTurn(notification, pending) {
  const inputs = Array.isArray(notification?.['input-messages']) ? notification['input-messages'].filter(m => typeof m === 'string') : [];
  return pending.filter(p => inputs.includes(p.text));
}

/** Posts the confirmed entries as this agent's receipt and clears them from the journal. -> the server's answer, or null. */
export async function sendReceipt(harness, sessionId, confirmed, { timeoutMs = 4000 } = {}) {
  if (!confirmed.length) return null;
  const key = readKey(); if (!key) return null;
  let base; try { base = origin(); } catch { return null; }
  const items = confirmed.slice(0, 50).map(p => ({ thread_id: p.thread_id, seq: p.seq }));
  let response;
  try {
    // only the identity: no X-EOL-Agent-Name (the hook does not know the title; the record keeps its name) and no X-EOL-Live
    response = await fetch(`${base}/api/msg/receipt`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, 'x-eol-agent': agentIdent(harness, sessionId), 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ trigger: 'injected-turn-finished', items }),
    });
  } catch { log('receipt_failed'); return null; }
  // 404: the switch is off for this account; the entries can never count, so they go too
  if (response.status === 404) { await response.body?.cancel(); clear(confirmed); return null; }
  if (!response.ok) { await response.body?.cancel(); log('receipt_failed', { status: response.status }); return null; }
  const answer = await response.json().catch(() => null);
  clear(confirmed.slice(0, 50));
  log('receipt_sent', { items: items.length });
  return answer;
}

function clear(entries) { for (const p of entries) { try { fs.unlinkSync(p.file); } catch {} } }

/** Claude Code's Stop hook: { session_id, transcript_path } on stdin. */
export async function stopHook(input) {
  const sessionId = input?.session_id;
  if (typeof input?.transcript_path !== 'string') return null;
  const confirmed = confirmedByTranscript(input.transcript_path, readPending('claude-code', sessionId));
  return sendReceipt('claude-code', sessionId, confirmed);
}

/** Codex's notify program (set by the launcher, codex.mjs): the JSON argument of an agent-turn-complete. */
export async function codexNotify(arg) {
  let notification; try { notification = JSON.parse(arg); } catch { return null; }
  if (notification?.type !== 'agent-turn-complete') return null;
  const threadId = notification['thread-id'];
  const confirmed = confirmedByCodexTurn(notification, readPending('codex', threadId));
  return sendReceipt('codex', threadId, confirmed);
}

/**
 * Whether the user's Codex config (CODEX_HOME/config.toml, read, never written) sets its own notify: any `notify` key at
 * all counts, in a profile too, so a guess never replaces theirs.
 */
export function hasUserNotify(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || '', '.codex');
  let text; try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return false; }
  return /^\s*notify\s*=/m.test(text);
}
