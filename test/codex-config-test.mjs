// EarthOnline's section in Codex's config.toml: only our marked block is added or removed, and removing it gives back the
// file byte for byte. No files, no network.
import './require-origin.mjs';
import assert from 'node:assert/strict';
import { BEGIN, END, OFF, block, foreignEol, hasOurBlock, withBlock, withoutBlock, withoutEarthonline, withEarthonlineBack } from '../codex-config.mjs';

const ours = block({ node: 'C:\\Program Files\\nodejs\\node.exe', mcp: 'C:/Users/x/.earthonline/app/mcp.mjs', eolHome: 'C:\\Users\\x\\.earthonline', codexHomeDir: 'C:\\Users\\x\\.codex' });
let checks = 0;
const check = (...a) => { assert.ok(...a); checks++; };

// The block is valid TOML for Codex: basic strings with escaped backslashes, our own two tables, the markers around it.
check(ours.startsWith(BEGIN + '\n') && ours.endsWith(END + '\n'), 'markers around the block');
check(ours.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'), 'Windows path escaped as a TOML basic string');
check(ours.includes('args = ["C:/Users/x/.earthonline/app/mcp.mjs", "--harness", "codex"]'), 'args');
check(ours.includes('[mcp_servers.earthonline.env]\nEOL_HOME = "C:\\\\Users\\\\x\\\\.earthonline"\nCODEX_HOME = "C:\\\\Users\\\\x\\\\.codex"'), 'env table');

const files = {
  empty: '',
  newline: '# my comment, keep me\nmodel = "x"   # trailing\n\n[mcp_servers.node_repl]\ncommand = "node"   # keep spacing\n',
  noNewline: 'model = "x"\n[projects.\'C:\\foo\']\ntrust_level = "trusted"',
  crlf: '# windows\r\nmodel = "x"\r\n\r\n[tui]\r\nscreen_reader_detection_done = true\r\n',
  blankEnd: 'model = "x"\n\n',
};
for (const [name, text] of Object.entries(files)) {
  const added = withBlock(text, ours);
  check(added.text.startsWith(text) && added.text.endsWith(ours) && hasOurBlock(added.text), `${name}: block appended, the rest untouched`);
  check(!foreignEol(added.text), `${name}: our own block is not a foreign earthonline`);
  check(withoutBlock(added.text, added.separator) === text, `${name}: removal gives the file back byte for byte`);
  // a second install replaces our block in place (a new path), and still removes cleanly
  const again = withBlock(added.text, ours.replace('mcp.mjs', 'mcp2.mjs'));
  check(again.separator === null && again.text.includes('mcp2.mjs') && !again.text.includes('/app/mcp.mjs"'), `${name}: reinstall replaces our block`);
  check(withoutBlock(again.text, added.separator) === text, `${name}: removal after reinstall`);
  // the user wrote after our block: their lines stay
  const after = added.text + '\n[profiles.fast]\nmodel = "y"\n';
  check(withoutBlock(after, added.separator) === text + '\n[profiles.fast]\nmodel = "y"\n', `${name}: lines after our block stay`);
}
// a block written before the package was renamed earthonline (its first line said `npx eol-connect`) is still ours
const oldBegin = '# >>> eol-connect (EarthOnline) >>> added by `npx eol-connect`, removed by `npx eol-connect uninstall`';
const oldFile = files.newline + '\n' + ours.replace(BEGIN, oldBegin).replaceAll('mcp_servers.earthonline', 'mcp_servers.eol');
check(hasOurBlock(oldFile) && withoutBlock(oldFile, '\n') === files.newline && !foreignEol(oldFile), 'an old-named block is found, removed and not foreign');
check(withBlock(oldFile, ours).text === files.newline + '\n' + ours, 'reinstall replaces an old-named block');
// without the saved separator (config.json lost), one blank line before the block goes with it
const lost = withBlock(files.newline, ours);
check(withoutBlock(lost.text, undefined) === files.newline, 'separator unknown: the usual blank line goes');

// someone else's earthonline, in every way TOML can say it: we never touch the file then
for (const text of ['[mcp_servers.earthonline]\ncommand = "x"\n', '[mcp_servers."earthonline"]\ncommand = "x"\n', "[ mcp_servers . 'earthonline' ]\n", '[mcp_servers.earthonline.env]\nA = "1"\n',
  'mcp_servers.earthonline.command = "x"\n', 'mcp_servers.earthonline = { command = "x" }\n', '[mcp_servers]\nearthonline = { command = "x" }\n', '[mcp_servers]\n  "earthonline".command = "x"\n']) {
  check(foreignEol(text), `foreign earthonline: ${JSON.stringify(text)}`);
}
for (const text of ['[mcp_servers.earthonline_other]\n', '[mcp_servers.node_repl]\nearthonline = 1\n'.replace('[mcp_servers.node_repl]', '[profiles.x]'), '# [mcp_servers.earthonline]\n', '[mcp_servers.earthonlinex]\n']) {
  check(!foreignEol(text), `not an earthonline server: ${JSON.stringify(text)}`);
}
// an earlier URL connection named earthonline: commented out in place, the next table untouched, back byte for byte
const old = 'model = "x"\n[mcp_servers.earthonline]\nurl = "https://mcp.earthonlines.com/mcp"\n# their note\n\n[mcp_servers."earthonline".env]\nA = "1"\n[mcp_servers.earthonline_beta]\nurl = "b"\n[tui]\ny = 2\n';
const off = withoutEarthonline(old);
check(off.includes(`${OFF}[mcp_servers.earthonline]\n${OFF}url = "https://mcp.earthonlines.com/mcp"\n${OFF}# their note\n${OFF}\n${OFF}[mcp_servers."earthonline".env]\n${OFF}A = "1"\n[mcp_servers.earthonline_beta]`), 'earthonline and its sub-tables off; earthonline_beta not');
check(off.endsWith('[tui]\ny = 2\n') && off.startsWith('model = "x"\n'), 'the rest untouched');
check(withEarthonlineBack(off) === old, 'turned back on byte for byte');
check(withoutEarthonline(off) === null && withoutEarthonline('model = 1\n') === null, 'nothing to turn off: null');
const both = withBlock(off, ours);
check(!foreignEol(both.text) && withEarthonlineBack(withoutBlock(both.text, both.separator)) === old, 'with our block: uninstall gives the original back');
const lastIsOld = withBlock('[mcp_servers.earthonline]\nurl = "https://earthonlines.com/mcp"\n', ours).text;
check(withoutEarthonline(lastIsOld).includes(`\n${BEGIN}\n`), 'our own block is never commented out');
// Foreign domains and command-based servers never qualify for automatic disabling.
for (const url of ['https://example.com/mcp', 'https://earthonlines.com.example.com/mcp', 'https://notearthonlines.com/mcp']) {
  const text = '[mcp_servers.earthonline]\nurl = ' + JSON.stringify(url) + '\n';
  check(withoutEarthonline(text) === null && foreignEol(text), 'foreign URL left alone: ' + url);
}
check(withoutEarthonline(ours) === null, 'our same-named stdio block is never disabled');
check(withoutEarthonline('[mcp_servers.earthonline]\ncommand = "node"\n') === null, 'foreign stdio left alone');
check(!foreignEol('[mcp_servers.eol]\ncommand = "theirs"\n'), 'foreign old eol does not conflict');
const crlfOld = old.replaceAll('\n', '\r\n');
check(withEarthonlineBack(withoutEarthonline(crlfOld)) === crlfOld, 'old URL restored with CRLF byte for byte');
check(withoutEarthonline(lastIsOld).endsWith(ours), 'all lines of our block remain active');
const local = ours.replaceAll('mcp_servers.earthonline', 'mcp_servers.earthonline-local');
const localBuilt = block({ node: 'node', mcp: '/app/mcp.mjs', eolHome: '/eol', codexHomeDir: '/codex', name: 'earthonline-local' });
check(localBuilt.includes('[mcp_servers.earthonline-local]') && localBuilt.includes('[mcp_servers.earthonline-local.env]'), 'keep mode registers the local name');
check(!foreignEol(old, 'earthonline-local') && foreignEol('[mcp_servers.earthonline-local]\n', 'earthonline-local'), 'local name has its own conflict check');
const kept = withBlock(old, local);
check(kept.text.startsWith(old) && withEarthonlineBack(withoutBlock(kept.text, kept.separator)) === old, 'keep mode preserves the URL entry');
check(!withBlock(oldFile, ours).text.includes('[mcp_servers.eol'), 'upgrade removes both old eol tables');
const arrayAfter = '[mcp_servers.earthonline]\nurl = "https://mcp.earthonlines.com/mcp"\n[[other]]\nvalue = 1\n';
check(withoutEarthonline(arrayAfter).endsWith('[[other]]\nvalue = 1\n'), 'unrelated array tables are not commented out');
const quotedUrl = "[mcp_servers.'earthonline']\n'url' = 'https://earthonlines.com/mcp' # old connector\n";
check(withEarthonlineBack(withoutEarthonline(quotedUrl)) === quotedUrl, 'quoted root, quoted URL key and apex domain supported');
// Each dotted key segment has TOML semantics, including single/double quotes and Unicode escapes.
for (const root of ['mcp_servers', '"mcp_servers"', "'mcp_servers'", String.raw`"mcp\u005fservers"`, String.raw`"\U0000006dcp_servers"`]) {
  for (const [name, spellings] of [
    ['earthonline', ['earthonline', '"earthonline"', "'earthonline'", String.raw`"\u0065arthonline"`, String.raw`"earth\U0000006fnline"`]],
    ['earthonline-local', ['earthonline-local', '"earthonline-local"', "'earthonline-local'", String.raw`"earthonline\u002dlocal"`]],
  ]) for (const spelling of spellings) {
    const key = `${root} . ${spelling}`;
    for (const text of [`[ ${key} ] # entry\ncommand = "foreign"\n`, `[${key}.env]\nA = "1"\n`,
      `${key}.command = "foreign"\n`, `[${root}]\n${spelling} = { command = "foreign" }\n`, `[[${key}]]\n`]) {
      check(foreignEol(text, name), `semantic conflict: ${text}`);
      check(foreignEol(withBlock(text, ours).text, name), 'outside conflicts still detected with our marker block');
    }
    if (name === 'earthonline') {
      const text = `[${key}]\r\nurl = "https://earthonlines.com/mcp"\r\n[${key}."env"]\r\nA = "1"\r\n[tui]\r\nx = 1\r\n`;
      const disabled = withoutEarthonline(text);
      check(disabled !== null && !foreignEol(disabled), 'all semantic URL table spellings disabled');
      check(withEarthonlineBack(disabled) === text, 'semantic URL tables round-trip byte for byte');
    }
  }
}
for (const text of [String.raw`["mcp_servers.earthonline"]`, String.raw`[mcp_servers.'\u0065arthonline']`,
  String.raw`[mcp_servers."earthonline\"other"]`, String.raw`[mcp_servers."earthonline\\other"]`,
  '["mcp_servers"."earthonline#other"]', '["mcp_servers"."earthonline]other"]',
  '[profiles.x]\n"mcp_servers"."earthonline".command = "foreign"\n']) {
  check(!foreignEol(text), `different semantic key is preserved: ${text}`);
}
console.log(`PASS codex-config: our section added and removed byte for byte, foreign earthonline left alone, an old earthonline turned off and back (${checks} checks)`);
