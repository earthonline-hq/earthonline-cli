// Real Codex app-server + queue; loopback fake model/EOL. No user configuration or paid API.
import { fixtureRuntime, modelToolCall } from './codex-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const previousCwd = process.cwd();
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-'));
const connect = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.EOL_CODEX_BIN;
assert.ok(exe && path.isAbsolute(exe), 'Set EOL_CODEX_BIN to installed Codex (real binary, no npx download)');
process.env.CODEX_HOME = root;
process.env.EOL_HOME = path.join(root, 'eol');
process.env.EOL_ORIGIN = `http://127.0.0.1:${PORT_BASE + 8}`;
fs.mkdirSync(process.env.EOL_HOME);
fs.writeFileSync(path.join(process.env.EOL_HOME, 'config.json'), JSON.stringify({origin:process.env.EOL_ORIGIN}));
const key = `eolc_${randomBytes(20).toString('hex')}`;
fs.writeFileSync(path.join(process.env.EOL_HOME, 'key'), key);
const config = `model="mock-model"\nmodel_provider="mock"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.mock]\nname="mock"\nbase_url="http://127.0.0.1:${PORT_BASE + 6}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`;
fs.writeFileSync(path.join(root, 'config.toml'), config);
process.chdir(root);
const runtime = fixtureRuntime(root, process.env.EOL_HOME, process.env.EOL_ORIGIN);
const { launchCodex } = await import(pathToFileURL(path.join(runtime, 'codex.mjs')).href);
const { callerIdentity } = await import('../codex-live.mjs');
const { makeSink } = await import('../live.mjs');
const bus = new EventEmitter();
function waitFor(check, event, ms = 20000) {
  if (check()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { if (check()) { clearTimeout(t); bus.off(event, done); resolve(); } };
    const t = setTimeout(() => { bus.off(event, done); reject(new Error('Timed out: ' + event)); }, ms);
    bus.on(event, done);
  });
}
const streams = new Map(), outbound = [], modelInputs = [], events = [], closedStreams = [];
let seq = 0, modelCount = 0, modelToolCalled = false, toolError = null, held = null, diagnostics = '', rpcId = 0, ws, tui, launched, server, model, inbox;
const pending = new Map();
function send(to, text, extra = {}) {
  const res = streams.get(to); assert.ok(res, 'target has live SSE: ' + to);
  const data = { from: { handle: 'peer' }, via: 'Codex', text, thread_id: 'private-test', seq: ++seq, reply: { arguments: { thread_id: 'private-test', reply_to_seq: seq } }, ...extra };
  res.write('event: message\ndata: ' + JSON.stringify(data) + '\n\n'); return data;
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId; const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
function answer(res, item) {
  if (res.writableEnded || res.destroyed) return;
  const id = 'resp_' + (++modelCount);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  ev('response.created', { response: { id } });
  ev('response.output_item.added', { output_index: 0, item });
  if (item.type === 'message') ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
  ev('response.output_item.done', { output_index: 0, item });
  ev('response.completed', { response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
}
const message = text => ({ type: 'message', role: 'assistant', id: 'msg_' + modelCount, content: [{ type: 'output_text', text }] });
try {
  model = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    if (!req.url.includes('responses')) { res.setHeader('content-type', 'application/json'); res.end('{"models":[]}'); return; }
    const j = JSON.parse(body); const user = [...(j.input ?? [])].reverse().find(x => x.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(x => x.text ?? '').join('');
    modelInputs.push(text); bus.emit('model');
    if (text === 'HOLD' && !held) { held = () => answer(res, message('released')); bus.emit('held'); return; }
    if (text === 'MODEL_TOOL' && !modelToolCalled) {
      modelToolCalled = true;
      fs.writeFileSync(path.join(root, 'tools-observed.json'), JSON.stringify(j.tools, null, 2));
      try { answer(res, modelToolCall(j.tools, 'eol_message', { text: 'from-model' })); } catch (e) { toolError = e; answer(res, message('no tool')); bus.emit('outbound'); } return;
    }
    answer(res, message('fixture received'));
  });
  await new Promise(r => model.listen(PORT_BASE + 6, '127.0.0.1', r));
  server = http.createServer(async (req, res) => {
    if (req.url === '/api/tools') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { tools: [{ name: 'eol_message', description: 'Send a message to another test participant.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' }, thread_id: { type: 'string' } }, required: ['text'] } }] } })); return; }
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const ident = req.headers['x-eol-agent'];
    if (req.url === '/api/agent/stream') {
      assert.match(ident, /^codex:[0-9a-f-]{36}$/); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); streams.set(ident, res); bus.emit('stream');
      req.on('close', () => { if (streams.get(ident) === res) streams.delete(ident); closedStreams.push(ident); bus.emit('closed'); }); return;
    }
    let raw = ''; for await (const b of req) raw += b;
    const args = JSON.parse(raw); outbound.push({ ident, args }); bus.emit('outbound');
    if (args.to && streams.has(args.to)) send(args.to, args.text);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { sent: true } }));
  });
  await new Promise(r => server.listen(PORT_BASE + 8, '127.0.0.1', r));
  let ready;
  const readyPromise = new Promise(r => { ready = r; });
  launched = launchCodex(['--port', String(PORT_BASE + 7)], { spawnTui(file, args, opts) {
    tui = new EventEmitter(); tui.exitCode = null; tui.signalCode = null; tui.kill = () => { if (tui.exitCode === null) { tui.exitCode = 0; tui.emit('exit', 0); } };
    const url = args[args.indexOf('--remote') + 1];
    ws = new WebSocket(url, { headers: { authorization: `Bearer ${opts.env.EOL_CODEX_TOKEN}` } });
    ws.on('error', e => { diagnostics += e.message; });
    ws.on('open', ready);
    ws.on('message', b => { const m = JSON.parse(b); if (m.id !== undefined && m.method === 'mcpServer/elicitation/request') { assert.equal(m.params.serverName,'earthonline'); assert.equal(m.params._meta?.codex_approval_kind,'mcp_tool_call'); assert.equal(m.params._meta.tool_params.text,'from-model'); ws.send(JSON.stringify({id:m.id,result:{action:'accept',content:{}}})); return; } if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } else { events.push(m); bus.emit('event'); } });
    return tui;
  } });
  await Promise.race([readyPromise, launched.then(() => { throw new Error('Launcher exited before WS ready'); })]);
  await rpc('initialize', { clientInfo: { name: 'eol_test', version: '1' }, capabilities: { experimentalApi: true } }); ws.send('{"method":"initialized"}');
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const t = await rpc('thread/start', { cwd: root, model: 'mock-model', modelProvider: 'mock', approvalPolicy: 'on-request', sandbox: 'read-only' }); ids.push(t.thread.id);
    await rpc('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'SEED-' + i }] });
    const bound = await rpc('mcpServer/tool/call', { threadId: t.thread.id, server: 'earthonline', tool: 'eol_message', arguments: { text: 'bind-' + i } });
    assert.ok(!bound.isError, JSON.stringify(bound));
  }
  const [a, b] = ids.map(id => 'codex:' + id);
  assert.deepEqual(outbound.slice(0, 2).map(x => x.ident), [a, b]);
  assert.equal(callerIdentity({}), null); assert.equal(callerIdentity({ threadId: ids[0], 'x-codex-turn-metadata': { thread_id: ids[1] } }), null);
  await waitFor(() => events.filter(e => e.method === 'turn/completed').length >= 2, 'event');
  for (const [from, to, mark] of [[ids[0], b, 'A-to-B'], [ids[1], a, 'B-to-A']]) {
    await rpc('mcpServer/tool/call', { threadId: from, server: 'earthonline', tool: 'eol_message', arguments: { to, text: mark } });
    await waitFor(() => modelInputs.some(t => t.includes(mark)), 'model');
  }
  console.log('PASS real queue: Codex private line both directions, distinct thread identities');
  const turn = await rpc('turn/start', { threadId: ids[0], input: [{ type: 'text', text: 'HOLD' }] });
  await waitFor(() => Boolean(held), 'held'); send(a, 'busy-queue'); held();
  await waitFor(() => modelInputs.some(t => t.includes('busy-queue')), 'model');
  for (const target of [a, b]) send(target, 'group-message', { thread_id: 'gc_test', group: { id: 'gc_test', name: 'test', size: 3, members: [{ handle: 'a' }, { handle: 'b' }, { handle: 'cc' }] } });
  await waitFor(() => modelInputs.filter(t => t.includes('group-message')).length >= 2, 'model');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\eol-ca-${process.pid}` : path.join(root, 'cc.sock');
  const ccToken = randomBytes(16).toString('hex'); let ccText;
  inbox = net.createServer(s => { let data = ''; s.on('data', d => data += d); s.on('end', () => { const [auth, msg] = data.trim().split('\n').map(JSON.parse); assert.equal(auth.token, ccToken); ccText = msg.message.content; s.end(); bus.emit('cc'); }); });
  await new Promise(r => inbox.listen(pipe, r));
  const sink = makeSink('claude-code', { env: { CLAUDE_CODE_MESSAGING_SOCKET: pipe, CLAUDE_CODE_MESSAGING_TOKEN: ccToken } });
  await rpc('mcpServer/tool/call', { threadId: ids[0], server: 'earthonline', tool: 'eol_message', arguments: { text: 'Codex-to-CC' } });
  await sink.deliver(outbound.at(-1).args.text); assert.equal(ccText, 'Codex-to-CC'); send(a, 'CC-to-Codex');
  await waitFor(() => modelInputs.some(t => t.includes('CC-to-Codex')), 'model'); sink.close();
  console.log('PASS real queue: busy/idle, group fanout, fake CC authenticated inbox both directions');
  await rpc('turn/start', { threadId: ids[1], input: [{ type: 'text', text: 'MODEL_TOOL' }] });
  await waitFor(() => { if (toolError) throw toolError; return outbound.some(x => x.args.text === 'from-model'); }, 'outbound');
  assert.equal(outbound.find(x => x.args.text === 'from-model').ident, b);
  console.log('PASS actual model-issued MCP tool call has the correct thread identity');
  const old = streams.get(a); old.end(); await waitFor(() => streams.get(a) && streams.get(a) !== old, 'stream');
  const duplicate = send(a, 'dedup-marker'); streams.get(a).write('event: message\ndata: ' + JSON.stringify(duplicate) + '\n\n');
  await waitFor(() => modelInputs.some(t => t.includes('dedup-marker')), 'model');
  await waitFor(() => events.filter(e => e.method === 'turn/completed').length >= 10, 'event');
  assert.equal(modelInputs.filter(t => t.includes('dedup-marker')).length, 1);
  const histories = [];
  for (const threadId of ids) {
    const result = await rpc('thread/read', { threadId, includeTurns: true });
    histories.push(JSON.stringify((result.thread.turns ?? []).flatMap(t => t.items ?? []).filter(i => i.type === 'userMessage')));
  }
  assert.ok(histories[0].includes('B-to-A') && !histories[0].includes('A-to-B'), 'A receives only its private line');
  assert.ok(histories[1].includes('A-to-B') && !histories[1].includes('B-to-A'), 'B receives only its private line');
  assert.ok(histories.every(h => h.includes('group-message')), 'both group members receive the group message');
  assert.equal(fs.readFileSync(path.join(root, 'config.toml'), 'utf8'), config);
  const closed = once(ws, 'close'); tui.kill(); await launched; await closed;
  await waitFor(() => streams.size === 0, 'closed', 5000);
  assert.equal(fs.readdirSync(path.join(process.env.EOL_HOME, 'live')).filter(x => /codex-auth|wrapper-codex/.test(x)).length, 0);
  const log = fs.readFileSync(path.join(process.env.EOL_HOME, 'live.log'), 'utf8');
  assert.ok(!log.includes(key) && !log.includes('A-to-B') && !log.includes('CC-to-Codex'));
  console.log('PASS source reconnect/dedup, config preservation, token cleanup, bounded event-driven shutdown, secret/body-free logs');
} catch (e) {
  console.error(e.stack);
  console.error('fixture directory:', root);
  console.error('last events:', JSON.stringify(events.slice(-5)));
  process.exitCode = 1;
} finally {
  held?.(); tui?.kill(); if (launched) await launched.catch(() => {}); ws?.terminate();
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closing')); }
  for (const s of [server, model]) if (s) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  if (inbox) await new Promise(r => inbox.close(r));
  process.chdir(previousCwd);
  if (!process.exitCode) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries:20, retryDelay:100 }); } catch { console.log('Fixture cleanup deferred until Windows releases cwd handles:', root); } }
}
