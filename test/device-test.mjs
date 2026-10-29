// (car11 M3) `login --device` without a terminal (device.mjs; research/cli-onboarding-design-1026.md "B7 contract
// (car11-dev-1026)", RFC 8628) against a fake EarthOnline on loopback port 0 that answers in the contract's shapes:
// POST /oauth/device_authorization and POST /oauth/token (form bodies, { error, error_description } on 400). No Mongo, no
// browser (no terminal: nothing is opened), no harness set up (--no-setup). Runs on Node 18 or later.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'eolc_' + randomBytes(20).toString('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-device-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline');
const pendingFile = path.join(eolHome, 'pending-device.json'), keyFile = path.join(eolHome, 'key'), configFile = path.join(eolHome, 'config.json');
let captured = '';

// ---- the fake: one device code per start, its state set by the test -------------------------------------------------------
const codes = []; // { device_code, user_code, state: pending|approved|denied|expired|used, polls: [ms], slowFirst, approveOnPoll }
const starts = [];
let startAnswer = null; // null: 200; else { status, headers, body } for the next starts
let expiresIn = 900, interval = 1;
const reply = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.method === 'GET' && req.url === '/api/tools') return reply(res, 200, { ok: true, result: { tools: [] } });
  if (req.method !== 'POST') return reply(res, 404, { error: 'not_found' });
  const form = Object.fromEntries(new URLSearchParams(raw));
  if (req.url === '/oauth/device_authorization') {
    starts.push({ form, type: req.headers['content-type'], ua: req.headers['user-agent'] ?? '' });
    if (startAnswer) return reply(res, startAnswer.status, startAnswer.body, startAnswer.headers);
    if (form.client_id !== 'earthonline-cli') return reply(res, 401, { error: 'invalid_client', error_description: 'Unknown client.' });
    const n = codes.length + 1;
    const user_code = `WDJB-MJH${'BCDFGHJKLM'[n % 10]}`;
    codes.push({ device_code: randomBytes(32).toString('base64url'), user_code, state: 'pending', polls: [], slowFirst: false, approveOnPoll: 0, issued: Date.now() });
    return reply(res, 200, { device_code: codes.at(-1).device_code, user_code, verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?user_code=${user_code}`, expires_in: expiresIn, interval });
  }
  if (req.url === '/oauth/token') {
    if (form.client_id !== 'earthonline-cli') return reply(res, 401, { error: 'invalid_client', error_description: 'Unknown client.' });
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return reply(res, 400, { error: 'unsupported_grant_type' });
    const code = codes.find(c => c.device_code === form.device_code);
    if (!code) return reply(res, 400, { error: 'invalid_grant', error_description: 'Unknown device code.' });
    code.polls.push(Date.now());
    if (code.slowFirst && code.polls.length === 1) return reply(res, 400, { error: 'slow_down', error_description: 'Polling too fast.', interval: 2 });
    if (code.approveOnPoll && code.polls.length >= code.approveOnPoll) code.state = 'approved';
    if (code.state === 'pending') return reply(res, 400, { error: 'authorization_pending', error_description: 'Not approved yet.' });
    if (code.state === 'denied') return reply(res, 400, { error: 'access_denied', error_description: 'The person pressed Deny.' });
    if (code.state === 'expired') return reply(res, 400, { error: 'expired_token', error_description: 'This code has expired.' });
    if (code.state === 'used') return reply(res, 400, { error: 'invalid_grant', error_description: 'This code was used already.' });
    code.state = 'used';
    return reply(res, 200, { access_token: KEY, token_type: 'Bearer', scope: 'owner', key_id: 'k_test', robot: { handle: 'robot_test1', name: 'Robot', url: `${base}/@robot_test1` }, created: false });
  }
  reply(res, 404, { error: 'not_found' });
});

const env = base => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: path.join(home, '.codex'), EOL_CLAUDE_BIN: path.join(home, 'no-claude'), EOL_ORIGIN: base, EOL_REQUIRE_ORIGIN: '1' };
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete e[k];
  return e;
};
let origin;
function cli(args, base = origin) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env: env(base), cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; captured += d; });
    p.stderr.on('data', d => { stderr += d; captured += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    p.stdin.end();
  });
}
const json = text => { const lines = text.trim().split('\n'); assert.equal(lines.length, 1, `one JSON line: ${text}`); return JSON.parse(lines[0]); };
const pending = () => JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
const DEVICE = ['login', '--device', '--no-setup', '--json'];

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  // 1. First run, no terminal: returns at once with the address; nothing polled; the device code only in the private pending file.
  let r = await cli(DEVICE);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 3000, `returned in ${r.ms} ms`);
  let o = json(r.stdout);
  assert.equal(o.status, 'approval_pending');
  assert.equal(o.resumed, false);
  assert.equal(o.user_code, codes[0].user_code);
  assert.equal(o.verification_uri_complete, `${origin}/device?user_code=${codes[0].user_code}`);
  assert.ok(o.expires_in > 890 && o.expires_in <= 900);
  assert.ok(o.next[0].includes(o.verification_uri_complete) && o.next[0].endsWith('npx earthonline login --device'), 'next: open, check the code, approve, run again');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].form, { client_id: 'earthonline-cli', scope: 'owner' });
  assert.equal(starts[0].type, 'application/x-www-form-urlencoded');
  assert.ok(starts[0].ua.startsWith('earthonline/'));
  assert.equal(codes[0].polls.length, 0, 'the first run without a terminal does not poll');
  assert.equal(pending().device_code, codes[0].device_code);
  if (process.platform !== 'win32') assert.equal(fs.statSync(pendingFile).mode & 0o777, 0o600, 'pending-device.json is private');
  assert.ok(!captured.includes(codes[0].device_code), 'the device code is never printed');
  console.log('PASS 1: first run returns at once (approval_pending, the address and code); no poll; device code only in a private file');

  // 2. A re-run before approval resumes the same code and polls for --wait seconds, then says it is still waiting.
  r = await cli([...DEVICE, '--wait', '2']);
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'approval_pending'); assert.equal(o.resumed, true); assert.equal(o.user_code, codes[0].user_code);
  assert.equal(starts.length, 1, 'no second code');
  assert.ok(codes[0].polls.length >= 1 && codes[0].polls.length <= 3, `polled ${codes[0].polls.length} times in 2 s at a 1 s interval`);
  assert.ok(r.ms < 5000, `--wait 2 ended in ${r.ms} ms`);
  console.log('PASS 2: a re-run resumes the code (no second start) and polls within --wait');

  // 3. Approved, then a re-run: signed in; the key only in the key file; the pending file gone; never sooner than the interval.
  codes[0].state = 'approved';
  r = await cli(DEVICE);
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'ok'); assert.equal(o.handle, 'robot_test1'); assert.equal(o.created, false); assert.equal(o.origin, origin);
  assert.ok(o.next.includes('npx earthonline setup'), '--no-setup: next is setup');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(pendingFile), 'the pending file goes once the key is saved');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).origin, origin, 'the key is remembered with its origin');
  const p0 = codes[0].polls;
  for (let i = 1; i < p0.length; i++) assert.ok(p0[i] - p0[i - 1] >= 950, `poll ${i} came ${p0[i] - p0[i - 1]} ms after the last (interval 1 s)`);
  r = await cli(DEVICE);
  assert.equal(r.code, 0); assert.equal(json(r.stdout).status, 'approval_pending', 'after a sign-in, login --device starts a new code');
  assert.equal(codes.length, 2);
  console.log('PASS 3: approved: status ok, key saved privately, pending file gone, polls never sooner than the interval');

  // 4. slow_down: the body's new interval is used for the next poll; --wait on a first run polls it.
  fs.rmSync(pendingFile, { force: true });
  r = await cli(DEVICE); // code 3
  Object.assign(codes[2], { slowFirst: true, approveOnPoll: 2 });
  r = await cli([...DEVICE, '--wait', '8']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r.stdout).status, 'ok');
  assert.equal(codes[2].polls.length, 2);
  assert.ok(codes[2].polls[1] - codes[2].polls[0] >= 1950, `after slow_down (interval 2) the next poll came ${codes[2].polls[1] - codes[2].polls[0]} ms later`);
  console.log('PASS 4: slow_down: the next poll waits the new interval from the body');

  // 5. Denied, expired, used: exit 3 with the RFC code, one JSON object on stderr, the pending file gone, next = login --device.
  for (const [state, code] of [['denied', 'access_denied'], ['expired', 'expired_token'], ['used', 'invalid_grant']]) {
    r = await cli(DEVICE);
    assert.equal(r.code, 0, r.stderr);
    codes.at(-1).state = state;
    r = await cli([...DEVICE, '--wait', '0']);
    assert.equal(r.code, 3, `${state}: exit 3: ${r.stderr}`);
    assert.equal(r.stdout, '');
    const e = json(r.stderr);
    assert.equal(e.code, code);
    assert.ok(e.next.includes('npx earthonline login --device'), `${state}: next is a new login --device`);
    assert.ok(!fs.existsSync(pendingFile), `${state}: the pending file goes`);
  }
  console.log('PASS 5: denied / expired / used: exit 3 access_denied / expired_token / invalid_grant, the pending file gone');

  // 6. A code with 60 s or less left is not resumed: a new one, at once.
  expiresIn = 50;
  r = await cli(DEVICE);
  const first = json(r.stdout).user_code, before = codes.length;
  r = await cli(DEVICE);
  o = json(r.stdout);
  assert.equal(o.resumed, false); assert.notEqual(o.user_code, first); assert.equal(codes.length, before + 1, 'a new code');
  expiresIn = 900;
  fs.rmSync(pendingFile, { force: true });
  console.log('PASS 6: a pending code with 60 s or less left is replaced, not resumed');

  // 7. The start refused: 429 (exit 4, retry_after), 503 (exit 4), a server without the device flow (404: exit 2, the email way), unreachable (exit 4).
  for (const [answer, exit, code, extra] of [
    [{ status: 429, headers: { 'retry-after': '30' }, body: { error: 'too_many_requests', error_description: 'Too many sign-in starts from here.' } }, 4, 'rate_limited', e => assert.equal(e.retry_after, 30)],
    [{ status: 503, headers: { 'retry-after': '5' }, body: { error: 'temporarily_unavailable', error_description: 'Try again in a few seconds.' } }, 4, 'unavailable', e => assert.equal(e.retry_after, 5)],
    [{ status: 404, body: '<html>Not found</html>' }, 2, 'unsupported', e => assert.ok(e.next.some(n => n.includes('login --email')))],
  ]) {
    startAnswer = answer;
    r = await cli(DEVICE);
    assert.equal(r.code, exit, `HTTP ${answer.status}: ${r.stderr}`);
    const e = json(r.stderr);
    assert.equal(e.code, code); extra(e);
    assert.ok(!fs.existsSync(pendingFile), 'nothing saved');
  }
  startAnswer = null;
  const closed = http.createServer();
  await new Promise(res => closed.listen(0, '127.0.0.1', res));
  const nowhere = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(res => closed.close(res));
  r = await cli(DEVICE, nowhere);
  assert.equal(r.code, 4); assert.equal(json(r.stderr).code, 'network');
  console.log('PASS 7: start refused: 429 and 503 exit 4 with retry_after, 404 exit 2 offering the email code, unreachable exit 4');

  // 8. Wrong combinations are input errors (exit 2), before any request.
  const startsBefore = starts.length;
  for (const args of [['login', '--device', '--email', 'a@example.test'], ['login', '--device', '--code', 'WDJBMJHT'], ['login', '--wait', '5'], ['login', '--device', '--wait', '541'], ['login', '--device', '--wait', 'soon'], ['login', '--device', '--wait', '-1']]) {
    r = await cli([...args, '--json']);
    assert.equal(r.code, 2, `${args.join(' ')}: exit 2: ${r.stderr}`);
  }
  assert.equal(starts.length, startsBefore, 'refused before any request');
  console.log('PASS 8: --device with --email/--code, --wait without --device or out of 0..540: exit 2, nothing sent');

  // 9. login --email resumed after 90 s without the mail offers login --device; sooner, it does not.
  for (const [ago, offered] of [[120_000, true], [10_000, false]]) {
    fs.writeFileSync(path.join(eolHome, 'pending-login.json'), JSON.stringify({ v: 1, email: 'ada@example.test', origin, to: 'a***@example.test', sent_at: new Date(Date.now() - ago).toISOString(), expires_at: new Date(Date.now() + 480_000).toISOString() }));
    r = await cli(['login', '--email', 'ada@example.test', '--json']);
    assert.equal(r.code, 0, r.stderr);
    o = json(r.stdout);
    assert.equal(o.resumed, true);
    assert.equal(o.next.some(n => n.includes('login --device')), offered, `${ago / 1000} s after the send: device offered ${offered}`);
  }
  console.log('PASS 9: a resumed login --email offers login --device after 90 s, not before');

  assert.ok(!/eolc_/.test(captured), 'no key in any output');
  console.log('PASS 10: no eolc_ in any output');
  console.log('device-test: PASS');
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
