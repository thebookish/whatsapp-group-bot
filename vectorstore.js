// vectorstore.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
const { DATA_FILE, OPENROUTER_API_KEY } = require('./config');

const DB_PATH = path.join(process.cwd(), 'courses.db');
const db = new Database(DB_PATH);

// Ensure schema exists
db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  qualification TEXT,
  campus TEXT,
  start_date TEXT,
  metadata TEXT,
  embedding BLOB
);
`);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Call OpenRouter embeddings API */
async function getEmbedding(text) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/embeddings",
      {
        model: "openai/text-embedding-3-small",
        input: text
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
    return res.data?.data?.[0]?.embedding || [];
  } catch (err) {
    console.error("Embedding API error:", err.response?.data || err.message);
    return [];
  }
}

/** Build SQLite vector store from providers_with_courses.json */
async function buildVectorStore() {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const raw = Object.values(parsed); // your dataset

  console.log(`📦 Found ${raw.length} providers in dataset`);

  const countRow = db.prepare("SELECT COUNT(*) as c FROM courses").get();
  if (countRow.c > 0) {
    console.log(`⚡ Skipping build — DB already has ${countRow.c} rows`);
    return;
  }

  const insert = db.prepare(
    `INSERT INTO courses (title, qualification, campus, start_date, metadata, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(rows => {
    for (const r of rows) insert.run(r.title, r.qualification, r.campus, r.start_date, r.metadata, r.embedding);
  });

  let texts = [];
  let meta = [];

  for (const [pi, provider] of raw.entries()) {
    for (const course of provider.courses || []) {
      for (const option of course.options || [null]) {
        const text = `${course.courseTitle || ''} ${course.outcomeQualification?.caption || ''} ${option?.location?.name || ''} ${option?.startDate?.date || ''}`;

        texts.push(text);
        meta.push({
          title: course.courseTitle || '',
          qualification: course.outcomeQualification?.caption || '',
          campus: option?.location?.name || '',
          start_date: option?.startDate?.date || '',
          metadata: JSON.stringify({ provider: provider.name, applicationCode: course.applicationCode || '' })
        });

        // Process in batches of 50
        if (texts.length >= 50) {
          await embedAndInsert(texts, meta, tx);
          texts = [];
          meta = [];
          console.log(`✅ Processed provider ${pi + 1}/${raw.length}`);
        }
      }
    }
  }

  if (texts.length) {
    await embedAndInsert(texts, meta, tx);
  }

  const total = db.prepare("SELECT COUNT(*) as c FROM courses").get().c;
  console.log(`🎉 Vector store built with ${total} rows`);
}

async function embedAndInsert(texts, meta, tx) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/embeddings",
    {
      model: "openai/text-embedding-3-small",
      input: texts
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  const vectors = res.data?.data || [];
  const rows = vectors.map((v, i) => ({
    ...meta[i],
    embedding: Buffer.from(new Float32Array(v.embedding).buffer)
  }));

  tx(rows);
}


/** Query top-k courses by semantic similarity */
async function queryCourses(userQuery, k = 10) {
  const queryVec = await getEmbedding(userQuery);
  if (!queryVec.length) return [];

  const rows = db.prepare("SELECT * FROM courses").all();
  rows.forEach((r) => {
    const emb = new Float32Array(new Uint8Array(r.embedding).buffer);
    r.sim = cosine(queryVec, emb);
  });

  rows.sort((a, b) => b.sim - a.sim);
  return rows.slice(0, k);
}

module.exports = { buildVectorStore, queryCourses };
