// Test-only preload, including the Node MCP child. Refuse before DNS/network I/O.
import './require-origin.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const PORT_BASE = Number(process.env.EOL_TEST_PORT_BASE || 23440);
const refuse = () => new Error('Codex fixture refuses non-loopback or unassigned endpoints');
const allowed = (host, port) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && Number(port) >= PORT_BASE && Number(port) <= PORT_BASE + 19;
// Local IPC the tests create: a Windows named pipe, or a Unix socket inside the temp directory (the fake CC inbox).
const fixtureIpc = p => typeof p === 'string' && (p.startsWith('\\\\.\\pipe\\')
  || (process.platform !== 'win32' && path.isAbsolute(p) && !path.relative(os.tmpdir(), p).startsWith('..')));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  if (fixtureIpc(values[0])) return connect.apply(this, args);
  const opts = typeof values[0] === 'object' ? values[0] : { port: values[0], host: typeof values[1] === 'string' ? values[1] : 'localhost' };
  if (opts?.path) {
    if (!fixtureIpc(String(opts.path))) throw refuse();
  } else if (!opts || !allowed(opts.host ?? opts.hostname ?? 'localhost', opts.port)) throw refuse();
  return connect.apply(this, args);
};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!allowed(url.hostname, url.port)) return Promise.reject(refuse());
  return fetchOriginal(input, init);
};
