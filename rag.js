// rag.js

const fs = require('fs');
const { DATA_FILE, ensureHttps } = require('./config');

/* ============================
   Dataset (providers_with_courses.json)
============================= */
let PROVIDERS_CACHE = null;

function loadProvidersData() {
  if (PROVIDERS_CACHE) return PROVIDERS_CACHE;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');

    // Input format is an object keyed by providerId
    PROVIDERS_CACHE = Object.values(parsed || {}).map(p => ({
      id: p.id,
      name: p.name || p.aliasName || '',
      institutionCode: p.institutionCode || '',
      providerSort: p.providerSort || '',
      websiteUrl: ensureHttps(p.websiteUrl || ''),
      logoUrl: p.logoUrl || '',
      address: p.address || {},
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      aboutUs: p.aboutUs || '',
      whatMakesUsDifferent: p.whatMakesUsDifferent || '',
      courseLocations: p.courseLocations || [],
      courses: (p.courses || []).map(c => ({
        id: c.id,
        academicYearId: c.academicYearId || '',
        title: c.courseTitle || '',
        destination: c.routingData?.destination?.caption || '',
        applicationCode: c.applicationCode || null,
        options: (c.options || []).map(o => ({
          id: o.id,
          studyMode: o.studyMode?.mappedCaption || o.studyMode?.caption || '',
          durationQty: o.duration?.quantity ?? null,
          durationType: o.duration?.durationType?.caption || '',
          location: o.location?.name || '',
          startDate: o.startDate?.date || '',
          outcome: o.outcomeQualification?.caption || '',
        }))
      }))
    }));
  } catch (err) {
    console.error('Failed to load providers_with_courses.json:', err.message);
    PROVIDERS_CACHE = [];
  }
  return PROVIDERS_CACHE;
}

/* ============================
   Retrieval (fuzzy + UCAS aware)
============================= */
function normBase(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[-/_,.()+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
const STOP = new Set([
  'the','a','an','with','and','of','for','in','to','at','on','about','into','from','by',
  'course','degree','program','programme','pg','ug','undergraduate','postgraduate'
]);
function tokenize(s) {
  if (!s) return [];
  return normBase(s).split(/\s+/).filter(t => t && !STOP.has(t));
}
function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}
function expandTerms(terms) {
  const map = {
    accountancy: 'accounting',
    accounts: 'accounting',
    acct: 'accounting',
    cs: 'computer science',
    comp: 'computing',
    'comp sci': 'computer science',
    counselling: 'counseling',
    counsellor: 'counselor',
    mgmt: 'management',
    biz: 'business',
    bms: 'business management',
    'software development': 'software',
    'software engineering': 'software',
    'business administration': 'business management',
    ai: 'artificial intelligence',
    data: 'data science'
  };
  const extra = [];
  for (const t of terms) {
    const k = t.toLowerCase();
    if (map[k]) for (const w of map[k].split(' ')) extra.push(w);
  }
  return [...new Set([...terms, ...extra])];
}
function ucascodesFromQuery(q) {
  const codes = [];
  const re = /\b([a-z0-9]{4})\b/ig;
  let m;
  while ((m = re.exec(q || '')) !== null) codes.push(m[1].toUpperCase());
  return codes;
}
function computeProviderScore(provider, qTokens) {
  const pTokens = new Set([
    ...tokenize(provider.name),
    ...tokenize(provider.institutionCode),
    ...tokenize(provider.providerSort),
    ...tokenize(provider.aboutUs),
    ...tokenize(provider.whatMakesUsDifferent),
    ...((provider.aliases || []).flatMap(a => tokenize(a))),
    ...((provider.courseLocations || []).flatMap(l => tokenize(`${l.title} ${l.address}`))),
    ...tokenize(provider.address?.line4 || ''),
    ...tokenize(provider.address?.country?.mappedCaption || '')
  ]);
  const overlap = [...pTokens].filter(t => qTokens.includes(t)).length;
  return overlap;
}
function computeCourseScore(provider, course, qTokens, qUCAS) {
  const titleTokens = tokenize(course.title);
  const optionStrings = (course.options || []).map(o =>
    `${o.studyMode} ${o.durationQty} ${o.durationType} ${o.location} ${o.startDate} ${o.outcome}`
  );
  const textTokens = new Set([
    ...titleTokens,
    ...tokenize(course.destination),
    ...tokenize(provider.name),
    ...tokenize(provider.institutionCode),
    ...tokenize(provider.address?.line4 || ''),
    ...tokenize(provider.address?.country?.mappedCaption || ''),
    ...optionStrings.flatMap(s => tokenize(s))
  ]);

  const overlap = [...textTokens].filter(t => qTokens.includes(t));
  const jTitle = jaccard(titleTokens, qTokens);

  const ucasBonus = (course.applicationCode && qUCAS.includes(course.applicationCode.toUpperCase())) ? 15 : 0;

  let keywordBoost = 0;
  const kws = new Set(['java','python','software','computing','computer','science','accounting','accountancy','business','management','data','ai','artificial','intelligence']);
  for (const t of overlap) if (kws.has(t)) keywordBoost += 1.5;

  const score =
    12 * jTitle +
    3 * overlap.length +
    2 * computeProviderScore(provider, qTokens) +
    ucasBonus +
    keywordBoost;

  const hardGate = jTitle >= 0.2 || overlap.length >= 2 || ucasBonus > 0;
  return hardGate ? score : 0;
}
function findRelevantData(query, opts = { topProviders: 3, topCourses: 8 }) {
  const providers = loadProvidersData();
  const baseTokens = tokenize(query);
  const qTokens = expandTerms(baseTokens);
  const qText = normBase(query);
  const qUCAS = ucascodesFromQuery(qText);

  // Providers (soft)
  const provScored = providers
    .map(p => ({ p, score: computeProviderScore(p, qTokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topProviders);

  // Courses (fuzzy across ALL providers)
  const courses = [];
  for (const pv of providers) {
    for (const c of pv.courses) {
      const score = computeCourseScore(pv, c, qTokens, qUCAS);
      if (score > 0) courses.push({ provider: pv, course: c, score });
    }
  }
  const courseRank = courses.sort((a, b) => b.score - a.score).slice(0, opts.topCourses);

  return {
    providers: provScored.map(x => x.p),
    courses: courseRank.map(x => ({ provider: x.provider, course: x.course }))
  };
}

/* ============================
   Option Picking / Formatting
============================= */
function parseDDMMYYYY(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  return new Date(yyyy, mm - 1, dd);
}
function pickBestOption(course) {
  const opts = Array.isArray(course.options) ? course.options : [];
  if (!opts.length) return null;
  const dated = opts
    .map(o => ({ o, dt: parseDDMMYYYY(o.startDate) }))
    .sort((a, b) => {
      if (!a.dt && !b.dt) return 0;
      if (!a.dt) return 1;
      if (!b.dt) return -1;
      return a.dt - b.dt;
    });
  return (dated[0] && dated[0].o) || opts[0];
}

/* ============================
   RAG Context Construction
============================= */
function buildRAGContext(results) {
  const { providers, courses } = results;
  const chunks = [];

  // Provider chunks
  for (const p of providers.slice(0, 3)) {
    const location = [p.address?.line4, p.address?.country?.mappedCaption].filter(Boolean).join(', ');
    const lines = [
      `--- RAG_CHUNK: PROVIDER`,
      `Provider: ${p.name}`,
      `Institution Code: ${p.institutionCode || '(not listed)'}`,
      location ? `Location: ${location}` : null,
      p.websiteUrl ? `Website: ${p.websiteUrl}` : null,
      p.aliases?.length ? `Aliases: ${p.aliases.join(', ')}` : null
    ].filter(Boolean);
    chunks.push(lines.join('\n'));
  }

  // Course chunks
  for (const { provider, course } of courses.slice(0, 10)) {
    const o = pickBestOption(course) || {};
    const fields = [
      `--- RAG_CHUNK: COURSE`,
      `Course Title: ${course.title}`,
      `Provider: ${provider.name}`,
      course.destination ? `Level: ${course.destination}` : null,
      course.applicationCode ? `UCAS: ${course.applicationCode}` : null,
      o.outcome ? `Outcome: ${o.outcome}` : null,
      o.studyMode ? `Mode: ${o.studyMode}` : null,
      (o.durationQty && o.durationType) ? `Duration: ${o.durationQty} ${o.durationType}` : null,
      o.location ? `Campus: ${o.location}` : null,
      o.startDate ? `Start: ${o.startDate}` : null
    ].filter(Boolean);
    chunks.push(fields.join('\n'));
  }

  if (!chunks.length) return '(none — no relevant courses/providers found for this query)';
  return chunks.join('\n\n');
}

/* ============================
   Output Sanitizer
============================= */
function sanitizeLLMReply(text) {
  if (!text) return text;
  let t = text.replace(/\[[^\]]+\]/g, ''); // remove [placeholders]
  const lines = t.split(/\r?\n/).map(l => l.trim());
  const filtered = lines.filter(l => {
    if (!l) return false;
    if (/Online or In[- ]?person/i.test(l)) return false;
    if (/Campus:\s*$/i.test(l)) return false;
    if (/Start:\s*$/i.test(l)) return false;
    if (/UCAS code?:\s*$/i.test(l)) return false;
    return true;
  }).map(l => l.replace(/\s–\s*$/,''));
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  loadProvidersData,
  findRelevantData,
  buildRAGContext,
  sanitizeLLMReply,
  // Exported utilities in case you need them elsewhere
  tokenize,
  normBase,
};
