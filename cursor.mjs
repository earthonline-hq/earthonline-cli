import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load, saveSettings, saveConfig, signIn } from './cli.mjs';
import { PATHS, APP_FILES, origin, checkOrigin } from './common.mjs';
import { ownerSettings } from './live.mjs';

export const CURSOR_EVENTS = ['sessionStart', 'stop', 'sessionEnd'];
export const LOOP_LIMIT = 5;
export const HOOK_LIMIT_MS = 2500;
const here = path.dirname(fileURLToPath(import.meta.url));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const cursorDirectory = project => path.join(project ? path.resolve(project) : os.homedir(), '.cursor');

// Exclusive creation: concurrent hooks never replace an existing host identity.
export function cursorHostId(home = os.homedir()) {
  const file = path.join(home, '.eol', 'host-id');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, randomUUID() + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const id = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid EOL host identity.');
  return id;
}

export function cursorEndpoint(conversationId, home) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(conversationId ?? '')) throw new Error('Invalid Cursor conversation identity.');
  return `cursor:${cursorHostId(home)}:${conversationId}`;
}

function quote(value) {
  const text = String(value).replaceAll('\\', '/');
  if (/["\r\n$`%!]/.test(text)) throw new Error('The Cursor hook path cannot be quoted safely.');
  return `"${text}"`;
}

export function cursorEntries(directory) {
  const prefix = `${quote(process.execPath)} ${quote(path.join(PATHS.app, 'cursor-hook.mjs'))} --config ${quote(path.join(directory, 'hooks.json'))}`;
  return Object.fromEntries(CURSOR_EVENTS.map(event => [event, {
    command: `${prefix} --event ${event}`,
    timeout: 3,
    ...(event === 'stop' ? { loop_limit: LOOP_LIMIT } : {}),
  }]));
}

function hooksAt(file) {
  const value = load(file);
  if (value.version !== undefined && value.version !== 1) throw new Error('Unsupported Cursor hooks version.');
  if (value.hooks !== undefined && !object(value.hooks)) throw new Error('Cursor hooks must be an object.');
  for (const event of CURSOR_EVENTS) if (value.hooks?.[event] !== undefined && !Array.isArray(value.hooks[event])) throw new Error('Cursor hook entries must be arrays.');
  return value;
}

// Ownership is an exact installed command, not a substring of somebody else's hook.
const owns = (entry, event, state) => typeof entry?.command === 'string' && entry.command === state?.entries?.[event]?.command;
export function cursorHooksPresent(directory, state) {
  const hooks = hooksAt(path.join(directory, 'hooks.json')).hooks;
  return CURSOR_EVENTS.every(event => hooks?.[event]?.some(entry => owns(entry, event, state)));
}

function removeEntries(value, state) {
  for (const event of CURSOR_EVENTS) {
    if (!Array.isArray(value.hooks?.[event])) continue;
    value.hooks[event] = value.hooks[event].filter(entry => !owns(entry, event, state));
    if (!value.hooks[event].length && !state.events?.includes(event)) delete value.hooks[event];
  }
  if (value.hooks && !Object.keys(value.hooks).length && !state.hadHooks) delete value.hooks;
  if (!state.hadVersion) delete value.version;
}

export function reconcileCursorHooks(directory, config, delivery = 'off') {
  const file = path.join(directory, 'hooks.json');
  const value = hooksAt(file);
  config.cursor ??= {};
  let state = config.cursor[directory];
  if (!state && delivery === 'off') return null;
  state ??= config.cursor[directory] = {
    hadHooks: Object.hasOwn(value, 'hooks'), hadVersion: Object.hasOwn(value, 'version'),
    events: Object.keys(value.hooks ?? {}), entries: cursorEntries(directory), endpoints: [],
  };
  if (state.installed && !cursorHooksPresent(directory, state)) state.removed = true;
  state.delivery = state.removed ? 'off' : delivery;
  removeEntries(value, state);
  if (state.delivery === 'fast') {
    state.entries = cursorEntries(directory);
    value.version = 1; value.hooks ??= {};
    for (const event of CURSOR_EVENTS) (value.hooks[event] ??= []).push(state.entries[event]);
  }
  state.installed = state.delivery === 'fast';
  saveConfig(config); // Remember opt-out before changing the user's hooks.
  if (fs.existsSync(file) || state.installed) saveSettings(value, file);
  return state;
}

function mcpAt(directory) {
  const file = path.join(directory, 'mcp.json'), value = load(file);
  if (value.mcpServers !== undefined && !object(value.mcpServers)) throw new Error('Cursor mcpServers must be an object.');
  return { file, value };
}

export function installCursor({ project, delivery = 'off', base = origin() } = {}) {
  if (!['off', 'fast'].includes(delivery)) throw new Error('Delivery must be off or fast.');
  const directory = cursorDirectory(project), config = load(PATHS.config);
  const { file, value } = mcpAt(directory);
  const server = { url: `${checkOrigin(base)}/mcp` };
  const existing = value.mcpServers?.eol;
  if (existing && JSON.stringify(existing) !== JSON.stringify(server)) throw new Error('Another Cursor MCP server owns eol; it was kept.');
  hooksAt(path.join(directory, 'hooks.json')); // Validate before touching either config.
  if (delivery === 'fast') {
    cursorEntries(directory); // Validate all command paths before copying anything.
    fs.mkdirSync(PATHS.app, { recursive: true, mode: 0o700 });
    // the whole app: cursor-hook.mjs loads cursor.mjs and through it cli.mjs, which loads detect.mjs and codex-config.mjs
    for (const name of APP_FILES) {
      const source = path.join(here, name), destination = path.join(PATHS.app, name);
      if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
    }
  }
  const state = reconcileCursorHooks(directory, config, delivery);
  value.mcpServers ??= {}; value.mcpServers.eol = server;
  saveSettings(value, file);
  return { directory, delivery: state?.delivery ?? 'off', removed: state?.removed === true };
}

export function uninstallCursor({ project, base = origin() } = {}) {
  const directory = cursorDirectory(project), config = load(PATHS.config);
  reconcileCursorHooks(directory, config, 'off');
  const { file, value } = mcpAt(directory);
  if (JSON.stringify(value.mcpServers?.eol) === JSON.stringify({ url: `${checkOrigin(base)}/mcp` })) {
    delete value.mcpServers.eol;
    saveSettings(value, file);
  }
  // Keep host-id, opt-out history, runtime and shared sign-in for other harnesses.
}

export async function cursorCommand(args) {
  const options = {}; let action = 'install', login = false, keyStdin = false;
  if (['install', 'uninstall', 'status'].includes(args[0])) action = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--project' && args.length) options.project = args.shift();
    else if (arg === '--delivery' && args.length && action === 'install') options.delivery = args.shift();
    else if (arg === '--origin' && args.length) options.base = checkOrigin(args.shift());
    else if (arg === '--sign-in' && action === 'install') login = true;
    else if (arg === '--key-stdin' && action === 'install') { login = true; keyStdin = true; }
    else throw new Error('Usage: earthonline cursor [install|uninstall|status] [--project DIR] [--delivery off|fast] [--origin URL] [--sign-in|--key-stdin]');
  }
  if (login) {
    await signIn(options.base ?? origin(), keyStdin);
    if (options.base) { const config = load(PATHS.config); config.origin = options.base; saveConfig(config); }
  }
  if (action === 'uninstall') {
    const state = load(PATHS.config).cursor?.[cursorDirectory(options.project)];
    uninstallCursor(options);
    for (const endpoint of state?.endpoints ?? []) await ownerSettings({ endpoint, delivery: 'off' });
    console.log('Cursor: EOL entries removed; other settings and backups kept.'); return;
  }
  if (action === 'install') {
    const result = installCursor(options);
    const state = load(PATHS.config).cursor?.[result.directory];
    if (result.delivery === 'off' && state?.endpoints?.length) {
      for (const endpoint of state.endpoints) await ownerSettings({ endpoint, delivery: 'off' });
    }
    console.log(`Cursor: ${result.delivery}${result.removed ? ' (owner removed a hook; not reinstalled)' : ''}; ${result.directory}`);
    if (result.delivery === 'fast') console.log('Delivery requires a server-registered turn-end capability and an owner-selected fast endpoint. See INSTALL.md for current integration gaps.');
  }
  const directory = cursorDirectory(options.project), state = load(PATHS.config).cursor?.[directory];
  const value = hooksAt(path.join(directory, 'hooks.json'));
  for (const event of CURSOR_EVENTS) for (const entry of value.hooks?.[event] ?? []) {
    if (owns(entry, event, state)) console.log(`EOL ${event}: ${entry.command}`);
  }
}
