// Proves a missing or non-loopback origin FAILS under the test guard instead of defaulting to production. No network at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const common = fileURLToPath(new URL('../common.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ origin: 'https://lobby.earthonlines.com' })); // even a config pointing at production
const probe = env => spawnSync(process.execPath, ['--input-type=module', '-e', `import { origin } from ${JSON.stringify(pathToFileURL(common).href)}; try { console.log('OK ' + origin()); } catch (e) { console.log('ERR ' + e.message); }`],
  { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EOL_HOME: home, ...env }, encoding: 'utf8' }).stdout.trim();
assert.match(probe({ EOL_REQUIRE_ORIGIN: '1' }), /^ERR .*EOL_ORIGIN is unset/, 'unset origin must fail, not default to production');
assert.match(probe({ EOL_REQUIRE_ORIGIN: '1', EOL_ORIGIN: 'https://lobby.earthonlines.com' }), /^ERR .*must be loopback/, 'production origin must fail');
assert.match(probe({ EOL_REQUIRE_ORIGIN: '1', EOL_ORIGIN: 'http://example.com' }), /^ERR/, 'non-loopback must fail');
assert.equal(probe({ EOL_REQUIRE_ORIGIN: '1', EOL_ORIGIN: `http://127.0.0.1:${PORT_BASE + 13}` }), `OK http://127.0.0.1:${PORT_BASE + 13}`);
// the harness flag itself is set by the shared helper
await import('./require-origin.mjs');
assert.equal(process.env.EOL_REQUIRE_ORIGIN, '1');
console.log('PASS origin-guard: missing/production/non-loopback origin fails under the test guard (4 checks)');
