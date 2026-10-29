// One stream per caller UUID. Owned by the MCP process; stdin EOF closes all streams.
// Two ways in: the launcher (`npx earthonline codex`: its own app-server, `codex queue --remote`), or our block in config.toml,
// loaded by plain `codex` and the Codex desktop app. In that desktop mode, `codex queue` without --remote puts the message
// in CODEX_HOME's thread queue, and the app-server that has the thread open runs it within about 8 s.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PATHS, origin, readKey, readJson, agentHeaders, USER_AGENT, log } from './common.mjs';
import { makeSink, readEvents, endpointDelivery, startBeats, fullJitter } from './live.mjs';
import { formatMessage, formatGroupEvent, unquote, oneLine, truncateUtf8, MAX_BYTES } from './format.mjs';
import { codexCommand } from './codex.mjs';
import { deliverHostEvent, recoverHostDelivery, hostJournal, reportHostUnknown } from './receipt.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// fast (the default since 0.2.1, Bonan 10-29: "对，默认改成fast"): queue it and open codex://threads/wake/<id> (about 3 s);
// off: nothing is queued, the agent reads at its next eol_ call. Only these two (Bonan: "为什么不是fast vs off，off就是正常人理解的安全"); a saved off is kept. The deleted quiet, and its first name queue, read as off without an
// error ("existing quiet users map to off", same entry): configs written by 0.1.x, and servers that still send quiet.
// fast's first name, front, is still fast. cli.mjs imports these, so the installer and the delivery read names alike.
export const WAKE_MODES = ['fast', 'off'];
const OLD_WAKES = { quiet: 'off', queue: 'off', front: 'fast' };
export const wakeName = v => (typeof v === 'string' && Object.hasOwn(OLD_WAKES, v) ? OLD_WAKES[v] : WAKE_MODES.includes(v) ? v : null);
const COALESCE_MS = Number(process.env.EOL_CODEX_COALESCE_MS ?? 1500);

export function callerIdentity(meta) {
  const direct = meta?.threadId, nested = meta?.['x-codex-turn-metadata'];
  let other;
  try { other = (typeof nested === 'string' ? JSON.parse(nested) : nested)?.thread_id; } catch { return null; }
  if (direct && other && direct !== other) return null;
  const id = direct ?? other;
  return typeof id === 'string' && UUID.test(id) ? { session_id: id, cwd: process.cwd() } : null;
}

/** How a desktop-mode thread is woken: the web's choice when the server sends one, else the installer's, else fast. */
let serverWake = null;
export function wakeMode() {
  return serverWake ?? wakeName(readJson(PATHS.config)?.codexWake) ?? 'fast';
}

/** Which program runs this MCP server, by its grandparent process: the Codex desktop app, an IDE extension, or the CLI. */
let surfaceOnce;
export function codexSurface() {
  return surfaceOnce ??= new Promise(resolve => {
    if (process.env.EOL_CODEX_SURFACE) return resolve(process.env.EOL_CODEX_SURFACE);
    const pid = Number(process.ppid);
    if (!Number.isInteger(pid) || pid <= 0) return resolve('unknown');
    const [file, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").Name }`]]
      : ['sh', ['-c', `ps -o comm= -p "$(ps -o ppid= -p ${pid} | tr -d ' ')"`]];
    execFile(file, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const name = err ? '' : String(stdout).trim();
      resolve(!name ? 'unknown' : /chatgpt|codex\.app|codex desktop/i.test(name) ? 'codex-desktop' : /^(code|cursor|windsurf)/i.test(name) ? 'codex-ide' : 'codex-cli');
    });
  });
}

/** codex://threads/wake/<id>: the desktop app checks that thread's queue at once and resumes it (it may come to the front). */
export function openWakeLink(threadId, run = execFile) {
  if (!UUID.test(threadId)) return;
  const url = `codex://threads/wake/${threadId}`;
  const [file, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  run(file, args, { windowsHide: true, timeout: 10000 }, () => {}); // explorer.exe exits 1 even when it worked
}

/**
 * The first line a person sees in the Codex thread (Bonan 10-29): "[EOL] @ada: <their first 100 characters>", in a group
 * "[EOL] "Hackathon" · @ada: …". The words as written: the server's quote is taken off (format.mjs unquote).
 */
export function summary(data, self = readJson(PATHS.config)?.handle) {
  const from = data.by === 'system' ? 'EarthOnline' : `@${oneLine(data.from?.handle ?? data.from ?? '', 80).replace(/^@/, '')}`;
  const where = data.group ? `"${oneLine(data.group.name)}" · ` : '';
  const chars = Array.from(unquote(data.text).replace(/\s+/g, ' ').trim());
  const text = chars.length > 100 ? `${chars.slice(0, 100).join('')}…` : chars.join('');
  return truncateUtf8(`[EOL] ${where}${from}: ${oneLine(text, 1000)}`, 700);
}
/** Select a complete prefix that fits one turn; the caller keeps the rest queued. */
export function combine(items) {
  if (!items.length) return { text: '', count: 0 };
  let text = items[0].text, count = 1;
  let summaries = items[0].summary, bodies = `\n${items[0].text}\n`;
  for (let i = 1; i < items.length; i++) {
    summaries += `\n${items[i].summary}`;
    bodies += `\n${items[i].text}\n`;
    const next = `[EOL] ${i + 1} new messages:\n${summaries}\n${bodies}`;
    // Full formatted bodies include their random boundaries, truncation notes and Reply lines.
    if (Buffer.byteLength(next) > MAX_BYTES) break;
    text = next; count = i + 1;
  }
  return { text, count };
}

export function createCodexLive({ warn = code => process.stderr.write(`[EarthOnline] ${code}; live delivery is unavailable or reconnecting.\n`), openLink = openWakeLink } = {}) {
  const sessions = new Map();
  let closed = false;
  async function ensure(identity) {
    if (closed || !identity) throw new Error('NO_CALLER_IDENTITY');
    const policy = await endpointDelivery('codex', identity, { register: true });
    if (policy.delivery !== 'fast') {
      const old = sessions.get(identity.session_id);
      if (old) { old.lifetime.abort(); old.sink.close(); await old.task; sessions.delete(identity.session_id); }
      return; // Pull tools still work; off is not a failed live connection.
    }
    const old = sessions.get(identity.session_id);
    if (old) { if (old.failed) throw new Error(old.failed); return old.ready; }
    const key = readKey(); if (!key) throw new Error('NOT_CONNECTED');
    const remote = process.env.EOL_CODEX_ENDPOINT_FILE ? fs.readFileSync(process.env.EOL_CODEX_ENDPOINT_FILE, 'utf8').trim() : process.env.EOL_CODEX_REMOTE;
    // The launcher's endpoint must be exact; without one this is desktop mode (config.toml).
    if (remote && (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(remote) || !process.env.EOL_CODEX_TOKEN)) throw new Error('USE_CODEX_LAUNCHER');
    const desktop = !remote;
    if (policy.core && !desktop) {
      if (!process.env.EOL_CODEX_ENDPOINT_FILE) throw new Error('USE_CODEX_LAUNCHER');
      // The supervisor owns this private directory and retires these sessions
      // only after observing its app-server's exit, never on MCP stdin EOF.
      fs.writeFileSync(path.join(path.dirname(process.env.EOL_CODEX_ENDPOINT_FILE), `thread-${identity.session_id}.json`),
        JSON.stringify({ session_id: identity.session_id }), { mode: 0o600 });
    }
    // Desktop mode has no supervisor that sees the app exit, so its endpoint is never retired explicitly: it goes
    // offline when its beats stop and stays resumable, as a lost process does (live.mjs retireSession).
    const lifetime = new AbortController();
    const sink = makeSink('codex', { codexCommand: codexCommand(), threadId: identity.session_id, remote: remote || undefined, retry: false });
    let yes, no;
    const state = { lifetime, sink, ready: new Promise((r, j) => { yes = r; no = j; }), failed: null };
    sessions.set(identity.session_id, state);
    const ident = { ...identity, surface: desktop ? await codexSurface() : 'codex-launcher' };
    const seen = new Set();
    const base = origin();
    const fatal = code => { if (state.failed) return; state.failed = code; no(new Error(code)); log('codex_delivery_failed', { thread_id: identity.session_id, reason: code }); warn(code); lifetime.abort(); sink.close(); };
    // Desktop mode: wait a moment, then queue everything that came in as one turn, and wake the app as chosen.
    let batch = [], timer = null, flushing = false;
    const sending = new Set(); // ids being queued right now: a replay arriving meanwhile is a duplicate too
    const flush = async () => {
      timer = null;
      if (flushing || lifetime.signal.aborted) return;
      flushing = true;
      try {
        while (batch.length && !lifetime.signal.aborted) {
          const { count } = combine(batch);
          const items = batch.splice(0, count);
          for (const item of items) if (item.id) sending.add(item.id);
          const mode = wakeMode();
          if (mode !== 'off') {
            // Durable (msg-core) events are claimed in the host journal before the queue and reported after it, as
            // receipt.mjs deliverHostEvent does one at a time, so a replay after a crash never injects twice. Desktop
            // mode installs no notify program (config.toml's notify stays the user's own), so no turn receipt is
            // journaled; reads count through eol_read / eol_inbox, as for a launcher user with their own notify.
            // With wake off nothing is queued or claimed: the agent reads at its next eol_ call.
            const durable = items.filter(i => i.event);
            let journal = null, kept = items;
            try {
              if (durable.length) {
                journal = hostJournal('codex', identity.session_id, { base });
                kept = items.filter(i => !i.event || journal.claim(i.event, { thread_id: i.thread_id, seq: i.seq }));
              }
              // a subset of a batch that fits fits too; the loop only makes sure nothing claimed is left behind
              for (let rest = kept; rest.length;) { const part = combine(rest); await sink.deliver(part.text, { retry: false }); rest = rest.slice(part.count); }
            } catch { fatal('QUEUE_FAILED'); return; }
            finally {
              const events = kept.filter(i => i.event).map(i => i.event);
              if (journal && events.length && await reportHostUnknown('codex', identity.session_id, events, { base })) journal.reported(events);
            }
            if (kept.length && mode === 'fast' && ident.surface === 'codex-desktop') openLink(identity.session_id); // the link would start the app for a CLI thread
          }
          for (const item of items) { if (item.id) { sending.delete(item.id); seen.add(item.id); if (seen.size > 2000) seen.delete(seen.values().next().value); } }
          log(mode === 'off' ? 'codex_wake_off' : 'codex_queued', { thread_id: items.at(-1).thread_id, seq: items.at(-1).seq, count: items.length, wake: mode });
        }
      } finally { flushing = false; }
    };
    state.task = (async () => {
      let attempt = 0, first = true;
      while (!lifetime.signal.aborted) {
        const ctl = new AbortController();
        const abort = () => ctl.abort(); lifetime.signal.addEventListener('abort', abort, { once: true });
        let idle, connectedAt = null, retryMs = null, beats = null;
        const touch = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 70000); };
        try {
          const currentPolicy = await endpointDelivery('codex', identity);
          if (currentPolicy.delivery !== 'fast') {
            yes(); lifetime.abort(); sink.close(); sessions.delete(identity.session_id); break;
          }
          if (currentPolicy.core) await recoverHostDelivery('codex', identity.session_id, { base });
          idle = setTimeout(() => ctl.abort(), 10000);
          // (Task 15b) X-EOL-Beat: the lease is kept by this session's own beats once the stream says so (`lease`)
          const response = await fetch(`${base}/api/agent/stream`, { headers: { authorization: `Bearer ${key}`, ...agentHeaders('codex', ident), 'x-eol-beat': '1', accept: 'text/event-stream', 'user-agent': USER_AGENT }, redirect: 'error', signal: ctl.signal });
          if (!response.ok) { await response.body?.cancel(); if ([401, 403].includes(response.status)) { fatal('ACCESS_REFUSED'); break; } if (response.status === 429) { const seconds = Number(response.headers.get('retry-after')); if (Number.isFinite(seconds)) retryMs = Math.min(60000, Math.max(1000, seconds * 1000)); } throw new Error('STREAM_UNAVAILABLE'); }
          first = false; yes(); connectedAt = Date.now(); touch(); log('codex_stream_connected', { thread_id: identity.session_id, surface: ident.surface });
          for await (const event of readEvents(response.body, touch, ctl.signal)) {
            if (lifetime.signal.aborted) break;
            if (event.type === 'lease') {
              let lease; try { lease = JSON.parse(event.data); } catch { continue; }
              if (!Number.isSafeInteger(lease?.generation)) continue;
              beats?.stop();
              attempt = 0; // a lease granted: the next reconnect starts its backoff afresh
              beats = startBeats({ base, key, headers: agentHeaders('codex', ident), generation: lease.generation, beatMs: lease.beat_ms,
                onAlive: touch, onLost: reason => { log('codex_beat_lost', { thread_id: identity.session_id, reason }); ctl.abort(); } });
              log('codex_leased', { thread_id: identity.session_id, generation: lease.generation });
              continue;
            }
            if (event.type === 'prefs') {
              let prefs; try { prefs = JSON.parse(event.data); } catch { continue; }
              const wake = wakeName(prefs?.codex_wake); if (wake) serverWake = wake; // the web's wake choice (desktop mode)
              if (Array.isArray(prefs?.endpoints) && prefs.endpoints.find(e => e.endpointId === `codex:${identity.session_id}`)?.delivery !== 'fast') {
                lifetime.abort(); sink.close(); sessions.delete(identity.session_id); break;
              }
              continue;
            }
            if (event.type === 'removed') { fatal('SESSION_REMOVED'); break; }
            if (!['message', 'group'].includes(event.type)) continue;
            let data; try { data = JSON.parse(event.data); } catch { continue; }
            let id, text;
            if (event.type === 'message') {
              if (!data.from || typeof data.text !== 'string') continue;
              id = data.seq != null && data.thread_id ? `message:${data.thread_id}:${data.seq}` : null;
              // A durable event that needs the owner carries only its fact: the gated text is never shown, in a summary neither.
              const fact = Boolean(event.id && data.needs_owner);
              text = fact ? truncateUtf8(data.fact ?? data.text) : formatMessage(data, { origin: base, self: readJson(PATHS.config)?.handle });
              // (10-29) a single message is its two lines alone; summary lines head only a batch (combine)
            } else { id = data.event_id ? `group:${data.event_id}` : null; text = formatGroupEvent(data, { origin: base }); }
            const durable = event.type === 'message' && event.id;
            // the host journal, not this process's memory, is what dedupes a durable event
            if (!text || (id && (sending.has(id) || batch.some(i => i.id === id))) || (!durable && id && seen.has(id))) continue;
            if (desktop) {
              const line = event.type === 'message' && !(event.id && data.needs_owner) ? summary(data) : truncateUtf8(text.split('\n')[0], 300);
              batch.push({ id, text, summary: line, thread_id: data.thread_id, seq: data.seq, ...(durable ? { event: data.event ?? event.id } : {}) });
              if (!flushing) timer ??= setTimeout(() => { void flush(); }, COALESCE_MS);
              continue;
            }
            // Launcher: await acceptance before dedupe. Ambiguous failure closes the session, never retries blindly.
            try {
              if (durable) {
                const outcome = await deliverHostEvent('codex', identity.session_id,
                  { event: data.event ?? event.id, data, text }, sink, { base });
                if (!outcome.injected) { log('host_delivery_suppressed', { thread_id: data.thread_id, seq: data.seq }); continue; }
              } else await sink.deliver(text);
            } catch { fatal('QUEUE_FAILED'); break; }
            if (!durable && id) { seen.add(id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
            log('codex_queued', { thread_id: data.thread_id, seq: data.seq });
          }
        } catch { if (first && !lifetime.signal.aborted) { fatal('STREAM_START_FAILED'); break; } }
        finally { clearTimeout(idle); beats?.stop(); lifetime.signal.removeEventListener('abort', abort); ctl.abort(); }
        if (lifetime.signal.aborted) break;
        log('codex_stream_disconnected', { thread_id: identity.session_id }); warn('STREAM_DISCONNECTED');
        if (connectedAt && Date.now() - connectedAt > 30000) attempt = 0;
        await sleep(retryMs ?? fullJitter(attempt++), undefined, { signal: lifetime.signal }).catch(() => {});
      }
    })().catch(() => { fatal('STREAM_FAILED'); });
    lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
    return state.ready;
  }
  async function close() { closed = true; for (const s of sessions.values()) { s.lifetime.abort(); s.sink.close(); } await Promise.allSettled([...sessions.values()].map(s => s.task)); }
  return { ensure, close };
}
