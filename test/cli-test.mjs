// Local-only installer story. Node 22; shared Mongo, ports EOL_TEST_PORT_BASE+4/+5 (default 23444/23445); no real harness commands.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const port = Number(process.env.EOL_TEST_PORT_BASE || 23440) + 4;
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const serverDir = process.env.EOL_SERVER_DIR;
assert.ok(serverDir && fs.existsSync(path.join(serverDir, 'server.mjs')), 'Set EOL_SERVER_DIR to the EOL repo eol_chat/web directory');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Run this story with Node 22 or newer');
const { startServer, dropTestDatabase, withMongo } = await import(pathToFileURL(path.join(serverDir, 'scripts', 'lib', 'harness.mjs')).href);
const { startFakeResend } = await import(pathToFileURL(path.join(serverDir, 'scripts', 'fake-resend.mjs')).href);
assert.ok(fs.existsSync(path.join(here, 'cli.mjs')), 'installer must exist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-agentlive-d space-'));
const env = { ...process.env, HOME: temp, USERPROFILE: temp, EOL_HOME: path.join(temp, '.earthonline'), CODEX_HOME: path.join(temp, '.codex'), EOL_ORIGIN: `http://127.0.0.1:${port}` };
env.npm_config_cache = path.join(temp, 'npm-cache');
env.npm_config_userconfig = path.join(temp, 'npmrc');
env.npm_config_globalconfig = path.join(temp, 'global-npmrc');
env.npm_config_update_notifier = 'false';
// never this machine's own Claude Code session: a run inside one must not bind it (setup.mjs, live.mjs bindSession)
for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete env[k];
delete env.CODEX_THREAD_ID;
delete env.CLAUDE_CONFIG_DIR;
env.EOL_CLAUDE_BIN = path.join(temp, 'fake-claude.mjs');
env.EOL_FAKE_ARGS = path.join(temp, 'args.jsonl');
env.EOL_CODEX_BIN = path.join(temp, 'fake-codex.mjs'); // Codex is "installed" on any machine; it is never run here
fs.writeFileSync(env.EOL_CODEX_BIN, 'process.exitCode = 0;\n');
fs.writeFileSync(env.EOL_CLAUDE_BIN, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EOL_FAKE_ARGS, JSON.stringify(args)+'\\n', { mode: 0o600 });
const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
config.mcpServers ??= {};
if (args[1] === 'remove') {
  const old = config.mcpServers[args[2]];
  if (args[2] === 'earthonline' && ['http', 'sse'].includes(old?.type)) {
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.EOL_HOME, 'config.json'), 'utf8'));
    if (JSON.stringify(saved.replaced?.earthonline) !== JSON.stringify(old)) process.exit(2);
  }
  delete config.mcpServers[args[2]];
}
else if (args[1] === 'add') {
  const start = args.indexOf('--');
  config.mcpServers[args[start - 1]] = { type: 'stdio', command: args[start + 1], args: args.slice(start + 2) };
} else if (args[1] === 'add-json') config.mcpServers[args[2]] = JSON.parse(args[3]);
else process.exit(1);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
`);
const connectorSecret = 'Bearer ' + randomUUID();
const claudeCalls = () => fs.existsSync(env.EOL_FAKE_ARGS) ? fs.readFileSync(env.EOL_FAKE_ARGS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const codexFile = path.join(env.CODEX_HOME, 'config.toml');
const skillFiles = [path.join(temp, '.claude', 'skills', 'earthonline', 'SKILL.md'), path.join(temp, '.agents', 'skills', 'earthonline', 'SKILL.md')];
fs.mkdirSync(env.CODEX_HOME, { recursive: true });
fs.writeFileSync(codexFile, '# Keep this exactly\nmodel = "untouched"\n');
const settingsFile = path.join(temp, '.claude', 'settings.json');
const before = { permissions: { allow: ['Read'] }, enabledPlugins: { 'eol-chat@earthonline': true }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo another-hook', timeout: 7 }] }], PostToolUse: [], Stop: [{ hooks: [{ type: 'command', command: 'echo untouched' }] }] } };
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(before, null, 2));
const children = new Set();
let captured = '', fromCli = '', key = '', server, resend;
const dbName = `eol_chat_test_agentlive_d_${process.pid}_${Date.now()}`;
const mongoUri = 'mongodb://127.0.0.1:27029';
function child(file, args = [], extraEnv = {}) {
  const p = spawn(node, [file, ...args], { env: { ...env, ...extraEnv }, cwd: here, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(p);
  let output = '', stdout = '';
  const cli = path.basename(file) === 'cli.mjs';
  for (const stream of [p.stdout, p.stderr]) stream.on('data', d => { output += d; captured += d; if (cli) fromCli += d; if (stream === p.stdout) stdout += d; });
  const ended = new Promise(resolve => p.stdout.once('end', resolve));
  const done = new Promise((resolve, reject) => {
    p.once('error', reject);
    p.once('exit', code => { children.delete(p); resolve({ code, output }); });
  });
  return { p, done, ended, output: () => output, stdout: () => stdout };
}
async function run(args, input = '', expectedCode = 0) {
  const c = child(path.join(here, 'cli.mjs'), args);
  c.p.stdin.end(input);
  const result = await c.done;
  assert.equal(result.code, expectedCode, 'CLI command has expected exit status');
  return result.output;
}
/** A --json run: stdout is exactly one JSON object (design 1026 §10). */
async function runJson(args, input = '', expectedCode = 0) {
  const c = child(path.join(here, 'cli.mjs'), args);
  c.p.stdin.end(input);
  const result = await c.done; await c.ended;
  assert.equal(result.code, expectedCode, `CLI command has expected exit status: ${result.output.replace(/eolc_[0-9A-Za-z]+/g, '[redacted]')}`);
  const lines = c.stdout().trim().split('\n');
  assert.equal(lines.length, 1, '--json: one line on stdout');
  return JSON.parse(lines[0]);
}
async function until(fn, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 30)); }
  throw new Error(`Timed out: ${label}`);
}
function mcp(extraEnv = {}, harness = 'claude-code') {
  const c = child(path.join(here, 'mcp.mjs'), ['--harness', harness], extraEnv);
  const pending = new Map(); let id = 0;
  createInterface({ input: c.p.stdout }).on('line', line => {
    const reply = JSON.parse(line); const p = pending.get(reply.id);
    if (p) { pending.delete(reply.id); clearTimeout(p.timer); p.resolve(reply); }
  });
  return { ...c, call(method, params) {
    const n = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP response timed out')), 12000);
      pending.set(n, { resolve, timer });
      c.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  } };
}
try {
  resend = await startFakeResend({ port: port + 1 });
  server = await startServer({ entry: path.join(serverDir, 'server.mjs'), port, readyTimeoutMs: 90000, env: { ...resend.env, MONGODB_URI: mongoUri, MONGODB_DB: dbName, PUBLIC_ORIGIN: env.EOL_ORIGIN, RESEND_FROM: 'test@example.test', EOL_FLAG_CLI_SETUP: '*' } });
  // 0.2.0 (design 1026 §10): an agent signs in with two commands, in the setup block's order (--origin before the command)
  const email = 'agentlive-d@example.test';
  const sent = await runJson(['--origin', env.EOL_ORIGIN, 'login', '--email', email, '--json']);
  assert.equal(sent.status, 'code_sent', 'login --email: the code is on its way');
  assert.ok(sent.expires_in > 0 && sent.next.some(n => n.includes('login --code')), 'login --email says what comes next');
  const mail = await until(() => resend.mailsTo(email).at(-1), 'fake email');
  const code = /\b([A-Z]{4})[ -]([A-Z]{4})\b/.exec(mail.text);
  assert.ok(code, 'email carries an eight-letter code');
  const signed = await runJson(['login', '--code', code[1] + code[2], '--name', 'Agentlive D', '--json']);
  assert.equal(signed.status, 'ok', 'login --code signs in and sets up');
  assert.deepEqual(signed.warnings, []);
  assert.ok(signed.agents.some(line => line.startsWith('Claude Code ✓')) && signed.agents.some(line => line.startsWith('Codex ✓')), 'both agents set up');
  assert.ok(!fs.existsSync(path.join(env.EOL_HOME, 'pending-login.json')), 'the pending sign-in is gone');
  // setup (car11 A2/A3): each agent program's skill, read back; this run is not inside Claude Code; no desk unless asked (Decision 6)
  assert.deepEqual(signed.skills, [{ host: 'claude-code', path: skillFiles[0], status: 'ok' }, { host: 'codex', path: skillFiles[1], status: 'ok' }]);
  assert.deepEqual(signed.session, { bound: false, reason: 'not_in_claude_code' });
  assert.equal(signed.desk, 'off');
  assert.ok(!fs.readFileSync(path.join(temp, '.claude.json'), 'utf8').includes('earthonline-guest'), 'one service name: no earthonline-guest');
  const keyFile = path.join(env.EOL_HOME, 'key');
  key = fs.readFileSync(keyFile, 'utf8').trim();
  assert.ok(/^eolc_[0-9A-Za-z]{40}$/.test(key), 'valid key saved');
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!captured.includes(key), 'key never printed');
  // Codex (the app and plain codex share config.toml): our marked section appended, the rest kept, the file backed up
  const tomlAfter = fs.readFileSync(codexFile, 'utf8');
  assert.ok(tomlAfter.startsWith('# Keep this exactly\nmodel = "untouched"\n\n# >>> eol-connect (EarthOnline) >>>') && tomlAfter.includes('[mcp_servers.earthonline]') && tomlAfter.includes(JSON.stringify(path.join(env.EOL_HOME, 'app', 'mcp.mjs').replaceAll('\\', '/'))), 'our section in config.toml');
  assert.ok(fs.readdirSync(env.CODEX_HOME).some(f => f.startsWith('config.toml.eol-backup-')), 'config.toml backed up first');
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.EOL_HOME, 'config.json'), 'utf8')).codexWake, 'off', 'wake defaults to off without a terminal (DECISIONS 10-25 third set: fast/off, default off)');
  console.log('PASS 1: login --email then login --code (no terminal), private key file, no key in output, Codex section added');
  // car11 M4 on the real server: doctor finds nothing to fix after that setup; call reaches a tool with the saved key
  const checked = await runJson(['doctor', '--json']);
  assert.deepEqual(checked.warnings, [], 'doctor: nothing to fix');
  assert.equal(checked.status, 'ok'); assert.equal(checked.signed_in, true); assert.equal(checked.app, 'current');
  assert.equal(checked.claude_code.skill, 'ok'); assert.equal(checked.codex.skill, 'ok'); assert.equal(checked.codex.config, true);
  const me = await runJson(['call', 'eol_whoami', '--json']);
  assert.equal(me.result.robot.handle.replace(/^@/, ''), checked.handle, 'call eol_whoami: the signed-in robot');
  console.log('PASS 1b: doctor exits 0 after setup; call eol_whoami answers as the saved key');
  // car11 S4 on the real server: the key opens the inbox's live line (GET /api/inbox/live), and watch stops by itself
  const watched = await runJson(['watch', '--for', '1', '--json']);
  assert.equal(watched.status, 'ok'); assert.equal(watched.ended, 'time'); assert.deepEqual(watched.events, []); assert.equal(watched.line, 'live');
  console.log('PASS 1d: watch --for 1 opens the inbox line with the key and stops by itself');
  // car11 S4 (新迁移 10-26): watch's key on /api/inbox/live is read-only. While the owner's web page has the same line open (a session
  // cookie), a stranger's message reaches both: watch prints it and the page's line is nudged and stays open (the key takes no web
  // lease); afterwards the message is still unread for the owner and for their agent (watch hands nothing over, marks nothing read).
  {
    const { createHash, randomBytes } = await import('node:crypto');
    const robot = await withMongo(mongoUri, c => c.db(dbName).collection('robots').findOne({ handle: checked.handle }));
    const token = randomBytes(32).toString('base64url');
    await withMongo(mongoUri, c => c.db(dbName).collection('sessions').insertOne({ _id: createHash('sha256').update(token).digest('hex'), accountId: robot.accountId ?? null, robotId: robot._id, keyId: null, createdAt: Date.now(), expiresAt: new Date(Date.now() + 3600_000) }));
    const cookie = `eol_session=${token}`;
    const page = new AbortController();
    const pageLine = await fetch(`${env.EOL_ORIGIN}/api/inbox/live`, { headers: { cookie, accept: 'text/event-stream' }, signal: page.signal });
    assert.equal(pageLine.status, 200, 'the web page opens its line');
    let pageSaw = '', pageClosed = false;
    (async () => { try { for await (const chunk of pageLine.body) pageSaw += Buffer.from(chunk).toString(); } catch { /* aborted at the end */ } pageClosed = !page.signal.aborted; })();
    const tail = child(path.join(here, 'cli.mjs'), ['watch', '--for', '6', '--json']);
    tail.p.stdin.end();
    await new Promise(r => setTimeout(r, 2000)); // watch has its starting point and its line open
    const text = 'watch story: hello from a stranger';
    const asked = await fetch(`${env.EOL_ORIGIN}/api/tools/eol_ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: `@${checked.handle}`, text }) });
    assert.ok(asked.ok, `a stranger writes (HTTP ${asked.status})`);
    const done = await tail.done; await tail.ended;
    assert.equal(done.code, 0, done.output.replace(/eolc_[0-9A-Za-z]+/g, '[redacted]'));
    const seen = JSON.parse(tail.stdout().trim());
    assert.ok(seen.events.some(e => e.text === text && !e.mine), `watch printed the message from the stranger as they wrote it: ${JSON.stringify(seen.events.map(e => e.text))}`);
    assert.ok(/event: inbox/.test(pageSaw), 'the line of the web page was nudged too');
    assert.equal(pageClosed, false, 'the line of the web page stayed open');
    const inbox = await (await fetch(`${env.EOL_ORIGIN}/api/inbox.json`, { headers: { cookie } })).json();
    assert.equal(inbox.ok, true, 'the web page still reads its inbox');
    const listed = await runJson(['call', 'eol_list_conversations', '--input', '-', '--json'], '{}');
    const row = listed.result.conversations.find(c => c.last?.text?.includes('hello from a stranger'));
    assert.ok(row && row.unread >= 1 && row.owner_unread >= 1, `still unread for the agent and for the owner: ${JSON.stringify(row && { unread: row.unread, owner_unread: row.owner_unread })}`);
    page.abort();
  }
  console.log('PASS 1e: watch with the key beside the web page: both see the message, the page stays connected, nothing marked read');
  // car11 M3/M5 on the real server (B7, RFC 8628): login --device and key rotate --device. The person's approval on /device is the
  // server's own story (devil-device DV4: page, CSRF, session); here it is the row update answerDevice makes, for the signed-in robot.
  const metadata = await (await fetch(`${env.EOL_ORIGIN}/.well-known/oauth-authorization-server`)).json().catch(() => ({}));
  if (!metadata.device_authorization_endpoint) console.log('SKIP 1c: this server has no device flow yet (B7, car11-dev-1026)');
  else {
    const approve = async () => {
      const robot = await withMongo(mongoUri, c => c.db(dbName).collection('robots').findOne({ handle: checked.handle }));
      assert.ok(robot, 'the signed-in robot');
      const r = await withMongo(mongoUri, c => c.db(dbName).collection('oauth_device_codes').updateMany({ status: 'pending', clientId: 'earthonline-cli', expiresAt: { $gt: new Date() } }, { $set: { status: 'approved', robotId: robot._id, accountId: robot.accountId ?? null, answeredAt: Date.now() } }));
      assert.equal(r.modifiedCount, 1, 'one device code to approve');
    };
    const config = () => JSON.parse(fs.readFileSync(path.join(env.EOL_HOME, 'config.json'), 'utf8'));
    const keyIds = async () => (await runJson(['call', 'eol_whoami', '--json'])).result.keys.map(k => k.id);
    const first = await runJson(['login', '--device', '--no-setup', '--json']);
    assert.equal(first.status, 'approval_pending', 'no terminal: the link and code, at once');
    assert.ok(/^[A-Z]{4}-[A-Z]{4}$/.test(first.user_code) && first.verification_uri_complete.startsWith(env.EOL_ORIGIN), 'the code and the page on this server');
    await approve();
    const viaDevice = await runJson(['login', '--device', '--no-setup', '--wait', '30', '--json']);
    assert.equal(viaDevice.status, 'ok'); assert.equal(viaDevice.handle, checked.handle, 'the same account');
    const deviceKey = fs.readFileSync(keyFile, 'utf8').trim();
    assert.ok(/^eolc_[0-9A-Za-z]{40}$/.test(deviceKey) && deviceKey !== key, 'a new key saved');
    const deviceKeyId = config().key_id;
    assert.ok(typeof deviceKeyId === 'string' && (await keyIds()).includes(deviceKeyId), 'key_id from the token response kept, and listed');
    assert.ok(!fs.existsSync(path.join(env.EOL_HOME, 'pending-device.json')));
    assert.equal((await runJson(['key', 'rotate', '--device', '--no-setup', '--json'])).status, 'approval_pending');
    await approve();
    const rotated = await runJson(['login', '--device', '--no-setup', '--wait', '30', '--json']);
    assert.deepEqual(rotated.rotated, { revoked: deviceKeyId }, 'the replaced key revoked');
    key = fs.readFileSync(keyFile, 'utf8').trim();
    const left = await keyIds();
    assert.ok(!left.includes(deviceKeyId) && left.includes(config().key_id), 'old key gone, new key listed');
    assert.ok(!captured.includes(deviceKey) && !captured.includes(key), 'no key printed');
    console.log('PASS 1c: login --device and key rotate --device on the real server (B7): new key and its id saved, the replaced key revoked');
  }
  await run([], '\n');
  if (process.platform === 'win32') {
    const shim = path.join(temp, 'fake-claude.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nnode "%dp0%\\fake-claude.mjs" %*\r\n');
    env.EOL_CLAUDE_BIN = shim;
  }
  await run(['--key-stdin'], key + '\n');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const name of ['SessionStart', 'PostToolUse', 'SessionEnd', 'Stop']) {
    assert.equal(settings.hooks[name].flatMap(x => x.hooks).filter(x => x.command.includes('/app/live.mjs" hook')).length, 1);
  }
  assert.deepEqual(settings.permissions, before.permissions);
  assert.deepEqual(settings.enabledPlugins, before.enabledPlugins);
  assert.deepEqual(settings.hooks.SessionStart[0], before.hooks.SessionStart[0]);
  assert.deepEqual(settings.hooks.Stop[0], before.hooks.Stop[0], "the user's own Stop hook stays first and untouched");
  assert.ok(fs.readdirSync(path.dirname(settingsFile)).some(x => x.startsWith('settings.json.eol-backup-')));
  assert.ok(captured.includes('claude plugin disable eol-chat@earthonline'));
  console.log('PASS 2: settings preserved, backup, hooks idempotent, old-plugin notice');
  const calls = fs.readFileSync(env.EOL_FAKE_ARGS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[0][1], 'add', 'missing earthonline is added without a remove');
  assert.deepEqual(calls.find(x => x[1] === 'add'), ['mcp', 'add', '--scope', 'user', 'earthonline', '--', 'node', path.join(env.EOL_HOME, 'app', 'mcp.mjs').replaceAll('\\', '/'), '--harness', 'claude-code']);
  console.log('PASS 3: fake Claude received exact argv, without shell');

  // This Node process stands in for Claude Code: it owns the identity and directly spawns MCP.
  Object.assign(process.env, { EOL_HOME: env.EOL_HOME });
  const common = await import('../common.mjs');
  const session = 'agentlive-session-one';
  if (fs.existsSync(path.join(here, 'live.mjs'))) {
    const hook = child(path.join(here, 'live.mjs'), ['hook', 'session-start'], { CLAUDE_PID: String(process.pid) });
    hook.p.stdin.end(JSON.stringify({ session_id: session, cwd: temp, source: 'startup' }));
    assert.equal((await hook.done).code, 0);
  } else common.writeIdentity('claude-code', process.pid, { session_id: session, cwd: temp });
  const client = mcp();
  for (const protocolVersion of ['2025-06-18', '2025-03-26', '2024-11-05', 'future']) {
    const reply = await client.call('initialize', { protocolVersion });
    assert.equal(reply.result.protocolVersion, protocolVersion === 'future' ? '2025-06-18' : protocolVersion);
    assert.equal(reply.result.serverInfo.name, 'earthonline');
  }
  client.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.deepEqual((await client.call('ping')).result, {});
  assert.equal((await client.call('unknown')).error.code, -32601);
  const list = (await client.call('tools/list')).result.tools;
  assert.ok(list.some(t => t.name === 'eol_whoami'));
  assert.ok(list.every(t => /^eol_[a-z0-9_]+$/.test(t.name)));
  async function checkAgent(c, ident) {
    const result = (await c.call('tools/call', { name: 'eol_whoami', arguments: {} })).result;
    assert.ok(!result.isError, 'whoami succeeds');
    const agentId = result.structuredContent.agent?.id;
    assert.ok(agentId, 'whoami identifies the caller');
    const stored = await withMongo(mongoUri, db => db.db(dbName).collection('agents').findOne({ _id: agentId }));
    assert.equal(stored.ident, ident);
  }
  await checkAgent(client, 'claude-code:' + session);
  common.writeIdentity('claude-code', process.pid, { session_id: 'agentlive-session-two', cwd: temp, source: 'clear' });
  await checkAgent(client, 'claude-code:agentlive-session-two');
  assert.equal((await client.call('tools/call', { name: '../whoami' })).error.code, -32602);
  client.p.stdin.end(); await client.done;
  const cx = mcp({ CODEX_THREAD_ID: 'agentlive-codex-thread' }, 'codex');
  assert.equal((await cx.call('tools/call', {name:'eol_whoami'})).result.structuredContent.error.code, 'no_session_identity', 'a shared environment is not caller identity');
  cx.p.stdin.end(); await cx.done;
  const owner = mcp({}, 'codex');
  assert.equal((await owner.call('tools/call', { name: 'eol_whoami' })).result.structuredContent.error.code, 'no_session_identity', 'no anonymous owner fallback');
  owner.p.stdin.end(); await owner.done;
  console.log('PASS 4: MCP negotiation, live identity reload, Codex missing identity fails closed');
  // A stand-in listener at the installed path proves uninstall stops only a confirmed runtime.
  const listenerFile = path.join(env.EOL_HOME, 'app', 'live.mjs');
  fs.writeFileSync(listenerFile, 'setInterval(() => {}, 1000);');
  const listener = child(listenerFile, ['run', '--harness', 'claude-code', '--pid', String(process.pid)]);
  fs.writeFileSync(path.join(env.EOL_HOME, 'live', 'run-cc-456.pid'), JSON.stringify({ pid: listener.p.pid }));
  assert.ok((await run(['status'])).includes('Running Claude Code listeners: 1'));
  // A stale pid file must never kill another process, even one currently alive.
  fs.writeFileSync(path.join(env.EOL_HOME, 'live', 'run-cc-123.pid'), JSON.stringify({ pid: process.pid }));
  await run(['uninstall']);
  await until(() => !children.has(listener.p), 'confirmed listener exits');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), before);
  const removes = fs.readFileSync(env.EOL_FAKE_ARGS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(removes.some(x => JSON.stringify(x) === JSON.stringify(['mcp', 'remove', 'earthonline', '--scope', 'user'])));
  for (const file of ['key', 'app', 'live', 'config.json']) assert.ok(!fs.existsSync(path.join(env.EOL_HOME, file)), file + ' removed');
  for (const file of skillFiles) assert.ok(!fs.existsSync(path.dirname(file)), 'uninstall removes the skill ' + file);
  console.log('PASS 5: uninstall restores settings, stops confirmed listener; unrelated PID survives');
  assert.equal(fs.readFileSync(codexFile, 'utf8'), '# Keep this exactly\nmodel = "untouched"\n', 'uninstall gives config.toml back byte for byte');
  console.log('PASS 6: Codex detected; after uninstall config.toml is as it was');
  const noKey = mcp();
  assert.ok((await noKey.call('tools/list')).result.tools.some(t => t.name === 'eol_whoami'));
  assert.equal((await noKey.call('tools/call', { name: 'eol_whoami' })).result.isError, true);
  noKey.p.stdin.end(); await noKey.done;
  // npm sits next to node on Windows (node_modules\npm) and under lib/ on Linux and macOS (bin/node, lib/node_modules/npm)
  const npm = [path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(f => fs.existsSync(f));
  assert.ok(npm, 'npm-cli.js found next to this node');
  const pack = child(npm, ['pack', '--dry-run', '--json', '--ignore-scripts']);
  pack.p.stdin.end(); const packed = await pack.done;
  assert.equal(packed.code, 0, packed.output);
  const actual = JSON.parse(packed.output)[0].files.map(f => f.path).sort();
  const expected = ['package.json', ...JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).files.filter(f => fs.existsSync(path.join(here, f)))].sort();
  assert.deepEqual(actual, expected);
  console.log('PASS 7: npm pack allowlist exact (lane C files included when present)');
  const userConfig = path.join(temp, '.claude.json');
  const foreign = { custom: 'keep', mcpServers: { earthonline: { type: 'http', url: 'https://example.com/mcp' } } };
  const foreignText = JSON.stringify(foreign, null, 2);
  fs.writeFileSync(userConfig, foreignText);
  let start = claudeCalls().length;
  const conflict = await run(['--key-stdin'], key + '\n', 1);
  assert.ok(conflict.includes('A different MCP server named earthonline'));
  await run(['uninstall']);
  assert.equal(fs.readFileSync(userConfig, 'utf8'), foreignText, 'foreign config stays byte-for-byte unchanged');
  assert.ok(!claudeCalls().slice(start).some(a => a[2] === 'earthonline' || a[4] === 'earthonline'), 'foreign earthonline is neither removed nor replaced');
  console.log('PASS 8: foreign earthonline survives install and uninstall without any Claude mutation');

  // Test the configured directory too; the default user config remains a decoy.
  env.CLAUDE_CONFIG_DIR = path.join(temp, 'custom-claude');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const configuredFile = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  // (review 2) a connector holding a literal credential is never replaced: restoring it would put the credential on a command line
  fs.writeFileSync(configuredFile, JSON.stringify({ mcpServers: { earthonline: { type: 'http', url: 'https://mcp.earthonlines.com/mcp', headers: { Authorization: connectorSecret } } } }));
  start = claudeCalls().length;
  const literal = await run(['--key-stdin', '--replace-earthonline'], key + '\n', 1);
  assert.ok(literal.includes('A different MCP server named earthonline'), 'a literal credential blocks replacement');
  assert.ok(!claudeCalls().slice(start).some(a => a[1] === 'remove' && a[2] === 'earthonline'), 'a connector with a literal credential is not removed');
  await run(['uninstall']);
  // (review 3) the key in the url (EarthOnline's personal /mcp/k/<key>) is a credential too
  fs.writeFileSync(configuredFile, JSON.stringify({ mcpServers: { earthonline: { type: 'http', url: `https://mcp.earthonlines.com/mcp/k/${connectorSecret}` } } }));
  start = claudeCalls().length;
  const inUrl = await run(['--key-stdin', '--replace-earthonline'], key + '\n', 1);
  assert.ok(inUrl.includes('A different MCP server named earthonline') && !claudeCalls().slice(start).some(a => a[1] === 'remove' && a[2] === 'earthonline'), 'a key in the url blocks replacement');
  await run(['uninstall']);
  const originalConnector = { type: 'http', url: 'https://mcp.earthonlines.com/mcp' };
  fs.writeFileSync(configuredFile, JSON.stringify({ mcpServers: { earthonline: originalConnector } }));
  start = claudeCalls().length;
  const kept = await run(['--key-stdin', '--keep-earthonline'], key + '\n');
  assert.ok(kept.includes('Earlier EarthOnline MCP connection: kept (--keep-earthonline)'));
  assert.ok(!claudeCalls().slice(start).some(a => a[1] === 'remove' && a[2] === 'earthonline'), '--keep-earthonline keeps it');
  assert.ok(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers['earthonline-local'], '--keep-earthonline registers the local name');
  assert.deepEqual(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers.earthonline, originalConnector, 'old entry unchanged in keep mode');
  // (10-20) one EarthOnline MCP: replaced by default, said first
  const replaced = await run(['--key-stdin'], key + '\n');
  assert.ok(replaced.includes("Replacing your earlier EarthOnline MCP connection 'earthonline'") && replaced.includes('Earlier EarthOnline MCP connection: replaced'), 'replaced by default, said first');
  assert.ok(claudeCalls().slice(start).some(a => JSON.stringify(a) === JSON.stringify(['mcp', 'remove', 'earthonline', '--scope', 'user'])));
  const saved = JSON.parse(fs.readFileSync(path.join(env.EOL_HOME, 'config.json'), 'utf8'));
  assert.ok(JSON.stringify(saved.replaced.earthonline) === JSON.stringify(originalConnector), 'original connector is backed up intact');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(env.EOL_HOME, 'config.json')).mode & 0o777, 0o600);
  await run(['--key-stdin'], key + '\n');
  // Hooks follow CLAUDE_CONFIG_DIR as Claude Code does; the default ~/.claude/settings.json is never written.
  const configuredSettings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const hooked = JSON.parse(fs.readFileSync(configuredSettings, 'utf8')).hooks;
  assert.ok(['SessionStart', 'PostToolUse', 'SessionEnd'].every(e => hooked[e]?.some(g => g.hooks.some(h => h.command.includes('/app/live.mjs" hook')))), 'hooks in CLAUDE_CONFIG_DIR/settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), before, 'default settings.json untouched under CLAUDE_CONFIG_DIR');
  start = claudeCalls().length;
  await run(['uninstall']);
  assert.ok(!fs.readFileSync(configuredSettings, 'utf8').includes('/app/live.mjs'), 'uninstall removes the hooks it added there');
  const restored = claudeCalls().slice(start).find(a => a[1] === 'add-json');
  assert.ok(JSON.stringify(restored) === JSON.stringify(['mcp', 'add-json', 'earthonline', JSON.stringify(originalConnector), '--scope', 'user']), 'restore argv matches the original JSON exactly');
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers.earthonline) === JSON.stringify(originalConnector), 'connector restored');
  assert.equal(fs.readFileSync(userConfig, 'utf8'), foreignText, 'CLAUDE_CONFIG_DIR leaves default config untouched');
  assert.ok(!captured.includes(connectorSecret), 'connector authorization never printed');
  console.log('PASS 9: the earlier connection is replaced by default (--keep-earthonline keeps it), private backup survives reinstall, exact restore, no credential output');
  // Upgrade only our old eol registration; leave someone else's old name alone.
  const ownOld = { type: 'stdio', command: 'node', args: [path.join(env.EOL_HOME, 'app', 'mcp.mjs')] };
  fs.writeFileSync(configuredFile, JSON.stringify({ mcpServers: { eol: ownOld } }));
  await run(['--key-stdin', '--agent', 'claude-code'], key + '\n');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers), ['earthonline'], 'old own eol upgraded without a duplicate');
  await run(['uninstall']);
  const foreignOld = { command: 'node', args: [path.join(temp, 'someone-else.mjs')] };
  fs.writeFileSync(configuredFile, JSON.stringify({ mcpServers: { eol: foreignOld } }));
  await run(['--key-stdin', '--agent', 'claude-code'], key + '\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers.eol, foreignOld, 'foreign eol survives upgrade');
  await run(['uninstall']);
  assert.deepEqual(JSON.parse(fs.readFileSync(configuredFile, 'utf8')).mcpServers, { eol: foreignOld }, 'foreign eol survives uninstall');
  // --agent codex connects Codex alone: no Claude Code command, no settings change, the launcher installed.
  const ccBefore = fs.readFileSync(configuredSettings, 'utf8'), ccConfigBefore = fs.readFileSync(configuredFile, 'utf8');
  start = claudeCalls().length;
  const codexOnly = await run(['--key-stdin', '--agent', 'codex', '--codex-wake', 'queue'], key + '\n');
  assert.ok(codexOnly.includes('Connecting Codex to EarthOnline MCP.') && codexOnly.includes('Codex ✓ (app and CLI; wake: off).') && !codexOnly.includes('Claude Code ✓'), 'Codex alone is connected');
  assert.equal(claudeCalls().length, start, 'no Claude Code command for --agent codex');
  assert.equal(fs.readFileSync(configuredSettings, 'utf8'), ccBefore, 'Claude settings unchanged for --agent codex');
  assert.equal(fs.readFileSync(configuredFile, 'utf8'), ccConfigBefore, 'Claude MCP config unchanged for --agent codex');
  assert.ok(fs.existsSync(path.join(env.EOL_HOME, 'app', 'codex.mjs')), 'launcher installed');
  assert.ok(fs.readFileSync(codexFile, 'utf8').includes('[mcp_servers.earthonline]'), 'our section added');
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.EOL_HOME, 'config.json'), 'utf8')).codexWake, 'off', 'the old name queue (once quiet) is off');
  assert.ok((await run(['status'])).includes("config.toml has EarthOnline's section") , 'status sees the section');
  // Codex wake is only fast or off (DECISIONS 10-25 third set: quiet is deleted; existing quiet users map to off).
  // An old config's quiet, or an old script's --codex-wake quiet, reads as off without an error; front is still fast.
  const configFile = path.join(env.EOL_HOME, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), codexWake: 'quiet' }));
  assert.equal((await runJson(['status', '--json'])).codex.wake, 'off', 'a saved quiet reads as off');
  const quietFlag = await run(['--key-stdin', '--agent', 'codex', '--codex-wake', 'quiet'], key + '\n');
  assert.ok(quietFlag.includes('Codex ✓ (app and CLI; wake: off).') && !/quiet/i.test(quietFlag), '--codex-wake quiet is off, and quiet is not offered');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).codexWake, 'off', 'saved as off');
  assert.ok((await run(['--key-stdin', '--agent', 'codex', '--codex-wake', 'front'], key + '\n')).includes('Codex ✓ (app and CLI; wake: fast).'), 'front is still fast');
  const usageText = await run(['setup', '--codex-wake', 'loud'], '', 2);
  assert.ok(usageText.includes('--codex-wake fast|off') && !/quiet/i.test(usageText), 'usage offers fast|off only');
  console.log('PASS 10q: Codex wake is fast or off (default off); an old quiet, saved or passed, reads as off without an error');
  await run(['uninstall']);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), '# Keep this exactly\nmodel = "untouched"\n', 'uninstall gives config.toml back byte for byte');
  // someone else's earthonline in config.toml: the file is never touched
  const foreignToml = '[mcp_servers.earthonline]\ncommand = "theirs"\n';
  fs.writeFileSync(codexFile, foreignToml);
  // (8ad26eb) a name conflict is found before sign-in or any write, and the install stops
  const foreignRun = await run(['--key-stdin', '--agent', 'codex'], key + '\n', 1);
  assert.ok(foreignRun.includes('A different MCP server named earthonline is already set up') && fs.readFileSync(codexFile, 'utf8') === foreignToml, 'a foreign earthonline is left alone');
  await run(['uninstall']);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), foreignToml, 'uninstall leaves a foreign earthonline alone');
  // an earlier URL connection named earthonline: turned off in place while ours is in (default), back on at uninstall
  const withOld = '# Keep this exactly\n[mcp_servers.earthonline]\nurl = "https://mcp.earthonlines.com/mcp"\n\n[mcp_servers.earthonline.http_headers]\nX = "1"\n\n[tui]\nx = 1\n';
  fs.writeFileSync(codexFile, withOld);
  const turnedOff = await run(['--key-stdin', '--agent', 'codex'], key + '\n');
  const offText = fs.readFileSync(codexFile, 'utf8');
  assert.ok(turnedOff.includes("Turning off your earlier EarthOnline MCP connection 'earthonline'") && offText.includes('#eol-connect-off# [mcp_servers.earthonline]\n#eol-connect-off# url = ') && offText.includes('#eol-connect-off# [mcp_servers.earthonline.http_headers]') && offText.includes('\n[tui]\nx = 1\n'), 'the old connection is commented out, the next table is not');
  await run(['uninstall']);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), withOld, 'uninstall turns it back on byte for byte');
  await run(['--key-stdin', '--agent', 'codex', '--keep-earthonline'], key + '\n');
  assert.ok(!fs.readFileSync(codexFile, 'utf8').includes('#eol-connect-off#') && fs.readFileSync(codexFile, 'utf8').includes('[mcp_servers.earthonline-local]'), '--keep-earthonline leaves it on and uses the local name');
  await run(['uninstall']);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), withOld);
  fs.writeFileSync(codexFile, '# Keep this exactly\nmodel = "untouched"\n');
  console.log('PASS 10: --agent codex: Codex alone, our config.toml section in and out byte for byte, a foreign earthonline untouched, an old earthonline turned off and back on');
  // car11 M6, the cli-setup switch on (EOL_FLAG_CLI_SETUP=*, docs-route.js): the setup block that opens /skill.md, run as written
  // with this CLI, the way an agent reading it would. Skipped only on a server without the switch (before car11-srv-1026).
  const skill = await (await fetch(`${env.EOL_ORIGIN}/skill.md`)).text();
  if (!skill.startsWith('**For AI agents: set your person up')) console.log('SKIP 11: this server has no cli-setup switch yet (car11-srv-1026)');
  else {
    const said = [...skill.matchAll(/`([^`]*? login --(?:email|code) [^`]*)`/g)].map(m => m[1]);
    assert.equal(said.length, 2, 'the block gives login --email and login --code');
    // the block's own words, its placeholders filled as the agent fills them; `npx [-y] earthonline[@version]` is this CLI
    const NPX = /^npx (?:-y )?earthonline(?:@[\w.-]+)? /;
    const run2 = (cmd, input = '') => {
      assert.ok(NPX.test(cmd) && !cmd.includes('<'), `a command to run as written: ${cmd}`);
      return runJson(cmd.replace(NPX, '').split(' '), input);
    };
    const email2 = 'agentlive-setup@example.test';
    const sent2 = await run2(said[0].replace('<their email>', email2).replace('<handle>', 'agentlive_setup'));
    assert.equal(sent2.status, 'code_sent');
    const mail2 = await until(() => resend.mailsTo(email2).at(-1), 'setup block email');
    const code2 = /\b([A-Z]{4})[ -]([A-Z]{4})\b/.exec(mail2.text);
    const signed2 = await run2(said[1].replace('<the 8 letters>', code2[1] + code2[2]));
    assert.equal(signed2.status, 'ok'); assert.equal(signed2.handle, 'agentlive_setup');
    const callLine = /`([^`]*? call <tool> --input -)`/.exec(skill)?.[1];
    assert.ok(callLine && NPX.test(callLine), 'the block gives call');
    const me2 = await run2(`${callLine.replace('<tool>', 'eol_whoami')} --json`, '{}');
    assert.equal(me2.result.robot.handle.replace(/^@/, ''), 'agentlive_setup');
    key = fs.readFileSync(keyFile, 'utf8').trim();
    assert.ok(!captured.includes(key));
    console.log('PASS 11: with the cli-setup switch on, /skill.md opens with the setup block, and its commands run as written with this CLI');
  }
  assert.ok(!captured.includes(key), 'no key in any child output');
  // The CLI's own output (design 1026 §13: grep eolc_ is empty). Not the MCP children's: eol_whoami's result lists each
  // key's display prefix (its first 9 characters, keys.js), the server's data passed through, not a key. On failure: where it
  // was, without what follows (a key would follow), the 60 characters before each eolc_.
  assert.deepEqual([...fromCli.matchAll(/[^]{0,60}eolc_/g)].map(m => m[0].replace(/\s+/g, ' ')).slice(0, 3), [], 'nothing key-shaped in any CLI output');
  const logFile = path.join(env.EOL_HOME, 'live.log');
  if (fs.existsSync(logFile)) assert.ok(!fs.readFileSync(logFile, 'utf8').includes(key), 'no key in log');
  console.log('PASS: all installer stories');
} catch (err) {
  // Never print assertions containing received secrets or raw server output.
  console.error('FAIL:', String(err.stack).replaceAll(connectorSecret, '[redacted]').replace(/eolc_[0-9A-Za-z]+/g, '[redacted]'));
  process.exitCode = 1;
} finally {
  for (const p of children) { p.kill(); }
  if (server) await server.stop();
  if (resend) await resend.close();
  await dropTestDatabase(mongoUri, dbName);
  fs.rmSync(temp, { recursive: true, force: true });
}
