// rag.js — SQLite FTS5 (BM25) backed, low-memory
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const Database = require('better-sqlite3');

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
  // expects "DD/MM/YYYY"
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
  const first = isGzip ? '[' : firstNonWsChar(filePath);

  const rs = fs.createReadStream(filePath);
  const pipeline = [];
  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser());

  const rootIsArray = first === '[';
  pipeline.push(rootIsArray ? streamArray() : streamObject());

  return chain([rs, ...pipeline]);
}

/** =========================
 *  SQLite (FTS5) store
 *  ========================= */
const DB_PATH = path.join(process.cwd(), 'rag.sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

/* Base table with compact/denormalized fields only */
db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idx INTEGER NOT NULL,
  nb TEXT NOT NULL,
  provider_name TEXT,
  course_title TEXT,
  campus TEXT,
  mode TEXT,
  start_date TEXT,
  start_month TEXT,
  duration TEXT,
  qualification TEXT,
  academic_year TEXT,
  application_code TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_idx ON records(idx);
CREATE INDEX IF NOT EXISTS idx_records_fields ON records(provider_name, course_title, campus, mode, start_month, qualification, academic_year);
`);

/* FTS5 index on nb with external content = records */
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  nb,
  content='records',
  content_rowid='id',
  tokenize='unicode61'
);
`);

/* Keep FTS in sync via triggers (so we can rebuild or incremental insert) */
db.exec(`
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, nb) VALUES (new.id, new.nb);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, nb) VALUES('delete', old.id, old.nb);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, nb) VALUES('delete', old.id, old.nb);
  INSERT INTO records_fts(rowid, nb) VALUES (new.id, new.nb);
END;
`);

/** =========================
 *  Ingestion
 *  ========================= */
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
  const start_month = monthTokenFromDate(start_date_raw);
  const qualification = option?.outcomeQualification?.caption || '';

  const textBlob = [
    provider_name, provider_city, provider_country,
    course_title, academic_year, destination, application_code,
    study_mode, duration_unit, campus, start_date_raw, start_month, qualification,
    provider?.aboutUs, provider?.whatMakesUsDifferent,
    ...(Array.isArray(provider?.aliases) ? provider.aliases : [])
  ].filter(Boolean).join(' ');

  const nb = normBase(textBlob);

  const duration = (duration_qty != null && duration_unit)
    ? `${duration_qty} ${duration_unit}` : (duration_qty ?? '');

  // Keep ONLY compact denormalized fields in raw_json
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

  return {
    idx,
    nb,
    provider_name,
    course_title,
    campus,
    mode: study_mode,
    start_date: start_date_raw,
    start_month,
    duration,
    qualification,
    academic_year,
    application_code,
    raw_json: JSON.stringify(raw)
  };
}

let INDEX_READY_PROMISE = null;

async function buildIndex() {
  if (INDEX_READY_PROMISE) return INDEX_READY_PROMISE;

  INDEX_READY_PROMISE = (async () => {
    const existing = db.prepare('SELECT COUNT(1) AS c FROM records').get().c;
    if (existing > 0) return; // already ingested

    const insert = db.prepare(`
      INSERT INTO records (
        idx, nb, provider_name, course_title, campus, mode,
        start_date, start_month, duration, qualification,
        academic_year, application_code, raw_json
      ) VALUES (
        @idx, @nb, @provider_name, @course_title, @campus, @mode,
        @start_date, @start_month, @duration, @qualification,
        @academic_year, @application_code, @raw_json
      )
    `);

    const tx = db.transaction((rows) => {
      for (const r of rows) insert.run(r);
    });

    const stream = openRootStream(DATA_FILE);
    let idx = 0;
    const batch = [];
    const BATCH_SIZE = 200; // small batches keep peak memory tiny

    await new Promise((resolve, reject) => {
      stream.on('data', ({ value }) => {
        try {
          const provider = value;
          if (!provider || typeof provider !== 'object') return;

          const courses = Array.isArray(provider.courses) ? provider.courses : [];
          for (const course of courses) {
            const options = Array.isArray(course.options) ? course.options : [null];
            for (const option of options) {
              const rec = makeRecord(provider, course, option, idx++);
              if (!rec.nb) continue;
              batch.push(rec);
              if (batch.length >= BATCH_SIZE) {
                tx(batch.splice(0, batch.length));
              }
            }
          }
        } catch { /* skip malformed entry */ }
      });

      stream.on('end', () => {
        if (batch.length) tx(batch.splice(0, batch.length));
        resolve();
      });
      stream.on('error', reject);
    });

    // (Optional) Optimize FTS after load
    try {
      db.exec(`INSERT INTO records_fts(records_fts) VALUES('optimize')`);
    } catch { /* not critical */ }
  })();

  return INDEX_READY_PROMISE;
}

/** =========================
 *  Retrieval (FTS5 BM25)
 *  ========================= */
async function findRelevantData(query, opts = {}) {
  const { max = 100 } = opts;
  const q = normBase(query);
  if (!q) return [];

  await buildIndex();

  const terms = tokenize(q);
  if (!terms.length) return [];

  // Build a strict AND query for FTS (safer for precision).
  // Escape double quotes and wrap each token in quotes to avoid FTS operators injection.
  const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');

  const rows = db.prepare(
    `SELECT r.*
     FROM records r
     JOIN records_fts fts ON fts.rowid = r.id
     WHERE records_fts MATCH ?
     ORDER BY bm25(records_fts) ASC
     LIMIT ?`
  ).all(ftsQuery, Math.max(1, Math.min(1000, max)));

  // Map to your original record shape expected by queryDataset utilities
  return rows.map(r => {
    const raw = JSON.parse(r.raw_json);
    return {
      idx: r.idx,
      nb: r.nb,
      provider_name: r.provider_name,
      course_title: r.course_title,
      campus: r.campus,
      mode: r.mode,
      start_date: r.start_date,
      start_month: r.start_month,
      duration: r.duration,
      qualification: r.qualification,
      academic_year: r.academic_year,
      application_code: r.application_code,
      raw
    };
  });
}

/** =========================
 *  Lightweight analytics (unchanged)
 *  ========================= */
const NUMERIC_FIELD_CANDIDATES = [
  'tuition_fee','tuition','fee','fees','international_fee','home_fee',
  'price','cost','duration_qty','duration_months','duration_weeks','duration_years','duration'
];

function pickNumericField(rows, questionLower) {
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

  if (/\bonline|distance|remote\b/.test(s)) {
    filters.push(rec => /online|distance|remote/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }
  if (/\bfull[- ]?time|on[- ]?campus|in person\b/.test(s)) {
    filters.push(rec => /full.?time|on.?campus|in.?person/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }
  if (/\bpart[- ]?time\b/.test(s)) {
    filters.push(rec => /part.?time/.test((rec.raw?.study_mode || '').toString().toLowerCase()));
  }

  const month = (s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/) || [])[0];
  if (month) {
    const m3 = month.slice(0,3).toLowerCase();
    filters.push(rec => (rec.raw?.start_month || '').toLowerCase().startsWith(m3));
  }

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
    const start = r.raw?.start_date_raw || r.start_date || '';
    const mode = r.raw?.study_mode || r.mode || '';
    const campus = r.raw?.campus || r.campus || '';
    const qual = r.raw?.qualification || r.qualification || '';
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

/** =========================
 *  High-level query API (unchanged)
 *  ========================= */
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

/** Existing helpers for LLM context builds */
function buildRAGContext(records = []) {
  const lines = records.map((r, i) => {
    const title = r.course_title || r.raw?.course_title || 'Course';
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
