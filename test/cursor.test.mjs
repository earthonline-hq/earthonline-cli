// Synthetic only. Run on the test box; never starts Cursor or calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const connect = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conversation = 'synthetic-conversation-0001';
const userHook = '{ "command" : "echo keep\\u0020this", "timeout": 7, "matcher" : "Stop" }';
const original = `{
  "version" : 1,
  "user_setting": { "escaped": "\\u0061", "list" : [1,  2] },
  "hooks" : {
    "stop": [ ${userHook} ],
    "sessionStart": [{ "command": "echo user-start" }],
    "beforeShellExecution": [ { "command" : "echo untouched" } ]
  }
}\n`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };

async function fixture(t, { hooks = original } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-cursor-synthetic-'));
  const directory = path.join(root, '.cursor'), settings = path.join(directory, 'hooks.json');
  if (hooks !== null) write(settings, hooks);
  const config = path.join(root, '.earthonline', 'config.json');
  const key = 'eolc_' + 's'.repeat(40);
  write(path.join(root, '.earthonline', 'key'), key + '\n');
  const requests = [], endpoints = new Map(), leases = new Set();
  const state = { queue: [], fail: false, stall: false, receiptFail: false, streamStall: false, streamClaimed: false, offAfterStream: false };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, endpoint = req.headers['x-eol-agent'];
    requests.push({ route: req.url, endpoint, body });
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (state.stall) return;
    const send = (result, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, result })); };
    if (state.fail) return send(null, 503);
    if (req.url === '/api/tools/eol_whoami') {
      // Explicit prerequisite fixture: production currently has no HTTP path
      // to register turn-end capability. This fake is NOT integration evidence.
      if (!endpoints.has(endpoint)) endpoints.set(endpoint, { endpointId: endpoint, delivery: 'fast', deliveryEditable: true });
      return send({ robot: { handle: 'synthetic-owner' }, catch_up: { messages: state.queue } });
    }
    if (req.url === '/api/tools/eol_update_profile') {
      assert.equal(endpoint, undefined, 'owner settings are not agent-authored');
      if (body.endpoint) endpoints.get(body.endpoint).delivery = body.delivery;
      return send({ endpoints: [...endpoints.values()] });
    }
    if (req.url === '/api/agent/stream') {
      leases.add(endpoint);
      res.on('close', () => leases.delete(endpoint));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      if (!state.streamClaimed) for (const payload of state.queue) res.write(`id: ${payload.event}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
      if (state.offAfterStream) endpoints.get(endpoint).delivery = 'off';
      if (!state.streamStall) res.end();
      return;
    }
    if (req.url === '/api/msg/receipt') {
      if (state.receiptFail) return send(null, 503);
      return send({ results: body.items.map(item => ({ thread_id: item.thread_id, cursor: item.seq, moved: true })) });
    }
    if (req.url === '/api/agent/retire') { endpoints.get(endpoint).retired = true; return send({ retired: true }); }
    send(null, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: root, USERPROFILE: root, EOL_HOME: path.join(root, '.earthonline'), EOL_ORIGIN: base, EOL_REQUIRE_ORIGIN: '1' };
  delete env.EOL_CURSOR_MODE;
  const children = new Set();
  t.after(async () => {
    for (const child of children) child.kill(); // Only children created by this fixture.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function child(args, input = '', extra = {}, closeInput = true) {
    const started = performance.now();
    const proc = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(proc);
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.stdin.on('error', () => {});
    if (closeInput) proc.stdin.end(input);
    const timer = setTimeout(() => proc.kill(), 5000);
    try {
      const result = await new Promise((resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, elapsed: performance.now() - started }));
      });
      return result;
    } finally { clearTimeout(timer); children.delete(proc); }
  }
  async function cli(args) {
    const result = await child([path.join(connect, 'cli.mjs'), 'cursor', ...args]);
    assert.equal(result.code, 0, result.stderr); return result;
  }
  async function hook(event, fields = {}, extra = {}, { closeInput = true, input } = {}) {
    const result = await child([path.join(connect, 'cursor-hook.mjs'), '--config', settings, '--event', event], input ?? JSON.stringify({
      hook_event_name: event, conversation_id: conversation, session_id: conversation,
      generation_id: 'synthetic-generation-1', status: 'completed', loop_count: 0, ...fields,
    }), extra, closeInput);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); return result;
  }
  return { root, directory, settings, config, base, env, state, requests, endpoints, leases, cli, hook, child };
}

const trusted = (seq = 1) => ({ event: `message.created:synthetic-${seq}`, message: `synthetic-${seq}`, thread_id: 'synthetic-thread',
  conv: 'dm:synthetic-thread', seq, from: 'synthetic-friend', by: 'human', text: `SYNTHETIC-TRUSTED-${seq}`,
  provenance: { owner: 'synthetic-friend-id', by: 'human' } });
const gated = () => ({ ...trusted(2), needs_owner: true, from: 'synthetic-stranger\nspoof',
  text: 'SYNTHETIC-DO-NOT-LEAK', history: [{ text: 'SYNTHETIC-HISTORY-SECRET' }], fact: 'SYNTHETIC-DO-NOT-TRUST-FACT' });
const retires = f => f.requests.filter(r => r.route === '/api/agent/retire');
const receipts = f => f.requests.filter(r => r.route === '/api/msg/receipt');

test('install/uninstall preserve raw user hooks, other settings and MCP entries; backups never collide', async t => {
  const f = await fixture(t);
  const mcpUser = '{ "command" : "other-server", "args": ["\\u0061"] }';
  write(path.join(f.directory, 'mcp.json'), `{"mcpServers":{"other": ${mcpUser}}}\n`);
  const script = `import {installCursor, uninstallCursor} from ${JSON.stringify(pathToFileURL(path.join(connect, 'cursor.mjs')).href)};
    Date.now = () => 42;
    installCursor({delivery:'fast'}); uninstallCursor(); installCursor({delivery:'fast'}); uninstallCursor();`;
  const result = await f.child(['--input-type=module', '-e', script]);
  assert.equal(result.code, 0, result.stderr);
  const final = fs.readFileSync(f.settings, 'utf8');
  assert.ok(final.includes(userHook));
  assert.ok(final.includes('{ "escaped": "\\u0061", "list" : [1,  2] }'));
  assert.deepEqual(read(f.settings), JSON.parse(original));
  assert.ok(fs.readFileSync(path.join(f.directory, 'mcp.json'), 'utf8').includes(mcpUser));
  assert.equal(read(path.join(f.directory, 'mcp.json')).mcpServers.eol, undefined);
  const backups = fs.readdirSync(f.directory).filter(name => name.startsWith('hooks.json.eol-backup-42-'));
  assert.equal(backups.length, 4);
  assert.equal(new Set(backups).size, 4);
  assert.ok(backups.some(name => fs.readFileSync(path.join(f.directory, name), 'utf8') === original));
  await f.cli(['--delivery', 'fast']);
  assert.ok(fs.readFileSync(f.settings, 'utf8').includes(userHook), 'raw hook is also unchanged while installed');
  for (const event of ['sessionStart', 'stop', 'sessionEnd']) {
    const entry = read(f.settings).hooks[event].find(h => h.command.includes('cursor-hook.mjs'));
    assert.ok(entry); assert.equal(entry.timeout, 3);
    if (event === 'stop') assert.equal(entry.loop_limit, 5);
    assert.equal(entry.hooks, undefined, 'Cursor uses direct command entries, not Claude groups');
  }
  assert.match((await f.cli(['status'])).stdout, /EOL stop:/);
});

test('owner removal is a persistent opt-out, including uninstall/reinstall; remaining hook reports off', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  await f.hook('sessionStart');
  const before = read(f.settings);
  before.hooks.stop = before.hooks.stop.filter(h => !h.command.includes('cursor-hook.mjs'));
  write(f.settings, JSON.stringify(before));
  assert.equal((await f.hook('sessionEnd', { reason: 'user_close' })).stdout, '');
  assert.equal([...f.endpoints.values()][0].delivery, 'off');
  assert.equal(retires(f).length, 0);
  await f.cli(['--delivery', 'fast']); await f.cli(['uninstall']); await f.cli(['--delivery', 'fast']);
  assert.equal(read(f.config).cursor[f.directory].removed, true);
  assert.equal(read(f.config).cursor[f.directory].delivery, 'off');
  assert.ok(!fs.readFileSync(f.settings, 'utf8').includes('cursor-hook.mjs'));
});

test('fresh off writes only mcp.json; no hooks, app, host ID or installer config; project scope is explicit', async t => {
  const f = await fixture(t, { hooks: null }); await f.cli([]);
  assert.deepEqual(fs.readdirSync(f.directory), ['mcp.json']);
  assert.deepEqual(read(path.join(f.directory, 'mcp.json')), { mcpServers: { eol: { url: `${f.base}/mcp` } } });
  for (const file of [f.config, path.join(f.root, '.eol', 'host-id'), path.join(f.root, '.earthonline', 'app')]) assert.equal(fs.existsSync(file), false);
  const project = path.join(f.root, 'synthetic-project');
  await f.cli(['--project', project, '--delivery', 'fast']);
  assert.equal(fs.existsSync(f.settings), false);
  assert.equal(read(path.join(project, '.cursor', 'hooks.json')).version, 1);
  await f.cli(['uninstall', '--project', project]);
  assert.deepEqual(read(path.join(project, '.cursor', 'hooks.json')), {});
});

test('invalid config and a conflicting MCP name are preserved', async t => {
  const f = await fixture(t);
  write(f.settings, '{ invalid');
  let result = await f.child([path.join(connect, 'cli.mjs'), 'cursor', '--delivery', 'fast']);
  assert.equal(result.code, 1); assert.equal(fs.readFileSync(f.settings, 'utf8'), '{ invalid');
  assert.equal(fs.existsSync(path.join(f.directory, 'mcp.json')), false);
  write(f.settings, original); write(path.join(f.directory, 'mcp.json'), '{"mcpServers":{"eol":{"command":"other"}}}');
  result = await f.child([path.join(connect, 'cli.mjs'), 'cursor', '--delivery', 'fast']);
  assert.equal(result.code, 1); assert.equal(fs.readFileSync(f.settings, 'utf8'), original);
  assert.equal(read(path.join(f.directory, 'mcp.json')).mcpServers.eol.command, 'other');
});

test('empty queue and loop limit emit nothing; trusted content and only an untrusted fact reach stop', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  assert.equal((await f.hook('sessionStart')).stdout, '');
  assert.equal((await f.hook('stop')).stdout, '');
  f.state.queue = [trusted(), gated()];
  const atLimit = await f.hook('stop', { loop_count: 5 }); assert.equal(atLimit.stdout, '');
  const output = JSON.parse((await f.hook('stop')).stdout).followup_message;
  assert.match(output, /SYNTHETIC-TRUSTED-1/);
  assert.match(output, /wrote to you privately:\nSYNTHETIC-TRUSTED-1/); // (10-29) two lines: who, then the words
  assert.match(output, /\[EOL\] synthetic-stranger spoof in dm:synthetic-thread \(#2\)\./);
  assert.doesNotMatch(output, /SYNTHETIC-DO-NOT|SYNTHETIC-HISTORY/);
  assert.equal(receipts(f).length, 0);
  assert.equal((await f.hook('stop')).stdout, '', 'same generation cannot emit twice');
  const next = JSON.parse((await f.hook('stop', { generation_id: 'synthetic-generation-2' })).stdout).followup_message;
  assert.doesNotMatch(next, /synthetic-stranger/, 'fact notice is not retried');
  assert.match(next, /SYNTHETIC-TRUSTED-1/, 'unconfirmed content remains replayable');
  assert.equal(f.leases.size, 0, 'no resident lease while idle');
});

test('only a completed subsequent prompt confirmed by transcript posts a receipt, once; facts do not count', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  const transcript = path.join(f.root, 'synthetic-transcript.jsonl'); write(transcript, '');
  f.state.queue = [trusted(), gated()];
  const first = JSON.parse((await f.hook('stop', { transcript_path: transcript })).stdout).followup_message;
  f.state.queue = [];
  const fields = { generation_id: 'synthetic-generation-2', transcript_path: transcript, loop_count: 5 };
  fs.appendFileSync(transcript, JSON.stringify({ role: 'tool', content: first }) + '\n');
  await f.hook('stop', fields); assert.equal(receipts(f).length, 0, 'tool output is not the delivered prompt');
  fs.appendFileSync(transcript, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: first }] } }) + '\n');
  await f.hook('stop', fields); assert.equal(receipts(f).length, 0, 'prompt alone is not a finished turn');
  fs.appendFileSync(transcript, JSON.stringify({ role: 'assistant', content: 'Synthetic reply' }) + '\n');
  await f.hook('stop', { ...fields, status: 'aborted' }); assert.equal(receipts(f).length, 0);
  assert.equal((await f.hook('stop', fields)).stdout, '', 'receipt still runs at the loop limit');
  assert.equal(receipts(f).length, 1);
  assert.deepEqual(receipts(f)[0].body.items, [{ thread_id: 'synthetic-thread', seq: 1 }]);
  assert.equal(receipts(f)[0].body.trigger, 'injected-turn-finished');
  await f.hook('stop', fields); assert.equal(receipts(f).length, 1);
  assert.equal((await f.hook('stop', { ...fields, loop_count: 0 })).stdout, '', 'read content is not reoffered');
});

test('a real cursor-agent 2026.10.22 transcript (timestamp line, user_query, turn_ended) confirms the turn once', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  const transcript = path.join(f.root, 'synthetic-real-shape.jsonl'); write(transcript, '');
  f.state.queue = [trusted()];
  const first = JSON.parse((await f.hook('stop', { transcript_path: transcript })).stdout).followup_message;
  f.state.queue = [];
  // At the loop limit nothing is re-offered, so the first followup stays the one awaiting its turn.
  const fields = { generation_id: 'synthetic-generation-2', transcript_path: transcript, loop_count: 5 };
  // The rows exactly as cursor-agent 2026.10.22 wrote them on the test box (10-25), with synthetic words.
  const turn = query => [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Sunday, Oct 25, 2026, 7:57 PM (UTC)</timestamp>\n<user_query>\n${query}\n</user_query>` }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n') + '\n';
  fs.appendFileSync(transcript, turn(`Not the delivery: ${first}`));
  await f.hook('stop', fields); assert.equal(receipts(f).length, 0, 'a turn that only quotes the delivery is not it');
  fs.appendFileSync(transcript, turn(first));
  await f.hook('stop', fields);
  assert.equal(receipts(f).length, 1);
  assert.deepEqual(receipts(f)[0].body.items, [{ thread_id: 'synthetic-thread', seq: 1 }]);
  await f.hook('stop', fields); assert.equal(receipts(f).length, 1);
});

test('cursor-agent 2026.10.22 rewrites its transcript in place without the idle turn_ended row; the delivered turn confirms once', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  const transcript = path.join(f.root, 'synthetic-rewritten.jsonl');
  const user = query => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Monday, Oct 26, 2026, 3:08 AM (UTC)</timestamp>\n<user_query>\n${query}\n</user_query>` }] } });
  const answer = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  const idle = JSON.stringify({ type: 'turn_ended', status: 'success' });
  // The stop hook runs on the idle file: the last turn, then the turn_ended row.
  const before = [user('Reply with the single word ok.'), answer].join('\n') + '\n';
  write(transcript, before + idle + '\n');
  const inode = fs.statSync(transcript).ino;
  f.state.queue = [trusted()];
  const first = JSON.parse((await f.hook('stop', { transcript_path: transcript })).stdout).followup_message;
  f.state.queue = [];
  // The followup's turn: the same file rewritten (as the 10-26 box probe saw it), the idle row gone, the new rows after.
  fs.writeFileSync(transcript, before + [user(first), answer, idle].join('\n') + '\n');
  assert.equal(fs.statSync(transcript).ino, inode, 'rewritten in place, as cursor-agent does');
  const fields = { generation_id: 'synthetic-generation-2', transcript_path: transcript, loop_count: 5 };
  await f.hook('stop', fields);
  assert.equal(receipts(f).length, 1, 'the delivered turn right after the idle row is confirmed');
  assert.deepEqual(receipts(f)[0].body.items, [{ thread_id: 'synthetic-thread', seq: 1 }]);
  await f.hook('stop', fields); assert.equal(receipts(f).length, 1);
});

test('receipt failure retains pending evidence and retries without claiming a read', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  const transcript = path.join(f.root, 'synthetic-transcript.txt'); write(transcript, '');
  f.state.queue = [trusted()];
  const first = JSON.parse((await f.hook('stop', { transcript_path: transcript })).stdout).followup_message;
  fs.appendFileSync(transcript, `user:\n<user_query>\n${first}\n</user_query>\nassistant:\nSynthetic answer\n`);
  const fields = { generation_id: 'synthetic-generation-2', transcript_path: transcript, loop_count: 5 };
  f.state.receiptFail = true; assert.equal((await f.hook('stop', fields)).stdout, '');
  f.state.receiptFail = false; await f.hook('stop', fields); await f.hook('stop', fields);
  assert.equal(receipts(f).length, 2, 'one failed attempt and one successful retry');
});

test('host identity is written once; resume reuses endpoint; fresh chat changes it', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  await f.hook('sessionStart');
  const hostFile = path.join(f.root, '.eol', 'host-id'), host = fs.readFileSync(hostFile, 'utf8'), mtime = fs.statSync(hostFile).mtimeMs;
  await f.hook('sessionEnd', { reason: 'aborted' }); await f.hook('sessionStart');
  const next = 'synthetic-conversation-0002'; await f.hook('sessionStart', { conversation_id: next, session_id: next });
  assert.equal(fs.readFileSync(hostFile, 'utf8'), host); assert.equal(fs.statSync(hostFile).mtimeMs, mtime);
  assert.deepEqual([...f.endpoints.keys()], [`cursor:${host.trim()}:${conversation}`, `cursor:${host.trim()}:${next}`]);
  assert.equal((await f.hook('sessionStart', { conversation_id: '../../unsafe' })).stdout, '');
  assert.equal(f.endpoints.size, 2);
});

test('user_close/window_close/completed retire; aborted/error only hang up and keep identity', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  for (const reason of ['user_close', 'window_close', 'completed', 'aborted', 'error']) {
    const id = `synthetic-${reason}`, fields = { conversation_id: id, session_id: id };
    await f.hook('sessionStart', fields);
    const before = retires(f).length;
    assert.equal((await f.hook('sessionEnd', { ...fields, reason })).stdout, '');
    assert.equal(retires(f).length - before, ['aborted', 'error'].includes(reason) ? 0 : 1);
    assert.equal(f.leases.size, 0);
  }
});

test('print/headless and sessionEnd-only calls are forced off; server off never injects or retires', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']); f.state.queue = [trusted()];
  await f.hook('sessionEnd', { reason: 'completed' });
  assert.equal([...f.endpoints.values()][0].delivery, 'off'); assert.equal(retires(f).length, 0);
  for (const mode of ['print', 'headless']) {
    const id = `synthetic-${mode}`, fields = { conversation_id: id, session_id: id };
    await f.hook('sessionStart', fields, { EOL_CURSOR_MODE: mode });
    const result = await f.hook('stop', fields, { EOL_CURSOR_MODE: mode }); assert.equal(result.stdout, '');
    assert.equal([...f.endpoints.values()].find(e => e.endpointId.endsWith(`:${id}`)).delivery, 'off');
  }
  await f.hook('sessionStart', { is_background_agent: true });
  assert.equal(f.requests.some(r => r.route === '/api/agent/stream'), false);
  assert.equal((await f.hook('stop')).stdout, '');
  await f.hook('sessionEnd', { reason: 'user_close' }); assert.equal(retires(f).length, 0);
});

test('policy off during polling and unknown server capability cannot emit', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']); f.state.queue = [trusted()];
  f.state.offAfterStream = true; assert.equal((await f.hook('stop')).stdout, '');
  f.state.offAfterStream = false;
  const endpoint = [...f.endpoints.values()][0]; endpoint.delivery = 'fast'; endpoint.deliveryEditable = false;
  const streams = f.requests.filter(r => r.route === '/api/agent/stream').length;
  assert.equal((await f.hook('stop', { generation_id: 'synthetic-generation-2' })).stdout, '');
  assert.equal(f.requests.filter(r => r.route === '/api/agent/stream').length, streams);
});

test('queued content is reauthorized after trust revocation; a user-edited loop limit is honored', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  f.state.queue = [trusted()]; await f.hook('sessionStart');
  f.state.queue = [{ ...trusted(), needs_owner: true }];
  const definitions = read(f.settings);
  definitions.hooks.stop.find(h => h.command.includes('cursor-hook.mjs')).loop_limit = 1;
  write(f.settings, JSON.stringify(definitions));
  assert.equal((await f.hook('stop', { loop_count: 1 })).stdout, '');
  const result = await f.hook('stop');
  const text = JSON.parse(result.stdout).followup_message;
  assert.doesNotMatch(text, /SYNTHETIC-TRUSTED/);
  assert.match(text, /\[EOL\] synthetic-friend in dm:synthetic-thread \(#1\)\./);
});

test('a lost local stream journal recovers content, but never reclaims an ambiguous fact notice', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  f.state.queue = [trusted(), gated()]; f.state.streamClaimed = true;
  const result = await f.hook('stop');
  const text = JSON.parse(result.stdout).followup_message;
  assert.match(text, /SYNTHETIC-TRUSTED-1/);
  assert.doesNotMatch(text, /synthetic-stranger|SYNTHETIC-DO-NOT/);
});

test('short polling releases a held stream, and switching off preserves all user hooks', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  f.state.streamStall = true;
  const result = await f.hook('sessionStart');
  assert.equal(result.stdout, ''); assert.ok(result.elapsed < 2500);
  assert.equal(f.leases.size, 0);
  await f.cli(['--delivery', 'off']);
  assert.deepEqual(read(f.settings), JSON.parse(original));
  assert.ok(fs.readFileSync(f.settings, 'utf8').includes(userHook));
  assert.equal([...f.endpoints.values()][0].delivery, 'off');
  assert.equal((await f.hook('sessionEnd', { reason: 'completed' })).stdout, '');
  assert.equal(retires(f).length, 0);
});

test('server failure/down, hung response, malformed stdin and unclosed stdin all exit 0 silently in time', async t => {
  const f = await fixture(t); await f.cli(['--delivery', 'fast']);
  f.state.fail = true;
  let result = await f.hook('stop'); assert.equal(result.stdout, ''); assert.ok(result.elapsed < 2500);
  f.state.fail = false; f.state.stall = true;
  result = await f.hook('stop'); assert.equal(result.stdout, ''); assert.ok(result.elapsed < 2500);
  f.state.stall = false;
  result = await f.hook('stop', {}, {}, { input: '{ broken' }); assert.equal(result.stdout, ''); assert.ok(result.elapsed < 2500);
  result = await f.hook('stop', {}, {}, { closeInput: false }); assert.equal(result.stdout, '');
  assert.ok(result.elapsed < 3000, '2.5 second process watchdog plus at most 0.5 second Node startup');
  const unavailable = http.createServer(); await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const port = unavailable.address().port; await new Promise(resolve => unavailable.close(resolve));
  result = await f.hook('stop', {}, { EOL_ORIGIN: `http://127.0.0.1:${port}` });
  assert.equal(result.stdout, ''); assert.ok(result.elapsed < 2500);
});
