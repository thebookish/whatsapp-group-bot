const { supabase } = require("./config");
const { getEmbeddingsBatch } = require("./vectorstore"); // now powered by OpenAI

/** =========================
 *  Helpers
 *  ========================= */
function normBase(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tryParseNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.replace(/[,£$]/g, "").match(/-?\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return NaN;
}

/** =========================
 *  Intent + Filters
 *  ========================= */
function detectIntent(q) {
  const s = q.toLowerCase();
  if (/\b(how many|count|number of)\b/.test(s)) return "COUNT";
  if (/\b(average|avg|mean)\b/.test(s)) return "AVG";
  if (/\b(min|minimum|cheapest|lowest|least)\b/.test(s)) return "MIN";
  if (/\b(max|maximum|most expensive|highest|largest)\b/.test(s)) return "MAX";
  return "LIST";
}

const COURSE_HINTS = [
  "course","degree","programme","program","uni","university","college","campus","module","intake","start","application","code",
  "undergraduate","postgraduate","bachelor","masters","master","phd","mba","msc","ma","ba","bsc","beng","pg","pgce","diploma","hnd","hnc"
];

function isCourseLike(query) {
  const s = normBase(query);
  if (COURSE_HINTS.some((k) => s.includes(k))) return true;
  if (/\b(bsc|ba|msc|ma|mba|phd)\b/.test(s)) return true;
  if (/\b(course|degree|program(me)?)\b/.test(s)) return true;
  if (/\b(computer science|data science|engineering|business|law|medicine|nursing|psychology|accounting|finance)\b.*\b(course|degree|msc|bsc|ba)\b/.test(s)) return true;
  return false;
}

/** =========================
 *  Query Supabase vector store
 *  ========================= */
async function querySupabaseCourses(question, k = 50) {
  const vectors = await getEmbeddingsBatch([question]);
  const queryVec = vectors[0];
  if (!queryVec?.length) return [];

  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: queryVec,
    match_count: k,
  });

  if (error) {
    console.error("Supabase match_courses error:", error);
    return [];
  }
  return data || [];
}

/** =========================
 *  Summaries + Context
 *  ========================= */
function summarizeRows(rows, limit = 10) {
  return rows
    .slice(0, limit)
    .map((r) => {
      const title = r.title || "";
      const qual = r.qualification || "";
      const campus = r.campus || "";
      const start = r.start_date || "";
      const app = r.metadata?.applicationCode || "";
      const provider = r.metadata?.provider || "";
      return [
        title || "Course",
        qual ? `(${qual})` : null,
        campus ? `Campus: ${campus}` : null,
        start ? `Start: ${start}` : null,
        app ? `Code: ${app}` : null,
        provider ? `Provider: ${provider}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

function buildRAGContext(records = []) {
  return records
    .map((r, i) => {
      return [
        `#${i + 1} ${r.title || "Course"}`,
        r.qualification ? `Qualification: ${r.qualification}` : null,
        r.start_date ? `Start: ${r.start_date}` : null,
        r.metadata?.applicationCode ? `Code: ${r.metadata.applicationCode}` : null,
        r.campus ? `Campus: ${r.campus}` : null,
        r.metadata?.provider ? `Provider: ${r.metadata.provider}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

function sanitizeLLMReply(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/\s+$/g, "").trim();
}

/** =========================
 *  Main high-level query
 *  ========================= */
async function queryDataset(question, opts = {}) {
  const courseQuery = isCourseLike(question);
  if (!courseQuery) {
    return {
      intent: "GENERAL",
      rows: [],
      count: 0,
      text:
        "I can help with courses, universities, or intakes. Ask away—or tell me your subject and level (UG/PG)!",
    };
  }

  let rows = await querySupabaseCourses(question, opts.max || 50);

  // ✅ Fallback: simplify query if no results
  if (!rows.length) {
    const simpler = question.replace(/\bin\s+[A-Za-z\s]+$/i, "").trim();
    if (simpler !== question) {
      rows = await querySupabaseCourses(simpler, opts.max || 50);
    }
  }

  if (!rows.length) {
    return { intent: "LIST", count: 0, rows: [], text: "No matches found in dataset." };
  }

  const intent = detectIntent(question);

  if (intent === "COUNT") {
    return { intent, count: rows.length, rows, text: `Found ${rows.length} courses.` };
  }

  if (intent === "AVG" || intent === "MIN" || intent === "MAX") {
    // simple fee/duration handling
    const fieldCandidates = ["tuition_fee", "fee", "fees", "price", "cost", "duration"];
    const nums = rows
      .map((r) => {
        for (const f of fieldCandidates) {
          const val = r.metadata?.[f];
          const num = tryParseNumber(val);
          if (!Number.isNaN(num)) return { field: f, val, title: r.title };
        }
        return null;
      })
      .filter(Boolean);

    if (!nums.length) {
      return { intent: "LIST", rows, text: summarizeRows(rows, 5) };
    }

    if (intent === "AVG") {
      const avg = nums.reduce((a, b) => a + parseFloat(b.val), 0) / nums.length;
      return { intent, value: avg, rows, text: `Average ${nums[0].field}: ${avg}` };
    }
    if (intent === "MIN") {
      const best = nums.reduce((a, b) => (parseFloat(a.val) < parseFloat(b.val) ? a : b));
      return { intent, value: best.val, rows, text: `Lowest ${best.field}: ${best.val} — ${best.title}` };
    }
    if (intent === "MAX") {
      const best = nums.reduce((a, b) => (parseFloat(a.val) > parseFloat(b.val) ? a : b));
      return { intent, value: best.val, rows, text: `Highest ${best.field}: ${best.val} — ${best.title}` };
    }
  }

  return { intent: "LIST", rows, text: summarizeRows(rows, 5) };
}

/** =========================
 *  Exports
 *  ========================= */
module.exports = {
  queryDataset,
  buildRAGContext,
  sanitizeLLMReply,
  normBase,
};
