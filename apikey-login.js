// apikey-login.js — Phase 2: in-app API-key login for Command Code and
// OpenCode Go. Keys land in the official file layouts the vendored CLI's
// quota providers already read, so no fork change is needed:
//
//   commandcode → ~/.commandcode/auth.json  top-level `apiKey`
//                 (merge-write: the file also carries identity fields and a
//                 nested codex entry that must survive)
//   opencode-go → ~/.local/share/opencode/auth.json  pre-2.x layout
//                 `opencode: { type: 'api', key }` (merge-write: sibling
//                 provider keys stay). The 2.x credential table in
//                 opencode.db stays authoritative when it has a Go row;
//                 this file only covers machines where it does not — the
//                 provider's own fallback order.
//
// A key is validated against the official endpoint BEFORE anything is
// written; both files get a one-time .vibe-bak backup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const COMMANDCODE_AUTH = join(homedir(), '.commandcode', 'auth.json');
const OPENCODE_ROOT = join(homedir(), '.local', 'share', 'opencode');
const OPENCODE_AUTH = join(OPENCODE_ROOT, 'auth.json');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function mergeWrite(path, mutator) {
  const parsed = readJson(path) ?? {};
  mutator(parsed);
  mkdirSync(dirname(path), { recursive: true });
  const bak = path + '.vibe-bak';
  if (existsSync(path) && !existsSync(bak)) {
    writeFileSync(bak, readFileSync(path, 'utf8'));
  }
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
}

async function bearerGet(url, key, timeoutMs = 12_000) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* classification only */ }
  return { status: res.status, ok: res.ok, payload };
}

/** Validate a Command Code key (the same whoami gate the provider uses)
 *  and merge it into ~/.commandcode/auth.json. */
export async function loginCommandcode(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty_key' };
  const res = await bearerGet('https://api.commandcode.ai/alpha/whoami?limits=1', trimmed);
  if (res.status === 401) return { ok: false, error: 'invalid_key' };
  if (!res.ok) return { ok: false, error: 'validate_failed_' + res.status };
  mergeWrite(COMMANDCODE_AUTH, (parsed) => { parsed.apiKey = trimmed; });
  return { ok: true };
}

/** Validate an OpenCode zen/Go key against the usage endpoint and merge it
 *  into the pre-2.x auth.json layout (db credential table stays first). */
export async function loginOpencodeGo(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty_key' };
  const res = await bearerGet('https://opencode.ai/zen/go/v1/usage', trimmed);
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid_key' };
  if (!res.ok) return { ok: false, error: 'validate_failed_' + res.status };
  mergeWrite(OPENCODE_AUTH, (parsed) => {
    parsed.opencode = { type: 'api', key: trimmed };
  });
  return { ok: true };
}
