// `login --device`: RFC 8628 device authorization against EarthOnline (research/cli-onboarding-design-1026.md §4.1, §7, §12
// and its "B7 contract (car11-dev-1026)"): one web page to approve on, the fallback when the email code does not arrive.
//
// Copied from gh auth login and Vercel's device login (RFC 8628, https://www.rfc-editor.org/rfc/rfc8628, 2019-08 [>12mo,
// stable RFC]; vercel.com/changelog "New Vercel CLI login flow", 2025-09-12) with fixed endpoints for our own public client, and
// from InsForge's resumable ~/.insforge/pending-device.json, reused while more than 60 s remain (@insforge/cli 0.2.8 dist, read
// 2026-10-26). Different on purpose from InsForge, which calls open() even without a terminal: without one no browser is opened
// (the agent decides where the address goes), and the first run returns at once with the address, as `login --email` does,
// because the agent can pass it on only once the command has ended (a shell waits at most 10 minutes, design §12). A re-run
// resumes the same code and polls for `--wait` seconds.
//
// EOL_HOME/pending-device.json: { v: 1, origin, device_code, user_code, verification_uri, verification_uri_complete, interval,
// started_at, expires_at, polled_at? }. Private like the key (writeSecret): an approved device code is worth a key. The device
// code is never printed; the key goes to the key file only.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { PATHS, KEY_RE, USER_AGENT, readJson, writeSecret } from './common.mjs';
import { EXIT, CliError, redact } from './contract.mjs';
import { RESUME_MARGIN_MS } from './pending.mjs';

export const CLIENT_ID = 'earthonline-cli';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Without a terminal, how long a re-run polls by default: inside the 2 minutes Claude Code's shell gives a command by default. */
export const DEFAULT_WAIT_S = 60;
export const MAX_WAIT_S = 540; // under the 10 minutes a shell can be given at most
const AGAIN = 'npx earthonline login --device';
const BY_EMAIL = "Or sign in with the email code: npx earthonline login --email <your owner's email>";

const httpUrl = value => { try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; } };

/** The device sign-in waiting on this computer, or null (none, another shape, or expired). */
export function readPendingDevice(now = Date.now()) {
  const p = readJson(PATHS.pendingDevice);
  if (!p || p.v !== 1 || typeof p.origin !== 'string' || typeof p.device_code !== 'string' || typeof p.user_code !== 'string' || !httpUrl(p.verification_uri_complete)) return null;
  const expires = Date.parse(p.expires_at);
  return Number.isFinite(expires) && expires > now ? p : null;
}
const savePendingDevice = record => writeSecret(PATHS.pendingDevice, JSON.stringify(record) + '\n');
export function clearPendingDevice() { fs.rmSync(PATHS.pendingDevice, { force: true }); }

/** A poll interval in whole seconds: 5 when absent (RFC 8628 §3.2), never under 1 so a server's 0 cannot make a busy loop. */
const seconds = value => { const n = Number(value ?? 5); return Number.isFinite(n) ? Math.max(1, Math.ceil(n)) : 5; };
const retryAfter = response => { const s = Number(response.headers.get('retry-after')); return Number.isFinite(s) && s >= 0 ? s : null; };

/** One form POST to an /oauth/ route of `base` -> { response, body } (body null when it is not JSON). Network failure: exit 4. */
async function post(base, route, fields) {
  let response;
  try {
    response = await fetch(`${base}${route}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
      body: new URLSearchParams(fields).toString(),
    });
  } catch {
    throw new CliError('network', `Could not reach EarthOnline at ${base}. Check the connection and try again.`, { exit: EXIT.network, next: [`Run the same command again once the connection is back: ${AGAIN}`] });
  }
  let body = null;
  try { body = await response.json(); } catch { /* a proxy's page: the status decides */ }
  return { response, body };
}

/** An answer that is not the one hoped for, as the CLI's error: busy and not-now are exit 4; a client mistake is a bug (exit 1). */
function notNow(base, response, body) {
  const after = retryAfter(response);
  const words = typeof body?.error_description === 'string' ? redact(body.error_description).slice(0, 600) : null;
  if (response.status === 429) return new CliError('rate_limited', words ?? 'EarthOnline is getting too many sign-in requests from here.', { exit: EXIT.network, next: [`Run the same command again${after ? ` in ${after} s` : ' in a little while'}.`], ...(after !== null ? { retry_after: after } : {}) });
  if (response.status >= 500 || body === null) return new CliError('unavailable', words ?? `EarthOnline at ${base} could not answer (HTTP ${response.status}).`, { exit: EXIT.network, next: ['Run the same command again in a minute.'], ...(after !== null ? { retry_after: after } : {}) });
  return new CliError(typeof body?.error === 'string' ? body.error : 'UNKNOWN_ERROR', words ?? `EarthOnline refused the device sign-in (HTTP ${response.status}).`, { exit: EXIT.unexpected, next: [BY_EMAIL] });
}

/** Step 1 (B7 §1): a new device code. A server without the device flow (404) is told apart from one that is down. */
async function start(base) {
  const { response, body } = await post(base, '/oauth/device_authorization', { client_id: CLIENT_ID, scope: 'owner' });
  if (response.status === 404) throw new CliError('unsupported', `EarthOnline at ${base} does not offer sign-in on a web page yet.`, { exit: EXIT.input, next: [BY_EMAIL] });
  if (!response.ok) throw notNow(base, response, body);
  const ok = body && typeof body.device_code === 'string' && body.device_code && typeof body.user_code === 'string' && body.user_code
    && httpUrl(body.verification_uri) && httpUrl(body.verification_uri_complete) && Number(body.expires_in) > 0;
  if (!ok) throw new CliError('UNKNOWN_ERROR', 'EarthOnline did not return a usable device sign-in.', { next: [BY_EMAIL] });
  const now = Date.now();
  const record = {
    v: 1, origin: base, device_code: body.device_code, user_code: body.user_code, verification_uri: body.verification_uri,
    verification_uri_complete: body.verification_uri_complete, interval: seconds(body.interval),
    started_at: new Date(now).toISOString(), expires_at: new Date(now + Number(body.expires_in) * 1000).toISOString(),
  };
  return { record, warnings: savePendingDevice(record) };
}

/**
 * Step 2 (B7 §2): one poll. -> { key, robot, created } when approved, { interval } while pending (the new one after
 * slow_down), or throws: denied, expired and unknown codes end this sign-in (the pending file goes); network and not-now keep it.
 */
async function poll(record) {
  const { response, body } = await post(record.origin, '/oauth/token', { grant_type: GRANT, device_code: record.device_code, client_id: CLIENT_ID });
  if (response.ok) {
    if (!KEY_RE.test(body?.access_token ?? '') || typeof body?.robot?.handle !== 'string') throw new CliError('UNKNOWN_ERROR', 'EarthOnline did not return a usable sign-in.', { next: [AGAIN] });
    return { key: body.access_token, robot: body.robot, created: body.created === true, keyId: typeof body.key_id === 'string' ? body.key_id : null };
  }
  const error = response.status === 400 && typeof body?.error === 'string' ? body.error : null;
  if (error === 'authorization_pending') return { interval: record.interval };
  // slow_down: the body's interval, else 5 s more (RFC 8628 §3.5; GitHub: "The error response includes the new interval")
  if (error === 'slow_down') return { interval: Number(body.interval) > record.interval ? seconds(body.interval) : record.interval + 5 };
  const ends = {
    access_denied: ['The sign-in was not approved on the web page.', [AGAIN, BY_EMAIL]],
    expired_token: ['The approval code expired before it was approved (a code works for 15 minutes).', [AGAIN]],
    invalid_grant: ['EarthOnline does not know this approval code any more (it was used already, or is not this client\'s).', [AGAIN]],
  };
  if (ends[error]) {
    clearPendingDevice();
    const [words, next] = ends[error];
    const said = typeof body.error_description === 'string' ? redact(body.error_description).slice(0, 600) : null;
    throw new CliError(error, said ?? words, { exit: EXIT.auth, next });
  }
  if (response.status === 429 || response.status >= 500 || body === null) throw notNow(record.origin, response, body);
  clearPendingDevice(); // invalid_request, invalid_client: this client's mistake; a re-run starts clean
  throw notNow(record.origin, response, body);
}

/** With a terminal only: the page in the person's browser. A failure to open is not an error; the address was printed. */
function openBrowser(url) {
  if (!httpUrl(url)) return false;
  const [file, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * login --device. `asked`: the --origin given (checked), else null; `fallback`: where a new sign-in goes without it. `tty`: a
 * person at a terminal (then the page is opened and the run waits up to the code's life). `wait`: --wait seconds, or undefined.
 * -> { signed: { handle, created, hint, warnings }, base } once approved, or { pending, human } to print as approval_pending.
 */
export async function deviceLogin({ asked = null, fallback, tty = false, wait, say = () => {} }) {
  const warnings = [];
  const waiting = readPendingDevice();
  const base = asked ?? waiting?.origin ?? fallback;
  let record = waiting && waiting.origin === base && Date.parse(waiting.expires_at) - Date.now() > RESUME_MARGIN_MS ? waiting : null;
  const resumed = Boolean(record);
  if (!record) { const started = await start(base); record = started.record; warnings.push(...started.warnings); }
  const left = () => Math.max(0, Math.round((Date.parse(record.expires_at) - Date.now()) / 1000));
  if (tty) {
    say(`To sign in, open ${record.verification_uri_complete}`);
    say(`and check that the page shows ${record.user_code}. It works for ${Math.ceil(left() / 60)} more minute(s).`);
    if (openBrowser(record.verification_uri_complete)) say('Opened it in your browser. Waiting for the approval...');
  }
  // A first run without a terminal returns at once: the address is what the agent needs, and it gets it only when this ends.
  const polls = resumed || tty || wait !== undefined;
  if (polls) {
    const deadline = Math.min(Date.parse(record.expires_at), Date.now() + (wait ?? (tty ? Infinity : DEFAULT_WAIT_S)) * 1000);
    // RFC 8628 §3.5: never sooner than `interval` after the code was issued or last polled, a killed earlier run's poll included
    const since = Date.now() - (Date.parse(record.polled_at ?? record.started_at) || 0);
    if (since < record.interval * 1000) await pause(record.interval * 1000 - since);
    for (;;) {
      const answer = await poll(record);
      if (answer.key) {
        warnings.push(...writeSecret(PATHS.key, answer.key + '\n'));
        clearPendingDevice();
        return { base: record.origin, signed: { handle: answer.robot.handle.replace(/^@/, ''), created: answer.created, keyId: answer.keyId, hint: null, warnings } };
      }
      record = { ...record, interval: answer.interval, polled_at: new Date().toISOString() };
      warnings.push(...savePendingDevice(record));
      if (Date.now() + record.interval * 1000 >= deadline) break;
      await pause(record.interval * 1000);
    }
  }
  const pending = {
    status: 'approval_pending', resumed, user_code: record.user_code, verification_uri: record.verification_uri,
    verification_uri_complete: record.verification_uri_complete, expires_at: record.expires_at, expires_in: left(), interval: record.interval,
    warnings: dedupe(warnings),
    next: [`Have your owner open ${record.verification_uri_complete}, check that it shows ${record.user_code} and approve, then run: ${AGAIN}`],
  };
  const human = left() > 0
    ? `Not approved yet. Open ${record.verification_uri_complete} and check that it shows ${record.user_code}; it works for ${Math.ceil(left() / 60)} more minute(s).`
    : 'The approval code expired before it was approved.';
  if (left() === 0) { clearPendingDevice(); throw new CliError('expired_token', human, { exit: EXIT.auth, next: [AGAIN] }); }
  return { pending, human };
}
/** The same ACL warning from each save of the pending file, said once. */
const dedupe = warnings => warnings.filter((w, i) => warnings.findIndex(o => o.step === w.step && o.error === w.error) === i);
