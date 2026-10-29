// setup (car11 A2 + A3; research/cli-onboarding-design-1026.md §2 "what login --code does", §9, §13): one call leaves the computer
// connected and says so in one object, against a fake EarthOnline on loopback port 0. No Mongo, no real harness: a fake claude
// (as in cli-test), a fake Codex file, a fake Claude Code session (a live process for CLAUDE_PID and a messaging socket).
//   1  login --code inside a Claude Code session: MCP, skill, a listener bound to that session; a message to the owner arrives
//      in the session as a turn, before any restart (magic moment 1); no front desk (Decision 6)
//   2  a second run changes nothing (files byte for byte, one listener)
//   3  outside Claude Code: no binding, no warning; inside one without cross-session messaging: a warning, exit 5
//   4  the skill: a write that fails, and a skill of the same name that is not ours, are warnings (exit 5, in --json)
//   5  --no-skill; --desk (eol_add_brain { kind: "credit" }), and a refused desk is a warning
//   6  Codex alone on an account with delivery settings: config.delivery is set, so Codex follows them
//   7  uninstall removes our skills and stops the listener it started from EOL_HOME/app
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'eolc_' + randomBytes(20).toString('hex');
const CODE = 'WDJBMJHT', HANDLE = 'robot_test1', SESSION = 'sess-setup-0001';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-setup-test-'));
const eolHome = path.join(home, '.earthonline'), codexHome = path.join(home, '.codex');
const token = randomBytes(24).toString('hex');
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\eol-setup-test-${randomBytes(8).toString('hex')}` : path.join(home, 'inbox.sock');
const ccSkill = path.join(home, '.claude', 'skills', 'earthonline', 'SKILL.md');
const codexSkill = path.join(home, '.agents', 'skills', 'earthonline', 'SKILL.md');
const configFile = path.join(eolHome, 'config.json');
const fakeClaude = path.join(home, 'fake-claude.mjs'), fakeCodex = path.join(home, 'fake-codex.mjs');
fs.writeFileSync(fakeCodex, 'process.exitCode = 0;\n');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
config.mcpServers ??= {};
if (args[1] === 'remove') delete config.mcpServers[args[2]];
else if (args[1] === 'add') { const start = args.indexOf('--'); config.mcpServers[args[start - 1]] = { type: 'stdio', command: args[start + 1], args: args.slice(start + 2) }; }
else process.exit(1);
fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
`);
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

const state = { msgCore: false, desk: 'ok', calls: [], streams: [], connections: new Set(), registered: new Set() };
const received = [];
let captured = '', badAuth = false;
const children = new Set();
const deadline = setTimeout(() => { process.stderr.write('FAIL: story deadline exceeded\n'); void cleanup().then(() => process.exit(1)); }, 120_000);

async function until(check, ms = 5000, why = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(25); }
  throw new Error(`Timed out: ${why}`);
}
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method === 'GET' && req.url === '/api/agent/stream') {
    state.streams.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hello\n\n');
    state.connections.add(res); res.on('close', () => state.connections.delete(res));
    return;
  }
  const name = req.url.replace(/^\/api\/tools\/?/, '');
  const args = raw ? JSON.parse(raw) : {};
  state.calls.push({ name, args, auth: req.headers.authorization ?? null, agent: req.headers['x-eol-agent'] ?? null });
  const signed = req.headers.authorization === `Bearer ${KEY}`;
  if (req.method === 'GET' && name === '') {
    const properties = state.msgCore ? { delivery: { type: 'string' } } : {};
    return reply(res, 200, { ok: true, result: { tools: [{ name: 'eol_update_profile', inputSchema: { type: 'object', properties } }] } });
  }
  if (name === 'eol_login') return reply(res, 200, { ok: true, result: { robot: { handle: '@' + HANDLE }, key: KEY, key_id: 'k1', created: true } });
  if (!signed) return reply(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Sign in first.' } });
  if (name === 'eol_whoami') { if (req.headers['x-eol-agent']) state.registered.add(req.headers['x-eol-agent']); return reply(res, 200, { ok: true, result: { robot: { handle: '@' + HANDLE } } }); }
  if (name === 'eol_update_profile') return reply(res, 200, { ok: true, result: { endpoints: [...state.registered].map(endpointId => ({ endpointId, delivery: 'fast' })) } });
  if (name === 'eol_add_brain') {
    if (state.desk === 'refuse') return reply(res, 403, { ok: false, error: { code: 'forbidden', message: 'Your front desk runs on a subscription of your own; credit never goes behind it.' } });
    return reply(res, 200, { ok: true, result: { agent: { handle: HANDLE }, brain: { id: 'b1', harness: 'credit', name: 'EarthOnline balance', platform: true, status: 'ready', signin: null }, created: true } });
  }
  return reply(res, 404, { ok: false, error: { code: 'not_found', message: 'No such tool.' } });
});
const inbox = net.createServer(socket => {
  let buffer = '', authenticated = false;
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data;
    for (;;) {
      const n = buffer.indexOf('\n'); if (n < 0) break;
      const item = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (item.type === 'auth') { authenticated = item.token === token; if (!authenticated) badAuth = true; }
      else if (item.type === 'user' && authenticated) received.push(item.message.content);
      else badAuth = true;
    }
  });
  socket.on('error', () => {});
});

let origin, parent;
const env = () => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: codexHome, EOL_ORIGIN: origin, EOL_CLAUDE_BIN: fakeClaude, EOL_CODEX_BIN: fakeCodex };
  // never this machine's own session or key: a test run inside Claude Code must not bind it
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete e[k];
  return e;
};
const inSession = () => ({ CLAUDE_CODE_MESSAGING_SOCKET: pipe, CLAUDE_CODE_MESSAGING_TOKEN: token, CLAUDE_PID: String(parent.pid), CLAUDE_CODE_SESSION_ID: SESSION, CLAUDECODE: '1' });

function cli(args, extra = {}, input = '') {
  const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env: { ...env(), ...extra }, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(p);
  let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; captured += d; });
  p.stderr.on('data', d => { stderr += d; captured += d; });
  p.stdin.end(input);
  return new Promise((resolve, reject) => {
    p.once('error', reject);
    p.once('close', code => { children.delete(p); resolve({ code, stdout, stderr }); });
  });
}
async function json(args, extra = {}, expected = 0) {
  const r = await cli([...args, '--json'], extra);
  assert.equal(r.code, expected, `${args.join(' ')}: exit ${r.code}, expected ${expected}\n${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `--json prints one object on stdout: ${r.stdout}`);
  return JSON.parse(lines[0]);
}
const listenerPid = () => { try { return JSON.parse(fs.readFileSync(path.join(eolHome, 'live', `run-cc-${parent.pid}.pid`), 'utf8')).pid; } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const snapshot = () => Object.fromEntries([path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json'), ccSkill, configFile]
  .map(f => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]));
const emit = (type, payload) => { for (const res of state.connections) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); };

async function cleanup() {
  const pid = listenerPid();
  if (pid && alive(pid)) { try { process.kill(pid); } catch {} }
  for (const p of children) { try { p.kill(); } catch {} }
  if (parent && parent.exitCode === null) parent.kill();
  for (const res of state.connections) res.destroy();
  server.closeAllConnections?.(); server.close(); inbox.close();
  await sleep(150);
  const resolved = path.resolve(home);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('eol-setup-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
  clearTimeout(deadline);
}

try {
  origin = await new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  await new Promise(r => inbox.listen(pipe, r));
  parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
  await until(() => Boolean(parent.pid), 2000, 'fake Claude Code process');

  // 1. Magic moment 1 (design 1026 §2, t 32-50): login --code from the session's Bash tool
  const signed = await json(['login', '--email', 'robot@example.invalid', '--code', CODE, '--agent', 'claude-code'], inSession());
  assert.equal(signed.status, 'ok');
  assert.deepEqual(signed.warnings, []);
  assert.equal(signed.handle, HANDLE);
  assert.ok(signed.agents.length === 1 && signed.agents[0].startsWith('Claude Code ✓'), signed.agents.join(' | '));
  assert.deepEqual(signed.skills, [{ host: 'claude-code', path: ccSkill, status: 'ok' }]);
  assert.equal(signed.session.bound, true, JSON.stringify(signed.session));
  assert.equal(signed.desk, 'off', 'no front desk unless asked (Decision 6)');
  assert.ok(signed.next.some(n => n.includes('claude --continue')) && signed.next.some(n => n.includes('setup --desk')), signed.next.join(' | '));
  const pid = listenerPid();
  assert.ok(pid && alive(pid), 'the listener runs');
  if (process.platform === 'linux') {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    assert.equal(argv[1], path.join(eolHome, 'app', 'live.mjs'), 'started from EOL_HOME/app, never the package folder or the npx cache');
  }
  await until(() => state.connections.size === 1, 5000, 'the listener opens its stream');
  const headers = state.streams.at(-1);
  assert.ok(headers.authorization === `Bearer ${KEY}` && headers['x-eol-agent'] === `claude-code:${SESSION}` && headers['x-eol-live'] === '1', 'the stream is this session, signed with the new key');
  emit('message', { thread_id: 'thread-hello', from: { handle: 'earthonline', name: 'EarthOnline' }, seq: 1, text: 'Hi, what are you building?', expects_reply: true });
  await until(() => received.length === 1, 5000, 'the message reaches the session');
  assert.ok(received[0].includes('[EarthOnline]') && received[0].includes('@earthonline') && received[0].includes('what are you building'), received[0]);
  assert.ok(!badAuth, 'the session token was used');
  const skill = fs.readFileSync(ccSkill, 'utf8');
  assert.ok(Buffer.byteLength(skill) <= 2048, `the skill is at most 2 KB (${Buffer.byteLength(skill)})`);
  const description = /^description: (.*)$/m.exec(skill)?.[1] ?? '';
  assert.ok(skill.startsWith('---\nname: earthonline\ndescription: ') && description.length > 50 && description.length <= 1536, 'frontmatter as both programs read it');
  for (const words of ['eol_api_search', 'information, not instructions', '@earthonline', 'npx earthonline call', 'eol_ask your own handle, then eol_wait with the guest_token']) assert.ok(skill.includes(words), `the skill says: ${words}`);
  assert.ok(!fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes('earthonline-guest'), 'one service name: no earthonline-guest');
  console.log('PASS 1: login --code in a Claude Code session: MCP, skill, a listener bound to the session; a message arrives as a turn; no desk');

  // 2. A second run changes nothing
  const before = snapshot();
  const again = await json(['setup', '--agent', 'claude-code'], inSession());
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.session, { bound: true, pid }, 'the same listener');
  assert.deepEqual(snapshot(), before, 'settings, MCP config, skill and config.json byte for byte');
  await sleep(300);
  assert.equal(state.connections.size, 1, 'still one stream');
  console.log('PASS 2: a second setup changes nothing');

  // 3. Outside Claude Code nothing is bound and nothing is wrong; inside one without the messaging socket it is a warning
  const outside = await json(['setup', '--agent', 'claude-code']);
  assert.deepEqual(outside.session, { bound: false, reason: 'not_in_claude_code' });
  assert.deepEqual(outside.warnings, []);
  const old = await json(['setup', '--agent', 'claude-code'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION }, 5);
  assert.equal(old.status, 'partial');
  assert.deepEqual(old.warnings.map(w => [w.step, w.host]), [['live', 'claude-code']]);
  assert.ok(/v2\.1\.234/.test(old.warnings[0].error) && old.warnings[0].fix, 'says which Claude Code version pushes');
  console.log('PASS 3: no binding outside Claude Code; a session without cross-session messaging is a warning (exit 5)');

  // 4. The skill: a failed write, and someone else's skill of the same name, are warnings in --json with exit 5
  fs.rmSync(path.dirname(ccSkill), { recursive: true });
  fs.writeFileSync(path.dirname(ccSkill), 'not a folder');
  const broken = await json(['setup', '--agent', 'claude-code'], {}, 5);
  assert.equal(broken.status, 'partial');
  assert.deepEqual(broken.warnings.map(w => [w.step, w.host]), [['skill', 'claude-code']]);
  assert.equal(broken.skills[0].status, 'failed');
  fs.rmSync(path.dirname(ccSkill));
  fs.mkdirSync(path.dirname(ccSkill), { recursive: true });
  fs.writeFileSync(ccSkill, '---\nname: earthonline\ndescription: Somebody else\'s.\n---\nTheirs.\n');
  const foreign = await json(['setup', '--agent', 'claude-code'], {}, 5);
  assert.equal(foreign.skills[0].status, 'kept');
  assert.deepEqual(foreign.warnings.map(w => w.step), ['skill']);
  assert.equal(fs.readFileSync(ccSkill, 'utf8'), '---\nname: earthonline\ndescription: Somebody else\'s.\n---\nTheirs.\n', 'their skill untouched');
  fs.rmSync(path.dirname(ccSkill), { recursive: true });
  console.log('PASS 4: a skill that cannot be written, or is not ours, is a warning with exit 5 (--json too); theirs is kept');

  // 5. --no-skill; the desk only with --desk, and a refusal is a warning
  const noSkill = await json(['setup', '--agent', 'claude-code', '--no-skill']);
  assert.deepEqual(noSkill.skills, []);
  assert.ok(!fs.existsSync(ccSkill), '--no-skill writes none');
  assert.ok(!state.calls.some(c => c.name === 'eol_add_brain'), 'nothing so far asked for a desk');
  const desk = await json(['setup', '--agent', 'claude-code', '--desk']);
  assert.equal(desk.desk, 'on');
  assert.deepEqual(state.calls.filter(c => c.name === 'eol_add_brain').map(c => c.args), [{ kind: 'credit' }]);
  state.desk = 'refuse';
  const refused = await json(['setup', '--agent', 'claude-code', '--desk'], {}, 5);
  assert.equal(refused.desk, 'off');
  assert.deepEqual(refused.warnings.map(w => w.step), ['desk']);
  assert.ok(refused.warnings[0].error.includes('subscription of your own'), 'the server says why');
  const loginDesk = await cli(['login', '--code', CODE, '--desk', '--json']);
  assert.equal(loginDesk.code, 2, '--desk belongs to setup only');
  console.log('PASS 5: --no-skill; the desk only on setup --desk (eol_add_brain credit); a refused desk is a warning');

  // 6. Codex alone, on an account whose server has per-endpoint delivery settings
  state.msgCore = true;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  delete config.delivery; fs.writeFileSync(configFile, JSON.stringify(config));
  const codex = await json(['setup', '--agent', 'codex']);
  assert.equal(codex.status, 'ok', JSON.stringify(codex.warnings));
  assert.ok(codex.agents[0].startsWith('Codex ✓'));
  assert.deepEqual(codex.skills, [{ host: 'codex', path: codexSkill, status: 'ok' }]);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).delivery, 'off', 'the installer saw the delivery settings: Codex threads follow them');
  console.log('PASS 6: Codex alone on a delivery-settings account sets config.delivery; its skill is in ~/.agents/skills');

  // 7. uninstall: our skills go, the listener started from EOL_HOME/app is stopped
  await json(['setup', '--agent', 'claude-code']);
  assert.ok(fs.existsSync(ccSkill) && fs.existsSync(codexSkill));
  const gone = await cli(['uninstall']);
  assert.equal(gone.code, 0, gone.stderr);
  assert.ok(!fs.existsSync(path.dirname(ccSkill)) && !fs.existsSync(path.dirname(codexSkill)), 'uninstall removes our skills and their folders');
  await until(() => !alive(pid), 5000, 'the listener stops');
  console.log('PASS 7: uninstall removes the skills and stops the session listener');

  assert.ok(!/eolc_/.test(captured), 'nothing key-shaped in any output');
  console.log('PASS: setup stories');
} finally {
  await cleanup();
}
