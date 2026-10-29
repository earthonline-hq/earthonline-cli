// `setup` (research/cli-onboarding-design-1026.md §2 "what login --code does", §9, §10; car11 A2): after a sign-in, one
// call leaves this computer connected and answers with one summary. In order: the MCP config of each agent program (cli.mjs
// install, 0.1.0's installers), the skill file of each (skills.mjs), a listener bound to the Claude Code session the command
// runs in (live.mjs bindSession), and the front desk only when asked (`--desk`; car11 Decision 6, Bonan 10-26: "默认是不要前台的").
//
// Every step that did not finish is a `warnings` entry ({ step, host?, error, fix }) and the run exits 5 (contract.mjs), with
// --json too: nothing about setup is said only to a person. 抄自 InsForge's post-login setup (installSkills after login,
// @insforge/cli 0.2.8 dist, read 2026-10-26), with its silent failures turned into warnings (stories/insforge-dogfood-1024.md).
// A second run changes nothing: each step writes only what differs (cli.mjs install, skills.mjs) and an already running
// listener or desk is reported as it is. 抄自 Neon's `init`, re-runnable by design (https://neon.com/docs/reference/cli-init,
// viewed 2026-10-26).
import { callTool } from './contract.mjs';
import { readKey, origin, readJson, PATHS } from './common.mjs';
import { bindSession } from './live.mjs';
import { installSkills } from './skills.mjs';

const HOSTS = { 'claude-code': 'Claude Code', codex: 'Codex' };
const hostOf = line => Object.keys(HOSTS).find(id => line.startsWith(HOSTS[id] + ' ')) ?? null;

/** What a session that could not be bound means for the owner: only a failure is a warning; not being in Claude Code is not. */
const SESSION_WARNINGS = {
  no_messaging_socket: ['This Claude Code session has no cross-session messaging (Claude Code v2.1.224 or later; v2.1.234 on Windows), so messages reach it only after a restart, through the EarthOnline tools.', 'Update Claude Code (claude update), then start a new session.'],
  no_session_id: ['This Claude Code session did not say which session it is (CLAUDE_PID, CLAUDE_CODE_SESSION_ID), so no listener was bound to it.', 'Start a new Claude Code session: its hooks bind it.'],
  delivery_settings_failed: ["EarthOnline's delivery settings could not be read, so no listener was bound to this session.", 'npx earthonline setup'],
  listener_not_started: ['The listener for this session did not start (see ~/.earthonline/live.log).', 'npx earthonline setup'],
};

/**
 * `install`: cli.mjs's install (passed in, since cli.mjs imports this file). `opts`: cli.mjs's, with `noSkill` and `desk`.
 * -> { handle, agents, skills, session, desk, warnings, next } (no status: contract.mjs out.done sets it from `warnings`).
 */
export async function setup(opts, { install, say = () => {}, env = process.env }) {
  const done = await install(opts);
  const warnings = [...done.warnings], next = [];
  const hosts = [...new Set(done.agents.map(hostOf).filter(Boolean))];
  for (const line of done.agents) {
    if (line.includes('✗')) warnings.push({ step: 'agent', host: hostOf(line), error: line, fix: 'Resolve it, then run: npx earthonline setup' });
  }

  // The skill file of each agent program set up, MCP registered or not: it also teaches the CLI fallbacks (design 1026 §9)
  const skills = opts.noSkill ? [] : installSkills(hosts);
  for (const s of skills) {
    if (s.status === 'ok') say(`${HOSTS[s.host]} skill: ${s.path}`);
    else warnings.push({ step: 'skill', host: s.host, error: s.error, fix: s.fix ?? 'npx earthonline setup' });
  }

  // The Claude Code session this command runs in, when Claude Code is one of the agents set up
  let session = { bound: false, reason: 'not_in_claude_code' };
  if (hosts.includes('claude-code')) {
    session = await bindSession(env);
    if (session.bound) say('This Claude Code session gets EarthOnline messages from now on, before any restart.');
    const known = SESSION_WARNINGS[session.reason];
    if (known) warnings.push({ step: 'live', host: 'claude-code', error: known[0], fix: known[1] });
  }

  // The front desk: off unless asked (Decision 6). eol_add_brain { kind: "credit" } answers created: false when it is on already.
  let desk = 'off';
  if (opts.desk) {
    try {
      await callTool(origin(), 'eol_add_brain', { kind: 'credit' }, readKey());
      desk = 'on';
      say('Your agent answers people for you, on your EarthOnline credit.');
    } catch (err) {
      warnings.push({ step: 'desk', error: String(err?.message ?? err), fix: 'npx earthonline setup --desk' });
    }
  } else next.push('To have your agent answer people for you on your EarthOnline credit: npx earthonline setup --desk');

  if (hosts.length) next.unshift('Start a new session to load the EarthOnline tools (claude --continue keeps this conversation). Until then: npx earthonline call <tool> --input -');
  const handle = done.handle ?? readJson(PATHS.config)?.handle ?? null;
  return { handle, agents: done.agents, skills, session, desk, warnings, next };
}
