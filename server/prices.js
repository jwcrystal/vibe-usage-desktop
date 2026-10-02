import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Embedded default price table.
import defaultPrices from './prices.json' with { type: 'json' };

// User-editable override: a `prices.json` in the data dir
// (~/.vibe-usage-server/, or VIBE_USAGE_SERVER_DIR) wins over the embedded
// default. Keeps pricing next to the user data rather than inside
// node_modules, so a reinstall never wipes it.
// Malformed/unreadable overrides fall through to the embedded default.
const DATA_DIR = process.env.VIBE_USAGE_SERVER_DIR?.trim() || join(homedir(), '.vibe-usage-server');

function readOverride(file) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  if (parsed.models && typeof parsed.models === 'object') return parsed;
  return null;
}

export function loadPrices() {
  try {
    const parsed = readOverride(join(DATA_DIR, 'prices.json'));
    // An override replaces the model-keyed table, but the embedded
    // source-scoped tables must survive unless the override defines its own.
    if (parsed) return parsed.sources ? parsed : { ...parsed, sources: defaultPrices.sources };
  } catch {
    // Malformed or unreadable — fall through to the embedded default.
  }
  return defaultPrices;
}

// Compute estimated cost for one bucket. Returns a number, or null if the
// model is not in the price table.
// formula: input*inputRate + output*outputRate + cachedInput*cacheReadRate
//        + cacheCreation5m*cacheWriteRate
// cacheWriteMtok is optional (missing = 0): models without a published
// cache-write price keep their previous cost unchanged.
export function estimateCost(bucket, prices = loadPrices()) {
  // A source-scoped table lets a few ids that Command Code serves at its own
  // catalog price coexist with the same id from another vendor at a different
  // price (e.g. gpt-5.6-sol). Everything else keeps the model-keyed lookup.
  const entry = prices.sources?.[bucket.source]?.models?.[bucket.model]
    ?? prices.models[bucket.model];
  if (!entry) return null;
  const perToken = {
    input: (entry.input ?? 0) / 1_000_000,
    output: (entry.output ?? 0) / 1_000_000,
    cacheRead: (entry.cacheReadMtok ?? 0) / 1_000_000,
    cacheWrite: (entry.cacheWriteMtok ?? 0) / 1_000_000,
  };
  const input = Number(bucket.inputTokens ?? 0);
  const output = Number(bucket.outputTokens ?? 0);
  const cached = Number(bucket.cachedInputTokens ?? 0);
  const reasoning = Number(bucket.reasoningOutputTokens ?? 0);
  const cacheWrite = Number(bucket.cacheCreation5mTokens ?? 0);
  return input * perToken.input + (output + reasoning) * perToken.output
    + cached * perToken.cacheRead + cacheWrite * perToken.cacheWrite;
}
