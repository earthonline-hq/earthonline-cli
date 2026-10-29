// The sign-in in progress between `login --email` and `login --code` (research/cli-onboarding-design-1026.md §10, §12): the
// two are separate calls, so an agent's shell that times out or is killed in between loses nothing, and a re-run of
// `login --email` with time left resumes instead of sending a second email.
//
// EOL_HOME/pending-login.json: { v: 1, email, handle?, name?, origin, to, sent_at, expires_at }. It never holds the code (the
// code goes from the owner straight to `--code`) and never a key. Private like the key (writeSecret).
// Copied from InsForge's ~/.insforge/pending-device.json (@insforge/cli 0.2.8 dist, read 2026-10-26): a pending login kept on
// disk and reused while it has time left; theirs holds a device code, ours only the address the code was sent to.
import fs from 'node:fs';
import { PATHS, readJson, writeSecret } from './common.mjs';

/** A pending sign-in is reused only with at least this long left; with less, a new code is the kinder answer. */
export const RESUME_MARGIN_MS = 60_000;

/**
 * The pending sign-in, or null (none, unreadable, another shape, or expired). `includeExpired`: an expired one too, for
 * what only needs its address (login --resend) or should say "expired" rather than "nothing was started".
 */
export function readPending({ includeExpired = false, now = Date.now() } = {}) {
  const p = readJson(PATHS.pending);
  if (!p || p.v !== 1 || typeof p.email !== 'string' || typeof p.origin !== 'string') return null;
  const expires = Date.parse(p.expires_at);
  if (!Number.isFinite(expires) || (!includeExpired && expires <= now)) return null;
  return p;
}

/** Whether `p` is for this address (any case) at this origin, with time left to be worth resuming. */
export function resumable(p, email, origin, now = Date.now()) {
  return Boolean(p) && p.email.toLowerCase() === String(email).trim().toLowerCase() && p.origin === origin && Date.parse(p.expires_at) - now > RESUME_MARGIN_MS;
}

/** Saves what `login --code` needs besides the code. Returns the warnings of writeSecret (a Windows ACL not tightened). */
export function savePending({ email, handle = null, name = null, origin, to = null, sentAt = new Date(), expiresAt }) {
  const record = { v: 1, email, ...(handle ? { handle } : {}), ...(name ? { name } : {}), origin, to, sent_at: new Date(sentAt).toISOString(), expires_at: new Date(expiresAt).toISOString() };
  return writeSecret(PATHS.pending, JSON.stringify(record) + '\n');
}

export function clearPending() { fs.rmSync(PATHS.pending, { force: true }); }
