// rag.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { DATA_FILE } = require('./config');

/** =========================
 *  Normalization + Helpers
 *  ========================= */
function normBase(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(nb) {
  if (!nb) return [];
  // Keep tokens >= 2 chars to match your previous logic
  return nb.split(' ').filter(t => t && t.length >= 2);
}

/** Fields you search across (make sure these match your dataset) */
const TEXT_FIELDS = ['course_title', 'provider_name', 'subject', 'campus', 'mode', 'summary', 'description'];
/** Fields you keep for response building */
const SLIM_FIELDS = ['course_title', 'provider_name', 'mode', 'duration', 'campus', 'start_date', 'ucas', 'ucas_code', 'title', 'provider', 'start'];

/** =========================
 *  Streaming JSON Array
 *  ========================= */
function openJsonArrayStream(filePath) {
  const isGzip = filePath.endsWith('.gz');
  const rs = fs.createReadStream(filePath);
  const pipeline = [];
  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser());
  pipeline.push(streamArray());
  return chain([rs, ...pipeline]);
}

/** =========================
 *  In-Memory Index
 *  =========================
 *  POSTINGS: Map<string, number[]>        // term -> sorted list of docIDs
 *  RECORDS: Array<{ idx:number, nb:string, ...slim }>
 */
let INDEX_READY_PROMISE = null;
let POSTINGS = null;
let RECORDS = null;

// Small LRU for query -> result caching (by normalized query)
const QUERY_CACHE = new Map();
const QUERY_CACHE_MAX = 200;

function lruGet(key) {
  if (!QUERY_CACHE.has(key)) return undefined;
  const val = QUERY_CACHE.get(key);
  QUERY_CACHE.delete(key);
  QUERY_CACHE.set(key, val);
  return val;
}
function lruSet(key, val) {
  QUERY_CACHE.set(key, val);
  if (QUERY_CACHE.size > QUERY_CACHE_MAX) {
    const firstKey = QUERY_CACHE.keys().next().value;
    QUERY_CACHE.delete(firstKey);
  }
}

/**
 * Build the index exactly once by streaming the dataset.
 * We keep a compact normalized blob per record and an inverted index of terms.
 */
async function buildIndex() {
  if (INDEX_READY_PROMISE) return INDEX_READY_PROMISE;
  INDEX_READY_PROMISE = (async () => {
    POSTINGS = new Map();
    RECORDS = [];

    const stream = openJsonArrayStream(DATA_FILE);
    let idx = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', ({ value }) => {
        try {
          // Create normalized blob for search
          const blob = TEXT_FIELDS.map(k => value?.[k] ?? '').join(' ');
          const nb = normBase(blob);
          if (!nb) { idx++; return; }

          // Keep only slim fields for downstream context building
          const slim = {};
          for (const f of SLIM_FIELDS) if (value?.[f] != null) slim[f] = value[f];
          slim.idx = idx;
          slim.nb = nb;

          RECORDS.push(slim);

          // Build term set per document (avoid duplicate docIDs per term)
          const terms = new Set(tokenize(nb));
          for (const t of terms) {
            let list = POSTINGS.get(t);
            if (!list) { list = []; POSTINGS.set(t, list); }
            // Keep postings sorted by pushing increasing idx
            // (idx increases monotonically as we stream)
            list.push(idx);
          }
          idx++;
        } catch {
          idx++;
          // ignore malformed rows
        }
      });

      stream.on('end', resolve);
      stream.on('error', reject);
    });
  })();

  return INDEX_READY_PROMISE;
}

/** =========================
 *  Query using the index
 *  ========================= */
function scoreDocByHits(doc, terms) {
  // Same cheap scoring you used: sum of term hit counts in the normalized blob.
  // nb.split(t).length - 1 per term (avoid regex overhead).
  let score = 0;
  const nb = doc.nb;
  for (const t of terms) {
    if (t.length < 2) continue;
    const hits = nb.split(t).length - 1;
    score += hits;
  }
  return score;
}

/**
 * Indexed retrieval: uses POSTINGS to get candidates, then cheap scoring.
 * Returns slim records (without nb) limited to {max}.
 */
async function findRelevantData(query, opts = {}) {
  const { max = 20 } = opts;
  const q = normBase(query);
  if (!q) return [];

  // build index lazily once
  await buildIndex();

  const cached = lruGet(q);
  if (cached) return cached.slice(0, max);

  const terms = tokenize(q);
  if (!terms.length) return [];

  // Collect candidates via postings union
  // candidateCounts[docId] = number of query terms that appear in doc
  const candidateCounts = new Map();
  for (const t of terms) {
    const posting = POSTINGS.get(t);
    if (!posting) continue;
    for (let i = 0; i < posting.length; i++) {
      const docId = posting[i];
      candidateCounts.set(docId, (candidateCounts.get(docId) || 0) + 1);
    }
  }
  if (candidateCounts.size === 0) return [];

  // Fast pre-prune: keep docs that matched at least one term, then score precisely
  // Turn into array of doc refs
  const candidates = [];
  for (const docId of candidateCounts.keys()) {
    const doc = RECORDS[docId];
    if (doc) candidates.push(doc);
  }

  // Score and rank
  const scored = candidates.map(doc => ({ score: scoreDocByHits(doc, terms), doc }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max).map(({ doc }) => {
    // strip nb from the returned item
    const { nb, ...rest } = doc;
    return rest;
  });

  lruSet(q, top);
  return top;
}

/** =========================
 *  Context Builder & Cleaners
 *  ========================= */
function buildRAGContext(records = []) {
  const lines = records.map((r, i) => {
    const title = r.course_title || r.title || 'Course';
    const provider = r.provider_name || r.provider || '';
    const mode = r.mode || '';
    const duration = r.duration || '';
    const campus = r.campus || '';
    const start = r.start_date || r.start || '';
    const ucas = r.ucas || r.ucas_code || '';

    return [
      `#${i + 1} ${title}${provider ? ` – ${provider}` : ''}`,
      mode ? `Mode: ${mode}` : null,
      duration ? `Duration: ${duration}` : null,
      campus ? `Campus: ${campus}` : null,
      start ? `Start: ${start}` : null,
      ucas ? `UCAS: ${ucas}` : null,
    ].filter(Boolean).join(' | ');
  });

  return lines.join('\n');
}

function sanitizeLLMReply(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\s+$/g, '').trim();
}

module.exports = {
  findRelevantData,   // now uses an in-memory index (built once)
  buildRAGContext,
  sanitizeLLMReply,
  normBase
};
