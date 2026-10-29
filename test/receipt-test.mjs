// (msg-core G02) receipt.mjs's decisions, no network: the journal, what a transcript or a Codex turn confirms, the user's own
// Codex notify left alone, and readEvents passing an SSE id through only when the event had one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-receipt-'));
process.env.EOL_HOME = path.join(root, 'eol');
const { recordPending, readPending, confirmedByTranscript, confirmedByCodexTurn, hasUserNotify } = await import('../receipt.mjs');
const { readEvents } = await import('../live.mjs');
try {
  const session = 'receipt-session-1';
  recordPending('claude-code', session, { thread_id: 'a:b', seq: 7, text: '[EOL] seven' });
  recordPending('claude-code', session, { thread_id: 'a:b', seq: 8, text: '[EOL] eight' });
  recordPending('claude-code', session, { thread_id: 'a:b', seq: 8, text: '[EOL] eight' }); // the same message once
  recordPending('claude-code', '../escape', { thread_id: 'a:b', seq: 9, text: 'x' }); // not a session id: nothing written
  const pending = readPending('claude-code', session);
  assert.deepEqual(pending.map(p => p.seq).sort(), [7, 8]);
  assert.equal(fs.readdirSync(path.join(process.env.EOL_HOME, 'live')).length, 1);

  const transcript = path.join(root, 't.jsonl');
  const user = content => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const assistant = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  const confirmed = lines => { fs.writeFileSync(transcript, lines.join('\n') + '\n'); return confirmedByTranscript(transcript, pending).map(p => p.seq).sort(); };
  assert.deepEqual(confirmed([user('[EOL] seven')]), [], 'no reply after it: the turn did not finish with it');
  assert.deepEqual(confirmed([user('[EOL] seven'), assistant]), [7]);
  assert.deepEqual(confirmed([user([{ type: 'text', text: 'wrapped: [EOL] eight' }]), assistant, user('[EOL] seven')]), [8], 'text blocks count; a later unanswered one does not');
  assert.deepEqual(confirmed([user([{ type: 'tool_result', content: '[EOL] seven' }]), assistant]), [], 'a tool result is not what the host was told');
  assert.deepEqual(confirmedByTranscript(path.join(root, 'missing.jsonl'), pending), []);

  assert.deepEqual(confirmedByCodexTurn({ type: 'agent-turn-complete', 'input-messages': ['[EOL] eight'] }, pending).map(p => p.seq), [8]);
  assert.deepEqual(confirmedByCodexTurn({ type: 'agent-turn-complete', 'input-messages': ['prefix [EOL] eight'] }, pending), [], 'Codex input matches exactly');

  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(codexHome);
  assert.equal(hasUserNotify({ CODEX_HOME: codexHome }), false);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n[profiles.p]\nnotify = ["say"]\n');
  assert.equal(hasUserNotify({ CODEX_HOME: codexHome }), true, 'a notify anywhere is the user\'s');

  const body = new Response('id: m:a:b:7\nevent: message\ndata: {"seq":7}\n\nevent: message\ndata: {"seq":8}\n\n').body;
  const events = [];
  for await (const e of readEvents(body, () => {})) events.push(e);
  assert.deepEqual(events, [{ type: 'message', data: '{"seq":7}', id: 'm:a:b:7' }, { type: 'message', data: '{"seq":8}' }]);
  console.log('receipt-test: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
