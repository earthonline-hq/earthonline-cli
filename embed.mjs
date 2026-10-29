// `embed` and `agents-md --link-claude` (research/cli-onboarding-design-1026.md §9, §10, A4): the owner's EarthOnline chat put on
// this project's pages by the one line EarthOnline gives, written into the page between markers, with a backup; the project's
// site allowed; and AGENTS.md told what is there, written after the line and the skills are checked, saying what was found.
//
// Copied from Clerk's `init`, which writes into the project (https://clerk.com/docs/cli, viewed 2026-10-26), and from InsForge's
// writeLocalAgentsMd markers (@insforge/cli 0.2.8, read 2026-10-26), with the check before the claim added (design §9). The
// line and the sites come from the same tools an agent has (eol_save_embed, eol_update_embed_sites, eol_list_embeds: design §6,
// primitives first); only the writing into files is local. Each project gets its own numbered embed, as the web's Embed tab
// makes one per website; a re-run finds it again from the page's block (or AGENTS.md's) and changes nothing.
//
// Claude Code reads AGENTS.md only when there is no CLAUDE.md, and a CLAUDE.md is the person's own: `embed` never edits it. It
// warns instead, and `agents-md --link-claude` adds the one line `@AGENTS.md` when the person agrees (design §9).
import fs from 'node:fs';
import path from 'node:path';
import { origin, readKey } from './common.mjs';
import { EXIT, CliError, callTool } from './contract.mjs';
import { checkSkills } from './skills.mjs';

const MODES = ['floating', 'pet', 'button', 'inline', 'icon', 'photo'];
const SIGN_IN = "npx earthonline login --email <your owner's email>";
// Where a site's pages end, in the order a project usually has them: a static site, then Next.js (App Router, then Pages Router)
const PAGES = ['index.html', 'public/index.html', 'src/index.html',
  'app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js',
  'pages/_document.tsx', 'pages/_document.jsx', 'pages/_document.js', 'src/pages/_document.tsx', 'src/pages/_document.jsx', 'src/pages/_document.js'];
const START = 'earthonline:start', END = 'earthonline:end';
const BLOCK_RE = /^([ \t]*)(?:<!--|\{\/\*) earthonline:start (?:-->|\*\/\})[^\n]*\n[\s\S]*?(?:<!--|\{\/\*) earthonline:end (?:-->|\*\/\})[^\n]*\n?/m;
const BODY_RE = /<\/body\s*>/i;

const jsx = file => /\.(jsx|tsx|js)$/.test(file);
const marker = (file, word) => (jsx(file) ? `{/* ${word} */}` : `<!-- ${word} -->`);
const posix = rel => rel.split(path.sep).join('/');
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** A project file changed in place, the earlier one kept beside it first (as the installer does with every config it edits). */
function rewrite(file, before, after) {
  if (before !== null) fs.copyFileSync(file, `${file}.eol-backup-${stamp()}`);
  fs.writeFileSync(file, after);
  if (readText(file) !== after) throw new CliError('UNKNOWN_ERROR', `${file} did not read back as written.`, { next: ['Check that the file is writable, then run the same command again.'] });
}

function needKey() {
  const key = readKey();
  if (!key) throw new CliError('missing_input', 'This puts your EarthOnline chat on your pages, so sign in first.', { exit: EXIT.input, next: [SIGN_IN] });
  return key;
}

/** The page to write into: --file (inside this project), else the one that already has our block, else the first that exists. */
function pickPage(root, asked) {
  if (asked) {
    const file = path.resolve(root, asked), rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new CliError('invalid_input', `${asked} is not inside this project (${root}). Run embed from the project's folder.`, { exit: EXIT.input, field: 'file' });
    if (readText(file) === null) throw new CliError('invalid_input', `There is no file ${asked}.`, { exit: EXIT.input, field: 'file' });
    return rel;
  }
  const found = PAGES.filter(rel => fs.existsSync(path.join(root, rel)));
  const withBlock = found.find(rel => BLOCK_RE.test(readText(path.join(root, rel))));
  if (withBlock || found[0]) return path.normalize(withBlock ?? found[0]);
  throw new CliError('missing_input', `No page found here to put the chat on (looked for ${PAGES.slice(0, 4).join(', ')} and the Next.js layouts). Name the page that has </body>:`, { exit: EXIT.input, needs: ['file'], next: ['npx earthonline embed --file <the page with </body>>'] });
}

/** The page's text with our block (code inside markers) in place: replacing ours, else just before </body>. null: no </body>. */
function withBlock(text, file, code) {
  const own = BLOCK_RE.exec(text);
  const lines = indent => `${indent}${marker(file, START)}\n${indent}${code}\n${indent}${marker(file, END)}\n`;
  if (own) return text.slice(0, own.index) + lines(own[1]) + text.slice(own.index + own[0].length);
  const body = BODY_RE.exec(text);
  if (!body) return null;
  const lineStart = text.lastIndexOf('\n', body.index - 1) + 1;
  const before = text.slice(lineStart, body.index);
  if (/^[ \t]*$/.test(before)) return text.slice(0, lineStart) + lines(before + (jsx(file) ? '  ' : '')) + text.slice(lineStart);
  return text.slice(0, body.index) + '\n' + lines('') + text.slice(body.index);
}

/** The embed number and handle in a block's line, or null. */
function blockEmbed(text) {
  const own = text && BLOCK_RE.exec(text);
  const n = own && /data-embed="(\d+)"/.exec(own[0]);
  const handle = own && /data-handle="([^"]+)"/.exec(own[0]);
  return n ? { n: Number(n[1]), handle: handle?.[1] ?? null } : null;
}
const handleOf = code => /data-handle="([^"]+)"/.exec(code ?? '')?.[1] ?? null;

/** The project's own website, when it says so: --site, else a GitHub Pages CNAME, else package.json `homepage` (not a local one). */
function projectSite(root, asked) {
  if (asked) return asked;
  const cname = readText(path.join(root, 'CNAME'))?.split(/\r?\n/)[0].trim();
  if (cname && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cname)) return cname;
  try {
    const home = new URL(JSON.parse(readText(path.join(root, 'package.json')) ?? '{}').homepage);
    if (['http:', 'https:'].includes(home.protocol) && !/^(localhost|127\.0\.0\.1)$|\.localhost$/.test(home.hostname)) return home.origin;
  } catch { /* none, or not a URL */ }
  return null;
}

/** AGENTS.md's block: what is here and how to change it, with what was checked as it was found. */
function agentsBlock({ handle, embed, page, checked }) {
  const id = JSON.stringify(embed.id);
  return [
    `<!-- ${START} -->`,
    '## EarthOnline chat on this site',
    '',
    `This project shows @${handle}'s EarthOnline chat: embed #${embed.n} (id ${embed.id}, type ${embed.mode}), one line in ${posix(page)} between the earthonline markers.`,
    `- Its type and look live on EarthOnline, not in this repo: change them with the eol_save_embed tool ({"id":${id}, ...}) or \`echo {"id":${id},"mode":"pet"} | npx earthonline call eol_save_embed --input -\`. Nothing here needs to change.`,
    '- Which websites may show it: eol_update_embed_sites (pages on localhost always may).',
    `- Checked by \`npx earthonline embed\`: line in ${posix(page)}: ${checked.line}; ${checked.skills.map(s => `${s.label} skill: ${s.status}`).join('; ')}.`,
    `<!-- ${END} -->`,
    '',
  ].join('\n');
}
const AGENTS_BLOCK_RE = new RegExp(`<!-- ${START} -->[\\s\\S]*?<!-- ${END} -->\\n?`);

/** embed [--file <path>] [--site <site>] [--mode <type>] [--id <embed id>] -> exit code */
export async function embedCommand(args, out) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[i + 1];
    if (['--file', '--site', '--mode', '--id'].includes(flag) && value !== undefined && !value.startsWith('--')) { opts[flag.slice(2)] = value; i++; continue; }
    throw new CliError('usage', 'Usage: earthonline embed [--file <page>] [--site <your site>] [--mode floating|pet|button|inline|icon|photo] [--id <embed id>]', { exit: EXIT.input });
  }
  if (opts.mode && !MODES.includes(opts.mode)) throw new CliError('invalid_input', `--mode is one of ${MODES.join(', ')}.`, { exit: EXIT.input, field: 'mode' });
  const key = needKey();
  const root = process.cwd(), base = origin();
  const page = pickPage(root, opts.file), file = path.join(root, page);
  const text = readText(file);
  if (!BLOCK_RE.test(text) && !BODY_RE.test(text)) throw new CliError('invalid_input', `${page} has no </body>, so there is nowhere to put the line.`, { exit: EXIT.input, field: 'file', next: ['npx earthonline embed --file <the page with </body>>'] });

  // which embed: --id, else the one this page's block (or AGENTS.md's) names, else a new one for this project
  const listed = await callTool(base, 'eol_list_embeds', {}, key);
  const embeds = Array.isArray(listed?.embeds) ? listed.embeds : [];
  const agentsFile = path.join(root, 'AGENTS.md'), agentsText = readText(agentsFile);
  const fromBlock = blockEmbed(text);
  const fromAgents = /\(id (\S+), type/.exec(AGENTS_BLOCK_RE.exec(agentsText ?? '')?.[0] ?? '')?.[1];
  let embed = opts.id ? embeds.find(e => e.id === opts.id)
    : (fromBlock && embeds.find(e => e.n === fromBlock.n && handleOf(e.code) === fromBlock.handle)) || embeds.find(e => e.id === fromAgents);
  if (opts.id && !embed) throw new CliError('invalid_input', `There is no embed ${opts.id} on this account (eol_list_embeds lists them).`, { exit: EXIT.input, field: 'id' });
  let made = false;
  if (!embed) { embed = (await callTool(base, 'eol_save_embed', { mode: opts.mode ?? 'floating' }, key)).embed; made = true; }
  else if (opts.mode && opts.mode !== embed.mode) embed = (await callTool(base, 'eol_save_embed', { id: embed.id, mode: opts.mode }, key)).embed;
  const handle = handleOf(embed?.code);
  if (!embed?.id || !handle) throw new CliError('UNKNOWN_ERROR', 'EarthOnline did not return the embed\'s line.', { next: ['Run the same command again.'] });

  // the project's website allowed (localhost always is, on the server)
  const site = projectSite(root, opts.site);
  const sites = Array.isArray(listed?.sites) ? listed.sites : [];
  const sitesAdded = [];
  if (site && !sites.includes(site)) { await callTool(base, 'eol_update_embed_sites', { add: site }, key); sitesAdded.push(site); }

  // the line in the page, then checked as it is on disk
  const next = withBlock(text, page, embed.code);
  if (next !== text) rewrite(file, text, next);
  const inPlace = readText(file)?.includes(embed.code) ? 'in place' : 'missing';
  if (inPlace !== 'in place') throw new CliError('UNKNOWN_ERROR', `The line is not in ${page} after writing it.`, { next: ['Check that the file is writable, then run the same command again.'] });

  // AGENTS.md, after the checks, saying what they found
  const labels = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const skills = checkSkills(['claude-code', 'codex']).map(s => ({ label: labels[s.host], status: s.status }));
  const block = agentsBlock({ handle, embed, page, checked: { line: inPlace, skills } });
  const agentsNext = agentsText === null ? block : AGENTS_BLOCK_RE.test(agentsText) ? agentsText.replace(AGENTS_BLOCK_RE, block) : `${agentsText.replace(/\n*$/, '\n\n')}${block}`;
  const agentsStatus = agentsNext === agentsText ? 'unchanged' : 'written';
  if (agentsStatus === 'written') rewrite(agentsFile, agentsText, agentsNext);

  const warnings = [];
  const claude = readText(path.join(root, 'CLAUDE.md'));
  if (claude !== null && !/^@AGENTS\.md\s*$/m.test(claude)) warnings.push({ step: 'agents_md', error: 'CLAUDE.md exists, so Claude Code will not read AGENTS.md (CLAUDE.md was not changed).', fix: 'With your owner\'s agreement: npx earthonline agents-md --link-claude (adds the line @AGENTS.md to CLAUDE.md)' });
  const nexts = site || sites.length ? [] : ['When the site has its address: npx earthonline embed --site <https://your.site> (pages on localhost show it already)'];
  return out.done({
    embed: { id: embed.id, n: embed.n, mode: embed.mode, made }, file: page, sites_added: sitesAdded,
    agents_md: { path: 'AGENTS.md', status: agentsStatus }, warnings, next: nexts,
  }, `@${handle}'s chat (embed #${embed.n}, ${embed.mode}) is in ${posix(page)}${sitesAdded.length ? `, ${sitesAdded[0]} allowed` : ''}; AGENTS.md says how to change it.`);
}

/** agents-md --link-claude: the line @AGENTS.md added to this project's CLAUDE.md once, so Claude Code reads AGENTS.md too. */
export async function agentsMdCommand(args, out) {
  if (args.length !== 1 || args[0] !== '--link-claude') throw new CliError('usage', 'Usage: earthonline agents-md --link-claude   (adds @AGENTS.md to this project\'s CLAUDE.md)', { exit: EXIT.input });
  const file = path.join(process.cwd(), 'CLAUDE.md'), text = readText(file);
  if (text === null) return out.done({ status: 'ok', claude_md: 'none', warnings: [], next: [] }, 'There is no CLAUDE.md here, so Claude Code reads AGENTS.md as it is.');
  if (/^@AGENTS\.md\s*$/m.test(text)) return out.done({ status: 'ok', claude_md: 'unchanged', warnings: [], next: [] }, 'CLAUDE.md already has @AGENTS.md.');
  rewrite(file, text, `${text.replace(/\n*$/, '\n')}\n@AGENTS.md\n`);
  return out.done({ status: 'ok', claude_md: 'linked', warnings: [], next: [] }, 'Added @AGENTS.md to CLAUDE.md (the earlier one is kept beside it).');
}
