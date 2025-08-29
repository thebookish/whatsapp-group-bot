// rag.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
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
  if (!nb) return [];
  return nb.split(' ').filter(t => t && t.length >= 2);
}
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function tryParseNumber(v) {
  if (isNumber(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/[,£$]/g, '').match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return NaN;
}
function firstNonWsChar(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const read = fs.readSync(fd, buf, 0, 1024, 0);
    const s = buf.slice(0, read).toString('utf8');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!/\s/.test(c)) return c;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
function monthTokenFromDate(dmy) {
  // expects "DD/MM/YYYY" like "15/09/2025"
  if (!dmy || typeof dmy !== 'string') return '';
  const m = dmy.split('/')[1];
  if (!m) return '';
  const n = Number(m);
  const names = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return names[(n - 1) | 0] || '';
}

/** =========================
 *  Streaming JSON (array or object root)
 *  ========================= */
function openRootStream(filePath) {
  const isGzip = filePath.endsWith('.gz');
  const first = isGzip ? '[' : firstNonWsChar(filePath); // if gz, we can’t peek easily; assume array/object not known → parser+object streamer works either way when chained correctly

  const rs = fs.createReadStream(filePath);
  const pipeline = [];
  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser());

  // If root is an array: use streamArray; if '{': use streamObject; if unknown, default to object.
  const rootIsArray = first === '[';
  pipeline.push(rootIsArray ? streamArray() : streamObject());

  return chain([rs, ...pipeline]);
}

/** =========================
 *  In-Memory Index
 *  =========================
 *  POSTINGS: Map<string, number[]>        // term -> sorted list of docIDs
 *  RECORDS: Array<{ idx:number, nb:string, ...slim, raw:any }>
 */
let INDEX_READY_PROMISE = null;
let POSTINGS = null;
let RECORDS = null;

const QUERY_CACHE = new Map();
const QUERY_CACHE_MAX = 200;
function lruGet(key) {
  if (!QUERY_CACHE.has(key)) return undefined;
  const val = QUERY_CACHE.get(key);
  QUERY_CACHE.delete(key); QUERY_CACHE.set(key, val);
  return val;
}
function lruSet(key, val) {
  QUERY_CACHE.set(key, val);
  if (QUERY_CACHE.size > QUERY_CACHE_MAX) {
    const firstKey = QUERY_CACHE.keys().next().value;
    QUERY_CACHE.delete(firstKey);
  }
}

/** Flatten provider → course → option into a single record */
 function makeRecord(provider, course, option, idx) {
   const provider_name = provider?.name || provider?.aliasName || '';
   const provider_city = provider?.address?.line4 || '';
   const provider_country = provider?.address?.country?.mappedCaption || '';
   const course_title = course?.courseTitle || '';
   const academic_year = course?.academicYearId || '';
   const destination = course?.routingData?.destination?.caption || '';
   const application_code = course?.applicationCode || '';
   const study_mode = option?.studyMode?.mappedCaption || option?.studyMode?.caption || '';
   const duration_qty = option?.duration?.quantity ?? null;
   const duration_unit = option?.duration?.durationType?.caption || '';
   const campus = option?.location?.name || '';
   const start_date_raw = option?.startDate?.date || '';
   const start_month = monthTokenFromDate(start_date_raw); // e.g., 'sep'
   const qualification = option?.outcomeQualification?.caption || '';

   // Build a text blob for indexing/search
   const textBlob = [
     provider_name, provider_city, provider_country,
     course_title, academic_year, destination, application_code,
     study_mode, duration_unit, campus, start_date_raw, start_month, qualification,
     provider?.aboutUs, provider?.whatMakesUsDifferent,
     ...(Array.isArray(provider?.aliases) ? provider.aliases : [])
   ].filter(Boolean).join(' ');

   const nb = normBase(textBlob);

   const slim = {
     idx,
     nb,
     provider_name,
     course_title,
     campus,
     mode: study_mode,
     start_date: start_date_raw,
     start_month,
     duration: duration_qty != null && duration_unit ? `${duration_qty} ${duration_unit}` : (duration_qty ?? ''),
     qualification,
     academic_year,
     application_code,
   };

  // Keep ONLY the small denormalized fields you actually use elsewhere.
  const raw = {
    provider_name,
    provider_city,
    provider_country,
    course_title,
    academic_year,
    destination,
    application_code,
    study_mode,
    duration_qty,
    duration_unit,
    campus,
    start_date_raw,
    start_month,
    qualification,
  };

   return { ...slim, raw };
 }


/** Build the index once */
async function buildIndex() {
  if (INDEX_READY_PROMISE) return INDEX_READY_PROMISE;
  INDEX_READY_PROMISE = (async () => {
    POSTINGS = new Map();
    RECORDS = [];

    const stream = openRootStream(DATA_FILE);
    let idx = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', ({ value }) => {
        try {
          // When streaming an object with streamObject, "value" is the provider object.
          // When streaming an array with streamArray, "value" is the entry itself.
          const provider = value;

          if (!provider || typeof provider !== 'object') return;

          const courses = Array.isArray(provider.courses) ? provider.courses : [];
          for (const course of courses) {
            const options = Array.isArray(course.options) ? course.options : [null];
            for (const option of options) {
              const rec = makeRecord(provider, course, option, idx);
              if (!rec.nb) { idx++; continue; }

              // store
              RECORDS.push(rec);

              // index postings (unique terms per doc)
              const terms = new Set(tokenize(rec.nb));
              for (const t of terms) {
                let list = POSTINGS.get(t);
                if (!list) { list = []; POSTINGS.set(t, list); }
                list.push(idx);
              }
              idx++;
            }
          }
        } catch {
          // ignore malformed provider entry, continue
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  })();

  return INDEX_READY_PROMISE;
}

/** Scoring */
function scoreDocByHits(doc, terms) {
  let score = 0;
  const nb = doc.nb || '';
  for (const t of terms) {
    if (t.length < 2) continue;
    const hits = nb.split(t).length - 1;
    score += hits;
  }
  return score;
}

/** Retrieve top records */
async function findRelevantData(query, opts = {}) {
  const { max = 100 } = opts;
  const q = normBase(query);
  if (!q) return [];

  await buildIndex();

  const cached = lruGet(q);
  if (cached) return cached.slice(0, max);

  const terms = tokenize(q);
  if (!terms.length) return [];

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

  const candidates = [];
  for (const docId of candidateCounts.keys()) {
    const doc = RECORDS[docId];
    if (doc) candidates.push(doc);
  }

  const scored = candidates.map(doc => ({ score: scoreDocByHits(doc, terms), doc }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max).map(({ doc }) => doc);

  lruSet(q, top);
  return top;
}

/** =========================
 *  Lightweight analytics
 *  ========================= */
const NUMERIC_FIELD_CANDIDATES = [
  'tuition_fee','tuition','fee','fees','international_fee','home_fee',
  'price','cost','duration_qty','duration_months','duration_weeks','duration_years','duration'
];

function pickNumericField(rows, questionLower) {
  // hint via question
  const hintPairs = [
    [/tuition|fee|fees|cost|price/, ['international_fee','tuition_fee','home_fee','tuition','fees','price','cost']],
    [/duration|length|years|months|weeks/, ['duration_qty','duration_months','duration_weeks','duration_years','duration']]
  ];
  for (const [re, prefs] of hintPairs) {
    if (re.test(questionLower)) {
      const f = prefs.find(k => rows.some(r => !Number.isNaN(tryParseNumber(r.raw?.[k]))));
      if (f) return f;
    }
  }
  // else first available
  return NUMERIC_FIELD_CANDIDATES.find(k => rows.some(r => !Number.isNaN(tryParseNumber(r.raw?.[k]))));
}

function detectIntent(q) {
  const s = q.toLowerCase();
  if (/\b(how many|count|number of)\b/.test(s)) return 'COUNT';
  if (/\b(average|avg|mean)\b/.test(s)) return 'AVG';
  if (/\b(min|minimum|cheapest|lowest|least)\b/.test(s)) return 'MIN';
  if (/\b(max|maximum|most expensive|highest|largest)\b/.test(s)) return 'MAX';
  return 'LIST';
}

function buildFilters(q) {
  const s = q.toLowerCase();
  const filters = [];

  // keyword tail: "... in/for/on X"
  const tail = s.match(/\b(?:in|on|for)\s+([a-z0-9 \-&\/]{3,})$/i);
  if (tail && tail[1]) {
    const subj = tail[1].trim();
    filters.push(rec => {
      const hay = [
        rec.raw?.course_title, rec.raw?.destination, rec.raw?.qualification,
        rec.raw?.provider_name, rec.raw?.provider_city, rec.raw?.provider_country,
        rec.raw?.campus
      ].map(x => (x || '').toString().toLowerCase()).join(' | ');
      return hay.includes(subj);
    });
  }

  // common UK cities; feel free to expand
  const locationWords = ['london','manchester','birmingham','leeds','sheffield','edinburgh','glasgow','oxford','cambridge','bristol','cardiff','liverpool','nottingham','newcastle','bath','brighton','coventry','york','aberdeen','hornchurch','havering','redbridge','hackney','rainham'];
  for (const w of locationWords) {
    if (s.includes(w)) {
      filters.push(rec => {
        const hay = [
          rec.raw?.provider_city, rec.raw?.campus, rec.raw?.provider_name
        ].map(x => (x || '').toString().toLowerCase()).join(' | ');
        return hay.includes(w);
      });
    }
  }

  // mode
  if (/\bonline|distance|remote\b/.test(s)) {
    filters.push(rec => /online|distance|remote/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }
  if (/\bfull[- ]?time|on[- ]?campus|in person\b/.test(s)) {
    filters.push(rec => /full.?time|on.?campus|in.?person/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }
  if (/\bpart[- ]?time\b/.test(s)) {
    filters.push(rec => /part.?time/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }

  // start month word
  const month = (s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/) || [])[0];
  if (month) {
    const m3 = month.slice(0,3).toLowerCase();
    filters.push(rec => (rec.raw?.start_month || '').toLowerCase().startsWith(m3));
  }

  // level keywords
  if (/\bpostgraduate|pg|pgce\b/.test(s)) {
    filters.push(rec => /(postgraduate|pgce)/.test((rec.raw?.destination || rec.raw?.qualification || '').toString().toLowerCase()));
  }
  if (/\bundergraduate|ug|bachelor|ba|bsc|hnd|hnc\b/.test(s)) {
    filters.push(rec => /(undergraduate|bachelor|ba|bsc|hnd|hnc)/.test((rec.raw?.destination || rec.raw?.qualification || '').toString().toLowerCase()));
  }

  return filters;
}

function applyFilters(rows, filters) {
  if (!filters.length) return rows;
  return rows.filter(r => filters.every(fn => fn(r)));
}

function summarizeRows(rows, limit = 10) {
  const lines = [];
  for (const r of rows.slice(0, limit)) {
    const uni = r.raw?.provider_name || '';
    const title = r.raw?.course_title || '';
    const start = r.raw?.start_date_raw || '';
    const mode = r.raw?.study_mode || '';
    const campus = r.raw?.campus || '';
    const qual = r.raw?.qualification || '';
    lines.push(
      [uni && title ? `${uni} — ${title}` : (title || uni || 'Course'),
       qual ? `(${qual})` : null,
       start ? `Start: ${start}` : null,
       mode ? `Mode: ${mode}` : null,
       campus ? `Campus: ${campus}` : null
      ].filter(Boolean).join(' | ')
    );
  }
  return lines.join('\n');
}

/** Main high-level query over dataset */
async function queryDataset(question, opts = {}) {
  const retrieved = await findRelevantData(question, { max: opts.max || 200 });
  if (!retrieved.length) return { intent: 'LIST', count: 0, rows: [], text: 'Not found in dataset.' };

  const filters = buildFilters(question);
  const filtered = applyFilters(retrieved, filters);

  const intent = detectIntent(question);
  if (intent === 'COUNT') {
    return { intent, count: filtered.length, rows: filtered, text: `Found ${filtered.length}.` };
  }

  if (intent === 'AVG' || intent === 'MIN' || intent === 'MAX') {
    const field = pickNumericField(filtered, question.toLowerCase());
    if (!field) {
      return { intent: 'LIST', rows: filtered, text: summarizeRows(filtered) };
    }
    const nums = filtered
      .map(r => ({ rec: r, val: tryParseNumber(r.raw?.[field]) }))
      .filter(x => !Number.isNaN(x.val));

    if (!nums.length) {
      return { intent: 'LIST', rows: filtered, text: summarizeRows(filtered) };
    }

    if (intent === 'AVG') {
      const avg = nums.reduce((a,b)=>a+b.val,0) / nums.length;
      return { intent, fieldUsed: field, value: Math.round(avg), rows: filtered, text: `Average ${field.replace(/_/g,' ')} ≈ ${Math.round(avg)}.` };
    }
    if (intent === 'MIN') {
      let best = nums[0];
      for (const n of nums) if (n.val < best.val) best = n;
      return {
        intent, fieldUsed: field, value: best.val, rows: filtered,
        text: `Lowest ${field.replace(/_/g,' ')}: ${best.val} — ${best.rec.raw?.provider_name || ''} — ${best.rec.raw?.course_title || ''}`
      };
    }
    if (intent === 'MAX') {
      let best = nums[0];
      for (const n of nums) if (n.val > best.val) best = n;
      return {
        intent, fieldUsed: field, value: best.val, rows: filtered,
        text: `Highest ${field.replace(/_/g,' ')}: ${best.val} — ${best.rec.raw?.provider_name || ''} — ${best.rec.raw?.course_title || ''}`
      };
    }
  }

  return { intent: 'LIST', rows: filtered, text: summarizeRows(filtered) };
}

/** Existing helpers for LLM context builds (still useful) */
function buildRAGContext(records = []) {
  const lines = records.map((r, i) => {
    const title = r.course_title || r.raw?.course_title || r.raw?.course?.courseTitle || 'Course';
    const provider = r.provider_name || r.raw?.provider_name || '';
    const mode = r.mode || r.raw?.study_mode || '';
    const duration = r.duration || (r.raw?.duration_qty != null ? `${r.raw.duration_qty} ${r.raw.duration_unit||''}`.trim() : '');
    const campus = r.campus || r.raw?.campus || '';
    const start = r.start_date || r.raw?.start_date_raw || '';
    const qual = r.raw?.qualification || '';
    const app = r.application_code || r.raw?.application_code || '';
    return [
      `#${i + 1} ${title}${provider ? ` – ${provider}` : ''}`,
      qual ? `Qualification: ${qual}` : null,
      mode ? `Mode: ${mode}` : null,
      duration ? `Duration: ${duration}` : null,
      campus ? `Campus: ${campus}` : null,
      start ? `Start: ${start}` : null,
      app ? `Application: ${app}` : null,
    ].filter(Boolean).join(' | ');
  });
  return lines.join('\n');
}
function sanitizeLLMReply(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\s+$/g, '').trim();
}

module.exports = {
  // search & analytics
  findRelevantData,
  queryDataset,

  // utils
  buildRAGContext,
  sanitizeLLMReply,
  normBase
};
