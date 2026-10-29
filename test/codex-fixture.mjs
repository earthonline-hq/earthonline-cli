import './codex-loopback.mjs';
import fs from 'node:fs';
import path from 'node:path';
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
// Copy the runtime exactly, with a test-only network preload on its MCP entry.
// This guard survives Codex's MCP environment scrubbing and does not change product behavior.
export function fixtureRuntime(root, eolHome, origin) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || +url.port < PORT_BASE || +url.port > PORT_BASE + 19) throw new Error('Fixture origin must be an assigned loopback port');
  fs.writeFileSync(path.join(eolHome, 'config.json'), JSON.stringify({ origin }));
  const app = path.join(root, 'runtime'); fs.mkdirSync(app);
  // the launcher and the MCP entry with every module they import (static or import()), followed from their source, so a new
  // import in the runtime is never missing here (common.mjs is not imported to read APP_FILES: it would fix EOL_HOME before the test sets it)
  const files = ['codex.mjs', 'mcp.mjs'];
  for (let i = 0; i < files.length; i++) {
    const text = fs.readFileSync(new URL('../' + files[i], import.meta.url), 'utf8');
    for (const [, dep] of text.matchAll(/(?:^import\s[^;]*?from\s+|\bimport\()'\.\/([\w.-]+\.mjs)'/gm)) if (!files.includes(dep)) files.push(dep);
  }
  for (const file of files) {
    let source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    if (file === 'mcp.mjs') source = source.replace(/^#![^\n]*\n/, '') + '\n';
    // Codex hands the MCP child only the env_vars it names, so the guard's port block is set first, from a file.
    if (file === 'mcp.mjs') source = "import './port-base.mjs';\nimport " + JSON.stringify(new URL('./codex-loopback.mjs', import.meta.url).href) + ';\n' + source;
    fs.writeFileSync(path.join(app, file), source);
  }
  fs.writeFileSync(path.join(app, 'port-base.mjs'), `process.env.EOL_TEST_PORT_BASE = ${JSON.stringify(String(PORT_BASE))};\n`);
  return app;
}

// The function_call a fake model sends for `tool`, shaped from the tools Codex itself advertised in this request
// (Codex groups MCP tools in a namespace entry and joins namespace + name when it routes the call). Throws with the
// advertised names when the tool is missing, so a renamed server shows up as a clear failure, not a timeout.
export function modelToolCall(tools, tool, args) {
  const call = { type: 'function_call', id: 'fc_eol', call_id: 'call_eol', arguments: JSON.stringify(args) };
  const seen = [];
  for (const t of tools ?? []) {
    if (Array.isArray(t.tools)) for (const inner of t.tools) { seen.push(`${t.name}/${inner.name}`); if (inner.name === tool) return { ...call, namespace: t.name, name: inner.name }; }
    else { seen.push(t.name); if (typeof t.name === 'string' && t.name.endsWith('__' + tool)) return { ...call, name: t.name }; }
  }
  throw new Error(`Codex did not advertise ${tool}; tools: ${seen.join(', ')}`);
}
