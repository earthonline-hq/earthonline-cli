// EarthOnline's own section in Codex's config.toml, so that plain `codex` and the Codex desktop app (they share this
// file) load the earthonline MCP server. Only our marked block is ever added or removed: the rest of the file stays byte for
// byte (`codex mcp add` rewrites the whole mcp_servers table and drops comments in other servers' sections, so it is
// not used). The markers follow the shell-profile installers' convention (conda, nvm).
import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from './detect.mjs';

// The marker id stays "eol-connect" so blocks written before the package became `earthonline` are still found.
export const BEGIN_ID = '# >>> eol-connect (EarthOnline) >>>';
export const BEGIN = `${BEGIN_ID} added by \`npx earthonline\`, removed by \`npx earthonline uninstall\``;
export const END = '# <<< eol-connect (EarthOnline) <<<';
export const codexConfigFile = (env = process.env) => path.join(codexHome(env), 'config.toml');

const quote = s => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
/** The block: our server, started with this Node, told where EarthOnline's and Codex's homes are. */
export function block({ node, mcp, eolHome, codexHomeDir, name = 'earthonline' }) {
  return [BEGIN,
    `[mcp_servers.${name}]`,
    `command = ${quote(node)}`,
    `args = [${[mcp, '--harness', 'codex'].map(quote).join(', ')}]`,
    `[mcp_servers.${name}.env]`,
    `EOL_HOME = ${quote(eolHome)}`,
    `CODEX_HOME = ${quote(codexHomeDir)}`,
    END, ''].join('\n');
}

function span(text) {
  const start = /^# >>> eol-connect \(EarthOnline\) >>>/m.exec(text)?.index ?? -1; // BEGIN_ID at a line start
  if (start < 0) return null;
  const endAt = text.indexOf(END, start);
  if (endAt < 0) return null;
  let end = endAt + END.length;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return { start, end };
}
export const hasOurBlock = text => span(text) !== null;

// Read TOML bare, literal and basic-string keys by value, not by their spelling.
// In particular, TOML's eight-digit Unicode escape is not a JSON escape.
function keyPath(text) {
  const keys = [];
  let rest = text.trimStart();
  while (true) {
    const token = /^(?:[A-Za-z0-9_-]+|'[^'\r\n]*'|"(?:[^"\\\r\n]|\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*")/.exec(rest)?.[0];
    if (!token) return null;
    let key = token;
    if (token[0] === "'") key = token.slice(1, -1);
    if (token[0] === '"') {
      let valid = true;
      key = token.slice(1, -1).replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[btnfr"\\])/g, (_, escape) => {
        if (escape[0] === 'u' || escape[0] === 'U') {
          const code = parseInt(escape.slice(1), 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { valid = false; return ''; }
          return String.fromCodePoint(code);
        }
        return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[escape];
      });
      if (!valid) return null;
    }
    keys.push(key);
    rest = rest.slice(token.length).trimStart();
    if (!rest.startsWith('.')) return { keys, rest };
    rest = rest.slice(1).trimStart();
  }
}
function tableHeader(line) {
  const text = line.trimStart(), array = text.startsWith('[[');
  if (!text.startsWith('[')) return null;
  const parsed = keyPath(text.slice(array ? 2 : 1));
  if (!parsed || !(array ? /^\]\]\s*(?:#.*)?$/ : /^\]\s*(?:#.*)?$/).test(parsed.rest)) return null;
  return { keys: parsed.keys, array };
}
const isServer = (keys, name) => keys?.[0] === 'mcp_servers' && keys[1] === name;

/** Whether the file defines an `earthonline` MCP server other than ours: then we leave the file alone. */
export function foreignEol(text, serverName = 'earthonline') {
  const s = span(text);
  const rest = s ? text.slice(0, s.start) + text.slice(s.end) : text;
  let scope = [];
  for (const line of rest.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      scope = tableHeader(line)?.keys ?? [];
      if (isServer(scope, serverName)) return true;
    } else {
      const entry = keyPath(line);
      if (entry?.rest.startsWith('=') && isServer([...scope, ...entry.keys], serverName)) return true;
    }
  }
  return false;
}

/** The new text with our block (replacing an older one of ours), and the separator put before it. */
export function withBlock(text, ours) {
  const s = span(text);
  if (s) return { text: text.slice(0, s.start) + ours + text.slice(s.end), separator: null };
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: text + separator + ours, separator };
}

/**
 * (10-20, Bonan) one EarthOnline MCP: an earlier URL connection named earthonline in this file is turned off while ours is
 * in, only when its URL belongs to earthonlines.com or a subdomain, so its tools are not listed twice. Its lines are commented out with our own prefix, where they are: uninstall takes
 * the prefix away again and the file is byte for byte as before. Only the table form is handled ([mcp_servers.earthonline]
 * and its sub-tables, including quoted/escaped keys); other forms are left as they are.
 */
export const OFF = '#eol-connect-off# ';
export function withoutEarthonline(text) {
  const lines = text.split('\n'), tables = [];
  let inOurs = false, current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(BEGIN_ID)) { if (current) current.end = i; current = null; inOurs = true; }
    if (inOurs) { if (line.startsWith(END)) inOurs = false; continue; }
    // Multiline strings need a full TOML parser; leave such a file alone rather than guess at table boundaries.
    if (!/^\s*#/.test(line) && (line.includes('"""') || line.includes("\x27\x27\x27"))) return null;
    const header = tableHeader(line);
    if (!/^\s*\[/.test(line)) continue;
    if (current) current.end = i;
    current = null;
    if (!header || header.array) continue; // Unrecognized/array tables still end the preceding table.
    if (isServer(header.keys, 'earthonline')) { current = { start: i, end: lines.length, root: header.keys.length === 2 }; tables.push(current); }
  }
  const roots = tables.filter(t => t.root);
  if (roots.length !== 1) return null;
  const root = roots[0];
  const urls = lines.slice(root.start + 1, root.end).filter(line => /^\s*(?:url|"url"|'url')\s*=/.test(line));
  if (urls.length !== 1) return null;
  const value = /^\s*(?:url|"url"|'url')\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?\r?$/.exec(urls[0])?.[1];
  if (!value) return null;
  try {
    const url = new URL(value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1));
    if (!['http:', 'https:'].includes(url.protocol) || !(url.hostname === 'earthonlines.com' || url.hostname.endsWith('.earthonlines.com'))) return null;
  } catch { return null; }
  for (const { start, end } of tables) for (let i = start; i < end; i++) lines[i] = OFF + lines[i];
  return lines.join('\n');
}
export const withEarthonlineBack = text => text.split('\n').map(line => line.startsWith(OFF) ? line.slice(OFF.length) : line).join('\n');

/** The text without our block; the separator we added before it goes too. */
export function withoutBlock(text, separator) {
  const s = span(text);
  if (!s) return text;
  let start = s.start;
  const sep = typeof separator === 'string' ? separator : '\n';
  if (sep && text.slice(0, start).endsWith(sep) && (sep !== '\n' || text.slice(0, start).endsWith('\n\n') || start === sep.length)) start -= sep.length;
  return text.slice(0, start) + text.slice(s.end);
}
