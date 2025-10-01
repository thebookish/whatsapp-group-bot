// vectorstore.js
const fs = require("fs");
const { supabase, DATA_FILE, OPENROUTER_API_KEY } = require("./config");
const OpenAI = require("openai");

/* ============================
   OpenAI Client
============================= */
const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY, // keep same env variable
});

/* ============================
   Batch embeddings
============================= */
async function getEmbeddingsBatch(texts) {
  try {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });
    return res.data.map((d) => d.embedding);
  } catch (err) {
    console.error("❌ Embedding API error:", err.response?.data || err.message || err);
    return texts.map(() => []); // return same length to avoid crash
  }
}


/* ============================
   Build vector store in Supabase
============================= */
async function buildVectorStore() {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  // Normalize dataset shape
  let raw;
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (parsed.records && Array.isArray(parsed.records)) {
    raw = parsed.records;
  } else if (typeof parsed === "object") {
    raw = Object.values(parsed);
  } else {
    throw new Error("Dataset format not recognized.");
  }

  console.log(`📦 Found ${raw.length} providers in dataset`);

  // Skip if already built
  const { count } = await supabase
    .from("course_vectors")
    .select("*", { count: "exact", head: true });

  if (count > 0) {
    console.log(`⚡ Skipping build — DB already has ${count} rows`);
    return;
  }

  let texts = [];
  let meta = [];
  let processed = 0;
  const BATCH_SIZE = 20; // safer than 50

  for (const [pi, provider] of raw.entries()) {
    for (const course of provider.courses || []) {
      for (const option of course.options || [null]) {
        const text = `${course.courseTitle || ""} ${course.outcomeQualification?.caption || ""} ${option?.location?.name || ""} ${option?.startDate?.date || ""}`;

        texts.push(text);
        meta.push({
          title: course.courseTitle || "",
          qualification: course.outcomeQualification?.caption || "",
          campus: option?.location?.name || "",
          start_date: option?.startDate?.date || "",
          metadata: {
            provider: provider.name,
            applicationCode: course.applicationCode || "",
          },
        });

        // Process when batch full
        if (texts.length >= BATCH_SIZE) {
          await embedAndInsert(texts, meta);
          processed += texts.length;
          console.log(`✅ Processed ${processed} rows (provider ${pi + 1}/${raw.length})`);
          texts = [];
          meta = [];
        }
      }
    }
  }

  // Insert leftovers
  if (texts.length) {
    await embedAndInsert(texts, meta);
    processed += texts.length;
  }

  console.log(`🎉 Vector store built with ${processed} rows total`);
}


/* ============================
   Insert batch into Supabase
============================= */
async function embedAndInsert(texts, meta) {
  const vectors = await getEmbeddingsBatch(texts);

  if (!vectors || vectors.length !== texts.length) {
    console.error("❌ Embedding batch failed, skipping this batch");
    return;
  }

  const rows = vectors.map((vec, i) => ({
    title: meta[i].title,
    qualification: meta[i].qualification,
    campus: meta[i].campus,
    start_date: meta[i].start_date,
    metadata: meta[i].metadata,
    embedding: vec, // float[]
  }));

  const { data, error } = await supabase.from("course_vectors").insert(rows);

  if (error) {
    console.error("❌ Insert error:", error);
  } else {
    console.log(`   ↳ Inserted ${rows.length} rows`);
  }
}




/* ============================
   Query top-k similar courses
============================= */
async function queryCourses(userQuery, k = 10) {
  const vectors = await getEmbeddingsBatch([userQuery]);
  const queryVec = vectors[0];
  if (!queryVec?.length) return [];

  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: queryVec,
    match_count: k,
  });

  if (error) {
    console.error("Query error:", error);
    return [];
  }
  return data;
}

module.exports = { buildVectorStore, queryCourses, getEmbeddingsBatch };
