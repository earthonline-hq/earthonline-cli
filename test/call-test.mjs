// (car11 M4) `call`, `feedback`, `status --json` and `doctor` (call.mjs, cli.mjs status; research/cli-onboarding-design-1026.md
// §10, A4) against fake EarthOnline servers on loopback port 0. No Mongo, no harness set up. Runs on Node 18 or later.
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
const KEY = newKey(), REVOKED = newKey(), LEAK = newKey();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-call-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline'), keyFile = path.join(eolHome, 'key');
let captured = '';

function fakeServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/tools') return send(200, { ok: true, result: { tools: [] } });
    const name = req.url.replace(/^\/api\/tools\//, '');
    calls.push({ name, raw, headers: req.headers });
    if (req.headers.authorization === `Bearer ${REVOKED}`) return send(401, { ok: false, error: { code: 'unauthorized', message: 'Sign in first.' } });
    const args = raw ? JSON.parse(raw) : {};
    if (name === 'eol_whoami') return send(200, { ok: true, result: { robot: { handle: '@robot_test1' } } });
    // the result as the server would write it: nested, unicode, a number, a key-shaped string (cut out before it is printed)
    if (name === 'eol_echo') return send(200, { ok: true, result: { got: args, note: 'héllo ✓ "quoted"', n: 1.5, list: [1, null, true], made: LEAK } });
    if (name === 'eol_message') return send(200, { ok: true, result: { seq: 1, thread_id: 'dm:earthonline:robot_test1', state: 'open', to: { online: true } } });
    send(404, { ok: false, error: { code: 'not_found', message: 'No such tool.' } });
  });
  return { calls, server, start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}
const A = fakeServer(), B = fakeServer();
let a, b;
const baseEnv = (extra = {}) => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: path.join(home, '.codex'), EOL_CLAUDE_BIN: path.join(home, 'no-claude'), EOL_ORIGIN: a, EOL_REQUIRE_ORIGIN: '1' };
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete e[k];
  return { ...e, ...extra };
};
function cli(args, { input = '', env = baseEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env, cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; captured += d; });
    p.stderr.on('data', d => { stderr += d; captured += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr }));
    p.stdin.end(input);
  });
}
const json = text => { const lines = text.trim().split('\n'); assert.equal(lines.length, 1, `one JSON line: ${text}`); return JSON.parse(lines[0]); };
const setKey = k => { fs.mkdirSync(eolHome, { recursive: true }); if (k) fs.writeFileSync(keyFile, k + '\n'); else fs.rmSync(keyFile, { force: true }); };

try {
  a = await A.start(); b = await B.start();
  setKey(KEY);

  // 1. call: the arguments from stdin exactly, the key as Bearer, and the tool's result printed as the REST body has it (keys cut).
  const input = '{"to":"@ada","text":"say \\"hi\\"\\nline two","n":2}';
  let r = await cli(['call', 'eol_echo', '--input', '-'], { input });
  assert.equal(r.code, 0, r.stderr);
  let last = A.calls.at(-1);
  assert.equal(last.name, 'eol_echo'); assert.deepEqual(JSON.parse(last.raw), JSON.parse(input));
  assert.equal(last.headers.authorization, `Bearer ${KEY}`); assert.ok(last.headers['user-agent'].startsWith('earthonline/'));
  const expected = { got: JSON.parse(input), note: 'héllo ✓ "quoted"', n: 1.5, list: [1, null, true], made: LEAK };
  assert.equal(r.stdout, JSON.stringify(expected).replace(LEAK, '[redacted]') + '\n', 'a human run prints the result, the same bytes as the REST result, the key cut out');
  r = await cli(['call', 'eol_echo', '--input', '-', '--json'], { input });
  let o = json(r.stdout);
  assert.equal(o.status, 'ok'); assert.equal(o.tool, 'eol_echo'); assert.deepEqual(o.warnings, []);
  assert.deepEqual(o.result, { ...expected, made: '[redacted]' });
  r = await cli(['call', 'eol_whoami', '--json']);
  assert.equal(r.code, 0); assert.equal(A.calls.at(-1).raw, '{}', 'no --input: no arguments');
  assert.deepEqual(json(r.stdout).result, { robot: { handle: '@robot_test1' } });
  console.log('PASS 1: call sends stdin JSON as the arguments and prints the REST result (same bytes, keys cut)');

  // 2. Input mistakes are exit 2 and send nothing; JSON is never taken from an argument.
  const before = A.calls.length;
  for (const [args, stdin, code] of [
    [['call'], '', 'missing_input'], [['call', 'whoami'], '', 'invalid_input'], [['call', 'eol_x', '--input', '{"a":1}'], '', 'invalid_input'],
    [['call', 'eol_x', '--input', '-'], 'not json', 'invalid_input'], [['call', 'eol_x', '--input', '-'], '[1,2]', 'invalid_input'],
    [['call', 'eol_x', 'eol_y'], '', 'usage'], [['feedback'], '', 'missing_input'], [['feedback', '-'], '  \n', 'missing_input'],
  ]) {
    r = await cli([...args, '--json'], { input: stdin });
    assert.equal(r.code, 2, `${args.join(' ')}: exit 2: ${r.stderr}`);
    assert.equal(json(r.stderr).code, code, args.join(' '));
  }
  assert.equal(A.calls.length, before, 'nothing sent');
  console.log('PASS 2: a missing or bad tool name, inline JSON, non-JSON or non-object stdin: exit 2, nothing sent');

  // 3. A revoked key: exit 3 signed_out with the sign-in command.
  setKey(REVOKED);
  r = await cli(['call', 'eol_whoami', '--json']);
  assert.equal(r.code, 3); const e = json(r.stderr);
  assert.equal(e.code, 'signed_out'); assert.ok(e.next.some(n => n.includes('login')));
  setKey(KEY);
  console.log('PASS 3: a revoked key is exit 3 signed_out');

  // 4. Inside a session the call says which one (as mcp.mjs does); outside, nothing. --origin after the command is honoured.
  await cli(['call', 'eol_whoami'], { env: baseEnv({ CLAUDE_CODE_SESSION_ID: 'call-session-1234', CLAUDE_CODE_ENTRYPOINT: 'cli' }) });
  last = A.calls.at(-1);
  assert.ok(last.headers['x-eol-agent'], 'Claude Code: X-EOL-Agent'); assert.equal(last.headers['x-eol-surface'], 'cli');
  assert.match(decodeURIComponent(last.headers['x-eol-agent-name']), /^Claude Code · /);
  await cli(['call', 'eol_whoami'], { env: baseEnv({ CODEX_THREAD_ID: 'codex-thread-1234' }) });
  assert.match(decodeURIComponent(A.calls.at(-1).headers['x-eol-agent-name']), /^Codex · /);
  await cli(['call', 'eol_whoami']);
  assert.equal(A.calls.at(-1).headers['x-eol-agent'], undefined, 'no session: no agent headers');
  const bBefore = B.calls.length;
  r = await cli(['call', 'eol_whoami', '--origin', b, '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(B.calls.length, bBefore + 1, '--origin after the command');
  console.log('PASS 4: session headers inside Claude Code and Codex, none outside; --origin anywhere on the line');

  // 5. feedback: eol_message to @earthonline with the text; the answer's way back in next; `feedback -` reads stdin; signed out: exit 2.
  r = await cli(['feedback', 'The', 'login', 'was', 'smooth', '--json']);
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(A.calls.at(-1).name, 'eol_message');
  assert.deepEqual(JSON.parse(A.calls.at(-1).raw), { to: '@earthonline', text: 'The login was smooth' });
  assert.equal(o.to, '@earthonline'); assert.equal(o.thread_id, 'dm:earthonline:robot_test1'); assert.equal(o.seq, 1);
  assert.ok(o.next[0].includes('eol_wait') && o.next[0].includes('dm:earthonline:robot_test1'), 'next: how the answer comes back');
  r = await cli(['feedback', '-'], { input: 'Line one\n"Line two"\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(A.calls.at(-1).raw).text, 'Line one\n"Line two"');
  assert.match(r.stdout, /^Sent to @earthonline\./);
  setKey(null);
  r = await cli(['feedback', 'hello', '--json']);
  assert.equal(r.code, 2); assert.ok(json(r.stderr).next.some(n => n.includes('login --email')));
  console.log('PASS 5: feedback is eol_message to @earthonline, says how the answer comes back; signed out it asks to sign in');

  // 6. status --json: the report, exit 0 whatever it finds; doctor: the same, problems as warnings, the exit code as the verdict.
  r = await cli(['status', '--json']);
  assert.equal(r.code, 0, r.stderr);
  o = json(r.stdout);
  assert.equal(o.status, 'ok'); assert.equal(o.signed_in, false); assert.deepEqual(o.warnings, []);
  assert.ok(o.problems.some(p => p.step === 'sign-in' && p.fix.includes('login --email')), 'status lists the problem with its fix');
  r = await cli(['doctor', '--json']);
  assert.equal(r.code, 3, 'doctor, not signed in: exit 3'); o = json(r.stdout);
  assert.equal(o.status, 'partial'); assert.ok(o.warnings.some(w => w.step === 'sign-in'));
  setKey(REVOKED);
  r = await cli(['doctor', '--json']);
  assert.equal(r.code, 3, 'doctor, revoked key: exit 3');
  setKey(KEY);
  r = await cli(['doctor', '--json']);
  assert.equal(r.code, 5, `doctor, signed in, nothing set up: exit 5: ${r.stdout}`);
  o = json(r.stdout);
  assert.equal(o.signed_in, true); assert.equal(o.handle, 'robot_test1'); assert.equal(o.app, 'missing');
  assert.ok(o.warnings.some(w => ['setup', 'agents'].includes(w.step) && w.fix), 'not set up: said, with the fix');
  const closed = http.createServer();
  await new Promise(res => closed.listen(0, '127.0.0.1', res));
  const nowhere = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(res => closed.close(res));
  r = await cli(['doctor', '--json'], { env: baseEnv({ EOL_ORIGIN: nowhere }) });
  assert.equal(r.code, 4, 'doctor, EarthOnline not reached: exit 4'); assert.equal(json(r.stdout).signed_in, null);
  r = await cli(['status']);
  assert.equal(r.code, 0); assert.match(r.stdout, /Signed in as @robot_test1\./);
  console.log('PASS 6: status --json reports (exit 0); doctor exits 3 not signed in or revoked, 4 not reached, 5 not set up');

  assert.ok(!/eolc_/.test(captured), 'no key in any output');
  console.log('PASS 7: no eolc_ in any output');
  console.log('call-test: PASS');
} finally {
  A.server.close(); B.server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
