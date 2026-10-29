export const MAX_BYTES = 16 * 1024;
export function truncateUtf8(value, bytes = MAX_BYTES) {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.length <= bytes) return buffer.toString();
  let end = Math.max(0, bytes);
  while (end && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString();
}
const line = (value, bytes = 160) => truncateUtf8(String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' '), bytes);
const handle = (person) => '@' + line(typeof person === 'string' ? person : person?.handle, 80).replace(/^@/, '');
const person = (value) => `${handle(value)}${value?.name ? ` (${line(value.name)})` : ''}${value?.via ? ` via ${line(value.via)}` : ''}`;

/**
 * Who the message @-mentions, from the server's `mentions` (members' handles found in the text), with the owner of this
 * session marked "(you)". Facts only: whether to answer is the agent's own call (10-20, Bonan).
 */
export function mentionsOf(event, self) {
  const me = self ? handle(self).toLowerCase() : null;
  return (Array.isArray(event.mentions) ? event.mentions : []).slice(0, 20).map(m => handle(m)).map(m => (me && m.toLowerCase() === me ? `${m} (you)` : m));
}


// Metadata stays visually on one line: control, bidi and line-separator characters become spaces.
const metaLine = (value, bytes = 160) => truncateUtf8(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' '), bytes);
/** The same one-line cleaning, for codex-live.mjs's summary line. */
export const oneLine = (value, bytes) => metaLine(value, bytes);
const metaHandle = value => '@' + metaLine(typeof value === 'string' ? value : value?.handle, 80).replace(/^@/, '');

/**
 * The server's quote of the other side's words (stranger-text.js quoted: a head line "Quoted from the other side (…):" or
 * "Quoted from your team conversation (…):", then every line as "> line"), back to the words as they were written. Only
 * what is delivered into a session is unquoted (Bonan 10-29: "可以默认直接显示原文"); the web and eol_read show it as before.
 * Anything else is returned unchanged.
 */
export function unquote(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  if (nl < 0) return s;
  const head = s.slice(0, nl);
  if (!/^Quoted from (?:the other side|your team conversation) \(/.test(head) || !head.endsWith(':')) return s;
  const lines = s.slice(nl + 1).split('\n');
  if (!lines.every(l => l.startsWith('> ') || l === '>')) return s;
  return lines.map(l => l.slice(2)).join('\n');
}

/** Who wrote it, from the server's fields only: "@ada (person)", "@ada's agent", or EarthOnline for a system line. */
function writerOf(event) {
  if (event.by === 'system') return 'EarthOnline';
  return event.by === 'human' ? `${metaHandle(event.from)} (person)` : `${metaHandle(event.from)}'s agent`;
}
const mentionsSelf = (event, self) => Boolean(self) && Array.isArray(event.mentions)
  && event.mentions.some(m => metaHandle(m).toLowerCase() === metaHandle(self).toLowerCase());

/**
 * The first line of a delivered message (Bonan 10-29: two lines, who and then the words). Private:
 * "[EarthOnline] @ada (person) wrote to you privately:". Group: "[EarthOnline] @ada's agent in "Hackathon", mentions you:".
 */
export function formatGroupHeading(event, self) {
  const mentioned = mentionsSelf(event, self) ? ', mentions you' : '';
  return `[EarthOnline] ${writerOf(event)} in "${metaLine(event.group?.name)}"${mentioned}:`;
}
function heading(event, self) {
  if (event.group) return formatGroupHeading(event, self);
  return `[EarthOnline] ${writerOf(event)} wrote to you privately${mentionsSelf(event, self) ? ', mentions you' : ''}:`;
}

/**
 * What a session receives for one message: the heading, then the words as written (the server's quote taken off). No thread
 * id, no reply instructions (eol_message's own description says how to answer), no history. A message longer than one turn
 * holds is cut, with where to read it whole.
 */
export function formatMessage(event, { self } = {}) {
  const top = heading(event, self);
  const text = unquote(event.text);
  const whole = `${top}\n${text}`;
  if (Buffer.byteLength(whole) <= MAX_BYTES) return whole;
  const readMore = event.group
    ? `eol_groupchat ${JSON.stringify({ action: 'history', group_id: event.thread_id ?? event.group.id, after_seq: Math.max(0, Number(event.seq) - 1 || 0) })}`
    : `eol_read ${JSON.stringify({ target: metaHandle(event.from) })}`;
  const note = `\n(cut short: read it whole with ${readMore})`;
  const room = MAX_BYTES - Buffer.byteLength(`${top}\n${note}`);
  return `${top}\n${truncateUtf8(text, Math.max(0, room))}${note}`;
}

export function formatGroupEvent(event, { origin } = {}) {
  const name = `"${line(event.group?.name)}"`;
  let text;
  switch (event.kind) {
    case 'join_request':
      text = `${person(event.joiner)} wants to join your group ${name}. Only your owner can let them in. Approval page: ${line(event.note_url, 2048)}.`;
      break;
    case 'joined':
      text = `${person(event.member)} joined ${name}. Members: ${(event.members ?? []).map(m => `${person(m)} (${m.online ? 'online' : 'offline'})`).join(', ')}.`;
      break;
    case 'refused': text = `Your request to join ${name} was refused.`; break;
    case 'disbanded': text = `${name} was disbanded by ${handle(event.by)}. Its links are invalid.`; break;
    // to the member taken out by the owner (a group event, not SSE 'removed', which ends this session)
    case 'removed': text = `You were removed from ${name} by ${handle(event.by)}. You can no longer read or write it.`; break;
    default: return null;
  }
  return truncateUtf8(`[EarthOnline] ${text}`);
}
