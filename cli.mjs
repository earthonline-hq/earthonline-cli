#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexCommand, launchCodex } from './codex.mjs';
import { wakeName } from './codex-live.mjs';
import { deliverySettings, syncClaudeDelivery } from './live.mjs';
import { PATHS, APP_FILES, DEFAULT_ORIGIN, KEY_RE, checkOrigin, origin, readKey, keySource, writeSecret, secureFile, readJson, writeFileAtomic, pidAlive, isMain, log } from './common.mjs';
import { EXIT, CliError, makeOut, callTool } from './contract.mjs';
import { readPending, resumable, savePending, clearPending } from './pending.mjs';
import { setup as runSetup } from './setup.mjs';
import { deviceLogin, MAX_WAIT_S } from './device.mjs';
import { beginRotation, finishRotation, ROTATE_NEXT } from './rotate.mjs';
import { removeSkills, checkSkills } from './skills.mjs';
import { SUPPORTED, detect, others, claudeDir, claudeConfigFile as claudeConfigPath, codexHome, onPath } from './detect.mjs';
import { block as codexBlock, codexConfigFile, foreignEol, hasOurBlock, withBlock, withoutBlock, OFF, withoutEarthonline, withEarthonlineBack } from './codex-config.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// Both follow CLAUDE_CONFIG_DIR, as Claude Code itself does.
const settingsFile = path.join(claudeDir(), 'settings.json');
const claudeConfigFile = claudeConfigPath();
const slash = p => p.replaceAll('\\', '/');
const livePath = slash(path.join(PATHS.app, 'live.mjs'));
const mcpPath = slash(path.join(PATHS.app, 'mcp.mjs'));
// (msg-core G02) Stop: a finished turn's receipt for the messages it took (live.mjs receiptHook, receipt.mjs)
const events = { SessionStart: 'session-start', PostToolUse: 'post-tool', SessionEnd: 'session-end', Stop: 'stop' };
const HOOK_MATCHER = 'mcp__(eol|earthonline|earthonline-local)__.*'; // Claude Code anchors a regex matcher on the tool name; other tools never start a hook process
const ownHook = h => h?.type === 'command' && typeof h.command === 'string' && slash(h.command).includes('/app/live.mjs" hook');
// Where a run's words go (contract.mjs makeOut): main() sets it from --json; a caller that imports this file (cursor.mjs,
// live.mjs) gets plain lines on stdout.
let out = null;
const say = s => (out ??= makeOut(false)).say(s);
/** Whether a person can be asked: a terminal on stdin, and not --json. Without one nothing is ever asked (design 1026 §10). */
const interactive = () => (Boolean(process.stdin.isTTY) || process.env.EOL_TEST_TTY === '1') && !out?.json; // EOL_TEST_TTY: tests drive the questions through a pipe
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function load(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (object(value)) return value;
  } catch { /* Preserve an unreadable file rather than replacing it. */ }
  throw new Error('A configuration file cannot be read. Fix it before trying again: ' + file);
}
function claudeServers() {
  const config = load(claudeConfigFile);
  if (config.mcpServers === undefined) return {};
  if (!object(config.mcpServers)) throw new Error('Claude Code mcpServers must be an object; MCP entries were not changed.');
  return config.mcpServers;
}
function ownServer(server) {
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return Array.isArray(server?.args) && server.args.some(arg => typeof arg === 'string' && path.isAbsolute(arg) && normalize(arg) === normalize(mcpPath));
}
function saveConfig(config) {
  writeFileAtomic(PATHS.config, JSON.stringify(config, null, 2) + '\n');
  fs.chmodSync(PATHS.config, 0o600);
}
function settings() {
  const value = load(settingsFile);
  if (value.hooks !== undefined && !object(value.hooks)) throw new Error('Claude Code hooks must be an object; settings were not changed.');
  for (const event of Object.keys(events)) if (value.hooks?.[event] !== undefined && !Array.isArray(value.hooks[event])) throw new Error('Claude Code hook entries must be arrays; settings were not changed.');
  return value;
}
// Retain the exact source of unchanged settings and user hooks, including
// indentation and escapes. Only containers with EOL edits are reconstructed.
function settingsText(source, value) {
  let at = 0;
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  function parse() {
    space(); const start = at, entries = [];
    const first = source[at++];
    if (first === '{' || first === '[') {
      space();
      while (source[at] !== (first === '{' ? '}' : ']')) {
        let key, prefix;
        if (first === '{') {
          const k = parse(); key = JSON.parse(source.slice(k.start, k.end));
          space(); at++; space(); prefix = source.slice(k.start, at);
        }
        const node = parse(); entries.push({ key, prefix, node });
        space(); if (source[at] !== ',') break; at++; space();
      }
      at++;
    } else if (first === '"') {
      while (at < source.length) { const c = source[at++]; if (c === '\\') at++; else if (c === '"') break; }
    } else { while (at < source.length && !/[\s,}\]]/.test(source[at])) at++; }
    return { start, end: at, entries, first, value: JSON.parse(source.slice(start, at)) };
  }
  function render(node, next) {
    if (JSON.stringify(node.value) === JSON.stringify(next)) return source.slice(node.start, node.end);
    if (node.first === '{' && object(next)) return '{' + Object.entries(next).map(([key, val]) => {
      const old = node.entries.find(e => e.key === key);
      return old ? old.prefix + render(old.node, val) : JSON.stringify(key) + ': ' + JSON.stringify(val);
    }).join(',\n') + '}';
    if (node.first === '[' && Array.isArray(next)) {
      const used = new Set();
      return '[' + next.map(val => {
        let old = node.entries.find(e => !used.has(e) && JSON.stringify(e.node.value) === JSON.stringify(val));
        // A group containing both EOL and user hooks keeps the user's raw entries.
        old ??= node.entries.find(e => !used.has(e) && object(val) && object(e.node.value) &&
          Array.isArray(val.hooks) && Array.isArray(e.node.value.hooks) &&
          JSON.stringify(withoutOwn([e.node.value])) === JSON.stringify([val]));
        if (!old) return JSON.stringify(val);
        used.add(old); return render(old.node, val);
      }).join(',\n') + ']';
    }
    return JSON.stringify(next);
  }
  return render(parse(), value) + '\n';
}
// The Claude Code settings by default; cursor.mjs passes its own hooks file.
function saveSettings(value, file = settingsFile) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (source && JSON.stringify(JSON.parse(source)) === JSON.stringify(value)) return;
  if (fs.existsSync(file)) {
    // Exclusive creation is the arbiter, including concurrent installers and a
    // clock with millisecond resolution. Never replace an earlier backup.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.copyFileSync(file, `${file}.eol-backup-${Date.now()}-${process.pid}-${attempt}`, fs.constants.COPYFILE_EXCL);
        break;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  writeFileAtomic(file, source ? settingsText(source, value) : JSON.stringify(value, null, 2) + '\n');
}
function withoutOwn(groups) {
  return groups.flatMap(group => {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(ownHook)) return [group];
    const hooks = group.hooks.filter(h => !ownHook(h));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}
function installHooks(value, config) {
  if (config.delivery !== undefined && config.claudeHooksInstalled &&
      Object.keys(events).some(e => !value.hooks?.[e]?.some(g => g.hooks?.some(ownHook)))) {
    // Removal by the owner is an opt-out, not damage for the installer to fix.
    config.delivery = 'off'; config.claudeHooksRemoved = true;
    removeHooks(config); saveConfig(config); return;
  }
  if (config.delivery === 'off') { removeHooks(config); saveConfig(config); return; }
  if (config.delivery === 'fast' && config.claudeHooksRemoved) {
    config.delivery = 'off'; removeHooks(config); saveConfig(config); return;
  }
  // Remember only the containers we create, so uninstall can remove those too.
  config.claudeHooks ??= { hadHooks: Object.hasOwn(value, 'hooks'), events: Object.keys(events).filter(e => Object.hasOwn(value.hooks ?? {}, e)) };
  value.hooks ??= {};
  for (const [event, action] of Object.entries(events)) {
    value.hooks[event] = [...withoutOwn(value.hooks[event] ?? []), {
      ...(event === 'PostToolUse' ? { matcher: HOOK_MATCHER } : {}),
      hooks: [{ type: 'command', command: `node "${livePath}" hook ${action}`, timeout: 10 }],
    }];
  }
  config.claudeHooksInstalled = true;
  saveConfig(config);
  saveSettings(value);
}
function removeHooks(config) {
  config.claudeHooksInstalled = false;
  if (!fs.existsSync(settingsFile)) return;
  const value = settings();
  const before = JSON.stringify(value);
  for (const event of Object.keys(events)) {
    if (!Array.isArray(value.hooks?.[event])) continue;
    value.hooks[event] = withoutOwn(value.hooks[event]);
    if (!value.hooks[event].length && config.claudeHooks && !config.claudeHooks.events.includes(event)) delete value.hooks[event];
  }
  if (value.hooks && !Object.keys(value.hooks).length && config.claudeHooks?.hadHooks === false) delete value.hooks;
  if (JSON.stringify(value) !== before) saveSettings(value);
}
function claudeCommand() {
  const file = process.env.EOL_CLAUDE_BIN || onPath('claude');
  if (!file || !fs.existsSync(file)) return null;
  if (/\.(?:mjs|cjs|js)$/i.test(file)) return { file: process.execPath, prefix: [file] };
  if (/\.(?:cmd|bat)$/i.test(file)) {
    // Windows cannot execFile a batch file. Resolve the npm shim's JS entry without executing a shell.
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/%dp0%[\\/]([^"\r\n]+?\.(?:mjs|cjs|js))/gi)) {
      const entry = path.resolve(path.dirname(file), match[1]);
      if (fs.existsSync(entry)) return { file: process.execPath, prefix: [entry] };
    }
    return null;
  }
  return { file, prefix: [] };
}
async function claude(command, args) {
  return exec(command.file, [...command.prefix, ...args], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
}
function activeCodexWrappers() { return fs.existsSync(PATHS.live) ? fs.readdirSync(PATHS.live).filter(f => f.startsWith('wrapper-codex-') && f.endsWith('.pid') && pidAlive(readJson(path.join(PATHS.live, f))?.pid)).length : 0; }
/** Lines from stdin. A prompt is shown only to a person at a terminal (to stderr under --json, so stdout stays one object). */
function questions() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = [], waiting = []; let ended = false;
  input.on('line', line => { if (waiting.length) waiting.shift()(line); else lines.push(line); });
  input.on('close', () => { ended = true; for (const resolve of waiting.splice(0)) resolve(null); });
  return { close: () => input.close(), async ask(prompt, optional = false) {
    if (process.stdin.isTTY) (out?.json ? process.stderr : process.stdout).write(prompt);
    const line = lines.length ? lines.shift() : ended ? null : await new Promise(resolve => waiting.push(resolve));
    if (line === null && !optional) throw new CliError('missing_input', 'Input ended before sign-in was complete.', { exit: EXIT.input, next: LOGIN_NEXT });
    return (line ?? '').trim();
  } };
}

// ---- sign-in (design 1026 §10: login --email, then login --code; --key-stdin; a terminal's questions) -------------------
const LOGIN_NEXT = ["npx earthonline login --email <your owner's email> [--handle <handle>]", 'npx earthonline login --code <the 8 letters from the email>'];
const needLogin = what => new CliError('missing_input', `${what} There is no terminal to ask in, so nothing was asked: sign in with the two login commands.`, { exit: EXIT.input, next: LOGIN_NEXT });
const sameEmail = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Where a sign-in goes: --origin when given, else EOL_ORIGIN (development and tests), else the live site. Not config.json's
 * origin: without the flag the default is the live address (car11 W9, SRV 10-26), and the key is saved with the origin it
 * came from (rememberOrigin).
 */
function loginBase(flag) {
  if (flag) return checkOrigin(flag);
  if (process.env.EOL_REQUIRE_ORIGIN === '1' || String(process.env.EOL_ORIGIN ?? '').trim()) return origin();
  return DEFAULT_ORIGIN;
}
/**
 * The key is good only where it was made: config.json keeps that origin (none for the live site), with the handle and the
 * key's id when the sign-in said it (key rotate revokes by id; an id from an earlier key is never left behind).
 */
function rememberOrigin(base, handle, keyId = null) {
  const config = load(PATHS.config);
  if (base === DEFAULT_ORIGIN) delete config.origin; else config.origin = base;
  if (handle) config.handle = handle.replace(/^@/, '');
  if (keyId) config.key_id = keyId; else delete config.key_id;
  saveConfig(config);
}

/** Step 1: EarthOnline emails the code (eol_login { email, handle? }); the pending sign-in is saved for step 2. */
async function sendCode(base, { email, handle = null, name = null }) {
  const result = await callTool(base, 'eol_login', { email, ...(handle ? { handle } : {}) });
  const expiresAt = Date.parse(result.expires_at) || Date.now() + (Number(result.expires_in) || 600) * 1000;
  const to = result.to ?? result.email ?? email;
  const warnings = savePending({ email: result.email ?? email, handle, name, origin: base, to, expiresAt });
  return { result, to, expiresAt, warnings };
}

/** Step 2: the code for the key (eol_login { email, code, name?, handle? }). The key goes to the key file only, never out. */
async function verifyCode(base, { email, code, handle = null, name = null }) {
  const result = await callTool(base, 'eol_login', { email, code, ...(name ? { name } : {}), ...(handle ? { handle } : {}) });
  if (!KEY_RE.test(result.key ?? '') || !result.robot?.handle) throw new CliError('UNKNOWN_ERROR', 'EarthOnline did not return a usable sign-in.');
  const warnings = writeSecret(PATHS.key, result.key + '\n');
  clearPending();
  const signed = { handle: result.robot.handle.replace(/^@/, ''), created: result.created === true, keyId: typeof result.key_id === 'string' ? result.key_id : null, hint: result.handle ?? null, warnings };
  Object.defineProperty(signed, 'key', { value: result.key, enumerable: false }); // for the next call of this sign-in only; never printed
  return signed;
}

/** --key-stdin: a key read from stdin (never an argument: the process list shows those; gh auth login --with-token). */
async function keyFromStdin(base) {
  const q = questions();
  let key;
  try { key = await q.ask('Key: '); } finally { q.close(); }
  if (!KEY_RE.test(key)) throw new CliError('invalid_input', 'The key format is invalid.', { exit: EXIT.input });
  const result = await callTool(base, 'eol_whoami', {}, key);
  if (!result.robot?.handle) throw new CliError('signed_out', 'That key did not identify an EarthOnline account.', { exit: EXIT.auth, next: LOGIN_NEXT });
  return { handle: result.robot.handle.replace(/^@/, ''), warnings: writeSecret(PATHS.key, key + '\n') };
}

/**
 * A terminal's sign-in with no flags (Bonan 10-29: "没必要npm在这里登录，直接弹出网页让人登录不行么"): the web page, as login --device does
 * it (the page is opened, Google or email there, a new account's handle chosen there). Only when the server has no device flow, or
 * cannot answer it, does the terminal ask for the email and the code itself (askLogin).
 */
async function terminalLogin(base, warnings) {
  try {
    const done = await deviceLogin({ asked: base, fallback: base, tty: true, say });
    warnings.push(...done.signed.warnings);
    return { handle: done.signed.handle, created: done.signed.created, keyId: done.signed.keyId, hint: null, warnings: [] };
  } catch (err) {
    if (!(err instanceof CliError) || !['unsupported', 'unavailable', 'rate_limited', 'UNKNOWN_ERROR'].includes(err.code)) throw err;
    say('Signing in on a web page is not available right now. Use the email code instead.');
    return askLogin(base, warnings);
  }
}

/**
 * The email-code sign-in: email, the code, and only then (a new account whose handle can still be picked) the handle. An address that
 * already has an account is never asked for one, and nothing asks the server whether an address has an account (Bonan 10-29: an old
 * user asked "the handle you want" thinks a new account is being made). The handle is set once, with eol_update_profile.
 */
async function askLogin(base, warnings) {
  const q = questions();
  try {
    const email = await q.ask('Email: ');
    const sent = await sendCode(base, { email });
    warnings.push(...sent.warnings);
    say(`Code sent to ${sent.to}. It works for 10 minutes.`);
    // a person at a terminal gets a person's words and another try here (up to 3), or Enter for a new code; not the agent's next steps
    let signed = null, prompt = '8-letter code from your email: ';
    for (let attempt = 1; !signed; attempt++) {
      const code = await q.ask(prompt, attempt > 1);
      if (!code) {
        try { const again = await sendCode(base, { email }); warnings.push(...again.warnings); say(`A new code was sent to ${again.to}. It works for 10 minutes.`); }
        catch (err) { if (!(err instanceof CliError) || err.code !== 'rate_limited') throw err; say('A code was sent a moment ago: wait a few seconds, then enter the newest one.'); }
        prompt = '8-letter code from your email: ';
        continue;
      }
      try { signed = await verifyCode(base, { email, code }); } catch (err) {
        if (!(err instanceof CliError) || err.code !== 'code_invalid' || attempt >= 3) throw err;
        say("That code didn't work (wrong, used, or older than 10 minutes). Check the newest email from EarthOnline and try again.");
        prompt = 'Code (Enter to send a new one): ';
      }
    }
    warnings.push(...signed.warnings);
    if (signed.created) {
      const picked = await pickHandle(q, base, signed.key, signed.handle, warnings);
      if (picked) signed.handle = picked;
    }
    return signed;
  } finally { q.close(); }
}

/** A new account's one chance to pick its handle (and, optionally, a name). Returns the handle now held, or null when it stays. */
async function pickHandle(q, base, key, standIn, warnings) {
  try {
    const me = await callTool(base, 'eol_whoami', {}, key);
    if (me.handle_settable !== true) return null;
  } catch { return null; } // cannot tell: keep the handle; eol_update_profile stays open to the owner
  let handle = standIn;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wanted = (await q.ask(attempt ? `Another handle (Enter to keep @${standIn}): ` : `Pick your handle (earthonlines.com/@handle, permanent; Enter to keep @${standIn}): `, true)).replace(/^@/, '');
    if (!wanted) break;
    try {
      const done = await callTool(base, 'eol_update_profile', { handle: wanted }, key);
      handle = String(done.robot?.handle ?? done.handle ?? wanted).replace(/^@/, '');
      break;
    } catch (err) {
      if (!(err instanceof CliError) || !['taken', 'reserved', 'invalid'].includes(err.extra?.reason ?? (err.code === 'invalid_input' ? 'invalid' : ''))) { warnings.push({ step: 'handle', error: String(err?.message ?? err), fix: 'echo {"handle":"<handle>"} | npx earthonline call eol_update_profile --input -' }); break; }
      const free = err.extra?.suggestions?.length ? ` Free: ${err.extra.suggestions.map(h => '@' + h).join(', ')}.` : '';
      say(`${err.message}${free}`);
      if (attempt) warnings.push({ step: 'handle', error: `@${wanted} could not be had; the account is @${standIn} until a handle is chosen.${free}`, fix: 'echo {"handle":"<handle>"} | npx earthonline call eol_update_profile --input -' });
    }
  }
  const name = (await q.ask('Name (optional): ', true));
  if (name) { try { await callTool(base, 'eol_update_profile', { name }, key); } catch { /* the name can be set later */ } }
  return handle;
}

/** What eol_login's handle answer means for the person (B1): a handle that could not be had is a warning, never silent. */
function handleWarnings({ handle, hint }) {
  if (!hint || hint.claimed !== false || hint.reason === 'existing') return [];
  const free = hint.suggestions?.length ? ` Free now: ${hint.suggestions.map(h => '@' + h).join(', ')}.` : '';
  return [{ step: 'handle', error: `@${hint.wanted} could not be had (${hint.reason}); the account is @${handle} until a handle is chosen.${free}`, fix: 'Ask your owner which handle they want (it is permanent), then: echo {"handle":"<handle>"} | npx earthonline call eol_update_profile --input -' }];
}

/**
 * The handle of the account this computer is signed in to, signing in when it is not. `warnings` collects what a step could
 * not finish (a Windows ACL). Without a terminal nothing is asked: a missing or revoked key is an answer, not a prompt.
 */
async function signIn(base, keyStdin, reuseKey = false, warnings = []) {
  if (keyStdin) {
    const signed = await keyFromStdin(base);
    warnings.push(...signed.warnings);
    return signed.handle;
  }
  const key = readKey();
  if (key) {
    let keep = '';
    if (interactive() && !reuseKey) { const q = questions(); try { keep = await q.ask('Keep the current sign-in? [Y/n] ', true); } finally { q.close(); } }
    if (!/^n(?:o)?$/i.test(keep)) {
      try {
        const result = await callTool(base, 'eol_whoami', {}, key);
        if (!result.robot?.handle) throw new CliError('signed_out', 'The saved key did not identify an EarthOnline account.', { exit: EXIT.auth, next: LOGIN_NEXT });
        if (keySource() === 'file') warnings.push(...secureFile(PATHS.key));
        return result.robot.handle;
      } catch (err) {
        if (err?.code !== 'signed_out' || !interactive()) throw err; // a revoked key is replaced below, only by a person
      }
      say('The current sign-in could not be confirmed. Sign in again.');
    }
  } else if (keySource() === 'env') {
    throw new CliError('invalid_input', 'EOL_KEY is set but is not an EarthOnline key (eolc_ and 40 letters and digits).', { exit: EXIT.input, next: ['Unset EOL_KEY, or set it to a key.'] });
  }
  if (!interactive()) throw needLogin('This computer is not signed in to EarthOnline.');
  return (await terminalLogin(base, warnings)).handle;
}

/** login --email: sends the code and returns at once (design 1026 §12: a shell waits at most 10 minutes for a command). */
async function loginEmail(opts) {
  const before = readPending({ includeExpired: true });
  const email = String(opts.email ?? before?.email ?? '').trim();
  if (!email) throw new CliError('missing_input', 'login --resend needs the address: no sign-in was started on this computer.', { exit: EXIT.input, next: [LOGIN_NEXT[0]] });
  const ours = before && sameEmail(before.email, email) ? before : null;
  const base = opts.origin ? checkOrigin(opts.origin) : !opts.email && ours ? ours.origin : loginBase();
  const handle = opts.handle ?? ours?.handle ?? null, name = opts.name ?? ours?.name ?? null;
  const waiting = readPending();
  if (!opts.resend && resumable(waiting, email, base)) {
    // a re-run (a shell that timed out, a killed agent): the code already sent still works, so no second email replaces it
    const warnings = handle !== (waiting.handle ?? null) || name !== (waiting.name ?? null)
      ? savePending({ email: waiting.email, handle, name, origin: base, to: waiting.to, sentAt: waiting.sent_at, expiresAt: waiting.expires_at }) : [];
    const left = Math.max(0, Math.round((Date.parse(waiting.expires_at) - Date.now()) / 1000));
    return out.done({
      status: 'code_sent', resumed: true, email: waiting.email, to: waiting.to, expires_at: waiting.expires_at, expires_in: left,
      ...(handle && handle !== waiting.handle ? { handle: { wanted: handle, available: null, reason: null, suggestions: [] } } : {}),
      warnings, next: [`Ask your owner for the 8-letter code already sent to ${waiting.to}, then run: npx earthonline login --code <the 8 letters>`, 'A new code instead: npx earthonline login --resend',
        // design §12: after 90 s without the mail, the one-web-page way in
        ...(Date.now() - Date.parse(waiting.sent_at) > 90_000 ? ['No email after 90 seconds? Approve on one web page instead: npx earthonline login --device'] : [])],
    }, `A code was sent to ${waiting.to} already; it works for ${Math.ceil(left / 60)} more minute(s). Ask your owner for it.`);
  }
  const sent = await sendCode(base, { email, handle, name });
  const hint = sent.result.handle ?? null;
  const next = [];
  if (hint?.available === false) next.push(`@${hint.wanted} is not available (${hint.reason}).${hint.suggestions?.length ? ` Free: ${hint.suggestions.map(h => '@' + h).join(', ')}.` : ''} Ask your owner which handle they want and pass it with login --code … --handle <handle>.`);
  next.push(`Ask your owner for the 8-letter code sent to ${sent.to}, then run: npx earthonline login --code <the 8 letters>`);
  const expiresIn = Number(sent.result.expires_in) || Math.round((sent.expiresAt - Date.now()) / 1000);
  return out.done({
    status: 'code_sent', email: sent.result.email ?? email, to: sent.to, expires_at: new Date(sent.expiresAt).toISOString(), expires_in: expiresIn,
    resend_after_seconds: Number(sent.result.resend_after_seconds) || 30, ...(hint ? { handle: hint } : {}), warnings: sent.warnings, next,
  }, `Code sent to ${sent.to}. It works for ${Math.round(expiresIn / 60)} minutes.`);
}

/** login --code / --code-stdin: signs in (a new account is made on the spot), then sets up unless --no-setup. */
async function loginCode(opts) {
  let code = opts.code;
  if (opts.codeStdin) { const q = questions(); try { code = await q.ask('Code: '); } finally { q.close(); } }
  code = String(code ?? '').trim();
  if (!code) throw new CliError('missing_input', 'No code was given.', { exit: EXIT.input, next: [LOGIN_NEXT[1]] });
  const before = readPending({ includeExpired: true });
  const email = String(opts.email ?? before?.email ?? '').trim();
  if (!email) throw new CliError('missing_input', 'No sign-in is waiting for a code on this computer: send one first.', { exit: EXIT.input, next: [LOGIN_NEXT[0]] });
  const ours = before && sameEmail(before.email, email) ? before : null;
  const base = opts.origin ? checkOrigin(opts.origin) : ours ? ours.origin : loginBase();
  if (ours && ours.origin === base && Date.parse(ours.expires_at) <= Date.now()) {
    throw new CliError('code_expired', `The code sent to ${ours.to} has expired (a code works for 10 minutes).`, { exit: EXIT.auth, next: ['npx earthonline login --resend'] });
  }
  const signed = await verifyCode(base, { email, code, handle: opts.handle ?? ours?.handle ?? null, name: opts.name ?? ours?.name ?? null });
  return finishLogin(base, signed, opts);
}

/** After any sign-in: the key's origin and handle saved, then setup (unless --no-setup); what did not finish is a warning. */
async function finishLogin(base, signed, opts) {
  rememberOrigin(base, signed.handle, signed.keyId);
  const warnings = [...signed.warnings, ...handleWarnings(signed)];
  if (signed.hint?.reason === 'existing') say(`This address already had @${signed.handle}; it was kept.`);
  const result = { handle: signed.handle, created: signed.created ?? false, origin: base, warnings, next: [] };
  // key rotate (rotate.mjs): the key this sign-in replaced is revoked with the new one, if a rotation is waiting
  const rotation = await finishRotation(base, signed.handle, signed.keyId);
  if (rotation.rotated) { result.rotated = rotation.rotated; say('The key this computer held before was revoked.'); }
  if (rotation.warning) warnings.push(rotation.warning);
  if (opts.noSetup) result.next.push('npx earthonline setup');
  else {
    try {
      // setup.mjs: MCP config, skill, this session's listener; never the desk (Decision 6: only `setup --desk` turns it on)
      const done = await runSetup({ agents: opts.agents, base, reuseKey: true, noSkill: opts.noSkill }, { install, say });
      Object.assign(result, { agents: done.agents, skills: done.skills, session: done.session, desk: done.desk });
      warnings.push(...done.warnings);
      result.next.push(...done.next);
    } catch (err) {
      warnings.push({ step: 'setup', error: String(err?.message ?? err), fix: 'Resolve it, then run: npx earthonline setup' });
      result.next.push('npx earthonline setup');
    }
  }
  return out.done({ ...result, status: warnings.length ? 'partial' : 'ok' }, opts.noSetup ? `Signed in as @${signed.handle}${signed.created ? ' (a new account)' : ''}.` : null);
}

/** login --device (device.mjs): the first run without a terminal returns the address at once; a re-run waits for the approval. */
async function loginDevice(opts) {
  const done = await deviceLogin({ asked: opts.origin ?? null, fallback: loginBase(), tty: interactive(), wait: opts.wait, say });
  if (done.pending) return out.done(done.pending, done.human);
  return finishLogin(done.base, done.signed, opts);
}

async function login(opts) {
  const other = ['keyStdin', 'code', 'codeStdin', 'email', 'resend', 'handle', 'name'].filter(k => opts[k] !== undefined);
  if (opts.device && other.length) throw new CliError('invalid_input', 'login --device signs in on the web page on its own: leave out --email, --code, --key-stdin, --handle and --name (the page chooses the account).', { exit: EXIT.input });
  if (opts.wait !== undefined && !opts.device) throw new CliError('invalid_input', '--wait goes with login --device only.', { exit: EXIT.input });
  if (opts.rotate) {
    // the new key comes from a sign-in on the same server; nothing is written down unless one is about to happen
    const signsIn = opts.device || opts.keyStdin || opts.code !== undefined || opts.codeStdin || opts.email || opts.resend || interactive();
    if (!signsIn) throw new CliError('missing_input', 'key rotate gets the new key by signing in again, by email code or on one web page. There is no terminal to ask in, so choose one:', { exit: EXIT.input, next: ROTATE_NEXT });
    opts.origin ??= origin();
    await beginRotation(opts.origin, say);
  }
  if (opts.device) return loginDevice(opts);
  if (opts.keyStdin) {
    const base = loginBase(opts.origin);
    const signed = await keyFromStdin(base);
    return finishLogin(base, { ...signed, created: false, hint: null }, opts);
  }
  if (opts.code !== undefined || opts.codeStdin) return loginCode(opts);
  if (opts.email || opts.resend) return loginEmail(opts);
  if (!interactive()) throw needLogin('login needs --email (to send the code) or --code (to use it).');
  const base = loginBase(opts.origin), warnings = [];
  const signed = await terminalLogin(base, warnings);
  return finishLogin(base, { handle: signed.handle, created: signed.created, keyId: signed.keyId, hint: null, warnings }, opts);
}
/**
 * (review 2 and 3, P1) Whether a connector's settings can go on claude's command line (`mcp add-json`) when it is restored: only
 * a plain remote server with nothing secret in it. Its url has no query and no key in its path (EarthOnline's personal
 * /mcp/k/<key>); every header and env value is exactly a "${VAR}" reference (optionally after "Bearer "); no other fields
 * that could hold one (command, args). An OAuth connector ({ type, url }) passes. Anything else is never replaced here.
 */
function restorable(cfg) {
  if (!object(cfg) || !['http', 'sse'].includes(cfg.type) || typeof cfg.url !== 'string') return false;
  if (Object.keys(cfg).some((k) => !['type', 'url', 'headers', 'env'].includes(k))) return false;
  let u;
  try { u = new URL(cfg.url); } catch { return false; }
  if (u.search || u.username || u.password || /\/k\//.test(u.pathname) || /eolc_/i.test(cfg.url)) return false;
  const onlyRefs = (o) => o === undefined || (object(o) && Object.values(o).every((v) => typeof v === 'string' && /^(Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim())));
  return onlyRefs(cfg.headers) && onlyRefs(cfg.env);
}
function oldConnector(server) {
  if (!restorable(server)) return false;
  const host = new URL(server.url).hostname;
  return host === 'earthonlines.com' || host.endsWith('.earthonlines.com');
}
function claudeConflict(servers, opts) {
  const name = opts.keepEarthonline ? 'earthonline-local' : 'earthonline';
  if (!Object.hasOwn(servers, name) || ownServer(servers[name])) return null;
  if (name === 'earthonline' && oldConnector(servers[name])) return null;
  return name;
}
async function replaceConnector(command, config, servers) {
  if (!Object.hasOwn(servers, 'earthonline') || ownServer(servers.earthonline)) return Object.hasOwn(config.replaced ?? {}, 'earthonline') ? 'replaced' : 'not present';
  if (!oldConnector(servers.earthonline)) throw new Error('The existing earthonline connection cannot be replaced safely; it was kept.');
  config.replaced ??= {};
  if (!object(config.replaced)) throw new Error('The saved connector backup cannot be read; the connector was kept.');
  if (Object.hasOwn(config.replaced, 'earthonline') && JSON.stringify(config.replaced.earthonline) !== JSON.stringify(servers.earthonline)) {
    throw new Error('A previous EarthOnline connector backup is still pending; the current connector was kept.');
  }
  say("Replacing your earlier EarthOnline MCP connection 'earthonline' with this one, so its tools are not listed twice. It is backed up; uninstall puts it back. To keep both: --keep-earthonline.");
  config.replaced.earthonline = servers.earthonline;
  saveConfig(config); // Persist the original before removing the same-named entry.
  await claude(command, ['mcp', 'remove', 'earthonline', '--scope', 'user']);
  return 'replaced';
}
async function restoreClaudeConnector(command, config) {
  if (!Object.hasOwn(config.replaced ?? {}, 'earthonline')) return true;
  const current = claudeServers(), saved = JSON.stringify(config.replaced.earthonline);
  if (Object.hasOwn(current, 'earthonline')) {
    if (JSON.stringify(current.earthonline) === saved) return true;
  } else if (command && restorable(config.replaced.earthonline)) {
    try {
      await claude(command, ['mcp', 'add-json', 'earthonline', saved, '--scope', 'user']);
      return true;
    } catch { /* Keep the backup for a later retry. */ }
  }
  say('Could not restore the EarthOnline connector. Its private backup remains in config.json; resolve any existing earthonline entry and retry.');
  return false;
}
function restoreCodexConnector(text, file, quiet = false) {
  if (!text.split('\n').some(line => line.startsWith(OFF))) return text;
  if (foreignEol(text)) {
    if (!quiet) say(`Could not restore the earlier EarthOnline connector in ${file}: an active earthonline entry exists; its commented backup was kept.`);
    return text;
  }
  return withEarthonlineBack(text);
}
// A refusal found before anything is written: stderr only, no live.log line.
class Preflight extends CliError { constructor(message) { super('conflict', message, { exit: EXIT.unexpected }); } }
const SAME = "A different MCP server named %N is already set up; it was left as it is. Remove it yourself if you want EarthOnline's, then run npx earthonline again, or use --keep-earthonline for earthonline-local.";
// Name each harness registers under. --keep-earthonline means earthonline-local; a bare --mode keeps what is already there.
function agentNames(opts, config, servers) {
  const LOCAL = 'earthonline-local';
  if (opts.keepEarthonline) return { claude: LOCAL, codex: LOCAL };
  if (!opts.mode) return { claude: 'earthonline', codex: 'earthonline' };
  const claude = ownServer(servers.earthonline) ? 'earthonline' : ownServer(servers[LOCAL]) ? LOCAL : 'earthonline';
  return { claude, codex: config.codexMcpName === LOCAL ? LOCAL : 'earthonline' };
}
function codexConflict(config, keep) {
  try { codexCommand(); } catch { return null; }
  const file = codexConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw new Preflight(`Codex's ${file} cannot be read; it was not changed.`); }
  const name = keep ? 'earthonline-local' : 'earthonline';
  const base = keep ? restoreCodexConnector(withoutBlock(text, config.codexBlock?.separator), file, true) : (withoutEarthonline(text) ?? text);
  return foreignEol(base, name) ? name : null;
}
async function install(opts) {
  const found = detect();
  const unsupported = found.filter(h => !h.supported).map(h => h.name);
  if (unsupported.length) say(`Also found ${unsupported.join(', ')}: not supported yet.`);
  const agents = opts.agents ?? found.filter(h => h.supported).map(h => h.id);
  if (!agents.length) throw new Error(`No supported agent found (${Object.values(SUPPORTED).join(', ')}). Install one, or name it with --agent ${Object.keys(SUPPORTED).join('|')}.`);
  say(`Connecting ${agents.map(id => SUPPORTED[id]).join(' and ')} to EarthOnline MCP.`);
  const value = agents.includes('claude-code') ? settings() : null, config = load(PATHS.config);
  const names = agentNames(opts, config, value ? claudeServers() : {});
  const ccOpts = { ...opts, keepEarthonline: names.claude === 'earthonline-local' };
  const codexOpts = { ...opts, keepEarthonline: names.codex === 'earthonline-local' };
  // Both harnesses are checked before sign-in or any write.
  if (value) {
    const conflict = claudeConflict(claudeServers(), ccOpts);
    if (conflict) throw new Preflight(SAME.replace('%N', conflict));
  }
  if (agents.includes('codex')) {
    const conflict = codexConflict(config, codexOpts.keepEarthonline);
    if (conflict) throw new Preflight(SAME.replace('%N', conflict));
  }
  if (opts.keepEarthonline) config.keepEarthonline = true;
  else if (!opts.mode) delete config.keepEarthonline;
  // (0.2.0, design 1026 §5.5) 0.1.0's groups mode hid 76 of the 81 tools, a removal of capability: it is gone, and a
  // saved 'groups' from 0.1.0 is dropped here (mcp.mjs ignores it too)
  if (opts.mode) config.mode = opts.mode;
  else if (config.mode === 'groups') delete config.mode;
  // `base`: a sign-in that has just saved its origin (finishLogin); --origin: this run's; else the saved one
  const base = opts.base ?? (opts.origin ? checkOrigin(opts.origin) : origin());
  if (/["\r\n$`]/.test(livePath)) throw new Error('The app path contains characters that cannot be safely used in a hook command. Choose another EOL_HOME.');
  const warnings = [];
  const handle = await signIn(base, opts.keyStdin, Boolean(opts.reuseKey || opts.mode), warnings);
  if (opts.origin) config.origin = base;
  config.handle = handle.replace(/^@/, ''); // so a push can say a message "mentions you"
  saveConfig(config);
  fs.mkdirSync(PATHS.app, { recursive: true, mode: 0o700 });
  for (const file of [...APP_FILES, 'INSTALL.md']) {
    const source = path.join(here, file);
    if (!fs.existsSync(source)) { say(`Package file missing: ${file}; skipped.`); continue; }
    if (path.resolve(source) !== path.resolve(PATHS.app, file)) fs.copyFileSync(source, path.join(PATHS.app, file));
  }
  const done = [];
  if (value) done.push(await installClaude(value, config, ccOpts, Boolean(opts.mode) && !opts.keepEarthonline));
  if (agents.includes('codex')) done.push(await installCodex(config, codexOpts));
  if (!value && agents.includes('codex')) warnings.push(...await codexDelivery());
  say(`Signed in as @${handle.replace(/^@/, '')}. ${done.join('  ')} New sessions load the EarthOnline tools; sessions already open do not.`);
  return { handle: handle.replace(/^@/, ''), agents: done, warnings };
}
/**
 * (msg-core Task 9) A computer set up for Codex alone, on an account whose server has per-endpoint delivery settings: the
 * installer records that it saw them (config.delivery, which live.mjs endpointDelivery reads; installClaude does it through
 * syncClaudeDelivery), so Codex threads follow the owner's per-session settings instead of the 0.1.0 runtime. 'off' only
 * says no Claude Code session is fast yet, as syncClaudeDelivery would; Claude Code's hooks are not touched. -> warnings
 */
async function codexDelivery() {
  const config = load(PATHS.config);
  if (config.delivery !== undefined) return [];
  let policy;
  try { policy = await deliverySettings(); } catch {
    return [{ step: 'delivery', host: 'codex', error: "EarthOnline's delivery settings could not be read; Codex threads use the 0.1.0 delivery until they are.", fix: 'npx earthonline setup --agent codex' }];
  }
  if (policy) { config.delivery = 'off'; saveConfig(config); }
  return [];
}
// How a Codex app thread is woken: fast or off (fast measured
// 10-20 on Bonan's machine, it does not take the focus), default fast since 0.2.1 (Bonan 10-29: "对，默认改成fast"); a wake
// already saved (an owner's off included) is kept. wakeName is codex-live.mjs's, so an old quiet
// (saved by 0.1.x, or in an old script's --codex-wake) reads as off here exactly as the delivery reads it.
const WAKES = { off: 'Off: nothing enters the thread; the agent sees new messages at its next eol_ call', fast: 'Fast: queue it and wake the Codex app (about 3 s)' };
async function installCodex(config, opts) {
  let found = true;
  try { codexCommand(); } catch { found = false; }
  if (!found) return 'Codex ✗ (executable not found; set EOL_CODEX_BIN to codex.exe or bin/codex.js).';
  // Plain codex and the Codex app share config.toml: our marked section there connects both (Bonan approved 10-20:
  // only our own section, backed up first, removed by uninstall, said here).
  const file = codexConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw new Error(`Codex's ${file} cannot be read; it was not changed.`); }
  const name = opts.keepEarthonline ? 'earthonline-local' : 'earthonline';
  const restored = opts.keepEarthonline ? restoreCodexConnector(withoutBlock(text, config.codexBlock?.separator), file) : text;
  const off = opts.keepEarthonline ? null : withoutEarthonline(text);
  const base = off ?? restored;
  if (foreignEol(base, name)) {
    say(`A different MCP server named ${name} is already in ${file}; it was left as it is. Remove it yourself if you want EarthOnline's, then run npx earthonline again.`);
    return `Codex ✗ (a different MCP server owns the name ${name}).`;
  }
  const next = withBlock(base, codexBlock({ node: process.execPath, mcp: mcpPath, eolHome: PATHS.home, codexHomeDir: codexHome(), name }));
  if (next.text !== text) {
    let backup = null;
    if (fs.existsSync(file)) { backup = `${file}.eol-backup-${Date.now()}-${process.pid}`; fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
    if (off !== null) say(`Turning off your earlier EarthOnline MCP connection 'earthonline' in ${file} (its lines are commented out with "${OFF.trim()}"), so its tools are not listed twice. Uninstall turns it back on. To keep both: --keep-earthonline.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next.text);
    if (next.separator !== null) config.codexBlock = { separator: next.separator };
    say(`Codex: added EarthOnline MCP to ${file}: only the lines between the "eol-connect" markers${backup ? `; the file before it is ${backup}` : ''}. The Codex app and plain codex load it in new threads; uninstall removes it.`);
  }
  // How a thread in the Codex app is woken when a message comes: asked once (the web's setting wins once it exists). Enter
  // keeps the saved choice, else fast.
  let wake = wakeName(opts.codexWake) ?? wakeName(config.codexWake);
  if (!opts.codexWake && !opts.keyStdin && interactive()) {
    const q = questions();
    const current = wake ?? 'fast';
    try {
      const answer = await q.ask(`When a message arrives for a thread in the Codex app:\n  1) ${WAKES.fast}${current === 'fast' ? ' [default]' : ''}\n  2) ${WAKES.off}${current === 'off' ? ' [default]' : ''}\nChoose 1 or 2: `, true);
      wake = answer === '1' ? 'fast' : answer === '2' ? 'off' : current;
    } finally { q.close(); }
  }
  config.codexMcpName = name;
  config.codexWake = wake ?? 'fast';
  saveConfig(config);
  say(`Codex: a thread is connected from its first eol_ tool call. Waking: ${WAKES[config.codexWake]}. Change it with npx earthonline --agent codex --codex-wake fast|off. A terminal session with instant delivery: npx earthonline codex.`);
  return `Codex ✓ (app and CLI; wake: ${config.codexWake}).`;
}
async function installClaude(value, config, opts, modeOnly = false) {
  const command = claudeCommand();
  const servers = claudeServers();
  const name = opts.keepEarthonline ? 'earthonline-local' : 'earthonline';
  const conflict = claudeConflict(servers, opts);
  if (conflict) throw new Error(`A different MCP server named ${conflict} is already set up; it was left as it is. Remove it yourself if you want EarthOnline's, then run npx earthonline again.`);
  // (msg-core Task 9) an account whose server has per-endpoint delivery settings: the hooks follow them (syncClaudeDelivery);
  // an older server: the hooks are installed as before
  saveConfig(config);
  const policy = await deliverySettings();
  if (policy) {
    await syncClaudeDelivery(policy);
    Object.assign(config, load(PATHS.config));
  } else {
    delete config.delivery;
    installHooks(value, config);
  }
  if (Object.entries(value.enabledPlugins ?? {}).some(([name, on]) => name.startsWith('eol-chat@') && on === true)) say('The old eol-chat plugin is on: turn it off first with `claude plugin disable eol-chat@earthonline`, or both will answer.');
  let cc = '✗ (Claude Code CLI not found or its launcher is unsupported)';
  let connector = opts.keepEarthonline ? 'kept (--keep-earthonline)' : 'not replaced';
  if (command) {
    try {
      if (!opts.keepEarthonline) connector = await replaceConnector(command, config, servers);
      if (ownServer(servers[name])) {
        await claude(command, ['mcp', 'remove', name, '--scope', 'user']);
        config.claudeMcp = false;
        saveConfig(config);
      }
      await claude(command, ['mcp', 'add', '--scope', 'user', name, '--', 'node', mcpPath, '--harness', 'claude-code']);
      // Remove our former registrations only after the new one is in place.
      for (const oldName of ['eol', 'earthonline-local', 'earthonline']) {
        if (oldName === name) continue;
        if (ownServer(servers[oldName])) await claude(command, ['mcp', 'remove', oldName, '--scope', 'user']);
      }
      if (opts.keepEarthonline && !modeOnly && await restoreClaudeConnector(command, config)) {
        if (Object.hasOwn(config.replaced ?? {}, 'earthonline')) {
          delete config.replaced.earthonline;
          connector = 'restored (--keep-earthonline)';
        }
      }
      config.claudeMcp = true;
      saveConfig(config);
      cc = '✓';
    } catch { cc = '✗ (MCP registration failed; any connector backup was kept)'; log('claude_registration_failed'); }
  }
  if (cc !== '✓') say(`Run manually: claude mcp add --scope user ${name} -- node "${mcpPath}" --harness claude-code`);
  if (cc === '✓' && ['live.mjs', 'format.mjs', 'receipt.mjs'].some(file => !fs.existsSync(path.join(PATHS.app, file)))) cc = '✗ (listener files missing from this package)';
  return `Claude Code ${cc}  Earlier EarthOnline MCP connection: ${connector}.`;
}
async function processArgs(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; }
  }
  try {
    const { stdout } = process.platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, timeout: 5000 })
      : await exec('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 5000 });
    return (stdout.match(/"[^"]*"|[^\s]+/g) ?? []).map(s => s.replace(/^"|"$/g, ''));
  } catch { return []; }
}
async function listeners() {
  if (!fs.existsSync(PATHS.live)) return { confirmed: [], unverified: [] };
  const found = [], unverified = [];
  for (const file of fs.readdirSync(PATHS.live)) {
    if (!file.endsWith('.pid')) continue;
    const data = readJson(path.join(PATHS.live, file));
    const pid = Number(object(data) ? data.pid : data);
    if (!pidAlive(pid)) continue;
    const args = await processArgs(pid);
    if (!args.length) { unverified.push(pid); continue; }
    const normalize = p => process.platform === 'win32' ? slash(path.resolve(p)).toLowerCase() : path.resolve(p);
    const i = args.findIndex(a => normalize(a) === normalize(livePath));
    if (i === 1 && args[i + 1] === 'run' && /^node(?:\.exe)?$/i.test(path.basename(args[0]))) found.push(pid);
  }
  return { confirmed: [...new Set(found)], unverified: [...new Set(unverified)] };
}
async function uninstall() {
  if (activeCodexWrappers()) throw new Error('Close EOL Codex sessions before uninstalling. Nothing was removed.');
  const config = load(PATHS.config);
  const servers = claudeServers();
  removeHooks(config);
  const command = claudeCommand();
  for (const name of ['earthonline', 'earthonline-local', 'eol']) {
    if (!ownServer(servers[name])) continue;
    if (command) {
      try { await claude(command, ['mcp', 'remove', name, '--scope', 'user']); }
      catch { say(`Could not remove the MCP entry. Run: claude mcp remove ${name} --scope user`); }
    } else say(`Run manually: claude mcp remove ${name} --scope user`);
  }
  const keepConfig = !await restoreClaudeConnector(command, config);
  // Codex: only our marked section of config.toml goes; the file is backed up first.
  const codexFile = codexConfigFile();
  let codexText = null;
  try { codexText = fs.readFileSync(codexFile, 'utf8'); } catch { /* no config.toml: nothing of ours there */ }
  if (codexText !== null && (hasOurBlock(codexText) || codexText.includes(OFF))) {
    const backup = `${codexFile}.eol-backup-${Date.now()}-${process.pid}`;
    fs.copyFileSync(codexFile, backup, fs.constants.COPYFILE_EXCL);
    const removed = withoutBlock(codexText, config.codexBlock?.separator);
    const restored = restoreCodexConnector(removed, codexFile);
    fs.writeFileSync(codexFile, restored);
    say(`Removed EarthOnline MCP from ${codexFile}${restored !== removed ? " and turned your earlier 'earthonline' connection back on" : ''} (the file before: ${backup}). Restart the Codex app so open threads drop it.`);
  }
  for (const file of removeSkills()) say(`Removed the EarthOnline skill ${file}.`);
  say('Active EOL Codex sessions: ' + activeCodexWrappers() + '.');
  const running = await listeners();
  for (const pid of running.confirmed) {
    try { process.kill(pid); }
    catch { if (pidAlive(pid)) say(`Could not stop listener PID ${pid}.`); }
  }
  if (running.unverified.length) say(`Could not verify ${running.unverified.length} recorded process(es); left them running.`);
  for (const file of [PATHS.app, PATHS.live, PATHS.key, PATHS.pending, ...(!keepConfig ? [PATHS.config] : [])]) fs.rmSync(file, { recursive: true, force: true });
  if (keySource() === 'env') say('EOL_KEY is still set in the environment; unset it to sign this computer out completely.');
  say('EarthOnline uninstalled. Settings backups and live.log were kept.');
}
/** Whether the app EOL_HOME/app holds is this package's own files (an `npx earthonline@latest` after an upgrade: not yet). */
function appState() {
  if (!fs.existsSync(path.join(PATHS.app, 'mcp.mjs'))) return 'missing';
  if (path.resolve(here) === path.resolve(PATHS.app)) return 'current';
  for (const file of APP_FILES) {
    let mine, theirs;
    try { mine = fs.readFileSync(path.join(here, file), 'utf8'); theirs = fs.readFileSync(path.join(PATHS.app, file), 'utf8'); } catch { return 'outdated'; }
    if (mine !== theirs) return 'outdated';
  }
  return 'current';
}
/**
 * status and doctor: one report. status says it (exit 0: a question answered); doctor makes each problem a warning with its
 * fix, so the exit code is the verdict: 0 nothing to fix, 3 not signed in, 4 EarthOnline not reached, 5 something else to fix.
 * Copied from `brew doctor` and `npm doctor`, which exit non-zero when there is something to fix (https://docs.brew.sh/Manpage,
 * https://docs.npmjs.com/cli/commands/npm-doctor, viewed 2026-10-26).
 */
async function status(opts = {}, { doctor = false } = {}) {
  const problems = [];
  const key = readKey(), source = keySource(), from = source === 'env' ? ' (the key in EOL_KEY)' : '';
  const base = opts.origin ? checkOrigin(opts.origin) : origin();
  const report = { signed_in: false, handle: null, key_source: key ? source : null, origin: base };
  if (!key) {
    say(source === 'env' ? 'EOL_KEY is set but is not an EarthOnline key.' : 'Not signed in.');
    problems.push(source === 'env'
      ? { step: 'sign-in', error: 'EOL_KEY is set but is not an EarthOnline key.', fix: 'Unset EOL_KEY, or set it to a key.' }
      : { step: 'sign-in', error: 'This computer is not signed in to EarthOnline.', fix: LOGIN_NEXT[0] });
  } else {
    try {
      const result = await callTool(base, 'eol_whoami', {}, key);
      if (!result.robot?.handle) throw new Error('EarthOnline did not say whose key this is.');
      Object.assign(report, { signed_in: true, handle: result.robot.handle.replace(/^@/, '') });
      say(`Signed in as @${report.handle}${from}.`);
    } catch (err) {
      if (err?.code === 'signed_out') {
        say(`Signed out: the key${from} was revoked or is not valid. Sign in again: ${LOGIN_NEXT[0]}`);
        problems.push({ step: 'sign-in', error: `The key${from} was revoked or is not valid.`, fix: LOGIN_NEXT[0] });
      } else {
        report.signed_in = null; // not known: EarthOnline was not reached
        say('Sign-in could not be confirmed.');
        problems.push({ step: 'network', error: String(err?.message ?? err), fix: 'Check the connection, then run: npx earthonline doctor' });
      }
    }
  }
  const found = detect();
  report.found = found.map(h => ({ id: h.id, name: h.name, supported: h.supported }));
  say(`Found: ${found.length ? found.map(h => h.supported ? h.name : `${h.name} (not supported yet)`).join(', ') : 'no agent programs'}.`);
  // only with a key EarthOnline just accepted: a revoked key or no connection is reported above, not a crash here
  const policy = report.signed_in ? await deliverySettings().catch(() => null) : null;
  if (policy) await syncClaudeDelivery(policy);
  const value = settings(), config = load(PATHS.config);
  if (policy) say(`Claude Code delivery: ${config.delivery ?? 'off'}${config.claudeHooksRemoved ? ' (owner removed a hook; not reinstalled)' : ''}.`);
  const installedHooks = Object.keys(events).filter(e => value.hooks?.[e]?.some(g => g.hooks?.some(ownHook))).length;
  report.app = appState();
  say(`Claude Code: ${installedHooks}/${Object.keys(events).length} hooks; MCP ${config.claudeMcp ? 'registered by installer' : 'not registered by installer'}; app ${report.app === 'missing' ? 'missing' : 'installed'}.`);
  let codex = false; try { codexCommand(); codex = true; } catch {}
  let section = false; try { section = hasOurBlock(fs.readFileSync(codexConfigFile(), 'utf8')); } catch {}
  say(`Codex: ${codex ? 'executable found' : 'executable not found (set EOL_CODEX_BIN)'}; config.toml ${section ? "has EarthOnline's section (the Codex app and plain codex)" : 'has no EarthOnline section'}; wake: ${wakeName(config.codexWake) ?? 'fast'}.`);
  const sessions = activeCodexWrappers();
  say('Active EOL Codex sessions: ' + sessions + '.');
  const running = await listeners();
  say(`Running Claude Code listeners: ${running.confirmed.length}${running.unverified.length ? ` (${running.unverified.length} recorded process(es) could not be verified)` : ''}`);
  // what was set up on this computer, and whether each part is still there
  const setUp = [...(config.claudeMcp ? ['claude-code'] : []), ...(section ? ['codex'] : [])];
  const skills = checkSkills(setUp);
  if (skills.length) say(`Skills: ${skills.map(k => `${SUPPORTED[k.host] ?? k.host} ${k.status}`).join(', ')}.`);
  const skillOf = host => skills.find(k => k.host === host)?.status ?? null;
  report.claude_code = { mcp: Boolean(config.claudeMcp), hooks: installedHooks, delivery: policy ? (config.delivery ?? 'off') : null, listeners: running.confirmed.length, skill: skillOf('claude-code') };
  report.codex = { executable: codex, config: section, wake: wakeName(config.codexWake) ?? 'fast', sessions, skill: skillOf('codex') };
  if (!setUp.length) {
    const supported = found.filter(h => h.supported);
    problems.push(supported.length
      ? { step: 'setup', error: `EarthOnline is not set up for ${supported.map(h => h.name).join(' or ')} on this computer.`, fix: 'npx earthonline setup' }
      : { step: 'agents', error: 'No supported agent program was found (Claude Code, Codex).', fix: 'Install Claude Code or Codex, then run: npx earthonline setup. Without one: npx earthonline call <eol_tool> --input -' });
  } else if (report.app !== 'current') {
    problems.push({ step: 'app', error: report.app === 'missing' ? `The EarthOnline app is missing from ${PATHS.app}.` : `The EarthOnline app in ${PATHS.app} is from another version of earthonline.`, fix: 'npx earthonline setup' });
  }
  for (const k of skills) {
    if (k.status === 'ok') continue;
    const name = SUPPORTED[k.host] ?? k.host;
    problems.push(k.status === 'foreign'
      ? { step: 'skill', host: k.host, error: `A different skill named earthonline is at ${k.path}, so ${name} does not get EarthOnline's.`, fix: `Remove ${path.dirname(k.path)} if it is not yours to keep, then run: npx earthonline setup` }
      : { step: 'skill', host: k.host, error: `${name}'s EarthOnline skill is ${k.status === 'missing' ? 'missing' : 'from another version'} (${k.path}).`, fix: `npx earthonline setup --agent ${k.host}` });
  }
  if (!doctor) { out.done({ status: 'ok', ...report, problems, warnings: [], next: [] }); return EXIT.ok; }
  const code = out.done({ ...report, warnings: problems, next: [] }, problems.length ? null : 'No problems found.');
  if (problems.some(p => p.step === 'sign-in')) return EXIT.auth;
  if (problems.some(p => p.step === 'network')) return EXIT.network;
  return code;
}
const USAGE = [
  'Usage: earthonline [--origin URL] [--json] [command]',
  "  login --email <email> [--handle <handle>] [--name <name>] [--resend]   email your owner an 8-letter code; returns at once",
  '  login --code <code> | --code-stdin [--handle <handle>] [--name <name>] [--no-setup] [--no-skill]   sign in with it, then set up',
  '  login --device [--wait <seconds>] [--no-setup] [--no-skill]   approve on one web page; a re-run waits for it (60 s, at most 540)',
  '  login --key-stdin [--no-setup]   sign in with a key read from stdin, never from an argument',
  '  setup [--agent claude-code,codex] [--no-skill] [--desk] [--codex-wake fast|off] [--keep-earthonline] [--mode legacy | --full]',
  "    MCP config, the skill file and this Claude Code session's listener; --desk also has your agent answer people for you (EarthOnline credit)",
  '  call <eol_tool> [--input -]   any EarthOnline tool; its arguments as JSON on stdin; prints the result',
  '  feedback "<text>" | feedback -   a message to @earthonline; the answer comes back as a message',
  '  embed [--file <page>] [--site <site>] [--mode <type>] [--id <embed id>]   your chat on the pages of this project; AGENTS.md says how to change it',
  '  agents-md --link-claude   adds @AGENTS.md to CLAUDE.md here, so Claude Code reads AGENTS.md too',
  '  watch [@handle] [--for <seconds>]   your conversations as they happen (without a terminal it stops after 60 s)',
  '  key rotate --device | --email <email>   a new key by signing in again (then login --code / --device as told); the old one is revoked',
  '  status | doctor   what is set up here; doctor exits 3 not signed in, 4 not reached, 5 something to fix (each with its fix)',
  '  uninstall | codex [resume UUID] | cursor [install|uninstall|status]',
  'With no command: at a terminal, sign in by answering questions, then set up; without one, the two login commands to run.',
  'Exit codes: 0 done, 1 unexpected, 2 input needed, 3 sign-in refused, 4 network or try later, 5 signed in but a setup step failed.',
].join('\n');
const usage = () => new CliError('usage', USAGE, { exit: EXIT.input });
/** (car11 A4) Commands in their own modules: each exports `async (args, out) -> exit code` on contract.mjs; loaded only when run. */
const MODULES = Object.freeze({
  call: ['./call.mjs', 'callCommand'], feedback: ['./call.mjs', 'feedbackCommand'],
  embed: ['./embed.mjs', 'embedCommand'], 'agents-md': ['./embed.mjs', 'agentsMdCommand'], watch: ['./watch.mjs', 'watchCommand'],
});

async function main(argv = process.argv.slice(2)) {
  const args = [...argv], opts = {};
  // --origin and --json may come before the command: the setup block runs `npx -y earthonline@latest --origin <base> login …`
  while (args[0] === '--json' || (args[0] === '--origin' && args.length > 1)) { if (args.shift() === '--json') opts.json = true; else opts.origin = args.shift(); }
  if (args[0] === 'cursor') {
    const { cursorCommand } = await import('./cursor.mjs');
    await cursorCommand([...args.slice(1), ...(opts.origin ? ['--origin', opts.origin] : [])]); return;
  }
  if (args[0] === 'codex') { process.exitCode = await launchCodex(args.slice(1)); return; }
  if (args.includes('--json')) opts.json = true;
  out = makeOut(Boolean(opts.json));
  if (Object.hasOwn(MODULES, args[0])) {
    // --json and --origin are this program's wherever they stand; the rest is the command's own
    const rest = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] === '--origin' && i + 1 < args.length) { opts.origin = args[++i]; continue; }
      rest.push(args[i]);
    }
    if (opts.origin) {
      try { process.env.EOL_ORIGIN = checkOrigin(opts.origin); } catch (err) { throw new CliError('invalid_input', err.message, { exit: EXIT.input, field: 'origin' }); }
    }
    const [file, name] = MODULES[args[0]];
    process.exitCode = await (await import(file))[name](rest, out);
    return;
  }
  let action = 'install';
  if (['uninstall', 'status', 'doctor', 'login', 'setup'].includes(args[0])) action = args.shift();
  else if (args[0] === 'key') {
    // key rotate: a sign-in (any login flags) that also revokes the key it replaces (rotate.mjs)
    args.shift();
    if (args.shift() !== 'rotate') throw usage();
    action = 'login'; opts.rotate = true;
  }
  const installs = action === 'install' || action === 'setup', isLogin = action === 'login';
  const value = () => { if (!args.length || /^--./.test(args[0])) throw usage(); return args.shift(); };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') opts.json = true;
    else if (arg === '--origin') opts.origin = value();
    else if (action === 'install' && arg === '--key-stdin') opts.keyStdin = true;
    else if (installs && arg === '--replace-earthonline') opts.replaceEarthonline = true; // the default since 10-20; still accepted
    else if (installs && arg === '--keep-earthonline') opts.keepEarthonline = true;
    else if ((installs || isLogin) && ['--agent', '-a'].includes(arg)) (opts.agents ??= []).push(...value().split(',').map(s => s.trim()).filter(Boolean));
    else if (installs && arg === '--codex-wake' && wakeName(args[0])) opts.codexWake = wakeName(args.shift());
    else if (installs && arg === '--mode' && args[0] === 'groups') throw new CliError('mode_removed', 'The groups mode was removed in earthonline 0.2.0: every EarthOnline tool is available, group chat included. Run npx earthonline without --mode.', { exit: EXIT.input });
    else if (installs && arg === '--mode' && args[0] === 'legacy') opts.mode = args.shift();
    else if (installs && arg === '--full') opts.mode = 'legacy';
    else if ((installs || isLogin) && arg === '--no-skill') opts.noSkill = true;
    else if (action === 'setup' && arg === '--desk') opts.desk = true; // car11 Decision 6: the desk only when asked, only here
    else if (isLogin && arg === '--email') opts.email = value();
    else if (isLogin && arg === '--handle') opts.handle = value().replace(/^@/, '');
    else if (isLogin && arg === '--name') opts.name = value();
    else if (isLogin && arg === '--code') opts.code = value();
    else if (isLogin && arg === '--code-stdin') opts.codeStdin = true;
    else if (isLogin && arg === '--key-stdin') opts.keyStdin = true;
    else if (isLogin && arg === '--resend') opts.resend = true;
    else if (isLogin && arg === '--no-setup') opts.noSetup = true;
    else if (isLogin && arg === '--device') opts.device = true;
    else if (isLogin && arg === '--wait') {
      const s = value();
      if (!/^\d+$/.test(s) || Number(s) > MAX_WAIT_S) throw new CliError('invalid_input', `--wait takes whole seconds from 0 to ${MAX_WAIT_S} (a shell gives a command at most 10 minutes).`, { exit: EXIT.input, field: 'wait' });
      opts.wait = Number(s);
    }
    else throw usage();
  }
  if (opts.origin) {
    try { opts.origin = checkOrigin(opts.origin); } catch (err) { throw new CliError('invalid_input', err.message, { exit: EXIT.input, field: 'origin' }); }
    // The flag is this run's EOL_ORIGIN: every request of the run goes there, live.mjs's settings calls included
    process.env.EOL_ORIGIN = opts.origin;
  }
  if (opts.agents) {
    // Wording as in add-mcp (src/index.ts) for a name it does not know.
    const later = others().filter(h => opts.agents.includes(h.id)).map(h => h.name);
    if (later.length) throw new CliError('invalid_input', `${later.join(', ')}: not supported yet. Valid agents: ${Object.keys(SUPPORTED).join(', ')}`, { exit: EXIT.input });
    const invalid = opts.agents.filter(id => !Object.hasOwn(SUPPORTED, id));
    if (invalid.length) throw new CliError('invalid_input', `Invalid agents: ${invalid.join(', ')}\nValid agents: ${Object.keys(SUPPORTED).join(', ')}`, { exit: EXIT.input });
    opts.agents = [...new Set(opts.agents)];
  }
  if (action === 'uninstall') await uninstall();
  else if (action === 'status' || action === 'doctor') process.exitCode = await status(opts, { doctor: action === 'doctor' });
  else if (action === 'login') process.exitCode = await login(opts);
  else {
    // setup: the saved sign-in, never a question; then setup.mjs (MCP config, skill, this session's listener, --desk)
    if (action === 'setup' && !readKey()) throw new CliError('missing_input', 'This computer is not signed in to EarthOnline yet.', { exit: EXIT.input, next: LOGIN_NEXT });
    const done = await runSetup({ ...opts, reuseKey: action === 'setup' }, { install, say });
    if (opts.mode) say(`Mode set to ${opts.mode}. Start a new session to see the change.`);
    process.exitCode = out.done(done);
  }
}

/** The end of a failed run: the error by the contract (contract.mjs), and a live.log line unless it was the caller's input. */
function failed(err) {
  if (!(err instanceof Preflight) && !(err instanceof CliError && err.exit === EXIT.input)) log('cli_failed', err instanceof CliError ? { code: err.code } : {});
  return (out ??= makeOut(process.argv.includes('--json'))).fail(err);
}
/** bin.mjs's way in, after its Node check. */
export const run = () => main().catch(err => { process.exitCode = failed(err); });

export { installHooks, removeHooks, settings, saveConfig, settingsFile };
// Cursor uses Task 9's lossless writer and exclusive backups, not a second implementation.
export { load, saveSettings, signIn };

// live.mjs and cursor.mjs import this file: only the program itself runs main. isMain compares real paths, since npm's
// bin on macOS and Linux is a symlink (process.argv[1] is the link, import.meta.url the file it points to).
if (isMain(import.meta.url)) main().catch(err => {
  process.exitCode = failed(err);
});
