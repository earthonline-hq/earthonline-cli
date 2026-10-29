// Which agent programs (harnesses) are on this machine. File checks only: nothing is run and nothing is changed.
// As in add-mcp (neondatabase/add-mcp, src/agents.ts detectGlobalInstall), a harness is present when its global config
// folder exists. For the two we connect we also accept the executable, since a fresh install may not have written
// its folder yet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexCommand } from './codex.mjs';

export const SUPPORTED = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });

/** Claude Code's config folder: settings.json lives here, and .claude.json too when CLAUDE_CONFIG_DIR is set. */
export function claudeDir(env = process.env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
export function claudeConfigFile(env = process.env) { return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'); }
export function codexHome(env = process.env) { return env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

export function onPath(name, env = process.env) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + suffix);
      try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

// Harnesses we see but do not connect yet, with the global paths add-mcp checks for them (src/agents.ts at
// ad92a0127ec94f5663dec00fba35736b606968d3, getPlatformPaths and each detectGlobalInstall).
export function others(env = process.env) {
  const home = os.homedir(), join = path.join;
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const appSupport = process.platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : xdg;
  const vscode = join(appSupport, 'Code', 'User');
  const goose = process.platform === 'win32' ? join(appSupport, 'Block', 'goose', 'config', 'config.yaml') : join(process.platform === 'darwin' ? join(home, '.config') : xdg, 'goose', 'config.yaml');
  return [
    ['antigravity', 'Antigravity', join(home, '.gemini', 'config')],
    ['cline', 'Cline VSCode Extension', join(vscode, 'globalStorage', 'saoudrizwan.claude-dev', 'settings')],
    ['cline-cli', 'Cline CLI', join(env.CLINE_DIR || join(home, '.cline'), 'data', 'settings')],
    ['claude-desktop', 'Claude Desktop', join(appSupport, 'Claude')],
    ['cursor', 'Cursor', join(home, '.cursor')],
    ['fx', 'fx', join(home, '.fx')],
    ['gemini-cli', 'Gemini CLI', join(home, '.gemini')],
    ['goose', 'Goose', goose],
    ['github-copilot-cli', 'GitHub Copilot CLI', env.COPILOT_HOME || join(home, '.copilot')],
    ['grok-build', 'Grok Build', env.GROK_HOME || join(home, '.grok')],
    ['kilo-code', 'Kilo Code', join(xdg, 'kilo'), join(vscode, 'globalStorage', 'kilocode.kilo-code')],
    ['kimi-code', 'Kimi Code', env.KIMI_CODE_HOME || join(home, '.kimi-code')],
    ['kiro-cli', 'Kiro CLI', join(home, '.kiro')],
    ['mastracode', 'Mastra Code', join(home, '.mastracode')],
    ['mcporter', 'MCPorter', join(home, '.mcporter')],
    ['opencode', 'OpenCode', join(home, '.config', 'opencode')],
    ['pi', 'Pi', env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')],
    ['vscode', 'VS Code', vscode],
    ['windsurf', 'Windsurf', join(home, '.codeium', 'windsurf')],
    ['zed', 'Zed', join(appSupport, ['darwin', 'win32'].includes(process.platform) ? 'Zed' : 'zed')],
  ].map(([id, name, ...paths]) => ({ id, name, paths }));
}

const exists = file => { try { fs.statSync(file); return true; } catch { return false; } };

/** [{ id, name, supported }] for every harness found, the supported ones first. */
export function detect(env = process.env) {
  const found = [];
  if (exists(claudeDir(env)) || exists(claudeConfigFile(env)) || (env.EOL_CLAUDE_BIN && exists(env.EOL_CLAUDE_BIN)) || onPath('claude', env)) found.push({ id: 'claude-code', name: SUPPORTED['claude-code'], supported: true });
  let codexBin = false;
  try { codexCommand(env); codexBin = true; } catch { /* Not installed, or only its folder is. */ }
  if (exists(codexHome(env)) || codexBin) found.push({ id: 'codex', name: SUPPORTED.codex, supported: true });
  for (const other of others(env)) if (other.paths.some(exists)) found.push({ id: other.id, name: other.name, supported: false });
  return found;
}
