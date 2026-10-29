// Which agent programs the installer finds, and what it says about the rest. Temporary folders only; no network, no
// server, no real harness: every folder the detection reads (home, APPDATA, LOCALAPPDATA, XDG) points into a temp dir.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-detect-'));
const dirs = name => { const d = path.join(temp, name); fs.mkdirSync(d, { recursive: true }); return d; };
function sandbox(name) {
  const home = dirs(name);
  const env = { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, EOL_REQUIRE_ORIGIN: '1', EOL_ORIGIN: 'http://127.0.0.1:23458',
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), EOL_HOME: path.join(home, '.earthonline') };
  return { home, env };
}
const run = (env, args) => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...args], { env, encoding: 'utf8', input: '', timeout: 30000, windowsHide: true });
const detect = env => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { detect } from ${JSON.stringify(pathToFileURL(path.join(root, 'detect.mjs')).href)}; console.log(JSON.stringify(detect()));`],
  { env, encoding: 'utf8', windowsHide: true }).stdout);
const listing = dir => fs.readdirSync(dir, { recursive: true }).sort();
let checks = 0;
const check = (...a) => { assert.ok(...a); checks++; };

try {
  // 1. Nothing installed: nothing found, the installer stops before sign-in and writes nothing.
  const empty = sandbox('empty');
  check(detect(empty.env).length === 0, 'an empty home has no harness');
  const none = run(empty.env, []);
  check(none.status === 1 && /No supported agent found \(Claude Code, Codex\)/.test(none.stderr), 'no harness: a clear stop');
  check(!/Email/.test(none.stdout), 'no harness: no sign-in asked');
  check(JSON.stringify(listing(empty.home)) === JSON.stringify(['.earthonline', path.join('.earthonline', 'live.log')]), 'no harness: nothing written but the failure line in live.log');

  // 2. Each harness by its folder, Codex also by CODEX_HOME, Claude Code by CLAUDE_CONFIG_DIR; the rest as add-mcp sees them.
  const mixed = sandbox('mixed');
  fs.mkdirSync(path.join(mixed.home, '.claude'));
  fs.mkdirSync(path.join(mixed.home, '.cursor'));
  fs.mkdirSync(path.join(mixed.env.APPDATA, 'Claude'), { recursive: true });
  fs.mkdirSync(path.join(mixed.home, '.gemini'));
  const seen = detect(mixed.env);
  check(JSON.stringify(seen.filter(h => h.supported).map(h => h.id)) === '["claude-code"]', 'Claude Code by ~/.claude');
  check(['cursor', 'gemini-cli'].every(id => seen.some(h => h.id === id && !h.supported)), 'Cursor and Gemini CLI seen, not supported');
  if (process.platform === 'win32') check(seen.some(h => h.id === 'claude-desktop'), 'Claude Desktop by %APPDATA%\\Claude');
  const codexHome = dirs('custom-codex');
  check(detect({ ...mixed.env, CODEX_HOME: codexHome }).some(h => h.id === 'codex'), 'Codex by CODEX_HOME');
  const ccOnlyByEnv = sandbox('cc-env');
  const ccDir = dirs('custom-claude');
  check(detect({ ...ccOnlyByEnv.env, CLAUDE_CONFIG_DIR: ccDir }).some(h => h.id === 'claude-code'), 'Claude Code by CLAUDE_CONFIG_DIR');

  // 3. The installer names the unsupported ones, and refuses them by name.
  const said = run(mixed.env, ['--agent', 'cursor']);
  check(said.status === 2 && /Cursor: not supported yet\. Valid agents: claude-code, codex/.test(said.stderr), 'a known unsupported agent is "not supported yet" (input: exit 2)');
  const bad = run(mixed.env, ['--agent', 'nope']);
  check(bad.status === 2 && /Invalid agents: nope\s+Valid agents: claude-code, codex/.test(bad.stderr), 'an unknown agent name, worded as add-mcp');
  const stat = run(mixed.env, ['status']);
  check(/Found: Claude Code, .*Cursor \(not supported yet\)/.test(stat.stdout), 'status lists what it found');

  // 4. The Codex desktop app's own CLI (outside PATH) is found, newest build first.
  if (process.platform === 'win32') {
    const desk = sandbox('desktop');
    const bin = path.join(desk.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    for (const [build, age] of [['old', 2000], ['new', 0]]) {
      fs.mkdirSync(path.join(bin, build), { recursive: true });
      const exe = path.join(bin, build, 'codex.exe');
      fs.writeFileSync(exe, '');
      const t = new Date(Date.now() - age * 1000); fs.utimesSync(exe, t, t);
    }
    const found = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { codexCommand } from ${JSON.stringify(pathToFileURL(path.join(root, 'codex.mjs')).href)}; console.log(codexCommand().file);`],
      { env: desk.env, encoding: 'utf8', windowsHide: true }).stdout.trim();
    check(found === path.join(bin, 'new', 'codex.exe'), 'the desktop app\'s newest codex.exe');
    check(detect(desk.env).some(h => h.id === 'codex'), 'Codex by the desktop app alone');
  }
  console.log(`PASS detect: harness detection, unsupported wording and the desktop Codex CLI (${checks} checks)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
