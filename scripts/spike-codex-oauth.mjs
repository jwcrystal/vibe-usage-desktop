#!/usr/bin/env node
// SPIKE（用完即丟）：驗證「pi-ai 當 OAuth 引擎」路線 for codex。
// 步驟：
//   1. pi-ai openaiCodexProvider().auth.oauth.login() — 瀏覽器 OAuth，本腳本驅動互動
//   2. credential 映射寫入 ~/.codex/auth.json（codex CLI 格式）
//   3. 用我們 vendor 的 cli provider 實測 usage API — 印出配額 snapshot = 成功
// 前置：npm install --no-save @earendil-works/pi-ai
// 執行：node scripts/spike-codex-oauth.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { fetchCodexQuota } from '../cli/src/quotas/providers/codex.js';

const CODEX_AUTH = join(homedir(), '.codex', 'auth.json');
const DEVICE_ID_FILE = join(homedir(), '.vibe-usage', 'device-id');

const redact = (s) => (typeof s === 'string' ? s.slice(0, 10) + '…(' + s.length + ' chars)' : s);

function ask(q) {
  return new Promise((res) => {
    let done = false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const finish = (a) => { if (!done) { done = true; rl.close(); res(String(a ?? '').trim()); } };
    rl.question(q, finish);
    rl.on('close', () => finish('')); // EOF / 無 TTY（背景執行）
  });
}

function getDeviceId() {
  try { return readFileSync(DEVICE_ID_FILE, 'utf8').trim(); } catch { /* first run */ }
  mkdirSync(join(homedir(), '.vibe-usage'), { recursive: true });
  const id = randomUUID();
  writeFileSync(DEVICE_ID_FILE, id);
  return id;
}

const oauth = openaiCodexProvider().auth.oauth;
console.log('[spike] provider:', oauth.name, '| loginLabel:', oauth.loginLabel || '(none)');

const interaction = {
  signal: AbortSignal.timeout(5 * 60_000),
  notify(event) {
    if (event.type === 'auth_url') {
      console.log('\n[spike] 開瀏覽器登入（5 分鐘內完成）…');
      spawnSync('open', [event.url], { stdio: 'ignore' });
    } else if (event.type === 'device_code') {
      console.log(`[spike] device code: ${event.userCode} → ${event.verificationUri}`);
    } else if (event.type === 'info') {
      console.log('[spike] info:', event.message);
    } else if (event.type === 'progress') {
      console.log('[spike] …', event.message);
    }
  },
  async prompt(p) {
    if (p.type === 'manual_code') {
      // manual_code 與本地 callback server 競速：瀏覽器完成登入 → server 贏 → 流程續行。
      // 有 TTY 才提供貼 code 的備位；背景執行就掛著不回答，絕不能回空字串
      //（空答案會被當成貼了空 code → Missing authorization code）。
      console.log('[spike] manual_code 已掛起 — 在瀏覽器完成登入即可，不用貼任何東西');
      if (process.stdin.isTTY) {
        return await ask('（瀏覽器沒自動繼續時才用）貼上 code 或 redirect URL: ');
      }
      return await new Promise(() => {}); // 永不結算：等 callback server 贏
    }
    if (p.type === 'select') {
      // 背景執行沒有 TTY：登入方式的選擇直接走 browser（裝置碼流程這次不測）
      if (p.options.some((o) => o.id === 'browser')) {
        console.log('[spike] auto-select: browser');
        return 'browser';
      }
      console.log('[spike]', p.message);
      for (const o of p.options) console.log('   -', o.id, ':', o.label);
      return await ask('輸入選項 id: ');
    }
    return await ask(p.message + ' ');
  },
};

console.log('[spike] login 開始');
const cred = await oauth.login(interaction, { getDeviceId });

console.log('\n[spike] credential 形狀（遮罩）:');
console.log('  keys   :', Object.keys(cred).join(', '));
console.log('  type   :', cred.type);
console.log('  access :', redact(cred.access));
console.log('  refresh:', redact(cred.refresh));
console.log('  expires:', Number.isFinite(cred.expires) ? new Date(cred.expires).toISOString() : cred.expires);
for (const k of Object.keys(cred)) {
  if (!['type', 'access', 'refresh', 'expires'].includes(k)) {
    console.log('  extra  :', k, '=', JSON.stringify(cred[k])?.slice(0, 80));
  }
}

// 映射成 codex CLI 的 auth.json 格式（provider 讀 tokens.access_token / tokens.account_id）
const tokens = { access_token: cred.access, refresh_token: cred.refresh };
if (typeof cred.account_id === 'string') tokens.account_id = cred.account_id;
const codexAuth = { tokens, last_refresh: Math.floor(Date.now() / 1000) };

if (existsSync(CODEX_AUTH)) {
  writeFileSync(CODEX_AUTH + '.spike-bak', readFileSync(CODEX_AUTH, 'utf8'));
  console.log('\n[spike] 既有 auth.json 已備份為 auth.json.spike-bak');
}
mkdirSync(join(homedir(), '.codex'), { recursive: true });
writeFileSync(CODEX_AUTH, JSON.stringify(codexAuth, null, 2) + '\n');
console.log('[spike] 已寫入', CODEX_AUTH);

// 端到端：我們的 provider 讀該檔案、打 usage API
console.log('\n[spike] 用 vendored provider 實測 usage API…');
try {
  const result = await fetchCodexQuota({});
  console.log('[spike] result:\n', JSON.stringify(result, null, 2).slice(0, 2500));
  console.log('\n[spike] ' + (result.status === 'ok'
    ? '✅ 成功：pi-ai 換的 token 能打 usage API，Phase 1 路線成立'
    : '⚠️ token 落地了，但 provider 回 status=' + result.status + (result.emptyReason ? ' / ' + result.emptyReason : '')));
} catch (err) {
  console.log('[spike] ❌ provider 拋錯:', err.message);
}
