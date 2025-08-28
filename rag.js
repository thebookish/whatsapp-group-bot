const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { DATA_FILE } = require('./config');

/**
 * Normalize text for cheap scoring
 */
function normBase(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Open a readable stream for JSON array file (supports .json or .json.gz)
 * The file is expected to be a top-level JSON array of course/provider objects.
 */
function openJsonArrayStream(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = ext === '.gz' ? path.basename(filePath, ext) : path.basename(filePath);
  const isGzip = filePath.endsWith('.gz');

  const rs = fs.createReadStream(filePath);
  const pipeline = [];

  if (isGzip) pipeline.push(zlib.createGunzip());
  pipeline.push(parser());        // parse tokens
  pipeline.push(streamArray());   // iterate over array items

  return chain([rs, ...pipeline]);
}

/**
 * Stream through the dataset and collect top matches by a trivial score.
 * This avoids loading the entire file into memory.
 */
async function findRelevantData(query, opts = {}) {
  const { max = 20 } = opts;
  const q = normBase(query);
  if (!q) return [];

  const terms = q.split(' ').filter(Boolean);
  const scores = [];
  const stream = openJsonArrayStream(DATA_FILE);

  // NOTE: Adjust these keys to whatever fields exist in your dataset
  const TEXT_FIELDS = ['course_title', 'provider_name', 'subject', 'campus', 'mode', 'summary', 'description'];

  return await new Promise((resolve, reject) => {
    stream.on('data', ({ value }) => {
      try {
        // value = one record from the array
        const blob = TEXT_FIELDS.map(k => value?.[k] ?? '').join(' ');
        const nb = normBase(blob);
        if (!nb) return;

        // simple score = #term hits
        let score = 0;
        for (const t of terms) {
          if (t.length < 2) continue;
          const hits = nb.split(t).length - 1;
          score += hits;
        }
        if (score > 0) {
          // Keep a small top list in memory
          scores.push({ score, item: value });
          if (scores.length > max * 5) {
            scores.sort((a, b) => b.score - a.score);
            scores.length = max * 3; // prune aggressively
          }
        }
      } catch {
        // ignore bad rows
      }
    });

    stream.on('end', () => {
      scores.sort((a, b) => b.score - a.score);
      const top = scores.slice(0, max).map(x => x.item);
      resolve(top);
    });

    stream.on('error', reject);
  });
}

/**
 * Build a small text context for the LLM from the retrieved records.
 * Only include fields you really need to keep tokens down.
 */
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

/**
 * Optional: clean up reply text (you already had something like this)
 */
function sanitizeLLMReply(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\s+$/g, '').trim();
}

module.exports = {
  findRelevantData,   // now ASYNC
  buildRAGContext,
  sanitizeLLMReply,
  normBase
};
