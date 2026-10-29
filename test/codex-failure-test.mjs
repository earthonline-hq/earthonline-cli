import './codex-loopback.mjs';
// Fake native queue failure: no model, credentials or non-loopback service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-'));
process.env.EOL_HOME = root;
process.env.EOL_ORIGIN = `http://127.0.0.1:${PORT_BASE + 10}`;
process.env.EOL_CODEX_REMOTE = `ws://127.0.0.1:${PORT_BASE + 9}`;
process.env.EOL_CODEX_TOKEN = 'isolated-test-token';
process.env.EOL_CODEX_BIN = path.join(root, 'queue-fails.mjs');
fs.writeFileSync(path.join(root, 'key'), 'eolc_' + 'f'.repeat(40));
fs.writeFileSync(process.env.EOL_CODEX_BIN, "process.exitCode = 1;\n");
const { createCodexLive } = await import('../codex-live.mjs');
let stream, responseCode = 200, calls = 0;
const server = http.createServer((req, res) => {
  calls++;
  if(responseCode !== 200) { res.writeHead(responseCode); res.end(); return; }
  stream = res;
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
});
await new Promise(r => server.listen(PORT_BASE + 10, '127.0.0.1', r));
let live, timeout;
try {
  await assert.rejects(fetch('https://lobby.earthonlines.com/api/tools'), /fixture refuses/, 'test guard blocks default-origin requests before network');
  let warn;
  const warned = new Promise(r => warn = r);
  live = createCodexLive({ warn });
  const identity = { session_id: '11111111-2222-3333-4444-555555555555' };
  await live.ensure(identity);
  const closed = once(stream, 'close');
  stream.write('event: message\ndata: ' + JSON.stringify({ from: { handle: 'peer' }, text: 'private-body', thread_id: 't1', seq: 1 }) + '\n\n');
  const code = await Promise.race([warned, new Promise((_, reject) => timeout = setTimeout(() => reject(new Error('queue failure was not observable')), 5000))]);
  clearTimeout(timeout);
  assert.equal(code, 'QUEUE_FAILED');
  await closed;
  await assert.rejects(live.ensure(identity), /QUEUE_FAILED/);
  assert.equal(calls, 1, 'failed queue must not reconnect/retry blindly');
  await live.close();
  responseCode = 403;
  live = createCodexLive({ warn() {} });
  await assert.rejects(live.ensure(identity), /ACCESS_REFUSED/);
  await live.close();
  const log = fs.readFileSync(path.join(root, 'live.log'), 'utf8');
  assert.ok(log.includes('QUEUE_FAILED') && !log.includes('private-body') && !log.includes('isolated-test-token'));
  fs.mkdirSync(path.join(root, 'live'), { recursive: true });
  const record = path.join(root, 'live', `wrapper-codex-${process.pid}.pid`);
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, kind: 'codex-wrapper' }));
  const uninstall = spawnSync(process.execPath, ['--import', new URL('./codex-loopback.mjs', import.meta.url).href, fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'uninstall'], { env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(uninstall.status, 0);
  assert.match(uninstall.stderr + uninstall.stdout, /Close EOL Codex sessions/);
  assert.ok(fs.existsSync(record) && fs.existsSync(path.join(root, 'key')), 'uninstall refused before mutation');
  console.log('PASS queue failure is observable, stream stops, later calls fail closed; access refusal and private logs; active-wrapper uninstall refusal');
} finally {
  clearTimeout(timeout); await live?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
