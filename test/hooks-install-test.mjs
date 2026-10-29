// Installer hooks: new install, upgrade from a matcher-less entry, uninstall. Temp HOME / CLAUDE_CONFIG_DIR; a tiny local whoami server; no claude binary.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as codexConfig from '../codex-config.mjs';

// Exercise the real installer functions against an in-memory filesystem and Claude command.
// This mode needs neither a server nor child processes and never reads a real harness config.
async function memory() {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(here, 'cli.mjs'), 'utf8').replace(/^import .*;\r?\n/gm, '').split('main().catch(err => {')[0].replaceAll('import.meta.url', 'sourceUrl');
  const home = path.join(here, 'memory-only');
  const paths = { home, app: path.join(home, 'app'), config: path.join(home, 'config.json'), key: path.join(home, 'key'), live: path.join(home, 'live') };
  const cfgFile = path.join(home, 'claude', '.claude.json');
  const settingsFile = path.join(home, 'claude', 'settings.json');
  const codexFile = path.join(home, 'codex', 'config.toml');
  const exe = path.join(home, 'fake-claude.mjs');
  let files, calls, signedIn, output, failRestore;
  const json = file => JSON.parse(files.get(file));
  const put = (file, value) => files.set(file, JSON.stringify(value));
  const fakeFs = {
    existsSync: file => files.has(file),
    readFileSync: file => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    writeFileSync: (file, value) => files.set(file, value),
    copyFileSync: (from, to) => files.set(to, files.get(from)),
    mkdirSync() {}, chmodSync() {}, readdirSync: () => [],
    rmSync: file => { for (const key of files.keys()) if (key === file || key.startsWith(file + path.sep)) files.delete(key); },
    constants: { COPYFILE_EXCL: 1 },
  };
  const fakeExec = async (file, argv) => {
    const args = argv.slice(1); calls.push(args);
    const config = json(cfgFile); config.mcpServers ??= {};
    const servers = config.mcpServers;
    if (args[1] === 'remove') {
      const old = servers[args[2]];
      if (args[2] === 'earthonline' && ['http', 'sse'].includes(old?.type)) assert.deepEqual(json(paths.config).replaced.earthonline, old, 'backup exists before old HTTP entry is removed');
      delete servers[args[2]];
    } else if (args[1] === 'add') {
      const at = args.indexOf('--');
      assert.ok(!Object.hasOwn(servers, args[at - 1]), 'same-name entry removed before add');
      servers[args[at - 1]] = { command: args[at + 1], args: args.slice(at + 2) };
    } else if (args[1] === 'add-json') {
      assert.ok(!Object.hasOwn(servers, args[2]), 'restore never overwrites an active entry');
      if (failRestore) throw new Error('simulated restore failure');
      servers[args[2]] = JSON.parse(args[3]);
    }
    else assert.fail('unexpected Claude command');
    put(cfgFile, config); return { stdout: '' };
  };
  const context = vm.createContext({ fs: fakeFs, path, fileURLToPath, sourceUrl: new URL('../cli.mjs', import.meta.url).href,
    promisify: fn => fn, execFile: fakeExec, PATHS: paths, URL,
    process: { platform: process.platform, execPath: process.execPath, env: { EOL_CLAUDE_BIN: exe, CLAUDE_CONFIG_DIR: path.dirname(cfgFile), CODEX_HOME: path.dirname(codexFile) }, stdin: { isTTY: false }, stdout: { write: text => { output += text; } } },
    claudeDir: () => path.dirname(cfgFile), claudeConfigPath: () => cfgFile,
    ...codexConfig, codexBlock: codexConfig.block, codexConfigFile: () => codexFile,
    codexHome: () => path.dirname(codexFile), codexCommand: () => ({ file: 'fake-codex' }),
    writeFileAtomic: (file, value) => files.set(file, value), readJson: file => files.has(file) ? json(file) : null,
    log() {}, pidAlive: () => false, detect: () => [{ id: 'claude-code', name: 'Claude Code', supported: true }], SUPPORTED: { 'claude-code': 'Claude Code' },
    checkOrigin: value => value, origin: () => 'http://127.0.0.1', OFF: '#eol-connect-off# ',
  });
  vm.runInContext(source, context);
  context.fakeSignIn = async () => { signedIn++; return 'tester'; };
  vm.runInContext('signIn = fakeSignIn', context);
  const install = vm.runInContext('installClaude', context), uninstall = vm.runInContext('uninstall', context), fullInstall = vm.runInContext('install', context);
  const installCodex = vm.runInContext('installCodex', context);
  const reset = servers => {
    files = new Map([[exe, ''], [path.join(paths.app, 'live.mjs'), ''], [path.join(paths.app, 'format.mjs'), '']]);
    calls = []; signedIn = 0; output = ''; failRestore = false; put(cfgFile, { mcpServers: servers });
  };
  const own = { command: 'node', args: [path.join(paths.app, 'mcp.mjs')] };
  const old = { type: 'http', url: 'https://mcp.earthonlines.com/mcp' };
  reset({ earthonline: old });
  await install({}, {}, {});
  assert.deepEqual(json(paths.config).replaced.earthonline, old);
  assert.ok(json(cfgFile).mcpServers.earthonline.args.includes(path.join(paths.app, 'mcp.mjs').replaceAll('\\', '/')));
  await install(json(settingsFile), json(paths.config), {});
  assert.deepEqual(json(paths.config).replaced.earthonline, old, 'reinstall keeps the original backup');
  await uninstall();
  assert.deepEqual(json(cfgFile).mcpServers, { earthonline: old }, 'uninstall restores the minimal HTTP connector exactly');
  for (const foreign of [{ type: 'http', url: 'https://example.com/mcp' }, { ...old, headers: { Authorization: 'literal-secret' } }, { ...old, url: 'https://earthonlines.com.example.com/mcp' }]) {
    reset({ earthonline: foreign }); const before = files.get(cfgFile);
    await assert.rejects(fullInstall({ agents: ['claude-code'] }), /A different MCP server named earthonline/);
    assert.equal(files.get(cfgFile), before); assert.equal(calls.length, 0); assert.equal(signedIn, 0);
    assert.ok(!files.has(settingsFile) && !files.has(paths.config), 'conflict stops before sign-in, hooks and config writes');
    await uninstall(); assert.equal(files.get(cfgFile), before);
  }
  reset({ eol: own }); await install({}, {}, {});
  assert.deepEqual(Object.keys(json(cfgFile).mcpServers), ['earthonline'], 'own old eol upgraded');
  const foreignOld = { command: 'node', args: [path.join(home, 'other.mjs')] };
  reset({ eol: foreignOld }); await install({}, {}, {}); await uninstall();
  assert.deepEqual(json(cfgFile).mcpServers, { eol: foreignOld }, 'foreign eol preserved');
  reset({ earthonline: old }); await install({}, {}, { keepEarthonline: true });
  assert.deepEqual(json(cfgFile).mcpServers.earthonline, old);
  assert.ok(json(cfgFile).mcpServers['earthonline-local']);
  const matcher = json(settingsFile).hooks.PostToolUse[0].matcher;
  const re = new RegExp('^(?:' + matcher + ')$');
  for (const name of ['eol', 'earthonline', 'earthonline-local']) assert.ok(re.test('mcp__' + name + '__eol_message'));
  for (const tool of ['Read', 'Bash', 'mcp__other__x', 'mcp__earthonline-local-other__x']) assert.ok(!re.test(tool));
  await uninstall(); assert.deepEqual(json(cfgFile).mcpServers, { earthonline: old });
  reset({ earthonline: old }); await install({}, {}, { keepEarthonline: true });
  await install(json(settingsFile), json(paths.config), {});
  assert.deepEqual(Object.keys(json(cfgFile).mcpServers), ['earthonline'], 'switching back removes our local alias');
  await uninstall(); assert.deepEqual(json(cfgFile).mcpServers, { earthonline: old });
  reset({ earthonline: old, 'earthonline-local': foreignOld });
  await assert.rejects(fullInstall({ agents: ['claude-code'], keepEarthonline: true }), /named earthonline-local/);
  assert.equal(calls.length, 0);
  // Normal install -> keep: migrate only our local registration, then safely restore the HTTP backup.
  for (const original of [{}, { earthonline: old }]) {
    reset(original); await install({}, {}, {});
    await install(json(settingsFile), json(paths.config), { keepEarthonline: true });
    let servers = json(cfgFile).mcpServers;
    assert.deepEqual(Object.keys(servers).sort(), [...Object.keys(original), 'earthonline-local'].sort());
    if (original.earthonline) assert.deepEqual(servers.earthonline, old);
    assert.ok(!json(paths.config).replaced?.earthonline, 'successful keep restore consumes the backup');
    await install(json(settingsFile), json(paths.config), { keepEarthonline: true });
    assert.deepEqual(json(cfgFile).mcpServers, servers, 'keep reinstall is idempotent');
    await uninstall(); assert.deepEqual(json(cfgFile).mcpServers, original);
  }
  reset({ earthonline: old }); await install({}, {}, {});
  failRestore = true;
  await install(json(settingsFile), json(paths.config), { keepEarthonline: true });
  assert.deepEqual(Object.keys(json(cfgFile).mcpServers), ['earthonline-local']);
  assert.deepEqual(json(paths.config).replaced.earthonline, old, 'failed restore keeps backup');
  assert.match(output, /private backup remains/);
  failRestore = false;
  await install(json(settingsFile), json(paths.config), { keepEarthonline: true });
  assert.deepEqual(json(cfgFile).mcpServers.earthonline, old, 'keep retries a pending backup');
  for (const mode of ['keep', 'uninstall']) {
    reset({ earthonline: old }); await install({}, {}, {});
    put(cfgFile, { mcpServers: { earthonline: foreignOld } }); output = '';
    if (mode === 'keep') await install(json(settingsFile), json(paths.config), { keepEarthonline: true });
    else await uninstall();
    assert.deepEqual(json(cfgFile).mcpServers.earthonline, foreignOld, 'user-added entry kept');
    assert.deepEqual(json(paths.config).replaced.earthonline, old, 'conflicting backup kept');
    assert.match(output, /private backup remains/);
  }
  // Run the actual Codex installer/uninstaller with the same memory-only filesystem.
  const remote = '["mcp_servers"."earthonline"]\r\nurl = "https://earthonlines.com/mcp"\r\n[tui]\r\nx = 1\r\n';
  for (const key of [name => `"mcp_servers".${name}`, name => `'mcp_servers'.'${name}'`, name => String.raw`"mcp\u005fservers"."\U00000065${name.slice(1)}"`]) {
    for (const name of ['earthonline', 'earthonline-local']) {
      reset({}); const input = `[${key(name)}]\r\ncommand = "foreign"\r\n`;
      files.set(codexFile, input); const before = [...files];
      await installCodex({}, { keepEarthonline: name === 'earthonline-local' });
      assert.deepEqual([...files], before, 'semantic conflict leaves all files byte-identical');
      assert.match(output, /A different MCP server named/);
    }
  }
  for (const initial of ['', remote]) {
    reset({}); files.set(codexFile, initial); await installCodex({}, {});
    await installCodex(json(paths.config), { keepEarthonline: true });
    const kept = files.get(codexFile);
    assert.ok(kept.startsWith(initial) && kept.includes('[mcp_servers.earthonline-local]'));
    assert.ok(!kept.includes(codexConfig.OFF), 'keep restores the HTTP connector');
    assert.equal(kept.split('[mcp_servers.earthonline]').length, 1, 'no duplicate local MCP');
    await installCodex(json(paths.config), { keepEarthonline: true });
    assert.equal(files.get(codexFile), kept, 'Codex keep reinstall is idempotent');
    await uninstall(); assert.equal(files.get(codexFile), initial, 'Codex uninstall restores original bytes');
  }
  for (const mode of ['keep', 'uninstall']) for (const active of [
    '["mcp_servers"."earthonline"]\r\ncommand = "foreign"\r\n',
    String.raw`["mcp\u005fservers"."\u0065arthonline".env]` + '\r\nA = "1"\r\n',
    '["mcp_servers"]\r\n"earthonline" = { command = "foreign" }\r\n',
  ]) {
    reset({}); files.set(codexFile, remote); await installCodex({}, {});
    const installed = files.get(codexFile), separator = json(paths.config).codexBlock.separator;
    files.set(codexFile, installed + active); output = '';
    if (mode === 'keep') await installCodex(json(paths.config), { keepEarthonline: true });
    else await uninstall();
    const after = files.get(codexFile);
    const outside = codexConfig.withoutBlock(after, mode === 'keep' ? json(paths.config).codexBlock.separator : undefined);
    assert.equal(outside, codexConfig.withoutBlock(installed, separator) + active, 'backup and active entry preserved byte for byte');
    assert.match(output, /active earthonline entry exists; its commented backup was kept/);
    assert.ok(!output.includes("turned your earlier 'earthonline' connection back on"));
    // Removing the conflict allows a later uninstall to restore the still-commented backup.
    files.set(codexFile, after.replace(active, ''));
    await uninstall(); assert.equal(files.get(codexFile), remote);
  }
  console.log('PASS hooks-install --memory: Claude/Codex semantic conflicts, safe backup restore/retry, normal-to-keep migration, matcher');
}
if (process.argv.includes('--memory')) await memory();
else {
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-hooks-'));
const cfg = path.join(temp, 'claude-cfg');
fs.mkdirSync(cfg, { recursive: true });
const KEY = 'eolc_' + 'a'.repeat(40);
// A legacy account: its tool list has no Delivery setting (live.mjs deliverySettings), so the installer installs the hooks itself.
const server = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: req.url === '/api/tools' ? { tools: [] } : { robot: { handle: '@tester' } } })); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, HOME: temp, USERPROFILE: temp, CLAUDE_CONFIG_DIR: cfg, EOL_HOME: path.join(temp, '.earthonline'), CODEX_HOME: path.join(temp, '.codex'), EOL_ORIGIN: origin, EOL_CLAUDE_BIN: path.join(temp, 'no-such-claude') };
for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDECODE']) delete env[k];
function cli(args, input = '', expected = 0) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env, cwd: here, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('error', reject); p.on('exit', code => code === expected ? resolve(out) : reject(new Error('cli exit ' + code + ': ' + out)));
    p.stdin.end(input);
  });
}
const settingsFile = path.join(cfg, 'settings.json');
const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
// claude itself is missing here (EOL_CLAUDE_BIN names no file): its MCP registration is a setup warning, exit 5 (car11 A2)
const install = () => cli(['--agent', 'claude-code', '--key-stdin', '--origin', origin], KEY + '\n', 5);
const own = h => /\/app\/live\.mjs" hook/.test(h.command.split(String.fromCharCode(92)).join('/'));
const ours = groups => (groups ?? []).filter(g => g.hooks?.some(own));
const MATCHER = 'mcp__(eol|earthonline|earthonline-local)__.*';
try {
  // new install
  await install();
  let s = read();
  assert.equal(ours(s.hooks.PostToolUse).length, 1);
  assert.equal(ours(s.hooks.PostToolUse)[0].matcher, MATCHER);
  assert.equal(ours(s.hooks.SessionStart).length, 1);
  assert.equal(ours(s.hooks.SessionEnd).length, 1);
  const re = new RegExp('^(?:' + MATCHER + ')$');
  assert.ok(re.test('mcp__eol__eol_message') && re.test('mcp__earthonline__eol_message') && re.test('mcp__earthonline-local__eol_message'));
  assert.ok(!re.test('Read') && !re.test('Bash') && !re.test('mcp__other__x') && !re.test('mcp__earthonline-local-other__x'));
  // upgrade from an old, matcher-less entry, other hooks kept
  const live = ours(s.hooks.PostToolUse)[0].hooks[0].command;
  const mine = { hooks: [{ type: 'command', command: 'echo mine', timeout: 3 }] };
  const old = { hooks: [{ type: 'command', command: live, timeout: 10 }] };
  s.hooks.PostToolUse = [mine, old];
  s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo stop' }] }];
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  await install();
  s = read();
  assert.equal(s.hooks.PostToolUse.length, 2, 'the user hook plus exactly one of ours');
  assert.deepEqual(s.hooks.PostToolUse[0], mine);
  assert.equal(ours(s.hooks.PostToolUse).length, 1);
  assert.equal(ours(s.hooks.PostToolUse)[0].matcher, MATCHER);
  assert.equal(ours(s.hooks.SessionStart).length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo stop');
  // uninstall
  await cli(['uninstall']);
  s = read();
  assert.equal(ours(s.hooks?.PostToolUse).length + ours(s.hooks?.SessionStart).length + ours(s.hooks?.SessionEnd).length, 0);
  assert.deepEqual(s.hooks.PostToolUse, [mine]);
  console.log('hooks-install-test: ok');
} finally { server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
