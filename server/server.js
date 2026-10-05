import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';
import { mkdirSync, writeFileSync, renameSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadData, saveData, ingestBuckets, upsertQuotaSnapshots, getDataPath, hash } from './store.js';
import { logEvent } from './log.js';
import { estimateCost } from './prices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, 'ui', 'dashboard.html');

const PORT = Number(process.env.PORT || process.env.VIBE_USAGE_PORT || 3456);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function supportsQuotaSnapshots(host = HOST) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

const SYNCABLE_QUOTA_IDS = new Set(['codex', 'commandcode', 'claude-code', 'opencode-go']);
const QUOTA_EMPTY_REASONS = new Set(['limitReached', 'noWindow', 'notEntitled', 'sessionWithoutPlanLimits', 'notDetected', 'unauthorized']);

function validDate(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// --- quota sync opt-in (the dashboard writes what the CLI reads) -----------

function readRawConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readQuotaSyncConfig() {
  const products = readRawConfig().quotaSyncProducts;
  return Array.isArray(products)
    ? products.filter((id) => typeof id === 'string' && SYNCABLE_QUOTA_IDS.has(id))
    : [];
}

// The CLI binds its opt-in to the normalized apiUrl it syncs against; the
// dashboard writes that same binding so the next sync picks the change up.
function normalizeApiTarget(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isLoopbackTarget(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function writeQuotaSyncConfig(products, apiTarget) {
  const cfg = readRawConfig();
  cfg.quotaSyncProducts = products;
  cfg.quotaSyncApiUrl = apiTarget;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  // The file carries the API key: owner-only, matching the CLI's writer.
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows mode models vary */ }
  return cfg.quotaSyncProducts;
}

function sanitizeQuotaSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !SYNCABLE_QUOTA_IDS.has(raw.id) || !['ok', 'no_data'].includes(raw.status)
    || !Array.isArray(raw.meters) || raw.meters.length > 20) return null;
  const fetchedAt = validDate(raw.fetchedAt);
  const dataAsOf = validDate(raw.dataAsOf || raw.fetchedAt);
  if (!fetchedAt || !dataAsOf) return null;
  const meters = [];
  for (const meter of raw.meters) {
    if (!meter || typeof meter !== 'object' || Array.isArray(meter)
      || typeof meter.id !== 'string' || meter.id.length > 80
      || typeof meter.label !== 'string' || meter.label.length > 80
      || typeof meter.utilization !== 'number' || !Number.isFinite(meter.utilization)
      || meter.utilization < 0 || meter.utilization > 100) return null;
    const normalized = { id: meter.id, label: meter.label, utilization: meter.utilization };
    if (meter.resetsAt !== undefined) {
      const resetsAt = validDate(meter.resetsAt);
      if (!resetsAt) return null;
      normalized.resetsAt = resetsAt;
    }
    if (meter.windowSeconds !== undefined) {
      if (typeof meter.windowSeconds !== 'number' || !Number.isFinite(meter.windowSeconds)
        || meter.windowSeconds <= 0 || meter.windowSeconds > 10 * 365 * 24 * 3600) return null;
      normalized.windowSeconds = meter.windowSeconds;
    }
    if (meter.amountUsed !== undefined || meter.amountLimit !== undefined) {
      if (typeof meter.amountUsed !== 'number' || !Number.isFinite(meter.amountUsed)
        || meter.amountUsed < 0 || meter.amountUsed > 1e9
        || typeof meter.amountLimit !== 'number' || !Number.isFinite(meter.amountLimit)
        || meter.amountLimit <= 0 || meter.amountLimit > 1e9) return null;
      normalized.amountUsed = meter.amountUsed;
      normalized.amountLimit = meter.amountLimit;
    }
    meters.push(normalized);
  }
  const snapshot = {
    id: raw.id,
    status: raw.status,
    meters,
    fetchedAt,
    dataAsOf,
  };
  if (raw.resetCredits !== undefined && raw.resetCredits !== null) {
    if (!Number.isInteger(raw.resetCredits) || raw.resetCredits < 0 || raw.resetCredits > 1_000_000) return null;
    snapshot.resetCredits = raw.resetCredits;
  }
  if (raw.resetCreditsAt !== undefined && raw.resetCreditsAt !== null) {
    if (!Array.isArray(raw.resetCreditsAt) || raw.resetCreditsAt.length > 8
      || raw.resetCreditsAt.some((item) => typeof item !== 'string' || validDate(item) === null)) return null;
    snapshot.resetCreditsAt = raw.resetCreditsAt.map(validDate);
  }
  if (raw.creditBalance !== undefined && raw.creditBalance !== null) {
    if (typeof raw.creditBalance !== 'number' || !Number.isFinite(raw.creditBalance)
      || raw.creditBalance < 0 || raw.creditBalance > 1e9) return null;
    snapshot.creditBalance = raw.creditBalance;
  }
  if (typeof raw.planLabel === 'string' && raw.planLabel.trim() && raw.planLabel.length <= 80) {
    snapshot.planLabel = raw.planLabel.trim();
  }
  if (['live', 'local', 'cache'].includes(raw.source)) snapshot.source = raw.source;
  if (QUOTA_EMPTY_REASONS.has(raw.emptyReason)) snapshot.emptyReason = raw.emptyReason;
  return snapshot;
}

function sanitizeQuotaSnapshots(raw) {
  if (!Array.isArray(raw) || raw.length > SYNCABLE_QUOTA_IDS.size) return [];
  const seen = new Set();
  return raw.map(sanitizeQuotaSnapshot).filter(snapshot => {
    if (!snapshot || seen.has(snapshot.id)) return false;
    seen.add(snapshot.id);
    return true;
  });
}

// API key expected by this server. Resolution order:
//   1. VIBE_USAGE_SERVER_KEY env (explicit)
//   2. ~/.vibe-usage/config.json apiKey (shared with the CLI)
//   3. none -> permissive: accept any "vbu_" prefixed key (simple local use)
const CONFIG_FILE = join(process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage'), 'config.json');

function resolveExpectedKey() {
  if (process.env.VIBE_USAGE_SERVER_KEY) return process.env.VIBE_USAGE_SERVER_KEY;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    if (cfg?.apiKey) return cfg.apiKey;
  } catch { /* fall through */ }
  return null;
}

const EXPECTED_KEY = resolveExpectedKey();

function authorize(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const supplied = m ? m[1].trim() : '';
  const ok = EXPECTED_KEY ? supplied === EXPECTED_KEY : supplied.startsWith('vbu_');
  if (!ok) {
    // The supplied key itself is deliberately absent — only the shape of the
    // request is recorded, so a bad key leaves a trace but no secret.
    logEvent('auth', '401', {
      req: `${req.method} ${req.url}`.slice(0, 80),
      ua: (req.headers['user-agent'] || '').slice(0, 40),
    });
  }
  return ok;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if ((req.headers['content-encoding'] || '').toLowerCase() === 'gzip') {
        try {
          resolve(gunzipSync(raw));
        } catch (e) {
          reject(new Error('invalid gzip body'));
        }
      } else {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(payload);
}

// Serve the single-file local dashboard, injecting the server's expected API
// key so the browser can authenticate against /api/usage. Only reachable on
// localhost (HOST=127.0.0.1 by default), so embedding the key here is no less
// exposed than the CLI/app reading ~/.vibe-usage/config.json.
function serveDashboard(req, res) {
  let html;
  try {
    html = readFileSync(DASHBOARD_PATH, 'utf-8');
  } catch {
    return sendJson(res, 500, { error: 'dashboard_missing', message: DASHBOARD_PATH });
  }
  html = html.replace('__VIBE_API_KEY__', JSON.stringify(EXPECTED_KEY || ''));
  const buf = Buffer.from(html);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// Static product icons for the quota card, vendored from the Mac app's
// Resources into src/ui/icons/. Strict filename whitelist — no traversal,
// no directory listing.
const ICON_DIR = join(__dirname, 'ui', 'icons');
const ICON_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveUiAsset(res, name) {
  if (!/^[a-z0-9-]+(@2x)?\.(png|svg)$/.test(name)) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  let body;
  try {
    body = readFileSync(join(ICON_DIR, name));
  } catch {
    return sendJson(res, 404, { error: 'not_found' });
  }
  res.writeHead(200, {
    'Content-Type': ICON_TYPES[name.slice(name.lastIndexOf('.'))],
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=604800',
  });
  res.end(body);
}

// Parse bucketStart into a Date. Accepts full ISO (with/without fractional
// seconds) — ISO strings sort/compare lexically when the offset is fixed.
function bucketTime(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function filterBuckets(buckets, params) {
  const now = Date.now();
  let min = -Infinity;
  let max = Infinity;

  if (params.days) {
    const d = Number(params.days);
    if (Number.isFinite(d) && d > 0) {
      min = now - d * 24 * 60 * 60 * 1000;
    }
  }

  if (params.from) {
    const t = bucketTime(params.from);
    if (t !== null) min = Math.max(min, t);
  }
  if (params.to) {
    const t = bucketTime(params.to);
    if (t !== null) max = Math.min(max, t);
  }

  return buckets.filter((b) => {
    const t = bucketTime(b.bucketStart);
    if (t === null) return false;
    return t >= min && t <= max;
  });
}

const router = {
  async 'POST /api/usage/ingest'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    let body;
    try {
      body = await parseBody(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid_body' });
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf-8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }

    const incomingBuckets = Array.isArray(payload.buckets) ? payload.buckets : [];
    const incomingSessions = Array.isArray(payload.sessions) ? payload.sessions : [];

    // Store raw tokens only. estimatedCost is computed at read time from the
    // live price table (prices.js/prices.json) so editing prices.json applies
    // to all existing data immediately — that is the whole point of 本地調價.
    const data = loadData();
    const stats = ingestBuckets(data, incomingBuckets, incomingSessions);
    let quotas = { accepted: 0, unchanged: 0 };
    if (supportsQuotaSnapshots() && Array.isArray(payload.quotas)) {
      const hostname = payload.client?.hostname;
      if (typeof hostname === 'string' && hostname.trim() && hostname.length <= 255
        && !/[\u0000-\u001f\u007f]/.test(hostname)) {
        const snapshots = sanitizeQuotaSnapshots(payload.quotas);
        quotas = upsertQuotaSnapshots(data, hostname.trim(), snapshots);
        logEvent('ingest', null, {
          hostname: hostname.trim(),
          quotas: snapshots.map((s) => s.id + ':' + s.status + (s.emptyReason ? '/' + s.emptyReason : '')).join(',') || 'none',
          accepted: quotas.accepted,
          unchanged: quotas.unchanged,
        });
      }
    }
    saveData(data);

    sendJson(res, 200, { ...stats, quotas });
  },

  'GET /api/usage'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const params = url.searchParams;
    const data = loadData();
    const buckets = filterBuckets(data.buckets, {
      days: params.get('days'),
      from: params.get('from'),
      to: params.get('to'),
    });
    // Compute estimatedCost live from the current price table.
    for (const b of buckets) b.estimatedCost = estimateCost(b);
    // Distinct models with no price entry — surfaced so undercounted KPIs
    // are visible instead of silently low.
    const unpricedModels = [...new Set(
      buckets.filter((b) => b.estimatedCost === null).map((b) => b.model),
    )].sort();
    sendJson(res, 200, {
      buckets,
      sessions: data.sessions,
      quotas: data.quotas || [],
      hasAnyData: data.buckets.length > 0,
      unpricedModels,
      quotaSync: supportsQuotaSnapshots() ? { products: readQuotaSyncConfig() } : null,
    });
  },

  'GET /api/usage/settings'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    // Fully local: always upload project names (no privacy concern sending to
    // your own machine). Quota-sync opt-in only exists on loopback, mirroring
    // the snapshot capability.
    sendJson(res, 200, {
      uploadProject: true,
      quotaSnapshots: supportsQuotaSnapshots(),
      quotaSyncProducts: supportsQuotaSnapshots() ? readQuotaSyncConfig() : [],
      // Buckets may carry firstCallAt/lastCallAt (actual model-call times
      // for the 詳細記錄 table). Loopback-only luxury; the hosted service
      // never sets it, so the CLI keeps the wire format unchanged there.
      bucketCallTimestamps: supportsQuotaSnapshots(),
    });
  },

  async 'POST /api/usage/quota-sync'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    if (!supportsQuotaSnapshots()) return sendJson(res, 403, { error: 'quota_sync_requires_loopback' });
    let payload;
    try {
      payload = JSON.parse((await parseBody(req)).toString('utf-8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const requested = Array.isArray(payload?.products) ? payload.products : null;
    if (!requested || requested.some((id) => !SYNCABLE_QUOTA_IDS.has(id))) {
      return sendJson(res, 400, { error: 'invalid_products' });
    }
    // The CLI gates quota sync on its configured apiUrl pointing at this
    // loopback server; managing from the UI would be a silent no-op
    // otherwise, so refuse with a distinguishable error instead.
    const target = normalizeApiTarget(readRawConfig().apiUrl || 'https://vibecafe.ai');
    if (!target || !isLoopbackTarget(target)) {
      return sendJson(res, 409, { error: 'api_url_not_loopback' });
    }
    const products = writeQuotaSyncConfig([...new Set(requested)], target);
    logEvent('sync', 'quota-sync', { products: products.join(',') || 'none' });
    sendJson(res, 200, { products });
  },

  'DELETE /api/usage/ingest'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const hostname = url.searchParams.get('hostname');
    const data = loadData();
    let deleted = 0;
    if (hostname) {
      const before = data.buckets.length;
      data.buckets = data.buckets.filter((b) => {
        if (b.hostname === hostname) { deleted += 1; return false; }
        return true;
      });
      data.sessions = data.sessions.filter((s) => s.hostname !== hostname);
      const quotaCount = data.quotas.length;
      data.quotas = data.quotas.filter((snapshot) => snapshot.hostname !== hostname);
      deleted = before - data.buckets.length;
      deleted += quotaCount - data.quotas.length;
    } else {
      deleted = data.buckets.length + data.sessions.length + data.quotas.length;
      data.buckets = [];
      data.sessions = [];
      data.quotas = [];
    }
    saveData(data);
    sendJson(res, 200, { deleted });
  },

  'GET /api/usage/device/code'(req, res) {
    sendJson(res, 501, { error: 'Device flow not supported in local mode. Use `vibe-usage init --manual-key <key>` instead.' });
  },

  'POST /api/usage/device/code'(req, res) {
    sendJson(res, 501, { error: 'Device flow not supported in local mode. Use `vibe-usage init --manual-key <key>` instead.' });
  },

  'POST /api/usage/device/poll'(req, res) {
    sendJson(res, 501, { error: 'Device flow not supported in local mode.' });
  },
};

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.VIBE_USAGE_LOG_REQUESTS === '1') {
      console.log(`[req] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms, ua=${(req.headers['user-agent'] || '').slice(0, 60)})`);
    }
  });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const routeKey = `${req.method} ${path}`;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    res.end();
    return;
  }
  const handler = router[routeKey];
  if (!handler) {
    // Local dashboard at / and /usage (GET only). No auth — localhost-only.
    if (req.method === 'GET' && (path === '' || path === '/' || path === '/usage' || path === '/index.html')) {
      return serveDashboard(req, res);
    }
    if (req.method === 'GET' && path.startsWith('/ui-assets/')) {
      return serveUiAsset(res, path.slice('/ui-assets/'.length));
    }
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  });
});

// Tests may bind the server to an ephemeral port.
export { server };

// Permissive auth (no configured key) accepts any vbu_-prefixed key. That is
// only acceptable on a loopback interface — refuse to bind anything wider.
export function assertSafeBind(host, hasExpectedKey) {
  const h = String(host || '').toLowerCase();
  if (hasExpectedKey || LOOPBACK_HOSTS.has(h)) return;
  throw new Error(
    `Refusing to bind ${host}: permissive auth (no VIBE_USAGE_SERVER_KEY and no apiKey in ~/.vibe-usage/config.json) accepts any vbu_ key. ` +
    'Set VIBE_USAGE_SERVER_KEY (or the config apiKey), or keep HOST=127.0.0.1.',
  );
}

export function start() {
  assertSafeBind(HOST, Boolean(EXPECTED_KEY));
  server.listen(PORT, HOST, () => {
    console.log(`Vibe Usage local server listening on http://${HOST}:${PORT}`);
    console.log(`Data: ${getDataPath()}`);
    console.log(`Expected key: ${EXPECTED_KEY ? (EXPECTED_KEY.slice(0, 12) + '...') : '(permissive, any vbu_ key)'}`);
  });
}
