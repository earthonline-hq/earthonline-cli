// `watch [@handle] [--for <s>]` (research/cli-onboarding-design-1026.md §2 "Where to watch", §10, §12, A4): a live text tail of
// the owner's conversations, for a person in a second terminal (magic moment 2: watching their agent talk). Agents wait with
// eol_wait instead; watch hands nothing over and reads nothing as read, so it never takes a message from an agent.
//
// Copied from the inbox page's own client (apps/web useInboxLive.ts, public/app.js 2046-2108): one live line to the owner's inbox,
// GET /api/inbox/live (src/hub.js watchInbox), whose events say only "something may have changed"; after each, one ask at a time
// (and one more after it for whatever came meanwhile), here eol_list_conversations, which hands nothing over and marks nothing read.
// A conversation whose newest message moved is printed. The line reconnects 2 s, 4 s ... at most a minute apart, and while it is
// down the inbox is asked every 20 s (INBOX_POLL_MS), as the page does. A server whose line does not take a key yet (before car11)
// is asked every 20 s throughout.
// Not /api/rt (core/realtime/line.js): its inbox topic carries only the conversations the new realtime path wrote, and an agent's
// eol_message is not one of them yet (rt-legacy.js: "an agent's send (its old path is eol_message)"); checked on the box 10-26.
// Copied from `resend webhooks listen` / `clerk webhooks listen` (resend.com/docs, clerk.com/docs/cli, viewed 2026-10-26), a tail
// that runs until stopped; different on purpose: without a terminal it stops by itself after --for (60 s by default, at most
// 540), so an agent's shell is never held past its limit (design §12).
import { origin, readKey, USER_AGENT } from './common.mjs';
import { EXIT, CliError, callTool } from './contract.mjs';

export const DEFAULT_FOR_S = 60;
export const MAX_FOR_S = 540;
const POLL_MS = Number(process.env.EOL_WATCH_POLL_MS) > 0 ? Number(process.env.EOL_WATCH_POLL_MS) : 20_000; // useInboxLive INBOX_POLL_MS (app.js:3634); tests shorten it
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000]; // useInboxLive: 2 s, 4 s ... at most a minute
const DEAD_MS = 60_000; // the line pings every 25 s (pages.js liveStream); two missed, it is opened again
const LIST_LIMIT = 50; // eol_list_conversations' most

const clock = date => date.toTimeString().slice(0, 8);
// eol_list_conversations gives an agent the other side's words inside a quote ("Quoted from the other side (their words ...):" and
// "> " lines, the server's prompt-injection fence); a person reads them as written.
const asWritten = text => { const m = /^Quoted from the other side[^\n]*\n([\s\S]*)$/.exec(text); return m ? m[1].replace(/^> ?/gm, '') : text; };
const pause = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** watch [@handle] [--for <s>] -> exit code */
export async function watchCommand(args, out) {
  let want = null, forS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--for') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_FOR_S) throw new CliError('invalid_input', `--for is a whole number of seconds from 1 to ${MAX_FOR_S}.`, { exit: EXIT.input, field: 'for' });
      forS = n;
    } else if (!want && /^@[A-Za-z0-9_.-]{1,64}$/.test(arg)) want = arg.slice(1).toLowerCase();
    else throw new CliError('usage', 'Usage: earthonline watch [@handle] [--for <seconds>]   (one conversation by its @handle, or all of them)', { exit: EXIT.input });
  }
  const key = readKey();
  if (!key) throw new CliError('missing_input', 'watch shows your conversations, so sign in first.', { exit: EXIT.input, next: ["npx earthonline login --email <your owner's email>"] });
  const tty = Boolean(process.stdout.isTTY) && !out.json;
  const seconds = forS ?? (tty ? Infinity : DEFAULT_FOR_S);
  const base = origin();

  // The starting point: what is there now is not news. A revoked key or an unreachable server ends here (exit 3 / 4).
  const me = await callTool(base, 'eol_whoami', {}, key);
  const seen = new Map(); // conversation -> its newest message as last shown
  const sameMessage = (a, b) => Boolean(a && b && a.at === b.at && a.text === b.text && a.from === b.from);
  const list = async () => {
    const r = await callTool(base, 'eol_list_conversations', { limit: LIST_LIMIT, ...(want ? { name: want } : {}) }, key);
    return (Array.isArray(r?.conversations) ? r.conversations : []).filter(c => !want || String(c.conversation ?? '').toLowerCase() === `@${want}`);
  };
  for (const c of await list()) if (c.last) seen.set(c.conversation, c.last);
  out.say(`Watching ${want ? `your conversation with @${want}` : `@${String(me?.robot?.handle ?? '').replace(/^@/, '')}'s conversations`}${Number.isFinite(seconds) ? ` for ${seconds} s` : ''}. Ctrl-C stops.`);

  const stop = new AbortController();
  const timer = Number.isFinite(seconds) ? setTimeout(() => stop.abort(), seconds * 1000) : null;
  let ended = 'time';
  const onInt = () => { ended = 'interrupted'; stop.abort(); };
  process.once('SIGINT', onInt);

  const events = [];
  // One ask at a time, and one more after it for whatever came meanwhile (app.js askNow 3606-3623).
  let asking = null, again = false, failure = null;
  const askOnce = async () => {
    const fresh = [];
    for (const c of await list()) {
      if (!c.last || typeof c.last.text !== 'string' || sameMessage(seen.get(c.conversation), c.last)) continue;
      seen.set(c.conversation, c.last);
      fresh.push(c);
    }
    fresh.sort((a, b) => String(a.last.at).localeCompare(String(b.last.at)));
    for (const c of fresh) {
      const mine = c.last.from === 'you';
      const name = c.name ?? c.conversation, text = asWritten(c.last.text);
      const at = new Date(Date.parse(c.last.at) || Date.now());
      events.push({ conversation: c.conversation, name, text, mine, by: c.last.by ?? null, at: at.toISOString() });
      if (!out.json) process.stdout.write(`${clock(at)}  ${mine ? `you → ${name}` : name}: ${text}\n`);
    }
  };
  const ask = () => {
    if (asking) { again = true; return asking; }
    asking = (async () => {
      try { do { again = false; if (!stop.signal.aborted) await askOnce(); } while (again); }
      catch (err) { if (err instanceof CliError && err.exit === EXIT.auth) { failure = err; stop.abort(); } } // a network blip: the next nudge or poll asks again
      finally { asking = null; }
    })();
    return asking;
  };

  let lineUp = false, lineTakesKeys = true, attempt = 0;
  const poller = (async () => { // while the line is down (or this server's line takes no key): every 20 s
    while (!stop.signal.aborted) {
      await pause(POLL_MS, stop.signal);
      if (!stop.signal.aborted && !lineUp) await ask();
    }
  })();

  try {
    while (!stop.signal.aborted && lineTakesKeys) {
      const line = new AbortController();
      let reader = null;
      // The reader is cancelled too: on the box (Node 22, 10-26) an aborted fetch did not always end a body already being read,
      // and watch then outlived --for. A cancelled reader's pending read() resolves done at once (WHATWG Streams, ReadableStreamDefaultReader.cancel).
      const abortLine = () => { line.abort(); reader?.cancel().catch(() => {}); };
      stop.signal.addEventListener('abort', abortLine, { once: true });
      let dead = setTimeout(abortLine, DEAD_MS);
      try {
        let response = null;
        try {
          response = await fetch(`${base}/api/inbox/live`, {
            signal: line.signal, redirect: 'error',
            headers: { accept: 'text/event-stream', authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
          });
        } catch { /* unreachable for now: opened again below, and the poll asks meanwhile */ }
        if (response && [401, 403, 404].includes(response.status)) {
          // the key was good a moment ago (eol_whoami): this server's line takes no key yet, so the inbox is asked every 20 s
          lineTakesKeys = false;
          response.body?.cancel().catch(() => {});
          out.say(`EarthOnline at ${base} has no live line for this program yet: checking every ${Math.round(POLL_MS / 1000)} s.`);
          break;
        }
        if (response?.ok && response.body) {
          lineUp = true; attempt = 0;
          ask(); // whatever came while it was down
          const decoder = new TextDecoder();
          let buffer = '';
          reader = response.body.getReader();
          if (line.signal.aborted) reader.cancel().catch(() => {});
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            clearTimeout(dead); dead = setTimeout(abortLine, DEAD_MS);
            buffer += decoder.decode(chunk, { stream: true });
            let cut, nudged = false;
            while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
              const block = buffer.slice(0, cut);
              buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
              if (block.split(/\r?\n/).some(f => f.startsWith('event:') || f.startsWith('data:'))) nudged = true; // ": ping" is only the beat
            }
            if (nudged) ask();
          }
        } else response?.body?.cancel().catch(() => {});
      } catch { /* the line broke or went silent: opened again below */ }
      finally {
        lineUp = false;
        clearTimeout(dead);
        stop.signal.removeEventListener('abort', abortLine);
      }
      if (stop.signal.aborted) break;
      await pause(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)], stop.signal);
    }
    await pause(Infinity === seconds ? 2 ** 31 - 1 : seconds * 1000, stop.signal); // the poll alone, when the line takes no key
    await poller;
    await asking;
  } finally {
    if (timer) clearTimeout(timer);
    process.off('SIGINT', onInt);
  }
  if (failure) throw failure;
  return out.done({ status: 'ok', watched: want ? `@${want}` : 'all', events, ended, line: lineTakesKeys ? 'live' : 'poll', warnings: [], next: [] },
    `Stopped ${ended === 'time' ? `after ${seconds} s` : 'on Ctrl-C'}: ${events.length} message${events.length === 1 ? '' : 's'}.${ended === 'time' && !tty ? ' Run it again to keep watching.' : ''}`);
}
