// The sign-in commands without a terminal (research/cli-onboarding-design-1026.md §10, §12; §13 A1, A5, A6), against two fake
// EarthOnline servers on loopback port 0: A (named with --origin) and B (EOL_ORIGIN, standing in for the default, since
// require-origin.mjs keeps every test off the live site). No Mongo, no mail, no harness is set up. Runs on Node 18 or later.
// The fake answers in the shapes of car11 W9 (eol_login step 1 { sent, email, to, expires_at, expires_in,
// resend_after_seconds, handle? }, step 2 { robot, key, created, handle? }) and errors as tools.js errorBody does.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const newKey = () => 'eolc_' + randomBytes(20).toString('hex');
const KEY = newKey(), ENV_KEY = newKey(), REVOKED = newKey();
const CODE = 'WDJBMJHT';
const LEAK = newKey(); // a key-shaped string inside a server message: it must never reach the output
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-login-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // a harness to find, so a bare run gets as far as signing in
const pendingFile = path.join(eolHome, 'pending-login.json'), keyFile = path.join(eolHome, 'key'), configFile = path.join(eolHome, 'config.json');
let captured = '';

function fakeServer(label) {
  const calls = [];
  let lastSend = 0;
  const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const refuse = (res, status, error) => reply(res, status, { ok: false, error });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const name = req.url.replace(/^\/api\/tools\//, '');
    const args = raw ? JSON.parse(raw) : {};
    calls.push({ name, args, auth: req.headers.authorization ?? null, ua: req.headers['user-agent'] ?? '' });
    if (req.method === 'GET' && req.url === '/api/tools') return reply(res, 200, { ok: true, result: { tools: [] } }); // no delivery settings
    if (name === 'eol_whoami') {
      const handle = { [`Bearer ${KEY}`]: '@ada', [`Bearer ${ENV_KEY}`]: '@envbot' }[req.headers.authorization];
      return handle ? reply(res, 200, { ok: true, result: { robot: { handle } } }) : refuse(res, 401, { code: 'unauthorized', message: 'Sign in first.' });
    }
    if (name !== 'eol_login') return refuse(res, 404, { code: 'not_found', message: 'No such tool.' });
    if (!args.code) {
      if (Date.now() - lastSend < 30000) return refuse(res, 429, { code: 'rate_limited', message: 'A code was sent less than 30 seconds ago.', retry_after_seconds: 30, reason: 'resend_gap' });
      lastSend = Date.now();
      const hint = args.handle ? (args.handle === 'taken' ? { wanted: 'taken', available: false, reason: 'taken', suggestions: ['taken2', 'taken3'] } : { wanted: args.handle, available: true, reason: null, suggestions: [] }) : null;
      return reply(res, 200, { ok: true, result: { sent: true, email: args.email, to: 'a***@example.test', expires_at: new Date(Date.now() + 600000).toISOString(), expires_in: 600, resend_after_seconds: 30, ...(hint ? { handle: hint } : {}) } });
    }
    if (args.code !== CODE) return refuse(res, 400, { code: 'invalid_argument', field: 'code', message: `That code is wrong or has expired (${LEAK}).` });
    const claimed = args.handle && args.handle !== 'taken';
    return reply(res, 200, { ok: true, result: { robot: { handle: claimed ? '@' + args.handle : '@ada' }, key: KEY, key_id: 'k1', created: true, ...(args.handle ? { handle: { wanted: args.handle, claimed, reason: claimed ? null : 'taken', suggestions: claimed ? [] : ['taken2', 'taken3'] } } : {}) } });
  });
  return { label, calls, server, start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

const A = fakeServer('A'), B = fakeServer('B');
const baseEnv = () => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: path.join(home, '.codex'), EOL_CLAUDE_BIN: path.join(home, 'no-claude') };
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete env[k];
  return env;
};
function cli(args, { input = '', env = baseEnv(), entry = 'cli.mjs' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const p = spawn(process.execPath, [path.join(here, entry), ...args], { env, cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; captured += d; });
    p.stderr.on('data', d => { stderr += d; captured += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    p.stdin.end(input);
  });
}
const json = text => { const lines = text.trim().split('\n'); assert.equal(lines.length, 1, `one JSON line: ${text}`); return JSON.parse(lines[0]); };
const mode = file => fs.statSync(file).mode & 0o777;
/** Windows: the ACEs icacls lists for the file. */
function acl(file) {
  const text = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  return text.split(/\r?\n/).map(line => line.replace(file, '').trim()).filter(line => /:\(/.test(line));
}
function privateToMe(file, label) {
  if (process.platform !== 'win32') { assert.equal(mode(file), 0o600, `${label}: mode 0600`); return; }
  const aces = acl(file);
  assert.equal(aces.length, 1, `${label}: one entry in its ACL, got ${JSON.stringify(aces)}`);
  assert.ok(aces[0].toLowerCase().includes(os.userInfo().username.toLowerCase()) && !aces[0].includes('(I)'), `${label}: only this user, not inherited: ${aces[0]}`);
}

try {
  const a = await A.start(), b = await B.start();
  const envB = () => ({ ...baseEnv(), EOL_ORIGIN: b, EOL_REQUIRE_ORIGIN: '1' });

  // 1. No terminal and nothing to go on: never a prompt; exit 2 with the commands to run.
  let r = await cli(['login', '--json'], { env: envB() });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout');
  let e = json(r.stderr);
  assert.equal(e.code, 'missing_input');
  assert.ok(e.next.some(n => n.includes('login --email')) && e.next.some(n => n.includes('login --code')), 'next names both steps');
  r = await cli([], { env: envB() });
  assert.equal(r.code, 2, 'bare run, no key, no terminal: exit 2, not a prompt: ' + r.stderr);
  assert.ok(!/Email:/.test(r.stdout) && /Next: npx earthonline login --email/.test(r.stderr), 'a human run says what to run');
  r = await cli(['login', '--bogus'], { env: envB() });
  assert.equal(r.code, 2, 'usage is input: exit 2');
  console.log('PASS 1: without a terminal nothing is asked; exit 2 with both login commands');

  // 2. login --email with --origin first (the setup block's order): returns at once, code_sent, the handle hint, a private pending file.
  r = await cli(['--origin', a, 'login', '--email', 'ada@example.test', '--handle', 'taken', '--name', 'Ada', '--json'], { env: envB() });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 3000, `login --email returned in ${r.ms} ms`);
  let o = json(r.stdout);
  assert.equal(o.status, 'code_sent');
  assert.equal(o.to, 'a***@example.test');
  assert.equal(o.expires_in, 600);
  assert.deepEqual(o.handle, { wanted: 'taken', available: false, reason: 'taken', suggestions: ['taken2', 'taken3'] });
  assert.ok(o.next[0].includes('@taken2') && o.next.at(-1).includes('login --code'), 'next offers the free handles, then the code step');
  assert.deepEqual(o.warnings, []);
  assert.equal(A.calls.length, 1); assert.equal(B.calls.length, 0, '--origin sends the request to A only');
  assert.ok(A.calls[0].ua.startsWith('earthonline/') && A.calls[0].auth === null, 'no key on a sign-in call');
  assert.deepEqual(A.calls[0].args, { email: 'ada@example.test', handle: 'taken' }, 'the name waits for step 2');
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.equal(pending.origin, a); assert.equal(pending.email, 'ada@example.test'); assert.equal(pending.handle, 'taken'); assert.equal(pending.name, 'Ada');
  privateToMe(pendingFile, 'pending-login.json');
  console.log('PASS 2: login --email: exit 0 in under 3 s, code_sent, handle suggestions, --origin honoured, pending file private');

  // 3. A re-run after a kill resumes (no second email); --resend asks again and the 30 s gap is exit 4 with retry_after.
  r = await cli(['--origin', a, 'login', '--email', 'ADA@example.test', '--json'], { env: envB() });
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.resumed, true); assert.equal(o.status, 'code_sent');
  assert.equal(A.calls.length, 1, 'no second email');
  r = await cli(['login', '--resend', '--json'], { env: envB() });
  assert.equal(r.code, 4, r.stderr);
  e = json(r.stderr);
  assert.equal(e.code, 'rate_limited'); assert.equal(e.retry_after, 30); assert.equal(e.reason, 'resend_gap');
  assert.equal(A.calls.length, 2, '--resend without --origin goes where the sign-in started');
  assert.ok(fs.existsSync(pendingFile), 'a refused resend keeps the pending sign-in');
  console.log('PASS 3: a re-run resumes without a second email; --resend inside 30 s is exit 4 rate_limited, retry_after 30');

  // 4. A wrong code: exit 3, one JSON object on stderr, the server's words without the key-shaped text; the pending file never holds a code.
  r = await cli(['login', '--code', 'WRONGXYZ', '--json'], { env: envB() });
  assert.equal(r.code, 3, r.stderr);
  e = json(r.stderr);
  assert.equal(e.code, 'code_invalid'); assert.equal(e.field, 'code');
  assert.ok(e.next.some(n => n.includes('--resend')));
  assert.ok(!r.stderr.includes('eolc_') && r.stderr.includes('[redacted]'), 'a key in a server message is cut out');
  assert.equal(A.calls.at(-1).args.code, 'WRONGXYZ'); assert.equal(B.calls.length, 0, 'step 2 goes where step 1 went');
  assert.ok(!fs.readFileSync(pendingFile, 'utf8').includes('WRONGXYZ'), 'the pending file never holds a code');
  console.log('PASS 4: a wrong code is exit 3 code_invalid on stderr as JSON; the pending sign-in is kept, without the code');

  // 5. The right code from stdin, without setup: signed in; a handle that could not be had is a warning, so exit 5 (partial).
  r = await cli(['login', '--code-stdin', '--no-setup', '--json'], { env: envB(), input: CODE + '\n' });
  assert.equal(r.code, 5, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'partial'); assert.equal(o.handle, 'ada'); assert.equal(o.created, true); assert.equal(o.origin, a);
  assert.equal(o.warnings.length, 1); assert.equal(o.warnings[0].step, 'handle');
  assert.ok(o.warnings[0].error.includes('@taken2') && o.warnings[0].fix.includes('eol_update_profile'), 'the warning says what is free and how to claim it');
  assert.ok(o.next.includes('npx earthonline setup'));
  assert.deepEqual(A.calls.at(-1).args, { email: 'ada@example.test', code: CODE, name: 'Ada', handle: 'taken' }, 'step 2 carries the name and handle from step 1');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), KEY, 'the key is in the key file');
  privateToMe(keyFile, 'key');
  assert.ok(!fs.existsSync(pendingFile), 'the pending sign-in is gone');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.origin, a, 'the key is saved with the origin it came from');
  assert.equal(config.handle, 'ada');
  console.log('PASS 5: --code-stdin signs in; key file private; origin and handle saved; a missed handle is exit 5 with a warning');

  // 6. Every later request goes to the saved origin (no EOL_ORIGIN, no flag). Checked above that config.origin is A, a loopback fake.
  const plain = baseEnv(); delete plain.EOL_ORIGIN; delete plain.EOL_REQUIRE_ORIGIN;
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).origin, a);
  const before = A.calls.length, beforeB = B.calls.length;
  r = await cli(['status'], { env: plain });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('Signed in as @ada.'), r.stdout);
  const later = A.calls.slice(before);
  assert.ok(later.some(c => c.name === 'eol_whoami') && later.every(c => c.auth === `Bearer ${KEY}`), 'status asked A, with the key');
  assert.equal(B.calls.length, beforeB, 'nothing went to B');
  console.log('PASS 6: after a sign-in with --origin, later requests go to that origin');

  // 7. EOL_KEY overrides the key file; a set but malformed EOL_KEY is no key (not quietly replaced by the file's).
  r = await cli(['status'], { env: { ...envB(), EOL_KEY: ENV_KEY } });
  assert.ok(r.stdout.includes('Signed in as @envbot (the key in EOL_KEY).'), r.stdout);
  assert.equal(B.calls.at(-1).auth, `Bearer ${ENV_KEY}`);
  r = await cli(['status'], { env: { ...envB(), EOL_KEY: 'not-a-key' } });
  assert.ok(r.stdout.includes('EOL_KEY is set but is not an EarthOnline key.'), r.stdout);
  console.log('PASS 7: EOL_KEY overrides the key file');

  // 8. A revoked key without a terminal: exit 3 signed_out, never a prompt; the next step is a new sign-in.
  fs.writeFileSync(keyFile, REVOKED + '\n');
  r = await cli(['--json'], { env: envB() });
  assert.equal(r.code, 3, r.stderr);
  e = json(r.stderr);
  assert.equal(e.code, 'signed_out'); assert.ok(e.next[0].includes('login --email'));
  console.log('PASS 8: a revoked key is exit 3 signed_out, not a question');

  // 9. --key-stdin: a key from stdin, never an argument; a malformed one is exit 2.
  r = await cli(['login', '--key-stdin', '--no-setup', '--json'], { env: envB(), input: KEY + '\n' });
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'ok'); assert.equal(o.handle, 'ada');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).origin, b, 'a sign-in without --origin is saved with the default (here EOL_ORIGIN)');
  privateToMe(keyFile, 'key (from --key-stdin)');
  r = await cli(['login', '--key-stdin', '--json'], { env: envB(), input: 'eolc_short\n' });
  assert.equal(r.code, 2); assert.equal(json(r.stderr).code, 'invalid_input');
  console.log('PASS 9: login --key-stdin');

  // 10. An expired pending sign-in says so (exit 3 code_expired) without calling the server; offline is exit 4 with nothing written.
  fs.writeFileSync(pendingFile, JSON.stringify({ v: 1, email: 'ada@example.test', origin: a, to: 'a***@example.test', sent_at: new Date(Date.now() - 700000).toISOString(), expires_at: new Date(Date.now() - 100000).toISOString() }));
  const calls = A.calls.length;
  r = await cli(['login', '--code', CODE, '--json'], { env: envB() });
  assert.equal(r.code, 3, r.stderr); assert.equal(json(r.stderr).code, 'code_expired');
  assert.equal(A.calls.length, calls, 'no request for an expired code');
  fs.rmSync(pendingFile);
  const closed = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(`http://127.0.0.1:${port}`)); }); });
  r = await cli(['--origin', closed, 'login', '--email', 'ada@example.test', '--json'], { env: envB() });
  assert.equal(r.code, 4, r.stderr); assert.equal(json(r.stderr).code, 'network');
  assert.ok(!fs.existsSync(pendingFile), 'offline: nothing written');
  console.log('PASS 10: an expired code is exit 3 code_expired; offline is exit 4 network and writes nothing');

  // 11. The npx entry checks Node first (exit 2 node_too_old below 18), then runs the same program.
  const { nodeTooOld, NEED } = await import('../bin.mjs');
  assert.equal(NEED, '>=18');
  for (const [v, old] of [['v16.20.2', true], ['v17.9.1', true], ['v18.0.0', false], ['v18.16.0', false], ['v20.15.1', false], ['v22.11.0', false], ['', true]]) assert.equal(nodeTooOld(v), old, v);
  r = await cli(['login', '--json'], { env: envB(), entry: 'bin.mjs' });
  assert.equal(r.code, 2, r.stderr); assert.equal(json(r.stderr).code, 'missing_input', 'bin.mjs runs cli.mjs on this Node');
  const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, NEED, 'engines and the run-time check agree');
  assert.equal(pkg.bin.earthonline, 'bin.mjs');
  console.log(`PASS 11: Node gate (this Node ${process.version} passes; 16 and 17 refused)`);

  assert.ok(!captured.includes('eolc_'), 'no key, and nothing key-shaped, in any output');
  console.log('PASS: login stories (no eolc_ in any output)');
} catch (err) {
  console.error('FAIL:', String(err?.stack ?? err).replace(/eolc_[0-9A-Za-z]+/g, '[redacted]'));
  process.exitCode = 1;
} finally {
  for (const s of [A, B]) { s.server.closeAllConnections?.(); await new Promise(r => s.server.close(r)); }
  fs.rmSync(temp, { recursive: true, force: true });
}
