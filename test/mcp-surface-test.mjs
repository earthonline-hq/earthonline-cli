// (car11 S2) mcp.mjs, the stdio MCP server, against a fake EarthOnline on 127.0.0.1:27985: tools/list asks for the slim list
// (X-EOL-Tools: slim), or the full one on a computer set to the legacy surface (config.json mode 'legacy'); a 401 on the list
// or on a call is the CLI's signed_out with the command that fixes it, never an empty list or "unavailable". Temporary HOME
// and EOL_HOME; no harness, no Mongo. Runs on Node 18 or later.
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
const PORT = 27985;
const newKey = () => 'eolc_' + randomBytes(20).toString('hex');
const KEY = newKey(), REVOKED = newKey();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-mcp-surface-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline');
const keyFile = path.join(eolHome, 'key'), configFile = path.join(eolHome, 'config.json');
const TOOLS = [{ name: 'eol_whoami', description: 'Who you are.', inputSchema: { type: 'object', properties: {} } }];
let captured = '';

const requests = [];
let plainUnauthorized = false; // a 401 whose body is not JSON (a proxy's page): the status alone decides
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method, url: req.url, headers: req.headers });
  const revoked = req.headers.authorization === `Bearer ${REVOKED}`;
  if (revoked) {
    if (plainUnauthorized) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Unauthorized'); }
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: `Sign in first (${REVOKED}).` } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.method === 'GET' && req.url === '/api/tools') return res.end(JSON.stringify({ ok: true, result: { tools: TOOLS } }));
  if (req.method === 'POST' && req.url === '/api/tools/eol_whoami') return res.end(JSON.stringify({ ok: true, result: { robot: { handle: '@robot_test1' } } }));
  res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'No such tool.' } }));
});

const env = () => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, EOL_ORIGIN: `http://127.0.0.1:${PORT}`, EOL_REQUIRE_ORIGIN: '1' };
  for (const k of ['EOL_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete e[k];
  return e;
};
/** A fresh mcp.mjs (its tool list is cached per process): rpc(method, params) -> the JSON-RPC answer; close() ends it. */
function mcp() {
  const child = spawn(process.execPath, [path.join(here, 'mcp.mjs'), '--harness', 'claude-code'], { env: env(), cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = new Map();
  let buffer = '', id = 0;
  child.stdout.on('data', d => {
    captured += d; buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const answer = JSON.parse(line);
      waiting.get(answer.id)?.(answer); waiting.delete(answer.id);
    }
  });
  child.stderr.on('data', d => { captured += d; });
  const closed = new Promise(r => child.on('close', r));
  return {
    rpc(method, params = {}) {
      const n = ++id;
      return new Promise(resolve => { waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    },
    close() { child.stdin.end(); return closed; },
  };
}
const listCalls = () => requests.filter(r => r.method === 'GET' && r.url === '/api/tools');
const setKey = key => { fs.mkdirSync(eolHome, { recursive: true }); fs.writeFileSync(keyFile, key + '\n'); };

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

  // 1. The everyday list: X-EOL-Tools: slim, and the server's list passed through.
  setKey(KEY);
  let m = mcp();
  let r = await m.rpc('tools/list');
  assert.deepEqual(r.result.tools.map(t => t.name), ['eol_whoami']);
  assert.equal(listCalls().length, 1);
  assert.equal(listCalls()[0].headers['x-eol-tools'], 'slim', 'the normal list request asks for the slim list');
  assert.equal(listCalls()[0].headers.authorization, `Bearer ${KEY}`);
  r = await m.rpc('tools/call', { name: 'eol_whoami', arguments: {} });
  assert.equal(r.result.isError, undefined, 'a tool call works as before');
  assert.deepEqual(r.result.structuredContent, { robot: { handle: '@robot_test1' } });
  await m.close();
  console.log('PASS 1: tools/list sends X-EOL-Tools: slim; calls unchanged');

  // 2. A computer set to the legacy surface (`setup --mode legacy` / `--full` wrote config.json mode 'legacy') asks for the full list.
  fs.writeFileSync(configFile, JSON.stringify({ handle: 'robot_test1', mode: 'legacy' }));
  m = mcp();
  r = await m.rpc('tools/list');
  assert.deepEqual(r.result.tools.map(t => t.name), ['eol_whoami']);
  assert.equal(listCalls().at(-1).headers['x-eol-tools'], 'full', 'legacy mode sends full');
  await m.close();
  fs.writeFileSync(configFile, JSON.stringify({ handle: 'robot_test1' }));
  console.log('PASS 2: legacy mode sends X-EOL-Tools: full');

  // 3. A revoked key on the list: a JSON-RPC error saying signed out and what to run; not cached, so signing in again is enough.
  setKey(REVOKED);
  m = mcp();
  const before = listCalls().length;
  r = await m.rpc('tools/list');
  assert.equal(r.result, undefined, 'no empty list in place of the error');
  assert.equal(r.error.code, -32000);
  assert.match(r.error.message, /not signed in to EarthOnline any more/);
  assert.match(r.error.message, /Next: npx earthonline login --email/);
  r = await m.rpc('tools/list');
  assert.equal(r.error?.code, -32000, 'asked again, still signed out');
  setKey(KEY);
  r = await m.rpc('tools/list');
  assert.deepEqual(r.result.tools.map(t => t.name), ['eol_whoami'], 'a new sign-in is seen without restarting the session');
  assert.equal(listCalls().length, before + 3, 'the signed-out answer is never cached');
  await m.close();
  console.log('PASS 3: a 401 on the list is signed_out (JSON-RPC error with the next step), not cached');

  // 4. A revoked key on a call: an MCP tool error (isError) with code signed_out, the message and the next step; also when the 401 body is not JSON.
  for (const plain of [false, true]) {
    plainUnauthorized = plain;
    setKey(REVOKED);
    m = mcp();
    r = await m.rpc('tools/call', { name: 'eol_whoami', arguments: {} });
    assert.equal(r.result.isError, true);
    const { error } = r.result.structuredContent;
    assert.equal(error.code, 'signed_out', `401 (${plain ? 'plain text' : 'JSON'} body) is signed_out`);
    assert.match(error.message, /not signed in to EarthOnline any more.*Next: npx earthonline login --email/);
    assert.deepEqual(error.next, ['npx earthonline login --email <your email>']);
    assert.match(r.result.content[0].text, /signed_out/);
    await m.close();
  }
  plainUnauthorized = false;
  console.log('PASS 4: a 401 on a call is an isError result, code signed_out, with the next step (JSON or not)');

  assert.ok(!/eolc_/.test(captured), 'no key in anything mcp.mjs wrote');
  console.log('PASS 5: no eolc_ in any output');
  console.log('mcp-surface-test: PASS');
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
