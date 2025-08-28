// rag.js
const fs = require('fs');
const zlib = require('zlib');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { streamObject } = require('stream-json/streamers/StreamObject');
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
  return nb ? nb.split(' ').filter(t => t && t.length >= 2) : [];
}

// Light stopwords; keep queries focused
const STOPWORDS = new Set([
  'suggest','suggestion','suggestions','course','courses','on','in','for','about','of','and','or',
  'please','plz','a','an','the','me','need','want','looking','search','find','give','recommend',
  'program','programme','degree'
]);

// Short aliases → subject terms
const SUBJECT_ALIASES = {
  cs: ['computer','science','computer science','computing'],
  cse: ['computer','science','engineering','computer science'],
  ai: ['artificial','intelligence','artificial intelligence'],
  ml: ['machine','learning','machine learning'],
  ds: ['data','science','data science','analytics'],
  se: ['software','engineering','software engineering'],
  it: ['information','technology','information technology','computing'],
  ee: ['electrical','engineering'],
  eee: ['electrical','electronic','electrical and electronic'],
  ece: ['electronics','communication','electronics and communication'],
  cyber: ['cyber','security','cyber security','cybersecurity'],
  hci: ['human','computer','interaction','human computer interaction'],
  fintech: ['financial','technology','financial technology'],
  'comp sci': ['computer','science','computer science']
};

function expandQuery(query) {
  const q = normBase(query);
  let tokens = q.split(' ').filter(Boolean).filter(t => !STOPWORDS.has(t));
  const extra = [];
  for (const t of tokens) {
    const alias = SUBJECT_ALIASES[t];
    if (alias) {
      for (const a of alias) extra.push(...a.split(' ').filter(x => x && x.length >= 2));
    }
  }
  const out = [];
  const seen = new Set();
  for (const t of [...tokens, ...extra]) {
    if (t.length < 2) continue;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** =========================
 *  Streaming JSON
 *  =========================
 *  Your file is a TOP-LEVEL OBJECT of providers. Each provider has courses[], each course has options[].
 *  We also retain support for a top-level ARRAY by auto-detecting the first structural token.
 */
function openJsonStreamFlexible(filePath) {
  const isGzip = filePath.toLowerCase().endsWith('.gz');
  const rs = fs.createReadStream(filePath);
  const pipeline = [];
  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser({ jsonStreaming: true }));
  // We will detect array vs object when building index and re-pipe accordingly.
  return chain([rs, ...pipeline]);
}

/** =========================
 *  In-Memory Index
 *  =========================
 *  POSTINGS: Map<string, number[]>        // term -> sorted list of docIDs
 *  RECORDS:  Array<{ idx, nb, provider_name, course_title, mode, duration, campus, start_date }>
 */
let INDEX_READY_PROMISE = null;
let POSTINGS = null;
let RECORDS = null;

// Small LRU for query -> result caching (by expanded tokens)
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
 * Flatten one provider object → multiple course-option records.
 */
function* flattenProvider(provider) {
  const pname = provider?.name || '';
  const pcode = provider?.institutionCode || '';
  const palias = Array.isArray(provider?.aliases) ? provider.aliases.join(' ') : '';
  const paddrTown = provider?.address?.line4 || '';
  const paddrCountry = provider?.address?.country?.mappedCaption || '';
  const psite = provider?.websiteUrl || '';

  const courses = Array.isArray(provider?.courses) ? provider.courses : [];
  for (const course of courses) {
    const ctitle = course?.courseTitle || '';
    const ccode = course?.applicationCode || '';
    const cdest = course?.routingData?.destination?.caption || '';

    const options = Array.isArray(course?.options) ? course.options : [];
    for (const opt of options) {
      const mode = opt?.studyMode?.mappedCaption || opt?.studyMode?.caption || '';
      const durationQty = opt?.duration?.quantity;
      const durationCap = opt?.duration?.durationType?.caption;
      const duration = (durationQty && durationCap) ? `${durationQty} ${durationCap}` : '';
      const campus = opt?.location?.name || '';
      const start_date = opt?.startDate?.date || '';
      const outcome = opt?.outcomeQualification?.caption || '';

      // Build normalized blob for indexing
      const nbParts = [
        pname, pcode, palias, paddrTown, paddrCountry, psite,
        ctitle, ccode, cdest,
        mode, duration, campus, start_date, outcome
      ];
      const nb = normBase(nbParts.filter(Boolean).join(' '));
      if (!nb) continue;

      yield {
        provider_name: pname,
        course_title: ctitle,
        mode,
        duration,
        campus,
        start_date,
        nb
      };
    }
  }
}

/**
 * Build the index exactly once by streaming the dataset.
 * Auto-detects top-level OBJECT vs ARRAY and streams accordingly.
 */
async function buildIndex() {
  if (INDEX_READY_PROMISE) return INDEX_READY_PROMISE;

  INDEX_READY_PROMISE = (async () => {
    POSTINGS = new Map();
    RECORDS = [];

    // First pass: detect whether top-level is array or object
    const peek = openJsonStreamFlexible(DATA_FILE);
    let topType = null; // 'array' | 'object'
    await new Promise((resolve, reject) => {
      peek.once('data', (token) => {
        // token.value contains tokens; easier: inspect token.name
        // But parser emits a stream of tokens; we need to determine the first start token
        // We'll look for the first token with "name" startArray or startObject
        if (token?.name === 'startArray') topType = 'array';
        else if (token?.name === 'startObject') topType = 'object';
        resolve();
      });
      peek.once('error', reject);
      // If the file is small, add fallback timeout
      setTimeout(() => resolve(), 50);
    });

    // Now build a proper stream pipeline for the detected structure
    const isGzip = DATA_FILE.toLowerCase().endsWith('.gz');
    const rs = fs.createReadStream(DATA_FILE);
    const pipeline = [];
    if (isGzip) pipeline.push(zlib.createGunzip());
    pipeline.push(parser());

    if (topType === 'array') {
      pipeline.push(streamArray());
      const stream = chain([rs, ...pipeline]);
      let idx = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', ({ value }) => {
          try {
            // If array items are providers (unlikely for your file), support both cases:
            // 1) provider object with courses[]
            // 2) already flattened course record
            if (value && value.courses) {
              for (const rec of flattenProvider(value)) {
                const withIdx = { ...rec, idx };
                RECORDS.push(withIdx);
                indexRecord(withIdx);
                idx++;
              }
            } else {
              // If it’s already a flat record (provider_name, course_title, etc.)
              const nb = normBase(Object.values(value || {}).join(' '));
              if (!nb) return;
              const withIdx = { ...value, nb, idx };
              RECORDS.push(withIdx);
              indexRecord(withIdx);
              idx++;
            }
          } catch {
            idx++;
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    } else {
      // Default: top-level OBJECT of providers (your case)
      const { streamObject } = require('stream-json/streamers/StreamObject');
      pipeline.push(streamObject());
      const stream = chain([rs, ...pipeline]);
      let idx = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', ({ key, value }) => {
          try {
            // key is provider id; value is the provider object
            for (const rec of flattenProvider(value)) {
              const withIdx = { ...rec, idx };
              RECORDS.push(withIdx);
              indexRecord(withIdx);
              idx++;
            }
          } catch {
            idx++;
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }
  })();

  return INDEX_READY_PROMISE;
}

function indexRecord(rec) {
  // Tokenize doc text; add synonym triggers if phrases present
  const terms = new Set(tokenize(rec.nb));

  // Phrase-based short tags → postings enrichment
  if (rec.nb.includes('computer science')) terms.add('cs');
  if (rec.nb.includes('artificial intelligence')) terms.add('ai');
  if (rec.nb.includes('data science')) terms.add('ds');
  if (rec.nb.includes('software engineering')) terms.add('se');
  if (rec.nb.includes('information technology')) terms.add('it');
  if (rec.nb.includes('machine learning')) terms.add('ml');
  if (rec.nb.includes('electrical and electronic')) terms.add('eee');
  if (rec.nb.includes('electrical engineering')) terms.add('ee');
  if (rec.nb.includes('electronics and communication')) terms.add('ece');
  if (rec.nb.includes('cyber security') || rec.nb.includes('cybersecurity')) terms.add('cyber');

  for (const t of terms) {
    let list = POSTINGS.get(t);
    if (!list) { list = []; POSTINGS.set(t, list); }
    list.push(rec.idx);
  }
}

/** =========================
 *  Query using the index
 *  ========================= */
function scoreDocByHits(doc, terms) {
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
  await buildIndex();

  const expandedTokens = expandQuery(query);
  if (!expandedTokens.length) return [];

  const cacheKey = expandedTokens.join(' ');
  const cached = lruGet(cacheKey);
  if (cached) return cached.slice(0, max);

  const candidateCounts = new Map();
  for (const t of expandedTokens) {
    const posting = POSTINGS.get(t);
    if (!posting) continue;
    for (let i = 0; i < posting.length; i++) {
      const docId = posting[i];
      candidateCounts.set(docId, (candidateCounts.get(docId) || 0) + 1);
    }
  }
  if (candidateCounts.size === 0) return [];

  const candidates = [];
  for (const docId of candidateCounts.keys()) {
    const doc = RECORDS[docId];
    if (doc) candidates.push(doc);
  }

  const scored = candidates.map(doc => ({ score: scoreDocByHits(doc, expandedTokens), doc }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, max).map(({ doc }) => {
    const { nb, ...rest } = doc;
    return rest;
  });

  lruSet(cacheKey, top);
  return top;
}

/** =========================
 *  (Optional) Context builder & cleaner
 *  ========================= */
function buildRAGContext(records = []) {
  const lines = records.map((r, i) => {
    const title = r.course_title || r.title || 'Course';
    const provider = r.provider_name || r.provider || '';
    const mode = r.mode || '';
    const duration = r.duration || '';
    const campus = r.campus || '';
    const start = r.start_date || r.start || '';
    return [
      `#${i + 1} ${title}${provider ? ` – ${provider}` : ''}`,
      mode ? `Mode: ${mode}` : null,
      duration ? `Duration: ${duration}` : null,
      campus ? `Campus: ${campus}` : null,
      start ? `Start: ${start}` : null,
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
