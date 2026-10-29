// Local-only delivery, identity, duplicate and secret-leak stories. No real harness is invoked.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const started = Date.now();
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-live-test-'));
process.env.EOL_HOME = home;
const live = fileURLToPath(new URL('../live.mjs', import.meta.url));
const key = `eolc_${randomBytes(20).toString('hex')}`;
const token = randomBytes(24).toString('hex');
const secretText = `PRIVATE-${randomBytes(12).toString('hex')}`;
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\eol-live-test-${randomBytes(8).toString('hex')}` : path.join(home, 'inbox.sock');
const children = [], detached = new Set(), requests = [], connections = new Set(), received = [];
let status = 200, retryAfter = null, badAuth = false, activeWrites = 0, peakWrites = 0;
let common, server, inbox;
let env;
const deadline = setTimeout(() => { process.stderr.write('FAIL: story deadline exceeded\n'); void cleanup().then(() => process.exit(1)); }, 150_000);

async function until(check, ms = 5000, why = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(25); }
  throw new Error(`Timed out: ${why}`);
}
function child(args, extra = {}) {
  const cp = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(cp);
  cp.out = ''; cp.err = '';
  cp.stdout.on('data', b => { cp.out += b; }); cp.stderr.on('data', b => { cp.err += b; });
  cp.on('error', () => { cp.failed = true; });
  cp.on('exit', () => { cp.done = true; });
  return cp;
}
async function session() { const cp = child(['-e', 'setInterval(()=>{},1e9)']); await until(() => Boolean(cp.pid)); return cp; }
async function stop(cp) { if (cp && !cp.done) { cp.kill(); await until(() => cp.done, 3000, 'child exit'); } }
function emit(type, payload) { for (const res of connections) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); }
function message(seq, extra = {}) {
  return { thread_id: 'thread-local', from: { handle: 'ada', name: 'Ada' }, via: 'Claude Code', seq, text: `${secretText}-${seq}`, expects_reply: true,
    reply: { tool: 'eol_message', arguments: { thread_id: 'thread-local', reply_to_seq: seq, client_msg_id: `reply-${seq}` } }, ...extra };
}
async function startRun(parent, sessionId, extraEnv = {}, args = []) {
  common.writeIdentity('claude-code', parent.pid, { session_id: sessionId, cwd: home });
  const cp = child([live, 'run', '--harness', 'claude-code', '--pid', String(parent.pid), ...args], extraEnv);
  return cp;
}
async function hook(parent, kind, input, extraEnv = {}) {
  const began = Date.now();
  const cp = child([live, 'hook', kind], { CLAUDE_PID: String(parent.pid), ...extraEnv });
  cp.stdin.end(JSON.stringify(input));
  await until(() => cp.done, 1800, `hook ${kind}`);
  assert.ok(cp.exitCode === 0 && !cp.out && !cp.err, 'hooks must be silent and exit zero');
  assert.ok(Date.now() - began < 1000, 'hooks must return within one second');
}
async function cleanup() {
  for (const cp of children) if (cp.pid && !cp.done) { try { cp.kill(); } catch {} }
  for (const pid of detached) { try { process.kill(pid); } catch {} }
  for (const res of connections) res.destroy();
  server?.closeAllConnections(); server?.close(); inbox?.close();
  await sleep(150);
  const resolved = path.resolve(home);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('eol-live-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
  clearTimeout(deadline);
}

try {
  assert.ok(fs.existsSync(live), 'live.mjs must exist');
  common = await import('../common.mjs');
  const { formatMessage } = await import('../format.mjs');
  fs.writeFileSync(common.PATHS.key, key, { mode: 0o600 });
  server = http.createServer((req, res) => {
    requests.push({ headers: req.headers, at: Date.now(), status });
    if (status !== 200) { res.writeHead(status, retryAfter ? { 'retry-after': retryAfter } : {}); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hello\n\n');
    connections.add(res); res.on('close', () => connections.delete(res));
  });
  let port;
  for (const candidate of [PORT_BASE + 2, PORT_BASE + 3]) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); port = candidate; break; }
    catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  assert.ok(port, 'a reserved port must be free');
  inbox = net.createServer(socket => {
    activeWrites++; peakWrites = Math.max(peakWrites, activeWrites);
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
    socket.on('close', () => activeWrites--); socket.on('error', () => {});
  });
  await new Promise(resolve => inbox.listen(pipe, resolve));
  env = { ...process.env, EOL_HOME: home, EOL_ORIGIN: `http://127.0.0.1:${port}`, CLAUDE_CODE_MESSAGING_SOCKET: pipe, CLAUDE_CODE_MESSAGING_TOKEN: token };
  const parent = await session();
  const run = await startRun(parent, 'session-first');
  await until(() => connections.size === 1, 5000, 'initial stream');
  const headers = requests.at(-1).headers;
  assert.ok(headers.authorization === `Bearer ${key}` && headers['x-eol-agent'] === 'claude-code:session-first' && headers['x-eol-agent-name'] && headers['x-eol-live'] === '1', 'identity and auth headers');
  assert.ok(!headers['claude-code-messaging-token'], 'inbox credential must stay local');
  const sent = Date.now(); emit('message', message(1));
  await until(() => received.length === 1, 2000, 'private delivery');
  const latency = Date.now() - sent;
  assert.ok(received[0].split('\n')[0].includes('[EarthOnline]') && received[0].split('\n')[0].includes('@ada'), 'source boundary');
  assert.ok(received[0].split('\n').length >= 2 && !/\[EarthOnline-[a-f0-9]{32}\]/.test(received[0]) && !received[0].includes('eol_message'), 'two lines: who, then the words (10-29)');
  const group = { id: 'gc_local', name: 'brainbob', size: 2, members: ['@ada', '@owner'] };
  emit('message', message(2, { group })); await until(() => received.length === 2);
  assert.match(received[1].split('\n')[0], /^\[EarthOnline\] @ada(?: \(person\)|'s agent) in "brainbob"/, 'group routing context');
  emit('message', message(1));
  for (const res of connections) res.end();
  await until(() => requests.length >= 2 && connections.size === 1, 4000, 'reconnect');
  emit('message', message(1)); emit('message', message(2, { group }));
  await sleep(200); assert.ok(received.length === 2, 'duplicates across reconnect must be suppressed');
  for (let seq = 3; seq <= 7; seq++) emit('message', message(seq));
  await until(() => received.length === 7);
  assert.ok(received.slice(2).every((text, i) => text.endsWith(`\n${secretText}-${i + 3}`)), 'delivery order');
  assert.ok(peakWrites === 1 && !badAuth, 'one authenticated connection at a time');
  const noteUrl = `${env.EOL_ORIGIN}/notes/local-note`;
  for (const kind of ['join_request', 'joined', 'refused', 'disbanded']) emit('group', { kind, group, joiner: { handle: 'rowan', name: 'Rowan', via: 'Claude Code' }, member: { handle: 'rowan' }, by: { handle: 'ada' }, members: [{ handle: 'rowan', online: true }], ...(kind === 'join_request' ? { note_id: 'local-note', note_url: noteUrl } : {}) });
  await until(() => received.length === 11);
  assert.ok(received[7].includes(noteUrl) && received[7].includes('Only your owner can let them in.'), 'owner approval boundary');
  emit('group', { kind: 'joined', group, member: { handle: 'rowan' } }); await sleep(100);
  assert.ok(received.length === 11, 'group duplicate must be suppressed');
  common.writeIdentity('claude-code', parent.pid, { session_id: 'session-second', source: 'clear' });
  await until(() => requests.at(-1).headers['x-eol-agent'] === 'claude-code:session-second', 3000, 'identity switch');
  assert.ok(requests.at(-1).headers['x-eol-agent-previous'] === 'claude-code:session-first', 'previous identity must migrate binding');
  for (const res of connections) res.end();
  const count = requests.length;
  await until(() => requests.length > count && connections.size === 1, 4000);
  assert.ok(!requests.at(-1).headers['x-eol-agent-previous'], 'previous pair sent once');
  const died = Date.now(); await stop(parent); await until(() => run.done, 6000, 'parent death cleanup');
  assert.ok(Date.now() - died < 6000 && !fs.existsSync(common.pidFile('claude-code', parent.pid)), 'parent death removes pid file');
  console.log(`PASS 1-6,8: private/group ${latency}ms; dedup, ordered queue, group events, identity migration, parent cleanup, headers`);

  const parent2 = await session();
  status = 401; const before401 = received.length;
  const denied = await startRun(parent2, 'session-denied'); await until(() => denied.done);
  assert.ok(received.length === before401 + 1 && received.at(-1).includes('401') && !received.at(-1).includes(key), 'auth failure notice without secret');
  const beforeOrigin = requests.length;
  const unsafe = await startRun(parent2, 'session-unsafe', { EOL_ORIGIN: 'http://example.com' }); await until(() => unsafe.done);
  assert.ok(requests.length === beforeOrigin, 'unsafe origin cannot send a request');
  status = 200;
  console.log('PASS 7-8: 401 notice and exit; unsafe origin rejected before network');

  await hook(parent2, 'session-start', { session_id: 'session-hooked', cwd: home });
  assert.ok(common.readIdentity('claude-code', parent2.pid)?.session_id === 'session-hooked', 'start writes identity');
  const post = { session_id: 'session-hooked', cwd: home, tool_name: 'mcp__eol__eol_whoami' };
  await hook(parent2, 'post-tool', { ...post, tool_name: 'unrelated' });
  assert.ok(!fs.existsSync(common.pidFile('claude-code', parent2.pid)), 'unrelated tools do not start listener');
  await hook(parent2, 'post-tool', post, { CLAUDE_CODE_MESSAGING_SOCKET: '' });
  assert.ok(!fs.existsSync(common.pidFile('claude-code', parent2.pid)), 'no inbox means no listener');
  const preHooks = requests.length;
  await Promise.all([hook(parent2, 'post-tool', post), hook(parent2, 'post-tool', post)]);
  await until(() => requests.length > preHooks && connections.size === 1, 5000, 'hook listener');
  const record = common.readJson(common.pidFile('claude-code', parent2.pid)); detached.add(record.pid);
  await sleep(250); assert.ok(requests.length === preHooks + 1 && common.pidAlive(record.pid), 'concurrent hooks start exactly one listener');
  await hook(parent2, 'session-end', { reason: 'clear' }); assert.ok(common.pidAlive(record.pid), 'clear keeps listener');
  await hook(parent2, 'session-start', { session_id: 'session-cleared', source: 'clear', cwd: home });
  assert.ok(common.readIdentity('claude-code', parent2.pid).used_eol, 'clear inherits used_eol');
  await hook(parent2, 'session-end', { reason: 'other' });
  await until(() => !common.pidAlive(record.pid), 3000, 'session-end kills owned listener');
  assert.ok(!fs.existsSync(common.pidFile('claude-code', parent2.pid)), 'session-end removes pid file');
  detached.delete(record.pid);
  // A stale file pointing at an unrelated live process must never authorize killing it.
  fs.writeFileSync(common.pidFile('claude-code', parent2.pid), JSON.stringify({ pid: parent2.pid, harness: 'claude-code', parent_pid: parent2.pid }));
  await hook(parent2, 'session-end', { reason: 'other' }); assert.ok(common.pidAlive(parent2.pid), 'unrelated process is never killed');
  fs.rmSync(common.pidFile('claude-code', parent2.pid), { force: true });
  console.log('PASS 9: silent hooks <1s, lazy start, concurrent lock, clear, safe session-end');

  const fakeCodex = path.join(home, 'fake-codex.mjs'), argvFile = path.join(home, 'argv.json');
  fs.writeFileSync(fakeCodex, `import fs from 'node:fs';\nconst file = process.env.FAKE_ARGV_FILE;\nlet runs = []; try { runs = JSON.parse(fs.readFileSync(file)); } catch {}\nruns.push(process.argv.slice(2)); fs.writeFileSync(file, JSON.stringify(runs));\nprocess.exit(runs.length <= 2 ? 1 : 0);\n`);
  const { makeSink } = await import('../live.mjs');
  const sink = makeSink('codex', { codexJs: fakeCodex, threadId: 'thread-fake-123', env: { ...env, FAKE_ARGV_FILE: argvFile } });
  const hostile = `${secretText} spaces "quotes" &|;$() 'single' \\ path\nnext line`;
  await sink.deliver(hostile); sink.close();
  const calls = JSON.parse(fs.readFileSync(argvFile));
  assert.ok(calls.length === 3 && calls.every(args => args.length === 5 && args[0] === 'queue' && args[2] === 'thread-fake-123' && args[4] === hostile), 'codex retries preserve one exact message argument');
  const long = formatMessage(message(99, { text: '汉😀'.repeat(10_000), history: [{ from: 'ada', seq: 98, text: 'history' }] }));
  assert.ok(Buffer.byteLength(long) <= 16384 && !long.includes('\ufffd') && long.includes('(cut short: read it whole with eol_read'), 'byte cap keeps where to read it whole');
  const logs = fs.readFileSync(common.PATHS.log, 'utf8');
  assert.ok(![key, token, secretText, hostile].some(value => logs.includes(value)), 'logs must not contain secrets or body');
  assert.ok(logs.includes('no_inbox'), 'missing inbox is logged');
  console.log('PASS 10-11: no body/token/key in logs; fake Codex retries twice then delivers one intact argv; 16KB cap');
  await stop(parent2);
  console.log(`ALL PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (err) {
  // Assertion values can include credentials. Only our fixed diagnostic is printed.
  console.error(`FAIL: ${err instanceof assert.AssertionError ? err.message.split('\n')[0] : String(err.message).replace(/eolc_[A-Za-z0-9]+/g, '[redacted]')}`);
  process.exitCode = 1;
} finally { await cleanup(); }
