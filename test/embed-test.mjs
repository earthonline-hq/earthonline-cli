// (car11 S3) `embed` (embed.mjs) and `agents-md --link-claude`: the one line written into a project page between markers, with a
// backup, the site allowed, and AGENTS.md's block stating what was checked. A fake EarthOnline on loopback port 0 keeps the
// owner's embeds (eol_list_embeds, eol_save_embed) and sites (eol_update_embed_sites). No Mongo. Runs on Node 18 or later.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = 'eolc_' + randomBytes(20).toString('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-embed-'));
const home = path.join(temp, 'home'), eolHome = path.join(home, '.earthonline');
let captured = '';

// ---- the fake: one owner, @robot_test1, with its embeds and sites -------------------------------------------------------
const embeds = [], calls = [];
let sites = [], origin;
const codeOf = n => `<script src="${origin}/embed.js" data-handle="robot_test1" data-embed="${n}" async></script>`;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if ((req.headers.authorization ?? '') !== `Bearer ${key}`) return send(401, { ok: false, error: { code: 'unauthorized', message: 'Sign in first.' } });
  const name = req.url.replace(/^\/api\/tools\//, '');
  const args = raw ? JSON.parse(raw) : {};
  calls.push({ name, args });
  if (name === 'eol_whoami') return send(200, { ok: true, result: { robot: { handle: 'robot_test1', name: 'Robot' } } });
  if (name === 'eol_list_embeds') return send(200, { ok: true, result: { embeds, sites } });
  if (name === 'eol_save_embed') {
    if (args.id) {
      const e = embeds.find(x => x.id === args.id);
      if (!e) return send(404, { ok: false, error: { code: 'not_found', message: 'No such embed.' } });
      Object.assign(e, args.mode ? { mode: args.mode } : {});
      return send(200, { ok: true, result: { embed: e } });
    }
    if (!args.mode) return send(400, { ok: false, error: { code: 'invalid_argument', field: 'mode', message: 'mode is required for a new embed.' } });
    const n = embeds.length + 1;
    const e = { id: `em_${String(n).padStart(18, '0')}`, n, name: `Embed ${n}`, mode: args.mode, code: codeOf(n) };
    embeds.push(e);
    return send(200, { ok: true, result: { embed: e } });
  }
  if (name === 'eol_update_embed_sites') {
    if (args.add && !sites.includes(args.add)) sites.push(args.add);
    return send(200, { ok: true, result: { anywhere: false, sites, snippet: codeOf(1) } });
  }
  send(404, { ok: false, error: { code: 'not_found', message: 'No such tool.' } });
});

const env = (extra = {}) => {
  const e = { ...process.env, HOME: home, USERPROFILE: home, EOL_HOME: eolHome, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), EOL_ORIGIN: origin, EOL_REQUIRE_ORIGIN: '1' };
  for (const k of ['EOL_KEY', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_PID', 'CLAUDECODE']) delete e[k];
  return { ...e, ...extra };
};
function cli(args, cwd, extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...args], { env: env(extra), cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; captured += d; });
    p.stderr.on('data', d => { stderr += d; captured += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr }));
    p.stdin.end();
  });
}
const json = text => { const lines = text.trim().split('\n'); assert.equal(lines.length, 1, `one JSON line: ${text}`); return JSON.parse(lines[0]); };
const project = name => { const dir = path.join(temp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const read = file => fs.readFileSync(file, 'utf8');
const backups = dir => fs.readdirSync(dir).filter(f => f.includes('.eol-backup-'));
const PAGE = '<!doctype html>\n<html>\n<head><title>Ada</title></head>\n<body>\n  <h1>Ada</h1>\n</body>\n</html>\n';

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(eolHome, { recursive: true });

  // 1. Not signed in: exit 2, nothing written, nothing asked of the server.
  const site = project('site');
  fs.writeFileSync(path.join(site, 'index.html'), PAGE);
  let r = await cli(['embed', '--json'], site);
  assert.equal(r.code, 2); assert.equal(json(r.stderr).code, 'missing_input');
  assert.equal(read(path.join(site, 'index.html')), PAGE); assert.equal(calls.length, 0);
  fs.writeFileSync(path.join(eolHome, 'key'), key + '\n');
  fs.writeFileSync(path.join(eolHome, 'config.json'), JSON.stringify({ handle: 'robot_test1' }));
  console.log('PASS 1: not signed in: exit 2, the page untouched');

  // 2. No page found, a page without </body>, a --file outside the project: exit 2 before any embed is made.
  const empty = project('empty');
  r = await cli(['embed', '--json'], empty);
  assert.equal(r.code, 2); let e = json(r.stderr);
  assert.equal(e.code, 'missing_input'); assert.deepEqual(e.needs, ['file']); assert.ok(e.next.some(n => n.includes('--file')));
  fs.writeFileSync(path.join(empty, 'part.html'), '<div>no body here</div>\n');
  r = await cli(['embed', '--file', 'part.html', '--json'], empty);
  assert.equal(r.code, 2); assert.equal(json(r.stderr).code, 'invalid_input');
  r = await cli(['embed', '--file', path.join(site, 'index.html'), '--json'], empty);
  assert.equal(r.code, 2, 'a page outside this project'); assert.equal(json(r.stderr).field, 'file');
  r = await cli(['embed', '--mode', 'sideways', '--json'], site);
  assert.equal(r.code, 2, 'an unknown type');
  assert.ok(!calls.some(c => c.name === 'eol_save_embed'), 'no embed made');
  console.log('PASS 2: no page, no </body>, a page elsewhere, an unknown type: exit 2 and no embed made');

  // 3. index.html: a new embed, the site from CNAME, the line before </body> with a backup, AGENTS.md's block after the check.
  fs.writeFileSync(path.join(site, 'CNAME'), 'ada.example\n');
  r = await cli(['embed', '--json'], site);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  let o = json(r.stdout);
  assert.equal(o.status, 'ok');
  assert.deepEqual(o.embed, { id: embeds[0].id, n: 1, mode: 'floating', made: true });
  assert.equal(o.file, 'index.html'); assert.deepEqual(o.sites_added, ['ada.example']);
  assert.deepEqual(calls.find(c => c.name === 'eol_save_embed').args, { mode: 'floating' });
  const page = read(path.join(site, 'index.html'));
  assert.equal(page, PAGE.replace('</body>', `<!-- earthonline:start -->\n${codeOf(1)}\n<!-- earthonline:end -->\n</body>`));
  assert.equal(backups(site).length, 1); assert.equal(read(path.join(site, backups(site)[0])), PAGE, 'the backup is the page as it was');
  const agents = read(path.join(site, 'AGENTS.md'));
  assert.ok(agents.startsWith('<!-- earthonline:start -->') && agents.trimEnd().endsWith('<!-- earthonline:end -->'));
  assert.ok(agents.includes('@robot_test1') && agents.includes(embeds[0].id) && agents.includes('index.html') && agents.includes('eol_save_embed'));
  assert.ok(/line in index\.html: in place/.test(agents) && /Claude Code skill: missing/.test(agents), 'the block says what was checked, as it is');
  assert.deepEqual(o.agents_md, { path: 'AGENTS.md', status: 'written' });
  console.log('PASS 3: a new embed, the site from CNAME, the line before </body> with a backup, AGENTS.md written after the check');

  // 4. Again: the same embed, nothing made, nothing rewritten, no second backup.
  const before = calls.length;
  r = await cli(['embed', '--json'], site);
  assert.equal(r.code, 0); o = json(r.stdout);
  assert.deepEqual(o.embed, { id: embeds[0].id, n: 1, mode: 'floating', made: false });
  assert.equal(o.agents_md.status, 'unchanged');
  assert.equal(read(path.join(site, 'index.html')), page); assert.equal(backups(site).length, 1); assert.equal(embeds.length, 1);
  assert.ok(!calls.slice(before).some(c => c.name === 'eol_save_embed'), 'no second embed');
  // --mode changes the type of the same embed; the line stays (the look lives on EarthOnline)
  r = await cli(['embed', '--mode', 'pet', '--json'], site);
  assert.equal(r.code, 0); assert.equal(json(r.stdout).embed.mode, 'pet'); assert.equal(embeds.length, 1);
  assert.equal(read(path.join(site, 'index.html')), page);
  console.log('PASS 4: run again: the same embed, the page byte for byte, one backup; --mode changes it in place');

  // 5. Next.js layout.tsx: a JSX block; a CLAUDE.md is never edited: a warning (exit 5) until agents-md --link-claude.
  const next = project('next');
  fs.mkdirSync(path.join(next, 'src', 'app'), { recursive: true });
  const layout = 'export default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n';
  fs.writeFileSync(path.join(next, 'src', 'app', 'layout.tsx'), layout);
  fs.writeFileSync(path.join(next, 'CLAUDE.md'), '# Notes\n');
  r = await cli(['embed', '--site', 'https://ada.example.org', '--json'], next);
  assert.equal(r.code, 5, r.stdout); o = json(r.stdout);
  assert.equal(o.status, 'partial'); assert.equal(o.file, path.join('src', 'app', 'layout.tsx'));
  assert.deepEqual(o.sites_added, ['https://ada.example.org']);
  assert.deepEqual(o.embed, { id: embeds[1].id, n: 2, mode: 'floating', made: true }, 'another project: its own numbered embed');
  const w = o.warnings.find(x => x.step === 'agents_md');
  assert.ok(w && w.fix.includes('agents-md --link-claude'));
  assert.equal(read(path.join(next, 'CLAUDE.md')), '# Notes\n', 'CLAUDE.md untouched');
  assert.equal(read(path.join(next, 'src', 'app', 'layout.tsx')), layout.replace('      </body>', `        {/* earthonline:start */}\n        ${codeOf(2)}\n        {/* earthonline:end */}\n      </body>`));
  r = await cli(['agents-md', '--link-claude', '--json'], next);
  assert.equal(r.code, 0, r.stderr); assert.equal(read(path.join(next, 'CLAUDE.md')), '# Notes\n\n@AGENTS.md\n');
  r = await cli(['agents-md', '--link-claude', '--json'], next);
  assert.equal(r.code, 0); assert.equal(read(path.join(next, 'CLAUDE.md')), '# Notes\n\n@AGENTS.md\n', 'once');
  r = await cli(['embed', '--json'], next);
  assert.equal(r.code, 0, r.stdout); assert.deepEqual(json(r.stdout).warnings, []);
  console.log('PASS 5: layout.tsx gets a JSX block; CLAUDE.md is never edited by embed: a warning until agents-md --link-claude, which adds @AGENTS.md once');

  assert.ok(!/eolc_/.test(captured), 'no key in any output');
  console.log('PASS 6: no eolc_ in any output');
  console.log('embed-test: PASS');
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
