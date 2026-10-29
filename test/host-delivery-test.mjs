// Synthetic crash/replay coverage. No server, browser, model, or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-host-delivery-'));
process.env.EOL_HOME = root;
process.env.EOL_REQUIRE_ORIGIN = '1';
process.env.EOL_ORIGIN = 'http://127.0.0.1:9';
const receiptUrl = new URL('../receipt.mjs', import.meta.url).href;
const { hostJournal, deliverHostEvent, recoverHostDelivery, readPending, confirmedByCodexTurn } = await import('../receipt.mjs');
const { makeSink } = await import('../live.mjs');
const { createDelivery } = await import('../../apps/api/src/core/msg/delivery.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const payload = (seq = 1, needs_owner = false) => ({ event: `message.created:synthetic:${seq}`,
  data: { thread_id: 'synthetic:thread', seq, needs_owner }, text: `Synthetic host text ${seq}` });

for (const harness of ['claude-code', 'codex']) {
  test(`${harness}: process death after host acceptance cannot inject again`, async () => {
    const session = `crash-${harness}`, marker = path.join(root, `accepted-${harness}`);
    // Exit inside delivery: no completion callback, no outcome report. The
    // pending receipt and unknown claim must already be on disk at this point.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { deliverHostEvent } from ${JSON.stringify(receiptUrl)};
      await deliverHostEvent(${JSON.stringify(harness)}, ${JSON.stringify(session)}, ${JSON.stringify(payload())}, {
        deliver() { fs.writeFileSync(${JSON.stringify(marker)}, 'accepted'); process.exit(0); }
      }, { report: async () => false });
    `], { env: process.env, timeout: 5000, windowsHide: true, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'accepted');
    const journal = hostJournal(harness, session);
    assert.deepEqual(journal.pending(), [payload().event]);
    const reports = [];
    const options = { report: async events => { reports.push(events); return true; } };
    await recoverHostDelivery(harness, session, options);
    let injections = 0;
    const result = await deliverHostEvent(harness, session, payload(), { deliver: async () => { injections++; } }, options);
    assert.equal(result.status, 'unknown');
    assert.equal(injections, 0);
    assert.deepEqual(reports[0], [payload().event]);
    assert.deepEqual(journal.pending(), []);
    assert.equal(readPending(harness, session).length, 1, 'Crash must not lose receipt evidence');
    assert.equal(confirmedByCodexTurn({ 'input-messages': [payload().text] }, readPending(harness, session)).length, 1);
  });

  test(`${harness}: concurrent/reconnected consumers share the claim; facts never count as reads`, async () => {
    const session = `fact-${harness}`, item = payload(2, true);
    let injections = 0;
    const sink = { deliver: async (_, opts) => { assert.equal(opts.retry, false); injections++; } };
    const options = { report: async () => true };
    await Promise.all([deliverHostEvent(harness, session, item, sink, options),
      deliverHostEvent(harness, session, item, sink, options)]);
    await deliverHostEvent(harness, session, item, sink, options);
    assert.equal(injections, 1);
    assert.equal(readPending(harness, session).length, 0);
  });
}

test('ambiguous rejection and failed reporting survive recovery without resend', async () => {
  const session = 'ambiguous-session', item = payload(3);
  let attempts = 0;
  const sink = { deliver: async () => { attempts++; throw new Error('Synthetic lost completion'); } };
  await assert.rejects(deliverHostEvent('codex', session, item, sink, { report: async () => false }), /lost completion/);
  assert.deepEqual(hostJournal('codex', session).pending(), [item.event]);
  await recoverHostDelivery('codex', session, { report: async () => true });
  await deliverHostEvent('codex', session, item, sink, { report: async () => true });
  assert.equal(attempts, 1);
});

test('journal scopes isolate endpoints and origins', () => {
  const one = hostJournal('codex', 'scoped-session');
  assert.equal(one.claim('event-1'), true);
  assert.equal(hostJournal('codex', 'scoped-session').claim('event-1'), false);
  assert.equal(hostJournal('claude-code', 'scoped-session').claim('event-1'), true);
  assert.equal(hostJournal('codex', 'another-session').claim('event-1'), true);
  assert.equal(hostJournal('codex', 'scoped-session', { base: 'http://127.0.0.1:10' }).claim('event-1'), true);
});

test('a legacy full journal migrates on read: delivery resumes, the file shrinks, recent claims still dedup', async () => {
  const session = 'bounded-session', journal = hostJournal('codex', session);
  journal.claim('seed');
  fs.writeFileSync(journal.file, JSON.stringify(Array.from({ length: 2000 }, (_, i) =>
    ({ event: `event-${i}`, status: 'unknown', reported: true }))));
  const before = fs.statSync(journal.file).size;
  let injected = false, reported = false;
  await deliverHostEvent('codex', session, payload(4), { deliver: async () => { injected = true; } },
    { report: async () => { reported = true; return true; } });
  assert.equal(injected, true, 'a saturated legacy journal must not stop delivery forever');
  assert.equal(reported, true);
  assert.ok(fs.statSync(journal.file).size < before / 4, 'the file is bounded now');
  assert.equal(journal.claim('event-1999'), false, 'a recent claim still dedups');
  assert.equal(journal.claim(payload(4).event), false);
});

test('corrupt, busy, or unwritable state never permits an injection', async () => {
  for (const mode of ['corrupt', 'busy', 'unwritable']) {
    const session = `blocked-${mode}`, journal = hostJournal('codex', session);
    journal.claim('seed');
    if (mode === 'corrupt') fs.writeFileSync(journal.file, '{broken');
    if (mode === 'busy') fs.writeFileSync(`${journal.file}.lock`, JSON.stringify({ pid: process.pid }));
    if (mode === 'unwritable') { fs.unlinkSync(journal.file); fs.mkdirSync(journal.file); }
    let injected = false;
    await assert.rejects(deliverHostEvent('codex', session, payload(5), { deliver: async () => { injected = true; } },
      { report: async () => false }));
    assert.equal(injected, false);
  }
});

test('a dead process journal lock can be recovered', () => {
  const journal = hostJournal('codex', 'stale-lock-session');
  journal.claim('before');
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0);
  fs.writeFileSync(`${journal.file}.lock`, JSON.stringify({ pid: child.pid }));
  assert.equal(journal.claim('after'), true);
  assert.equal(journal.claim('before'), false);
});

test('core sink never retries an ambiguous Codex queue invocation', async () => {
  const output = path.join(root, 'queue-attempts');
  const program = path.join(root, 'synthetic-queue.cjs');
  fs.writeFileSync(program, `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'attempt\\n'); process.exit(1);`);
  const sink = makeSink('codex', { threadId: 'synthetic-thread', codexCommand: { file: process.execPath, prefix: [program] } });
  try {
    await assert.rejects(sink.deliver('Synthetic message', { retry: false }), { code: 'QUEUE_FAILED' });
    assert.equal(fs.readFileSync(output, 'utf8'), 'attempt\n');
  } finally { sink.close(); }
});

test('unknown outcome is private, idempotent, scoped to a server claim, and never a read', async () => {
  const entries = [], dedup = new Map();
  const claimKey = (owner, endpoint, event) => `injection.claimed:${JSON.stringify([owner, endpoint, event])}`;
  dedup.set(claimKey('owner-a', 'codex:synthetic', 'event-1'), { status: 'unknown' });
  const store = {
    routingEndpoint: async (owner, selector) => owner === 'owner-a'
      && (selector.agentId === 'agent-a' || selector.endpoint === 'codex:synthetic') ? { endpointId: 'codex:synthetic' } : null,
    endpointOwner: async () => ({ enabled: true }),
    getDedup: async id => dedup.get(id), putDedup: async row => dedup.set(row._id, row),
    transaction: async work => work({}),
  };
  const delivery = createDelivery({ store, clock: { now: () => 1 }, core: {}, active: () => true, enabled: owner => owner.enabled,
    refuse: (code, message) => Object.assign(new Error(message), { code }), inboxAppend: async (owner, entry) => entries.push({ owner, ...entry }) });
  const args = { owner: 'owner-a', agentId: 'agent-a', events: ['event-1'] };
  await delivery.hostDeliveryUnknown(args);
  await delivery.hostDeliveryUnknown(args);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].owner, 'owner-a');
  assert.equal(entries[0].status, 'unknown');
  assert.equal(entries[0].read, false);
  for (const other of [{ owner: 'owner-b' }, { agentId: 'agent-b' }, { events: ['event-2'] }]) {
    await assert.rejects(delivery.hostDeliveryUnknown({ ...args, ...other }), { code: 'not_found' });
  }
  assert.equal(entries.length, 1);
});
