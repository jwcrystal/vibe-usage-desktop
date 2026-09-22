import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Data directory override (test hook). Defaults to ~/.vibe-usage-server/.
const DATA_DIR = process.env.VIBE_USAGE_SERVER_DIR?.trim() || join(homedir(), '.vibe-usage-server');
const DATA_FILE = join(DATA_DIR, 'data.json');

export function getDataPath() {
  return DATA_FILE;
}

const BAK_FILE = `${DATA_FILE}.bak`;
const CORRUPT_FILE = `${DATA_FILE}.corrupt`;
let backedUpThisProcess = false;

function tryRead(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function tryParse(text) {
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through */ }
  return null;
}

function normalize(parsed) {
  return {
    buckets: Array.isArray(parsed.buckets) ? parsed.buckets : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

export function loadData() {
  const raw = tryRead(DATA_FILE);
  const parsed = tryParse(raw);
  if (parsed) {
    // One backup per process: a snapshot of the last healthy file, so a torn
    // write or disk corruption never loses everything.
    if (!backedUpThisProcess) {
      backedUpThisProcess = true;
      try {
        writeFileSync(BAK_FILE, raw);
      } catch { /* best-effort */ }
    }
    return normalize(parsed);
  }
  if (raw != null) {
    // Corrupt main file: preserve it for manual inspection before any later
    // save overwrites it, then try the backup.
    console.warn(`[store] ${DATA_FILE} unreadable — preserving as ${CORRUPT_FILE} and trying ${BAK_FILE}`);
    try {
      if (!existsSync(CORRUPT_FILE)) writeFileSync(CORRUPT_FILE, raw);
    } catch { /* best-effort */ }
  }
  const bak = tryParse(tryRead(BAK_FILE));
  if (bak) {
    console.warn(`[store] recovered from ${BAK_FILE}`);
    return normalize(bak);
  }
  return { buckets: [], sessions: [] };
}

function saveData(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, DATA_FILE);
}

// Bucket dedup key. Must mirror the CLI's bucketKey so incremental sync works.
export function bucketKey(b) {
  return `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
}

export function sessionKey(s) {
  return `${s.source}|${s.sessionHash}`;
}

// Upsert incoming buckets/sessions with dedup. Returns per-bucket aggregate
// stats mirroring the upstream /ingest response shape:
//   { ingested, sessions, dropped, protected }
//   dropped: { buckets, unknownModels, implausible, unknownSources }
//   protected: { buckets }
export function ingestBuckets(data, incomingBuckets, incomingSessions) {
  const stats = {
    ingested: 0,
    sessions: 0,
    dropped: { buckets: 0, unknownModels: 0, implausible: 0, unknownSources: [] },
    protected: { buckets: 0 },
  };

  const byKey = new Map();
  for (const b of data.buckets) byKey.set(bucketKey(b), b);

  for (const b of incomingBuckets) {
    if (!isPlausible(b)) {
      stats.dropped.buckets += 1;
      stats.dropped.implausible += 1;
      continue;
    }
    const key = bucketKey(b);
    const existing = byKey.get(key);
    if (existing && existing.totalTokens >= b.totalTokens) {
      // Larger existing snapshot wins — smaller snapshot does not overwrite.
      stats.protected.buckets += 1;
      continue;
    }
    const stored = { ...b, estimatedCost: b.estimatedCost ?? null };
    byKey.set(key, stored);
    stats.ingested += 1;
  }
  data.buckets = [...byKey.values()];

  const sessByKey = new Map();
  for (const s of data.sessions) sessByKey.set(sessionKey(s), s);
  for (const s of incomingSessions) {
    const key = sessionKey(s);
    const existing = sessByKey.get(key);
    if (existing && existing.durationSeconds >= s.durationSeconds) continue;
    sessByKey.set(key, s);
    stats.sessions += 1;
  }
  data.sessions = [...sessByKey.values()];

  return stats;
}

function isPlausible(b) {
  const t = Number(b.totalTokens ?? 0);
  if (t < 0 || t > 100_000_000_000) return false;
  return true;
}

export function hash(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export { saveData };
