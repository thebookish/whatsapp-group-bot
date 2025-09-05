// rag.js
const { queryCourses } = require('./vectorstore');

/** Helpers (simplified, keep from old rag.js if needed) */
function sanitizeLLMReply(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim();
}

function summarizeRows(rows, limit = 10) {
  return rows.slice(0, limit).map(r => {
    const m = JSON.parse(r.metadata || '{}');
    return [
      r.title || 'Course',
      r.qualification ? `(${r.qualification})` : null,
      m.applicationCode ? `Code: ${m.applicationCode}` : null,
      r.campus ? `Campus: ${r.campus}` : null,
      r.start_date ? `Start: ${r.start_date}` : null
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

function buildRAGContext(records = []) {
  return records.map((r, i) => {
    const m = JSON.parse(r.metadata || '{}');
    return [
      `#${i + 1} ${r.title || 'Course'}`,
      r.qualification ? `Qualification: ${r.qualification}` : null,
      m.applicationCode ? `Code: ${m.applicationCode}` : null,
      r.campus ? `Campus: ${r.campus}` : null,
      r.start_date ? `Start: ${r.start_date}` : null
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

/** Main query interface (same signature as before) */
async function queryDataset(question, opts = {}) {
  const rows = await queryCourses(question, opts.max || 20);
  if (!rows.length) {
    return { intent: 'LIST', rows: [], count: 0, text: 'No matches found.' };
  }
  return { intent: 'LIST', rows, count: rows.length, text: summarizeRows(rows, 5) };
}

module.exports = {
  queryDataset,
  buildRAGContext,
  sanitizeLLMReply
};
