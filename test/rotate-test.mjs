// (car11 M5) `key rotate` (rotate.mjs): a new key by signing in again, then the replaced key revoked with the new one, against a
// fake EarthOnline on loopback port 0 that keeps a key table (eol_whoami `keys`, eol_login and the B7 device flow issuing keys
// with their key_id, eol_revoke_key). No Mongo, no harness set up (--no-setup). Runs on Node 18 or later.
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
const newKey = () => 'eolc_' + randomBytes(20).toString('hex');
const CODE = 'WDJBMJHT';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-rotate-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline');
const keyFile = path.join(eolHome, 'key'), configFile = path.join(eolHome, 'config.json'), rotateFile = path.join(eolHome, 'rotate.json');
let captured = '';

// ---- the fake's key table ---------------------------------------------------------------------------------------------------
const keys = new Map(); // key -> { id, handle, revoked }
let issued = 0, signInHandle = 'robot_test1', failRevoke = false;
const revokes = [];
const issue = handle => { const key = newKey(); keys.set(key, { id: `k_${++issued}`, handle, revoked: false }); return key; };
const devices = new Map();
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.method === 'GET' && req.url === '/api/tools') return send(200, { ok: true, result: { tools: [] } });
  if (req.url === '/oauth/device_authorization') {
    const device_code = randomBytes(32).toString('base64url');
    devices.set(device_code, 'pending');
    return send(200, { device_code, user_code: 'WDJB-MJHT', verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?user_code=WDJB-MJHT`, expires_in: 900, interval: 1 });
  }
  if (req.url === '/oauth/token') {
    const form = Object.fromEntries(new URLSearchParams(raw));
    const state = devices.get(form.device_code);
    if (state === 'pending') return send(400, { error: 'authorization_pending' });
    if (state !== 'approved') return send(400, { error: 'invalid_grant' });
    devices.set(form.device_code, 'used');
    const key = issue(signInHandle);
    return send(200, { access_token: key, token_type: 'Bearer', scope: 'owner', key_id: keys.get(key).id, robot: { handle: signInHandle, name: 'Robot', url: `${base}/@${signInHandle}` }, created: false });
  }
  const name = req.url.replace(/^\/api\/tools\//, '');
  const args = raw ? JSON.parse(raw) : {};
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (name === 'eol_login') {
    if (!args.code) return send(200, { ok: true, result: { sent: true, email: args.email, to: 'a***@example.test', expires_at: new Date(Date.now() + 600000).toISOString(), expires_in: 600, resend_after_seconds: 30 } });
    if (args.code !== CODE) return send(400, { ok: false, error: { code: 'invalid_argument', field: 'code', message: 'That code is wrong.' } });
    const key = issue(signInHandle);
    return send(200, { ok: true, result: { robot: { handle: '@' + signInHandle }, key, key_id: keys.get(key).id, created: false } });
  }
  const me = keys.get(bearer);
  if (!me || me.revoked) return send(401, { ok: false, error: { code: 'unauthorized', message: 'Sign in first.' } });
  if (name === 'eol_whoami') {
    const mine = [...keys].filter(([, k]) => k.handle === me.handle && !k.revoked).map(([key, k]) => ({ id: k.id, prefix: `${key.slice(0, 9)}…`, name: null }));
    return send(200, { ok: true, result: { robot: { handle: '@' + me.handle }, keys: mine } });
  }
  if (name === 'eol_revoke_key') {
    revokes.push({ id: args.id, by: bearer });
    if (failRevoke) return send(503, { ok: false, error: { code: 'unavailable', message: 'Try again in a minute.' } });
    for (const k of keys.values()) if (k.id === args.id && k.handle === me.handle) k.revoked = true;
    return send(200, { ok: true, result: { revoked: { id: args.id } } });
  }
  send(404, { ok: false, error: { code: 'not_found', message: 'No such tool.' } });
});

let origin;
const baseEnv = (extra = {}) => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: path.join(home, '.codex'), EOL_CLAUDE_BIN: path.join(home, 'no-claude'), EOL_ORIGIN: origin, EOL_REQUIRE_ORIGIN: '1' };
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete e[k];
  return { ...e, ...extra };
};
function cli(args, env = baseEnv()) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env, cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; captured += d; });
    p.stderr.on('data', d => { stderr += d; captured += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr }));
    p.stdin.end();
  });
}
const json = text => { const lines = text.trim().split('\n'); assert.equal(lines.length, 1, `one JSON line: ${text}`); return JSON.parse(lines[0]); };
const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const fileKey = () => fs.readFileSync(keyFile, 'utf8').trim();
/** This computer signed in with `key`; `keyId` in config.json as a 0.2.0 sign-in leaves it, or none as before 0.2.0. */
function signedIn(key, keyId) {
  fs.rmSync(eolHome, { recursive: true, force: true });
  fs.mkdirSync(eolHome, { recursive: true });
  fs.writeFileSync(keyFile, key + '\n');
  fs.writeFileSync(configFile, JSON.stringify({ handle: 'robot_test1', ...(keyId ? { key_id: keyId } : {}) }));
}
const approveAll = () => { for (const [code, state] of devices) if (state === 'pending') devices.set(code, 'approved'); };

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  // 1. key rotate --device: the rotation written down, the code returned; the device sign-in finishes it: old key revoked by the new.
  let old = issue('robot_test1'), oldId = keys.get(old).id;
  signedIn(old, oldId);
  let r = await cli(['key', 'rotate', '--device', '--json']);
  assert.equal(r.code, 0, r.stderr);
  let o = json(r.stdout);
  assert.equal(o.status, 'approval_pending');
  assert.ok(o.notes.some(n => n.includes('the old one is revoked')), 'it says the old key goes once the sign-in finishes');
  const marker = JSON.parse(fs.readFileSync(rotateFile, 'utf8'));
  assert.deepEqual({ ...marker, expires_at: undefined }, { v: 1, origin, handle: 'robot_test1', key_id: oldId, expires_at: undefined });
  assert.ok(!fs.readFileSync(rotateFile, 'utf8').includes('eolc_'), 'no key in rotate.json');
  assert.equal(fileKey(), old, 'the old key stays until the new one is saved');
  approveAll();
  r = await cli(['login', '--device', '--no-setup', '--json']);
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'ok'); assert.deepEqual(o.rotated, { revoked: oldId });
  const fresh = fileKey();
  assert.notEqual(fresh, old);
  assert.deepEqual(revokes.at(-1), { id: oldId, by: fresh }, 'revoked with the new key');
  assert.equal(keys.get(old).revoked, true);
  assert.equal(config().key_id, keys.get(fresh).id, 'the new key\'s id is kept for the next rotation');
  assert.ok(!fs.existsSync(rotateFile));
  console.log('PASS 1: key rotate --device, then login --device: the new key saved, the old one revoked with it, key_id kept');

  // 2. A key from before 0.2.0 (no key_id saved): found by its first letters; the email way, code in a second run.
  old = issue('robot_test1');
  signedIn(old, null);
  r = await cli(['key', 'rotate', '--email', 'ada@example.test', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(json(r.stdout).status, 'code_sent');
  r = await cli(['login', '--code', CODE, '--no-setup', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r.stdout).rotated, { revoked: keys.get(old).id });
  assert.equal(keys.get(old).revoked, true);
  console.log('PASS 2: without a saved key_id the key is found by its first letters; email code in two runs');

  // 3. Nothing written down unless a sign-in follows: no way chosen, no key, EOL_KEY, a revoked key.
  old = issue('robot_test1');
  signedIn(old, keys.get(old).id);
  const before = revokes.length;
  r = await cli(['key', 'rotate', '--json']);
  assert.equal(r.code, 2); let e = json(r.stderr);
  assert.equal(e.code, 'missing_input'); assert.deepEqual(e.next, ['npx earthonline key rotate --device', "npx earthonline key rotate --email <your owner's email>"]);
  r = await cli(['key', 'rotate', '--device', '--json'], baseEnv({ EOL_KEY: old }));
  assert.equal(r.code, 2, 'EOL_KEY is not this computer\'s key file');
  keys.get(old).revoked = true;
  r = await cli(['key', 'rotate', '--device', '--json']);
  assert.equal(r.code, 3); assert.equal(json(r.stderr).code, 'signed_out');
  fs.rmSync(keyFile);
  r = await cli(['key', 'rotate', '--device', '--json']);
  assert.equal(r.code, 2); assert.equal(json(r.stderr).code, 'missing_input');
  r = await cli(['key', 'turn']);
  assert.equal(r.code, 2, 'key needs rotate');
  assert.ok(!fs.existsSync(rotateFile), 'no rotation written down'); assert.equal(revokes.length, before, 'nothing revoked');
  console.log('PASS 3: no way chosen, no key, EOL_KEY or a revoked key: exit 2/3, nothing written, nothing revoked');

  // 4. Another account signs in: the old key is kept, with a warning (exit 5). A rotation left too long is dropped quietly.
  old = issue('robot_test1');
  signedIn(old, keys.get(old).id);
  r = await cli(['key', 'rotate', '--email', 'ada@example.test', '--json']);
  signInHandle = 'robot_other';
  r = await cli(['login', '--code', CODE, '--no-setup', '--json']);
  assert.equal(r.code, 5, r.stdout);
  o = json(r.stdout);
  assert.equal(o.rotated, undefined); assert.ok(o.warnings.some(w => w.step === 'rotate' && w.fix.includes('eol_revoke_key')));
  assert.equal(keys.get(old).revoked, false, 'another account: kept');
  signInHandle = 'robot_test1';
  old = issue('robot_test1');
  signedIn(old, keys.get(old).id);
  fs.writeFileSync(rotateFile, JSON.stringify({ v: 1, origin, handle: 'robot_test1', key_id: keys.get(old).id, expires_at: new Date(Date.now() - 1000).toISOString() }));
  r = await cli(['login', '--code', CODE, '--no-setup', '--json'], baseEnv());
  assert.equal(r.code, 2, 'no pending email sign-in here: input needed');
  fs.writeFileSync(path.join(eolHome, 'pending-login.json'), JSON.stringify({ v: 1, email: 'ada@example.test', origin, to: 'a***@example.test', sent_at: new Date().toISOString(), expires_at: new Date(Date.now() + 480000).toISOString() }));
  r = await cli(['login', '--code', CODE, '--no-setup', '--json']);
  assert.equal(r.code, 0, r.stdout); o = json(r.stdout);
  assert.equal(o.rotated, undefined); assert.deepEqual(o.warnings, []);
  assert.equal(keys.get(old).revoked, false); assert.ok(!fs.existsSync(rotateFile), 'the stale rotation is gone');
  console.log('PASS 4: another account keeps the old key (warning, exit 5); a rotation older than 20 minutes is dropped');

  // 5. The revoke refused: the new key is saved anyway, the warning says how to revoke the old one (exit 5).
  old = issue('robot_test1');
  signedIn(old, keys.get(old).id);
  await cli(['key', 'rotate', '--email', 'ada@example.test', '--json']);
  failRevoke = true;
  r = await cli(['login', '--code', CODE, '--no-setup', '--json']);
  failRevoke = false;
  assert.equal(r.code, 5); o = json(r.stdout);
  const w = o.warnings.find(x => x.step === 'rotate');
  assert.ok(w && w.error.includes(keys.get(old).id) && w.fix.includes(`"id":"${keys.get(old).id}"`), 'the fix names the old key\'s id');
  assert.notEqual(fileKey(), old, 'the new key is saved anyway');
  console.log('PASS 5: a refused revoke leaves the new key saved and says how to revoke the old one');

  assert.ok(!/eolc_/.test(captured), 'no key in any output');
  console.log('PASS 6: no eolc_ in any output');
  console.log('rotate-test: PASS');
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
