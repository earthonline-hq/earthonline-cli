// (Task 15b) live.mjs's beats and backoff, against a local stand-in for POST /api/agent/beat: what a beat sends, what ends the
// lease (409; two failures in a row; a beat that hangs past its timeout), the interval clamped to BEAT_MS, SIGUSR2's nudge, and
// Full Jitter's bounds (at most min(30 s, 1 s * 2 ** attempt)).
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.EOL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-beat-'));
const { startBeats, fullJitter } = await import('../live.mjs');

// Full Jitter: random() * min(cap, base * 2 ** attempt); the cap is 30 s however many attempts
assert.equal(fullJitter(0, () => 1), 1000);
assert.equal(fullJitter(3, () => 1), 8000);
assert.equal(fullJitter(5, () => 1), 30000, '32 s is over the cap');
assert.equal(fullJitter(1e6, () => 1), 30000);
assert.equal(fullJitter(4, () => 0), 0, 'Full Jitter may wait nothing at all');
for (let attempt = 0; attempt < 50; attempt++) {
  const wait = fullJitter(attempt);
  assert.ok(wait >= 0 && wait <= Math.min(30000, 1000 * 2 ** attempt), `attempt ${attempt}: ${wait}`);
}

const seen = [];
let reply = () => [200, { ok: true, until_ms: 20000 }];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const answer = reply();
    if (!answer) return; // a beat that never comes back
    res.writeHead(answer[0], { 'content-type': 'application/json' }).end(JSON.stringify(answer[1]));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'x-eol-agent': 'cc/test-session', 'x-eol-harness': 'claude-code' };
const beats = options => {
  const calls = { alive: 0, lost: [] };
  const handle = startBeats({ base, key: 'eol_sk_test', headers, generation: 7, beatMs: 60000,
    onAlive: () => { calls.alive++; }, onLost: reason => { calls.lost.push(reason); }, ...options });
  return { ...handle, calls };
};

try {
  // a beat taken: what it sends, and the stream told it is alive
  {
    const b = beats();
    assert.equal(await b.beatNow(), 'ok');
    const [beat] = seen.splice(0);
    assert.equal(beat.method, 'POST');
    assert.equal(beat.url, '/api/agent/beat');
    assert.equal(beat.headers.authorization, 'Bearer eol_sk_test');
    assert.equal(beat.headers['x-eol-agent'], 'cc/test-session');
    assert.deepEqual(beat.body, { generation: 7 });
    assert.equal(b.calls.alive, 1);
    // one beat in flight at a time
    const [first, second] = [b.beatNow(), b.beatNow()];
    assert.equal(first, second);
    await first;
    assert.equal(seen.splice(0).length, 1);
    b.stop();
    assert.equal(await b.beatNow(), 'stopped');
    assert.equal(seen.length, 0);
    assert.deepEqual(b.calls.lost, [], 'stopping is not losing');
  }

  // 409: the server says the lease ended, once, and then no more beats
  {
    reply = () => [409, { error: { code: 'conflict', reason: 'lease_lost' } }];
    const b = beats();
    assert.equal(await b.beatNow(), 'lost');
    assert.deepEqual(b.calls.lost, ['lease_lost']);
    assert.equal(await b.beatNow(), 'stopped');
    assert.deepEqual(b.calls.lost, ['lease_lost']);
    for (const status of [401, 403, 404]) {
      reply = () => [status, {}];
      const c = beats();
      assert.equal(await c.beatNow(), 'lost', `HTTP ${status}`);
      assert.deepEqual(c.calls.lost, ['lease_lost']);
    }
    seen.splice(0);
  }

  // failures: two in a row end it ('unreachable'); a beat taken in between starts the count again
  {
    let statuses = [500, 200, 503, 502];
    reply = () => [statuses.shift(), {}];
    const b = beats();
    assert.equal(await b.beatNow(), 'failed');
    assert.equal(await b.beatNow(), 'ok');
    assert.equal(await b.beatNow(), 'failed');
    assert.deepEqual(b.calls.lost, [], 'one failure since the last beat taken');
    assert.equal(await b.beatNow(), 'failed');
    assert.deepEqual(b.calls.lost, ['unreachable']);
    assert.equal(await b.beatNow(), 'stopped');
    // a network that is not there at all (nothing listens) counts the same
    const gone = startBeats({ base: 'http://127.0.0.1:9', key: 'k', headers, generation: 1, onLost: reason => gone.lost.push(reason) });
    gone.lost = [];
    await gone.beatNow(); await gone.beatNow();
    assert.deepEqual(gone.lost, ['unreachable']);
    seen.splice(0);
  }

  // a beat that hangs (a blackholed network) times out: it counts as a failure after at most 4 s
  {
    let statuses = [null, 500];
    reply = () => { const status = statuses.shift(); return status ? [status, {}] : null; };
    const b = beats();
    const started = Date.now();
    assert.equal(await b.beatNow(), 'failed');
    const took = Date.now() - started;
    assert.ok(took >= 3900 && took < 6000, `the hung beat gave up after ${took} ms`);
    assert.equal(await b.beatNow(), 'failed');
    assert.deepEqual(b.calls.lost, ['unreachable']);
    seen.splice(0);
  }

  // the interval: what the lease event asks for, never longer than BEAT_MS (5 s), never shorter than 1 s
  reply = () => [200, { ok: true, until_ms: 20000 }];
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const slow = beats({ beatMs: 60000 }); // asks for 60 s: beats every 5 s all the same
    mock.timers.tick(4999); await sleep(50);
    assert.equal(seen.length, 0);
    mock.timers.tick(1); await sleep(200);
    assert.equal(seen.splice(0).length, 1, 'the first beat at 5 s');
    mock.timers.tick(5000); await sleep(200);
    assert.equal(seen.splice(0).length, 1, 'and every 5 s after');
    slow.stop();
    const fast = beats({ beatMs: 10 }); // asks for 10 ms: 1 s
    mock.timers.tick(999); await sleep(50);
    assert.equal(seen.length, 0);
    mock.timers.tick(1); await sleep(200);
    assert.equal(seen.splice(0).length, 1);
    fast.stop();
    mock.timers.tick(10000); await sleep(100);
    assert.equal(seen.length, 0, 'stopped: no more beats');
  } finally { mock.timers.reset(); }

  // SIGUSR2 beats at once (POSIX only), while the beats run; after they stopped it does nothing, and does not end the process
  if (process.platform !== 'win32') {
    const b = beats();
    process.kill(process.pid, 'SIGUSR2');
    for (let i = 0; i < 40 && !seen.length; i++) await sleep(25);
    assert.equal(seen.splice(0).length, 1);
    b.stop();
    process.kill(process.pid, 'SIGUSR2');
    await sleep(300);
    assert.equal(seen.length, 0);
  }
  console.log('beat-test: ok');
} finally {
  server.close();
  server.closeAllConnections?.();
}
