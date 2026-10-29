// Bounded durable delivery journal (common.mjs journal helper), used by receipt.mjs and cursor-hook.mjs.
// Synthetic data only: no server, browser, model or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-journal-bounded-'));
process.env.EOL_HOME = root;
process.env.EOL_REQUIRE_ORIGIN = '1';
process.env.EOL_ORIGIN = 'http://127.0.0.1:9';
const commonUrl = new URL('../common.mjs', import.meta.url).href;
const { hostJournal, deliverHostEvent } = await import('../receipt.mjs');
const { journalLoad, journalSave, journalNote, journalSeen, journalRetire } = await import('../common.mjs');
const { loadCursorState, remember } = await import('../cursor-hook.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const THREAD = 'synthetic:thread';
const event = seq => `message.created:m${seq}`;

test('receipt journal: 5,000 events through one conversation stay small and never replay', async () => {
  let injected = 0, biggest = 0;
  const journal = hostJournal('codex', 'five-thousand'), sink = { deliver: async () => { injected++; } };
  for (let seq = 1; seq <= 5000; seq++) {
    const data = { thread_id: THREAD, seq, needs_owner: true };
    await deliverHostEvent('codex', 'five-thousand', { event: event(seq), data, text: `t${seq}` }, sink, { report: async () => true });
    if (seq % 100 === 0) biggest = Math.max(biggest, fs.statSync(journal.file).size);
  }
  assert.equal(injected, 5000, 'delivery never stops');
  assert.ok(biggest < 40 * 1024, `journal stays small (${biggest} bytes)`);
  assert.equal(journal.claim(event(1), { thread_id: THREAD, seq: 1 }), false, 'an evicted old event is still deduped by the watermark');
  assert.equal(journal.claim(event(5000), { thread_id: THREAD, seq: 5000 }), false);
  assert.deepEqual(journal.pending(), []);
  // Unreported claims (the server never answers) are bounded too, and a full journal still claims.
  for (let seq = 5001; seq <= 9000; seq++) journal.claim(event(seq), { thread_id: THREAD, seq });
  assert.ok(fs.statSync(journal.file).size < 1024 * 1024);
  assert.equal(journal.claim('fresh-id', { thread_id: 'other', seq: 1 }), true);
});

test('cursor journal: 5,000 events through one conversation stay small, in order, never replay', () => {
  const file = path.join(root, 'cursor-state.json');
  let state = loadCursorState(file), biggest = 0;
  for (let seq = 1; seq <= 5000; seq++) {
    const payload = { event: event(seq), thread_id: THREAD, seq, text: 't' + seq, from: 'a', provenance: { owner: 'o' } };
    remember(state, payload);
    assert.ok(state.items[event(seq)], 'accepted once');
    remember(state, payload); // a replay is a no-op
    delete state.items[event(seq)]; // read: terminal
    if (seq % 50 === 0) { journalSave(file, state); state = loadCursorState(file); biggest = Math.max(biggest, fs.statSync(file).size); }
  }
  assert.ok(biggest < 40 * 1024, `journal stays small (${biggest} bytes)`);
  assert.equal(journalSeen(state, event(7), THREAD, 7), true);
  assert.equal(journalSeen(state, event(5001), THREAD, 5001), false);
});

test('an old cursor journal loads: read stubs retire, live items stay, other fields survive', () => {
  const file = path.join(root, 'cursor-old.json');
  const items = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [event(i), { event: event(i), thread_id: THREAD, seq: i + 1, text: 'x', gated: false, status: i % 2 ? 'read' : 'queued' }]));
  items.stub = { event: 'stub', status: 'read' };
  fs.writeFileSync(file, JSON.stringify({ items, active: true, lastGeneration: 'g' }));
  const state = loadCursorState(file);
  assert.equal(state.active, true);
  assert.equal(state.lastGeneration, 'g');
  assert.equal(Object.keys(state.items).length, 1000);
  assert.equal(journalSeen(state, 'stub'), true);
});

test('odd files load and never throw', () => {
  const file = path.join(root, 'odd.json');
  for (const text of ['', '[]', 'null', '{"items":5}', '{broken', '{"v":2,"marks":{"a":"x"},"recent":[1,null,"ok"]}']) {
    fs.writeFileSync(file, text);
    const state = loadCursorState(file);
    assert.deepEqual(Object.keys(state.items), []);
    assert.ok(Array.isArray(state.recent));
  }
});

test('a crash between write and rename leaves the previous journal loadable', () => {
  const file = path.join(root, 'crash.json');
  const journal = journalLoad(file);
  journalNote(journal, 'a', THREAD, 1);
  journalSave(file, journal);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { journalLoad, journalNote, journalSave } from ${JSON.stringify(commonUrl)};
    const file = ${JSON.stringify(file)}, j = journalLoad(file);
    journalNote(j, 'b', ${JSON.stringify(THREAD)}, 2);
    fs.renameSync = () => process.exit(0); // die after the temp file is written, before the rename
    journalSave(file, j);
  `], { env: process.env, timeout: 5000, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.readdirSync(root).some(name => name.startsWith('crash.json.') && name.endsWith('.tmp')), 'the crash left its temp file');
  const loaded = journalLoad(file, { strict: true });
  assert.equal(loaded.marks[THREAD], 1);
  assert.equal(journalSeen(loaded, 'b', THREAD, 2), false, 'the unfinished write never happened');
  assert.equal(journalSeen(loaded, 'a', THREAD, 1), true);
});
