// rag.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { pick } = require('stream-json/filters/Pick');
const { DATA_FILE, DATA_ARRAY_KEY } = require('./config');

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
  return nb ? nb.split(' ').filter(t => t && t.length >= 2) : [];
}

/** Fields to search across (align with your dataset) */
const TEXT_FIELDS = ['course_title', 'provider_name', 'subject', 'campus', 'mode', 'summary', 'description'];
/** Fields to keep for building responses (lean footprint) */
const SLIM_FIELDS = [
  'course_title', 'provider_name', 'mode', 'duration', 'campus',
  'start_date', 'ucas', 'ucas_code', 'title', 'provider', 'start'
];

/** =========================
 *  Stream a JSON array
 *  =========================
 *  Supports:
 *   - Top-level array: [ {...}, {...} ]
 *   - Object with array at a known key: { "records": [ ... ] }
 */
function openJsonArrayStream(filePath, arrayKey) {
  const isGzip = filePath.toLowerCase().endsWith('.gz');
  const rs = fs.createReadStream(filePath);
  const pipeline = [];

  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser());

  if (arrayKey && typeof arrayKey === 'string' && arrayKey.trim()) {
    // Dive into the object key that holds the array
    pipeline.push(pick({ filter: arrayKey }));
  }
  // Now we should be positioned at the array to stream its items
  pipeline.push(streamArray());

  return chain([rs, ...pipeline]);
}

/** =========================
 *  In-Memory Index
 *  =========================
 *  POSTINGS: Map<string, number[]>         // term -> docIDs
 *  RECORDS: Array<{ idx:number, nb:string, ...slim }>
 */
let INDEX_READY_PROMISE = null;
let POSTINGS = null;
let RECORDS = null;

// Tiny LRU for normalized query → results
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
 * Build the inverted index once by streaming the dataset.
 * Works for top-level arrays or arrays under DATA_ARRAY_KEY.
 */
async function buildIndex() {
  if (INDEX_READY_PROMISE) return INDEX_READY_PROMISE;

  INDEX_READY_PROMISE = (async () => {
    POSTINGS = new Map();
    RECORDS = [];

    const stream = openJsonArrayStream(DATA_FILE, DATA_ARRAY_KEY);
    let idx = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', ({ value }) => {
        try {
          const blob = TEXT_FIELDS.map(k => value?.[k] ?? '').join(' ');
          const nb = normBase(blob);
          if (!nb) { idx++; return; }

          const slim = {};
          for (const f of SLIM_FIELDS) if (value?.[f] != null) slim[f] = value[f];
          slim.idx = idx;
          slim.nb = nb;

          RECORDS.push(slim);

          const terms = new Set(tokenize(nb));
          for (const t of terms) {
            let list = POSTINGS.get(t);
            if (!list) { list = []; POSTINGS.set(t, list); }
            list.push(idx);
          }
          idx++;
        } catch {
          idx++; // skip malformed row, keep index advancing
        }
      });

      stream.on('end', resolve);
      stream.on('error', (err) => {
        // Helpful hint when top-level isn't an array and no key provided
        if (!DATA_ARRAY_KEY) {
          reject(new Error(
            `Failed to stream JSON array. If your file is an object like { "records": [...] }, set DATA_ARRAY_KEY="records". Original: ${err.message}`
          ));
        } else {
          reject(err);
        }
      });
    });
  })();

  return INDEX_READY_PROMISE;
}

function scoreDocByHits(doc, terms) {
  let score = 0;
  const nb = doc.nb;
  for (const t of terms) {
    if (t.length < 2) continue;
    const hits = nb.split(t).length - 1; // fast substring count
    score += hits;
  }
  return score;
}

/**
 * Indexed retrieval (no full file rescans on each query).
 */
async function findRelevantData(query, opts = {}) {
  const { max = 20 } = opts;
  const q = normBase(query);
  if (!q) return [];

  await buildIndex();

  const cached = lruGet(q);
  if (cached) return cached.slice(0, max);

  const terms = tokenize(q);
  if (!terms.length) return [];

  // Collect candidate doc IDs from postings (union)
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

  // Materialize candidates and score
  const candidates = [];
  for (const docId of candidateCounts.keys()) {
    const doc = RECORDS[docId];
    if (doc) candidates.push(doc);
  }

  const scored = candidates.map(doc => ({ score: scoreDocByHits(doc, terms), doc }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, max).map(({ doc }) => {
    const { nb, ...rest } = doc; // strip search blob
    return rest;
  });

  lruSet(q, top);
  return top;
}

/** =========================
 *  Context Builder & Cleaner
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
  findRelevantData,
  buildRAGContext,
  sanitizeLLMReply,
  normBase
};
