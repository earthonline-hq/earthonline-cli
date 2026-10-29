#!/usr/bin/env node
// `npx earthonline`: checks Node before anything else is loaded, then runs cli.mjs. Design 1026 §10: below Node 18, exit 2
// with {"code":"node_too_old","need":">=18"}. npm only warns (EBADENGINE) when `engines` does not match and runs the package
// anyway (design 1026 §10, P2), so the check is made here as well. engines >=18 is copied from @insforge/cli and add-mcp.
// The other files may use anything Node 18 has; this one keeps to syntax every Node with ES modules parses (var, no ?? or
// ?.), and loads cli.mjs only after the check, so an old Node gets this answer instead of a SyntaxError from a later file.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export var NEED = '>=18';

/** Whether this Node is too old for earthonline ('v16.20.2' -> true, 'v18.0.0' -> false). */
export function nodeTooOld(version) {
  var major = Number(String(version || '').replace(/^v/, '').split('.')[0]);
  return !(major >= 18);
}

function isEntry() {
  try {
    var a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch (e) { return false; }
}

if (isEntry()) {
  if (nodeTooOld(process.version)) {
    var message = 'earthonline needs Node 18 or later, and this is Node ' + process.version + '. Install a newer Node (https://nodejs.org), then run it again.';
    process.stderr.write((process.argv.indexOf('--json') !== -1
      ? JSON.stringify({ error: message, code: 'node_too_old', need: NEED, next: ['Install Node 18 or later from https://nodejs.org, then run the same command again.'] })
      : message) + '\n');
    process.exitCode = 2;
  } else {
    import('./cli.mjs').then(function (cli) { return cli.run(); });
  }
}
