// The command-line contract of earthonline 0.2.0 (research/cli-onboarding-design-1026.md §10): exit codes, what --json
// prints, and the one REST call every command makes (POST /api/tools/<name>, the same operations as the MCP tools).
//
// Copied from InsForge's handleError (@insforge/cli 0.2.8 dist, read 2026-10-26): with --json a failure is one object on
// stderr, { error, code }, and each error has its own exit code; plus Neon's `Next` (https://neon.com/docs/reference/cli-init,
// viewed 2026-10-26): what to run next. Different on purpose from InsForge: missing input never exits 0 (their `create -y`
// read EOF and exited 0 having made nothing, stories/insforge-dogfood-1024.md), and a warning is never only in a human line.
//
//   exit 0  done
//        1  unexpected (UNKNOWN_ERROR, or the server's own code)
//        2  input needed, or no terminal to ask in (missing_input, invalid_input, node_too_old)
//        3  authentication (code_invalid, signed_out, forbidden)
//        4  network, or the service says not now (network, rate_limited, unavailable, signups_paused): run it again later
//        5  partial: the account is fine, a setup step was not (each one in `warnings`)
//
// --json: on success one object on stdout, { status, ..., warnings: [], next: [] }; on failure one object on stderr,
// { error, code, next, ... }. What a human run would have said along the way is in `notes`. A key is never in either:
// every line written goes through redact().
import { USER_AGENT } from './common.mjs';

export const EXIT = Object.freeze({ ok: 0, unexpected: 1, input: 2, auth: 3, network: 4, partial: 5 });

/** Cuts every key out of a text written anywhere (stdout, stderr, notes). */
export const redact = text => String(text).replace(/eolc_[0-9A-Za-z]+/g, '[redacted]');

export class CliError extends Error {
  /** `extra`: more fields for the --json object (retry_after, reason, field, needs, need, suggestions). */
  constructor(code, message, { exit = EXIT.unexpected, next = [], ...extra } = {}) {
    super(message);
    this.code = code; this.exit = exit; this.next = next; this.extra = extra;
  }
}

/**
 * Where a command's words go. Human: lines on stdout, an error on stderr. --json: nothing until the end, then one object
 * (result on stdout, or failure on stderr) with the lines it would have said as `notes`.
 */
export function makeOut(json = false) {
  const notes = [];
  const write = (stream, text) => stream.write(redact(text) + '\n');
  return {
    json,
    say(line) { if (json) notes.push(redact(line)); else write(process.stdout, line); },
    /** The end of a successful command. `human`: what a person reads instead of the object. */
    done(result, human = null) {
      const warnings = result.warnings ?? [];
      const status = result.status ?? (warnings.length ? 'partial' : 'ok');
      if (json) write(process.stdout, JSON.stringify({ ...result, status, warnings, next: result.next ?? [], ...(notes.length ? { notes } : {}) }));
      else {
        if (human) write(process.stdout, human);
        for (const w of warnings) write(process.stderr, `Warning (${w.step}): ${w.error}${w.fix ? ` Fix: ${w.fix}` : ''}`);
        for (const n of result.next ?? []) write(process.stdout, `Next: ${n}`);
      }
      return status === 'partial' ? EXIT.partial : EXIT.ok;
    },
    fail(err) {
      const known = err instanceof CliError;
      const code = known ? err.code : 'UNKNOWN_ERROR';
      if (json) write(process.stderr, JSON.stringify({ error: redact(err?.message ?? err), code, next: known ? err.next : [], ...(known ? err.extra : {}), ...(notes.length ? { notes } : {}) }));
      else {
        write(process.stderr, err?.message ?? err);
        for (const n of known ? err.next : []) write(process.stderr, `Next: ${n}`);
      }
      return known ? err.exit : EXIT.unexpected;
    },
  };
}

/** A refusal from EarthOnline ({ code, message, retry_after_seconds?, field?, reason? }, tools.js errorBody) as a CliError. */
export function serverError(name, status, error = {}) {
  const words = redact(typeof error.message === 'string' ? error.message : `EarthOnline could not complete ${name} (HTTP ${status}).`).slice(0, 600);
  const extra = {};
  if (Number.isFinite(error.retry_after_seconds)) extra.retry_after = error.retry_after_seconds;
  if (typeof error.reason === 'string') extra.reason = error.reason;
  if (typeof error.field === 'string') extra.field = error.field;
  if (Array.isArray(error.suggestions)) extra.suggestions = error.suggestions.filter(h => typeof h === 'string').slice(0, 5);
  const code = typeof error.code === 'string' ? error.code : null;
  if (code === 'rate_limited' || status === 429) {
    const after = extra.retry_after ? ` in ${extra.retry_after} s` : ' in a little while';
    return new CliError('rate_limited', words, { exit: EXIT.network, next: [`Run the same command again${after}.`], ...extra });
  }
  if (['unavailable', 'signups_paused', 'sends_paused'].includes(code) || status >= 500) {
    return new CliError(code ?? 'unavailable', words, { exit: EXIT.network, next: ['Run the same command again in a minute.'], ...extra });
  }
  if (code === 'unauthorized' || status === 401) {
    return new CliError('signed_out', 'This computer is not signed in to EarthOnline any more: its key was revoked or is not valid.', { exit: EXIT.auth, next: ['npx earthonline login --email <your email>'] });
  }
  if (code === 'forbidden' || status === 403) return new CliError('forbidden', words, { exit: EXIT.auth, ...extra });
  if (code === 'invalid_argument' && name === 'eol_login' && extra.field === 'code') {
    // the server answers a wrong, an expired and a used-up code the same, on purpose (auth.js loginWithEmailCode)
    return new CliError('code_invalid', words, { exit: EXIT.auth, next: ['Check the code with your owner and run login --code again, or ask for a new one: npx earthonline login --resend'], ...extra });
  }
  if (code === 'invalid_argument') return new CliError('invalid_input', words, { exit: EXIT.input, ...extra });
  return new CliError(code ?? 'UNKNOWN_ERROR', words, { exit: EXIT.unexpected, ...extra });
}

/**
 * POST <base>/api/tools/<name> with this key (or none): the tool's `result`, or a CliError. Never logs or echoes the key.
 * `headers`: more request headers (call.mjs: the X-EOL-Agent headers of the session the command runs in).
 */
export async function callTool(base, name, args = {}, key = null, { timeoutMs = 15000, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${base}/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, 'content-type': 'application/json', 'user-agent': USER_AGENT, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(args ?? {}),
    });
  } catch {
    throw new CliError('network', `Could not reach EarthOnline at ${base}. Check the connection and try again.`, { exit: EXIT.network, next: ['Run the same command again once the connection is back.'] });
  }
  let body;
  try { body = await response.json(); } catch {
    throw new CliError(response.status >= 500 ? 'unavailable' : 'network', `EarthOnline at ${base} did not answer with JSON (HTTP ${response.status}).`, { exit: EXIT.network, next: ['Run the same command again in a minute.'] });
  }
  if (response.ok && body?.ok) return body.result;
  throw serverError(name, response.status, body?.error);
}
