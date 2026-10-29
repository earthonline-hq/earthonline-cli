// `call <tool> [--input -]` and `feedback "<text>"` (research/cli-onboarding-design-1026.md §10, §12, A4): every EarthOnline
// tool from a shell, before the session has the MCP tools loaded (a new session is needed for those) or without MCP at all.
//
// `call` is POST /api/tools/<tool>, the same operations as the MCP tools and eol_api_*; its output is the tool's `result`, the
// same JSON as the REST body's (keys cut out by redact()). Arguments come as JSON on stdin only, never in argv: PowerShell eats
// the double quotes of a JSON argument (design §12), and argv shows in the process list. Copied from `gh api --input -`
// (https://cli.github.com/manual/gh_api, viewed 2026-10-26).
// `feedback` is a message to EarthOnline's own address, so the answer comes back like any message
// sendmessage么"); better than InsForge's one-way `insforge feedback` (@insforge/cli 0.2.8, read 2026-10-26). Copied from
// Stripe's send_stripe_feedback (https://docs.stripe.com/mcp, viewed 2026-10-26), with a reply on top.
//
// A call made inside an agent session says which session it is (the X-EOL-Agent headers mcp.mjs sends), so an answer to it
// comes back to that session and the owner sees which session wrote.
import { SESSION_ID_RE, origin, readKey, keySource, readIdentity, agentHeaders } from './common.mjs';
import { EXIT, CliError, callTool } from './contract.mjs';

const TOOL_NAME = /^eol_[a-z0-9_]+$/;
const MAX_INPUT = 1024 * 1024;
export const FEEDBACK_TO = '@earthonline';
const SIGN_IN = "npx earthonline login --email <your owner's email>";

/** The session a command runs in (Claude Code's Bash tool, a Codex shell), as mcp.mjs names it; none outside one. */
export function callerHeaders(env = process.env) {
  if (SESSION_ID_RE.test(env.CLAUDE_CODE_SESSION_ID ?? '')) {
    const pid = Number(env.CLAUDE_PID);
    const saved = Number.isInteger(pid) && pid > 0 ? readIdentity('claude-code', pid) : null;
    return agentHeaders('claude-code', saved?.session_id === env.CLAUDE_CODE_SESSION_ID ? saved : { session_id: env.CLAUDE_CODE_SESSION_ID, cwd: process.cwd() });
  }
  if (SESSION_ID_RE.test(env.CODEX_THREAD_ID ?? '')) return agentHeaders('codex', { session_id: env.CODEX_THREAD_ID, cwd: process.cwd() });
  return {};
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_INPUT) throw new CliError('invalid_input', 'The input is larger than 1 MB.', { exit: EXIT.input, field: 'input' });
  }
  return text;
}
function key() {
  const k = readKey();
  if (!k && keySource() === 'env') throw new CliError('invalid_input', 'EOL_KEY is set but is not an EarthOnline key (eolc_ and 40 letters and digits).', { exit: EXIT.input, next: ['Unset EOL_KEY, or set it to a key.'] });
  return k;
}

/** call <tool> [--input -] -> exit code. Without a key the call goes keyless (eol_login, eol_find work so); a 401 is signed_out. */
export async function callCommand(args, out) {
  let tool = null, input = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input') {
      if (args[i + 1] !== '-') throw new CliError('invalid_input', '--input takes - : the arguments as JSON on stdin, for example echo {"to":"@ada","text":"Hi"} | npx earthonline call eol_message --input -', { exit: EXIT.input, field: 'input' });
      input = '-'; i++;
    } else if (!tool && !arg.startsWith('-')) tool = arg;
    else throw new CliError('usage', 'Usage: earthonline call <eol_tool> [--input -]   (the arguments as JSON on stdin)', { exit: EXIT.input });
  }
  if (!tool) throw new CliError('missing_input', 'Name the tool: npx earthonline call <eol_tool> [--input -]', { exit: EXIT.input, needs: ['tool'] });
  if (!TOOL_NAME.test(tool)) throw new CliError('invalid_input', `${tool} is not an EarthOnline tool name (eol_ and lower-case letters, digits, _).`, { exit: EXIT.input, field: 'tool' });
  let params = {};
  if (input) {
    const text = (await readStdin()).trim();
    if (text) {
      try { params = JSON.parse(text); } catch { throw new CliError('invalid_input', 'The input on stdin is not JSON.', { exit: EXIT.input, field: 'input' }); }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new CliError('invalid_input', 'The input on stdin must be one JSON object of the tool\'s arguments.', { exit: EXIT.input, field: 'input' });
    }
  }
  // eol_wait may hold the request for minutes (design §12): the shell's own limit applies, not a short one here
  const result = await callTool(origin(), tool, params, key(), { timeoutMs: 330_000, headers: callerHeaders() });
  if (out.json) return out.done({ status: 'ok', tool, result, warnings: [], next: [] });
  return out.done({ status: 'ok', warnings: [], next: [] }, JSON.stringify(result));
}

/** feedback "<text>" (or `feedback -`: the text on stdin) -> exit code. A message from your address, so the reply comes back. */
export async function feedbackCommand(args, out) {
  const words = args.filter(a => a !== '--json');
  const text = (words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ')).trim();
  if (!text) throw new CliError('missing_input', 'Say what to tell EarthOnline: npx earthonline feedback "<text>"', { exit: EXIT.input, needs: ['text'] });
  const k = key();
  if (!k) throw new CliError('missing_input', 'Feedback is a message from your EarthOnline address, so the answer can come back to you: sign in first.', { exit: EXIT.input, next: [SIGN_IN] });
  const sent = await callTool(origin(), 'eol_message', { to: FEEDBACK_TO, text }, k, { headers: callerHeaders() });
  const thread = typeof sent?.thread_id === 'string' ? sent.thread_id : null;
  return out.done({
    status: 'ok', to: FEEDBACK_TO, ...(thread ? { thread_id: thread } : {}), ...(Number.isInteger(sent?.seq) ? { seq: sent.seq } : {}), warnings: [],
    next: [`The answer comes as an EarthOnline message: in this session when it is connected, or ${thread ? `echo {"thread_id":"${thread}"} | npx earthonline call eol_wait --input -` : 'npx earthonline call eol_inbox'}`],
  }, `Sent to ${FEEDBACK_TO}. The answer comes back as an EarthOnline message.`);
}
