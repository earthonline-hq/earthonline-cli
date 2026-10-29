#!/usr/bin/env node
// Owned foreground app-server, remote TUI and lifetime supervisor. No user config edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PATHS, readKey, writeFileAtomic, readJson, log } from './common.mjs';
import { hasUserNotify } from './receipt.mjs';
import { endpointDelivery, retireSession } from './live.mjs';

const self = fileURLToPath(import.meta.url);
/** The CLI the Codex desktop app ships outside PATH (Windows: %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe), newest build first. */
export function desktopCodex(env = process.env) {
  if (process.platform !== 'win32') return null;
  // An MCP server started by Codex may not be given LOCALAPPDATA: then the usual place under the home folder.
  const root = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  let best = null;
  try {
    for (const dir of fs.readdirSync(root)) {
      try { const file = path.join(root, dir, 'codex.exe'), { mtimeMs } = fs.statSync(file); if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs }; } catch {}
    }
  } catch {}
  return best?.file ?? null;
}
export function codexCommand(env = process.env) {
  let file = env.EOL_CODEX_BIN;
  if (!file) for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const p = path.join(dir.replace(/^"|"$/g, ''), 'codex' + suffix);
      try { if (fs.statSync(p).isFile()) { file = p; break; } } catch {}
    }
    if (file) break;
  }
  file ||= desktopCodex(env);
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) throw new Error('Codex executable not found. Set EOL_CODEX_BIN to its absolute path.');
  if (/\.(mjs|cjs|js)$/i.test(file)) return { file: process.execPath, prefix: [file] };
  if (/\.(cmd|bat)$/i.test(file)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/%dp0%[\\/]([^"\r\n]+?\.(?:mjs|cjs|js))/gi)) {
      const entry = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(entry)) return { file: process.execPath, prefix: [entry] };
    }
    throw new Error('Unsupported Codex shim. Set EOL_CODEX_BIN to codex.exe or bin/codex.js.');
  }
  return { file, prefix: [] };
}

async function supervise() {
  const notify = value => { if (process.connected) process.send(value, () => {}); };
  let server, stopping = false, tokenDir, tuiPid, retirement = null;
  const retireOwned = () => retirement ??= (async () => {
    if (!tokenDir) return;
    for (const file of fs.readdirSync(tokenDir).filter(name => /^thread-[0-9a-f-]{36}\.json$/i.test(name))) {
      try {
        const identity = JSON.parse(fs.readFileSync(path.join(tokenDir, file), 'utf8'));
        // Delivery off has no retirement hook. Settings errors leave the end
        // offline and resumable rather than guessing at an explicit retirement.
        const policy = await endpointDelivery('codex', identity);
        if (policy.core && policy.delivery === 'fast') await retireSession('codex', identity);
      } catch { log('retire_failed'); }
    }
  })();
  const wrapperRecord = path.join(PATHS.live, 'wrapper-codex-' + process.ppid + '.pid');
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (tuiPid) { try { process.kill(tuiPid); } catch {} }
    if (server && server.exitCode === null && server.signalCode === null) {
      const done = new Promise(r => server.once('exit', r));
      server.kill();
      const force = setTimeout(() => server.kill('SIGKILL'), 3000);
      await done; clearTimeout(force);
    }
    if (server && (server.exitCode !== null || server.signalCode !== null)) await retireOwned();
    if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true });
    try { if (JSON.parse(fs.readFileSync(wrapperRecord, 'utf8')).supervisor === process.pid) fs.rmSync(wrapperRecord, { force: true }); } catch {}
    process.exit(0);
  };
  process.on('message', m => { if (Number.isInteger(m.tuiPid) && m.tuiPid > 0) tuiPid = m.tuiPid; });
  process.once('disconnect', stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.once('message', async ({ port, command, cwd }) => {
    try {
      tokenDir = fs.mkdtempSync(path.join(PATHS.live, 'codex-auth-'));
      fs.chmodSync(tokenDir, 0o700);
      const tokenFile = path.join(tokenDir, 'token');
      fs.writeFileSync(tokenFile, process.env.EOL_CODEX_TOKEN, { mode: 0o600 });
      const mcp = path.join(path.dirname(self), 'mcp.mjs');
      const inherited = ['EOL_HOME', 'EOL_ORIGIN', 'EOL_CODEX_BIN', 'EOL_CODEX_TOKEN', 'CODEX_HOME', 'EOL_CODEX_REMOTE', 'EOL_REQUIRE_ORIGIN'];
      // Remote port is known after bind: MCP reads a private endpoint file populated before the TUI starts.
      const endpointFile = path.join(tokenDir, 'endpoint');
      const name = readJson(PATHS.config)?.codexMcpName === 'earthonline-local' ? 'earthonline-local' : 'earthonline';
      const override = `mcp_servers.${name}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(mcp)},"--harness","codex"],env_vars=${JSON.stringify(inherited)},env={EOL_CODEX_ENDPOINT_FILE=${JSON.stringify(endpointFile)}}}`;
      // (msg-core G02) a finished turn's receipt: Codex's notify program on agent-turn-complete (live.mjs codex-notify). Codex
      // runs one notify command, so it is set only when the user has none of their own (theirs is never replaced; such a
      // session sends no turn receipts, and its reads still count through eol_read / eol_inbox)
      const notifyArgs = hasUserNotify() ? [] : ['-c', `notify=${JSON.stringify([process.execPath, path.join(path.dirname(self), 'live.mjs'), 'codex-notify'])}`];
      server = spawn(command.file, [...command.prefix, 'app-server', '--listen', `ws://127.0.0.1:${port}`, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile, '-c', override, ...notifyArgs], {
        cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let banner = '', ready = false;
      const timeout = setTimeout(() => { notify({ error: 'Codex app-server startup timed out.' }); void stop(); }, 15000);
      server.stdout.resume(); // Do not forward potentially sensitive server diagnostics.
      server.stderr.on('data', b => {
        if (ready) return;
        banner = (banner + b).slice(-8192);
        const match = banner.match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
        if (!match) return;
        ready = true; clearTimeout(timeout);
        fs.writeFileSync(endpointFile, match[1], { mode: 0o600 });
        notify({ remote: match[1], serverPid: server.pid });
      });
      server.once('error', error => { log('codex_server_spawn_failed', { code: error.code }); clearTimeout(timeout); notify({ error: 'Could not start Codex app-server.' }); void stop(); });
      server.once('exit', (code, signal) => { log('codex_server_exit', { code, signal }); clearTimeout(timeout); if (!stopping) { notify({ error: 'Codex app-server exited.' }); void stop(); } });
    } catch (error) { log('codex_supervisor_failed', { code: error.code }); notify({ error: 'Could not prepare the private Codex launcher.' }); void stop(); }
  });
}

export async function launchCodex(args = [], options = {}) {
  if (!readKey()) throw new Error('Run npx earthonline once to sign in before starting Codex.');
  const argv = [...args];
  let port = 0;
  if (argv[0] === '--port') { port = Number(argv[1]); argv.splice(0, 2); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.'); }
  if (argv.some(a => /^--remote(?:=|$)/.test(a)) || ['app-server', 'exec', 'queue'].includes(argv[0])) throw new Error('Use this launcher for an interactive Codex session or resume <UUID>.');
  const command = codexCommand();
  fs.mkdirSync(PATHS.live, { recursive: true, mode: 0o700 });
  const env = { ...process.env, EOL_HOME: PATHS.home, EOL_CODEX_BIN: process.env.EOL_CODEX_BIN || (command.prefix[0] ?? command.file), EOL_CODEX_TOKEN: randomBytes(32).toString('hex') };
  delete env.EOL_CODEX_REMOTE; // Never inherit another wrapper's endpoint.
  delete env.EOL_CODEX_ENDPOINT_FILE;
  // Windows needs a separate hidden console so terminal death cannot kill the cleanup owner.
  const child = fork(self, ['--supervise'], { env, cwd: process.cwd(), detached: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  const record = path.join(PATHS.live, `wrapper-codex-${process.pid}.pid`);
  writeFileAtomic(record, JSON.stringify({ pid: process.pid, supervisor: child.pid, kind: 'codex-wrapper' }));
  let tui, stopped = false;
  const childDone = new Promise(r => { child.once('exit', r); child.once('error', r); });
  const stop = () => { if (stopped) return; stopped = true; if (tui && tui.exitCode === null && tui.signalCode === null) tui.kill(); if (child.connected) child.disconnect(); };
  const onSignal = () => stop();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const remote = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error('Codex supervisor exited before ready.')));
      child.once('message', m => { if(m.error) reject(new Error(m.error)); else { writeFileAtomic(record, JSON.stringify({pid:process.pid,supervisor:child.pid,serverPid:m.serverPid,kind:'codex-wrapper'})); resolve(m.remote); } });
      child.send({ port, command, cwd: process.cwd() });
    });
    child.on('message', m => { if (m.error) { process.stderr.write('[EarthOnline] App-server disconnected; closing this session.\n'); stop(); } });
    child.once('exit', stop);
    if (stopped) return 1;
    log('codex_session_started');
    const tuiArgs = [...command.prefix, '--remote', remote, '--remote-auth-token-env', 'EOL_CODEX_TOKEN', ...argv];
    tui = (options.spawnTui ?? spawn)(command.file, tuiArgs, { env, stdio: 'inherit', windowsHide: true });
    if (tui.pid) {
      child.send({ tuiPid: tui.pid });
      const saved = JSON.parse(fs.readFileSync(record, 'utf8'));
      writeFileAtomic(record, JSON.stringify({ ...saved, tuiPid: tui.pid }));
    }
    return await new Promise((resolve, reject) => { tui.once('error', reject); tui.once('exit', code => resolve(code ?? 1)); });
  } finally {
    stop(); await childDone;
    fs.rmSync(record, { force: true });
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    log('codex_session_stopped');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--supervise' && process.send) void supervise();
  else launchCodex(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { log('codex_launch_failed', { code: error.code ?? 'START_FAILED' }); process.stderr.write('[EarthOnline] Codex could not start. Check installation, EOL_CODEX_BIN and Codex version.\n'); process.exitCode = 1; });
}
