// `key rotate` (research/cli-onboarding-design-1026.md §10, A4): a new key for this computer, then the one it held revoked.
//
// EarthOnline makes a key only through a sign-in (eol_create_key refuses every key credential: sec-keys-relay, 10-09), so the
// new key comes from signing in again, by email code or on the web page, and the old one is revoked with the new key
// (eol_revoke_key { id }). The sign-in may take two runs (`login --email` then `login --code`; `login --device` twice), so the
// rotation is written down first and finished by whichever sign-in completes within ROTATE_MS, on the same server and account.
// Copied from `gh auth refresh` / `stripe login`, which replace the stored credential by signing in again, plus the revoke of the
// replaced one that GitHub's token docs ask for (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation, viewed 2026-10-26).
//
// EOL_HOME/rotate.json: { v: 1, origin, handle, key_id, expires_at }. No key in it (the id is not a credential).
import fs from 'node:fs';
import { PATHS, KEY_RE, readJson, readKey, keySource, writeSecret } from './common.mjs';
import { EXIT, CliError, callTool } from './contract.mjs';

export const ROTATE_MS = 20 * 60 * 1000; // a device code lives 15 minutes, an email code 10: either sign-in fits
const KEY_PREFIX = 9; // the first letters EarthOnline shows of a key (core/accounts/keys.js keyPrefix)
export const ROTATE_NEXT = ['npx earthonline key rotate --device', "npx earthonline key rotate --email <your owner's email>"];

/** The key in the key file only (never EOL_KEY: that one is not this computer's to replace). */
function fileKey() {
  try { const k = fs.readFileSync(PATHS.key, 'utf8').trim(); return KEY_RE.test(k) ? k : null; } catch { return null; }
}

/**
 * Before the sign-in: which key is being replaced. -> { handle, key_id }. The id is the one saved at sign-in (config.json
 * key_id) when EarthOnline still lists it, else the one key whose first letters match (keys signed in before 0.2.0).
 */
export async function beginRotation(base, say = () => {}) {
  if (keySource() === 'env') throw new CliError('invalid_input', 'EOL_KEY is set: that key is not this computer\'s key file, so it is not replaced here. Make a new key where EOL_KEY comes from, or unset EOL_KEY.', { exit: EXIT.input });
  const old = fileKey();
  if (!old || readKey() !== old) throw new CliError('missing_input', 'This computer has no key to rotate: sign in instead.', { exit: EXIT.input, next: ['npx earthonline login --device', "npx earthonline login --email <your owner's email>"] });
  const me = await callTool(base, 'eol_whoami', {}, old); // a revoked key is signed_out (exit 3): nothing left to rotate
  const handle = String(me?.robot?.handle ?? '').replace(/^@/, '');
  const keys = Array.isArray(me?.keys) ? me.keys : [];
  const saved = readJson(PATHS.config)?.key_id;
  const byPrefix = keys.filter(k => typeof k?.prefix === 'string' && k.prefix.replace(/…$/, '') === old.slice(0, KEY_PREFIX));
  const id = keys.some(k => k?.id === saved) ? saved : byPrefix.length === 1 ? byPrefix[0].id : null;
  if (!handle || typeof id !== 'string') throw new CliError('key_unknown', 'EarthOnline did not say which of your keys this computer holds, so it could not be revoked after the new sign-in. Revoke it on your Keys page after signing in again.', { exit: EXIT.unexpected, next: ['npx earthonline login --device'] });
  writeSecret(PATHS.rotate, JSON.stringify({ v: 1, origin: base, handle, key_id: id, expires_at: new Date(Date.now() + ROTATE_MS).toISOString() }) + '\n');
  say(`Rotating @${handle}'s key on this computer: the old one is revoked as soon as the new sign-in finishes.`);
  return { handle, key_id: id };
}

/**
 * After any sign-in (cli.mjs finishLogin): finishes a rotation begun within ROTATE_MS on this server for this account, with the
 * new key. -> { rotated: { revoked } } | { warning } | {} when none was waiting. Never throws: the sign-in itself succeeded.
 */
export async function finishRotation(base, handle, newKeyId = null) {
  const r = readJson(PATHS.rotate);
  if (!r) return {};
  fs.rmSync(PATHS.rotate, { force: true });
  if (r.v !== 1 || !(Date.parse(r.expires_at) > Date.now())) return {};
  const fix = `If no one uses it any more: echo {"id":"${r.key_id}"} | npx earthonline call eol_revoke_key --input -`;
  if (r.origin !== base || r.handle !== handle) return { warning: { step: 'rotate', error: `Signed in as @${handle}${r.origin !== base ? ` at ${base}` : ''}, not the @${r.handle} whose key was being replaced: that key was kept.`, fix } };
  const key = fileKey();
  if (!key || r.key_id === newKeyId) return { warning: { step: 'rotate', error: 'The new key is not in the key file, so the old one was kept.', fix } };
  try {
    await callTool(base, 'eol_revoke_key', { id: r.key_id }, key);
    return { rotated: { revoked: r.key_id } };
  } catch (err) {
    return { warning: { step: 'rotate', error: `The new key is saved, but the old one (${r.key_id}) could not be revoked: ${err?.message ?? err}`, fix } };
  }
}
