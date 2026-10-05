// codex-oauth.js — Phase 1: in-app OpenAI Codex OAuth via pi-ai.
//
// Why a sidecar: refresh needs the pi-ai credential shape (incl. `expires`),
// which ~/.codex/auth.json does not carry. auth.json stays the single source
// the quota provider and the official codex CLI read; the sidecar
// (~/.vibe-usage/codex-oauth.json) only exists so *we* can refresh the token
// on machines where the official CLI is not installed to do it for us.
//
// Both files are written on login and on every refresh. A one-time backup of
// any pre-existing auth.json is kept as auth.json.vibe-bak.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CODEX_DIR = join(homedir(), '.codex');
const AUTH_FILE = join(CODEX_DIR, 'auth.json');
const AUTH_BACKUP = join(CODEX_DIR, 'auth.json.vibe-bak');
const VIBE_DIR = join(homedir(), '.vibe-usage');
const SIDECAR = join(VIBE_DIR, 'codex-oauth.json');
const DEVICE_ID_FILE = join(VIBE_DIR, 'device-id');

// Observed access-token TTL (spike 2026-10-05: login 02:24 → expires 10-15 02:24).
// Only used to seed the sidecar from a pre-existing auth.json; the login and
// refresh responses always carry the authoritative expiry.
const SEED_TTL_MS = 10 * 24 * 3600 * 1000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function deviceId() {
  const existing = readJson(DEVICE_ID_FILE);
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  mkdirSync(VIBE_DIR, { recursive: true });
  const id = randomUUID();
  writeFileSync(DEVICE_ID_FILE, id);
  return id;
}

async function providerOauth() {
  // Lazy: keeps pi-ai (and its SDK graph) out of app startup; only login and
  // an actual refresh pay the import cost.
  const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex');
  return openaiCodexProvider().auth.oauth;
}

function toCodexAuth(cred) {
  const tokens = { access_token: cred.access, refresh_token: cred.refresh };
  if (typeof cred.accountId === 'string') tokens.account_id = cred.accountId;
  return { tokens, last_refresh: Math.floor(Date.now() / 1000) };
}

/** Persist a fresh credential to both the sidecar and codex's auth.json. */
export function writeBoth(cred) {
  mkdirSync(VIBE_DIR, { recursive: true });
  writeJson(SIDECAR, cred);
  mkdirSync(CODEX_DIR, { recursive: true });
  if (existsSync(AUTH_FILE) && !existsSync(AUTH_BACKUP)) {
    writeFileSync(AUTH_BACKUP, readFileSync(AUTH_FILE, 'utf8'));
  }
  writeJson(AUTH_FILE, toCodexAuth(cred));
}

/**
 * One-time migration: an auth.json written before this module existed (e.g.
 * by the spike) has valid tokens but no sidecar, so refresh would never run.
 * Seed the sidecar from it so the token chain survives without a re-login.
 * Returns true when a sidecar now exists.
 */
export function ensureSidecar() {
  if (existsSync(SIDECAR)) return true;
  const auth = readJson(AUTH_FILE);
  const tokens = auth && auth.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') return false;
  const lastRefresh = Number.isFinite(auth.last_refresh) ? auth.last_refresh * 1000 : Date.now();
  writeBoth({
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: lastRefresh + SEED_TTL_MS,
    ...(typeof tokens.account_id === 'string' ? { accountId: tokens.account_id } : {}),
  });
  return true;
}

/**
 * Refresh before the token expires. Cheap no-op while fresh; only machines
 * without the official codex CLI rely on this (the CLI refreshes its own
 * credential when used). Margin defaults to 24h so a daily sync never sees
 * an expired token. Returns 'refreshed' | 'fresh' | 'none'.
 */
export async function refreshIfExpiring({ marginMs = 24 * 3600 * 1000, log = () => {} } = {}) {
  if (!ensureSidecar()) return 'none';
  const cred = readJson(SIDECAR);
  if (!cred || typeof cred.refresh !== 'string') return 'none';
  if (Number.isFinite(cred.expires) && cred.expires - Date.now() > marginMs) return 'fresh';
  const oauth = await providerOauth();
  const renewed = await oauth.refresh(cred, AbortSignal.timeout(30_000));
  writeBoth(renewed);
  log('token refreshed, expires ' + new Date(renewed.expires).toISOString());
  return 'refreshed';
}

/**
 * Drive the pi-ai browser OAuth flow. `openUrl` receives the authorize URL
 * (Electron: shell.openExternal). Headless-safe: the login-method select
 * auto-picks browser, and the manual_code prompt never answers — the local
 * callback server wins when the user finishes in the browser.
 */
export async function loginCodex({ openUrl, log = () => {} } = {}) {
  const oauth = await providerOauth();
  const interaction = {
    signal: AbortSignal.timeout(5 * 60_000),
    notify(event) {
      if (event.type === 'auth_url') {
        log('opening browser for OpenAI authorization');
        openUrl(event.url);
      } else if (event.type === 'info') {
        log(event.message);
      }
    },
    async prompt(p) {
      if (p.type === 'select' && p.options.some((o) => o.id === 'browser')) return 'browser';
      if (p.type === 'manual_code') {
        // Racing the callback server: never answer (an empty answer would be
        // treated as a pasted code and fail the login). See spike 2026-10-05.
        log('manual_code prompt parked — waiting for browser callback');
        return await new Promise(() => {});
      }
      throw new Error('unexpected_prompt:' + p.type);
    },
  };
  const cred = await oauth.login(interaction, { getDeviceId: deviceId });
  writeBoth(cred);
  log('logged in, expires ' + new Date(cred.expires).toISOString());
  return cred;
}
