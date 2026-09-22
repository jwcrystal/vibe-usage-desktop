import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadData, saveData, ingestBuckets, getDataPath, hash } from './store.js';
import { estimateCost } from './prices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, 'ui', 'dashboard.html');

const PORT = Number(process.env.PORT || process.env.VIBE_USAGE_PORT || 3456);
const HOST = process.env.HOST || '127.0.0.1';

// API key expected by this server. Resolution order:
//   1. VIBE_USAGE_SERVER_KEY env (explicit)
//   2. ~/.vibe-usage/config.json apiKey (shared with the CLI)
//   3. none -> permissive: accept any "vbu_" prefixed key (simple local use)
function resolveExpectedKey() {
  if (process.env.VIBE_USAGE_SERVER_KEY) return process.env.VIBE_USAGE_SERVER_KEY;
  const configFile = join(process.env.VIBE_USAGE_CONFIG_DIR?.trim() || join(homedir(), '.vibe-usage'), 'config.json');
  try {
    if (existsSync(configFile)) {
      const cfg = JSON.parse(readFileSync(configFile, 'utf-8'));
      if (cfg?.apiKey) return cfg.apiKey;
    }
  } catch { /* fall through */ }
  return null;
}

const EXPECTED_KEY = resolveExpectedKey();

function authorize(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const supplied = m ? m[1].trim() : '';
  if (EXPECTED_KEY) {
    return supplied === EXPECTED_KEY;
  }
  // Permissive mode: require a plausible vbu_-style key.
  return supplied.startsWith('vbu_');
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
    saveData(data);

    sendJson(res, 200, stats);
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
      hasAnyData: data.buckets.length > 0,
      unpricedModels,
    });
  },

  'GET /api/usage/settings'(req, res) {
    if (!authorize(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    // Fully local: always upload project names (no privacy concern sending to
    // your own machine).
    sendJson(res, 200, { uploadProject: true });
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
      deleted = before - data.buckets.length;
    } else {
      deleted = data.buckets.length + data.sessions.length;
      data.buckets = [];
      data.sessions = [];
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
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  });
});

// Tests may bind the server to an ephemeral port.
export { server };

export function start() {
  server.listen(PORT, HOST, () => {
    console.log(`Vibe Usage local server listening on http://${HOST}:${PORT}`);
    console.log(`Data: ${getDataPath()}`);
    console.log(`Expected key: ${EXPECTED_KEY ? (EXPECTED_KEY.slice(0, 12) + '...') : '(permissive, any vbu_ key)'}`);
  });
}
