// Sequential test runner. Never runs two tests at once. Usage: node test/run.mjs [name ...]   (e.g. cli-test)
//
// Port table (all inside 23440-23459; override the start with EOL_TEST_PORT_BASE, each test uses BASE + offset):
//   live-core-test    BASE+0, +1   mock SSE server (tries +0 then +1)
//   live-test         BASE+2, +3   mock SSE server (tries +2 then +3)
//   cli-test          BASE+4, +5   EOL server (+4), fake Resend (+5)
//   codex-test        BASE+6, +7, +8   fake model (+6), launcher app-server (+7), fake EOL origin (+8)
//   codex-failure-test BASE+9, +10     fake remote URL (+9, not listened), fake EOL origin (+10)
//   codex-tui-test    BASE+11, +12     fake model + origin (+11), launcher app-server (+12)
//   origin-guard-test BASE+13          only used as a string, nothing listens
//   codex-desktop-real-test BASE+15, +16   fake model (+15), fake EOL (+16); real codex app-server over stdio
//   codex-desktop-test BASE+14         fake EOL stream (desktop mode, fake codex)
//   detect-test       BASE+18          only used as a string, nothing listens
//   mcp-surface-test  127.0.0.1:27985 (car11 S2 brief: outside every tree's BASE..BASE+19)
//   receipt-test, host-delivery-test, journal-bounded-test, beat-test, cursor.test (msg-core), login-test, device-test, call-test, rotate-test, embed-test, watch-test, setup-test: no fixed port
//                     (no network, or a loopback server on port 0)
//   (e2e-local/, not a test: its local server BASE+17, fake mail BASE+18)
//   codex-loopback.mjs / codex-fixture.mjs allow BASE .. BASE+19 only.
//
// Environment:
//   EOL_SERVER_DIR   eol_chat/web directory of the EOL repo (with node_modules)  -> cli-test
//   EOL_CODEX_BIN    absolute path to a real codex binary                        -> codex-test
//   EOL_PTY_MODULE   path to an installed node-pty (or have node-pty resolvable)  -> codex-tui-test
// Not tests (not run): codex-fixture.mjs, codex-loopback.mjs, require-origin.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.EOL_TEST_TIMEOUT_MS || 4 * 60 * 1000);
const tests = ['origin-guard-test', 'detect-test', 'codex-config-test', 'mode-test', 'mcp-surface-test', 'login-test', 'device-test', 'call-test', 'rotate-test', 'embed-test', 'watch-test', 'setup-test', 'live-core-test', 'live-test', 'receipt-test', 'host-delivery-test', 'journal-bounded-test', 'beat-test', 'cursor.test', 'hooks-install-test', 'cli-test', 'codex-test', 'codex-failure-test', 'codex-desktop-test', 'codex-desktop-real-test', 'codex-tui-test'];

function skipReason(name) {
  if (name === 'cli-test') {
    const d = process.env.EOL_SERVER_DIR;
    if (!d || !fs.existsSync(path.join(d, 'server.mjs')) || !fs.existsSync(path.join(d, 'node_modules'))) return 'set EOL_SERVER_DIR to the EOL repo eol_chat/web directory (needs server.mjs and node_modules)';
  }
  if (name === 'codex-test' || name === 'codex-desktop-real-test') {
    const b = process.env.EOL_CODEX_BIN;
    if (!b || !path.isAbsolute(b) || !fs.existsSync(b)) return 'set EOL_CODEX_BIN to the absolute path of a real codex binary';
  }
  if (name === 'codex-tui-test') {
    try { createRequire(import.meta.url).resolve(process.env.EOL_PTY_MODULE || 'node-pty'); }
    catch { return 'node-pty not found; set EOL_PTY_MODULE to an installed node-pty or install node-pty'; }
  }
  return null;
}

function run(name) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(dir, name + '.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: out + String(e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, out: timedOut ? out + `\nTIMEOUT after ${TIMEOUT_MS} ms` : out + (code ? `\nexit code ${code}` : '') }); });
  });
}

if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node 22 or newer is required.'); process.exit(1); }
// The version the program reports (USER_AGENT, serverInfo) is the package's.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8'));
  const { VERSION } = await import('../common.mjs');
  if (VERSION !== pkg.version) { console.error(`common.mjs VERSION ${VERSION} differs from package.json ${pkg.version}.`); process.exit(1); }
}
const wanted = process.argv.slice(2).map(x => x.replace(/\.mjs$/, ''));
const unknown = wanted.filter(x => !tests.includes(x));
if (unknown.length) { console.error('Unknown test: ' + unknown.join(', ') + '. Known: ' + tests.join(', ')); process.exit(1); }
const results = [];
for (const name of wanted.length ? tests.filter(t => wanted.includes(t)) : tests) {
  const reason = skipReason(name);
  if (reason) { console.log(`SKIP ${name}: ${reason}`); results.push('SKIP'); continue; }
  const r = await run(name);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!r.ok) console.log(r.out.trim().split(/\r?\n/).slice(-25).map(l => '    ' + l).join('\n'));
  results.push(r.ok ? 'PASS' : 'FAIL');
}
const n = s => results.filter(x => x === s).length;
console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped`);
process.exit(n('FAIL') ? 1 : 0);
