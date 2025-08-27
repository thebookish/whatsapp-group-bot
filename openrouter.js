
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

/* ============================
   Supabase / OpenRouter Config
============================= */
const supabaseUrl = process.env.SUPABASE_URL || 'https://jlznlwkluocqjnepxwbv.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsem5sd2tsdW9jcWpuZXB4d2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MDA3MDAsImV4cCI6MjA3MTI3NjcwMH0.8gFwwwcV9w2Pcs-QObN2uyuxnf9lGjzhRotR56BMTwo';
const supabase = createClient(supabaseUrl, supabaseKey);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';

/* ============================
   Dataset (providers_with_courses.json)
============================= */
const DATA_FILE = process.env.PROVIDERS_DATA_PATH || path.join(process.cwd(), 'providers_with_courses.json');
let PROVIDERS_CACHE = null;

/* ============================
   UK Accommodation (Nestoria)
============================= */
const NESTORIA_ENDPOINT = 'https://api.nestoria.co.uk/api';

/* ============================
   Small Utils
============================= */
function ensureHttps(url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

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

/* ============================
   OpenRouter (RAG-grounded)
============================= */
async function generateAIResponse(profile, studentMessage, conversationHistory = [], ragContext = '') {
  const historyContext = conversationHistory
    .map(h => `User: ${h.message}\nAssistant: ${h.response}`)
    .join('\n');

  const systemPrompt = `
You are a helpful Student Assistant focused on UK university providers and courses.

STYLE:
- Keep replies short, WhatsApp-like. 1–2 lines if simple; bullets for lists.
- Prioritize course-level matches first; include provider when useful.

STRICT RULES:
- Use ONLY the "RAG College Data Context" below for facts (providers, UCAS codes, campuses, start dates, modes, durations).
- If a field is not present in the context, do NOT invent it. Say: "Not listed in my dataset."
- No placeholders like [Campus], [Date], etc.
- If no relevant items exist in RAG context, say briefly that it's not in the dataset and give general guidance (e.g., try related subjects or nearby providers).

RAG College Data Context:
${ragContext}
  `.trim();

  const userPrompt = `
Student Info:
- Name: ${profile.name}
- Interests: ${profile.interests}
- Goals: ${profile.goals}
- Country: ${profile.country}

Recent Chat History:
${historyContext}

Student's Latest Question:
"${studentMessage}"

Respond grounded in the dataset above. Prefer bullets like:
• <Course Title> (Outcome) – <Mode> – <Duration> – <Campus> – starts <DD/MM/YYYY> – UCAS: <Code>
Include only the fields present in the RAG context.
  `.trim();

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        // You can swap to a stronger model if desired
        model: 'mistralai/mistral-7b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 400,
        temperature: 0.4
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    return res.data?.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
  } catch (error) {
    console.error('AI API error:', error?.response?.data || error.message);
    return "Sorry, I couldn't process that right now.";
  }
}

/* ============================
   Onboarding & App State
============================= */
const ONBOARDING_STEPS = { NAME: 1, INTERESTS: 2, GOALS: 3, COUNTRY: 4, COMPLETE: 0 };
const GREETING_PATTERNS = /\b(hello|hi|hey|start|begin)\b/i;
const ACCO_PATTERNS = /\b(accommodation|accomodation|accommodation|rent|room|flat|house|hall|student hall|dorm|hostel)\b/i;

const activeSessions = new Map();

function createUserProfile() {
  return {
    name: '',
    interests: '',
    goals: '',
    country: '',
    onboardingStep: ONBOARDING_STEPS.NAME,
    lastInteraction: new Date(),
    conversationHistory: []
  };
}

function extractTextFromMessage(message) {
  if (!message) return null;
  if (typeof message === 'string') return message.trim();
  if (typeof message.conversation === 'string') return message.conversation.trim();
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text.trim();
  if (message.imageMessage?.caption) return message.imageMessage.caption.trim();
  if (message.videoMessage?.caption) return message.videoMessage.caption.trim();
  if (message.text) {
    if (typeof message.text === 'string') return message.text.trim();
    if (message.text.body) return message.text.body.trim();
  }
  return null;
}

function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') throw new Error('Invalid userId');
  return userId;
}
function validateMessage(msg) {
  if (!msg || typeof msg !== 'string' || !msg.trim()) throw new Error('Empty message');
  if (msg.length > 1000) throw new Error('Message too long');
  return msg.trim();
}
function isGreetingOnly(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z\s']/g, ' ').trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(w => /(hello|hi|hey|start|begin)/.test(w));
}
function extractNameFromText(text) {
  const p1 = /(my name is|i am|i'm|this is)\s+([^\n,.;!?]+)/i.exec(text);
  if (p1 && p1[2]) return p1[2].trim();
  const p2 = /^(hello|hi|hey)[\s,!:;-]*(.*)$/i.exec(text.trim());
  if (p2 && p2[2]) {
    const rest = p2[2].trim();
    if (rest) return rest;
  }
  if (!isGreetingOnly(text) && text.trim().length <= 60) return text.trim();
  return '';
}

/* ============================
   Supabase DB Helpers
============================= */
async function checkUserExists(userId) {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
    if (error && error.code !== 'PGRST116') throw error;
    return { exists: !!data, user: data || null };
  } catch (error) {
    console.error('Error checking user existence:', error);
    return { exists: false, user: null };
  }
}
async function createUserInDB(userId, profile) {
  try {
    const { data, error } = await supabase.from('users').insert([{
      user_id: userId,
      name: profile.name,
      interests: profile.interests,
      goals: profile.goals,
      country: profile.country,
      created_at: new Date(),
      last_interaction: new Date()
    }]).select().single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error creating user in DB:', error);
    throw error;
  }
}
async function updateUserInDB(userId, updates) {
  try {
    const { data, error } = await supabase.from('users').update({
      ...updates, last_interaction: new Date()
    }).eq('user_id', userId).select().single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error updating user in DB:', error);
    throw error;
  }
}
async function getConversationHistory(userId) {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting conversation history:', error);
    return [];
  }
}
async function saveConversation(userId, message, response) {
  try {
    const { error } = await supabase.from('conversations').insert([{
      user_id: userId, message, response, created_at: new Date()
    }]);
    if (error) throw error;
  } catch (error) {
    console.error('Error saving conversation:', error);
  }
}

/* ============================
   Accommodation Helpers (UK)
============================= */
function parseAccommodationQuery(text) {
  const q = normBase(text);

  const priceMatch = q.match(/\b(?:under|<=?|max|up to)\s*[£$]?\s*(\d{2,5})\b/) || q.match(/\b[£$]\s*(\d{2,5})\b/);
  const price_max = priceMatch ? parseInt(priceMatch[1], 10) : undefined;

  let bedrooms;
  const bedMatch = q.match(/\b(\d)\s*(?:bed|beds|bedroom|bedrooms)\b/);
  if (bedMatch) bedrooms = parseInt(bedMatch[1], 10);
  else if (/\bstudio\b/.test(q)) bedrooms = 0;

  let place_name;
  const locMatch = q.match(/\b(?:in|at|near|around)\s+([a-z\s\-&']{2,})$/i);
  if (locMatch) {
    place_name = locMatch[1].trim();
  } else {
    const cap = (text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [])[0];
    if (cap) place_name = cap.trim();
  }

  return { place_name, price_max, bedrooms };
}

async function searchUKAccommodation({ place_name, price_max, bedrooms, page = 1, num = 8 }) {
  if (!place_name) return { listings: [], meta: { message: 'No location provided' } };

  const params = {
    encoding: 'json',
    action: 'search_listings',
    country: 'uk',
    listing_type: 'rent',
    page,
    number_of_results: Math.max(3, Math.min(num, 20)),
    place_name
  };
  if (price_max) params.price_max = price_max;
  if (typeof bedrooms === 'number') {
    if (bedrooms === 0) { params.bedroom_max = 0; }
    else { params.bedroom_min = bedrooms; params.bedroom_max = bedrooms; }
  }

  try {
    const r = await axios.get(NESTORIA_ENDPOINT, { params, timeout: 15000 });
    const body = r.data && r.data.response ? r.data.response : {};
    const listings = (body.listings || []).map(x => ({
      title: x.title || `${x.bedroom_number || ''} bed ${x.property_type || 'property'}`.trim(),
      price: x.price,
      price_formatted: x.price_formatted || (x.price ? `£${x.price} pcm` : ''),
      bedrooms: x.bedroom_number,
      bathrooms: x.bathroom_number,
      property_type: x.property_type,
      address: x.formatted_address || x.summary || '',
      url: x.lister_url || x.url || '',
      thumbnail: x.thumb_url || x.img_url || '',
      latitude: x.latitude,
      longitude: x.longitude
    }));
    return { listings, meta: { total: body.total_results, page: body.page, pages: body.total_pages } };
  } catch (e) {
    console.error('Accommodation API error:', e?.response?.data || e.message);
    return { listings: [], meta: { error: true, message: 'Failed to fetch listings' } };
  }
}

function formatAccommodationReply(listings) {
  if (!listings.length) return 'Couldn’t find live listings for that—try a nearby area or raise budget a bit?';
  const top = listings.slice(0, 5);
  const lines = top.map(l =>
    `• ${l.title} – ${l.price_formatted}${l.bedrooms != null ? `, ${l.bedrooms} bed` : ''}\n  ${l.address}${l.url ? `\n  ${l.url}` : ''}`
  );
  return lines.join('\n');
}

/* ============================
   Main entry (ALL Q&A → RAG → OpenRouter)
============================= */
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);

    let messageText = typeof rawMessage === 'object' ? extractTextFromMessage(rawMessage) : rawMessage;
    if (!messageText) return "Text only please 🙂";
    messageText = validateMessage(messageText);
    const lowerMsg = messageText.toLowerCase();

    const { exists, user } = await checkUserExists(uid);

    let profile;
    if (activeSessions.has(uid)) {
      profile = activeSessions.get(uid);
    } else if (exists && user) {
      profile = {
        name: user.name || '',
        interests: user.interests || '',
        goals: user.goals || '',
        country: user.country || '',
        onboardingStep: ONBOARDING_STEPS.COMPLETE,
        lastInteraction: new Date(),
        conversationHistory: await getConversationHistory(uid)
      };
      activeSessions.set(uid, profile);
      try { await updateUserInDB(uid, {}); } catch (_) {}
    } else {
      profile = createUserProfile();
      activeSessions.set(uid, profile);
    }

    // ==== ONBOARDING ====
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME: {
          if (isGreetingOnly(messageText)) return `Hey! I’m your study buddy. What’s your name?`;
          const name = extractNameFromText(messageText);
          if (!name) return `All good—tell me your name (e.g., "I'm Nabil Hasan").`;
          profile.name = name;
          profile.onboardingStep = ONBOARDING_STEPS.INTERESTS;
          return `Nice to meet you, ${profile.name}! What subjects/fields are you into?`;
        }
        case ONBOARDING_STEPS.INTERESTS: {
          profile.interests = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.GOALS;
          return `Got it. Your main goal—scholarship, admission, job?`;
        }
        case ONBOARDING_STEPS.GOALS: {
          profile.goals = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COUNTRY;
          return `Cool. Which country are you in / targeting?`;
        }
        case ONBOARDING_STEPS.COUNTRY: {
          profile.country = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COMPLETE;
          try {
            await createUserInDB(uid, profile);
          } catch (e) {
            try { await updateUserInDB(uid, {
              name: profile.name, interests: profile.interests, goals: profile.goals, country: profile.country
            }); } catch (_) {}
          }
          return `Profile saved ✅ Ask me anything about courses, unis, or apps.`;
        }
      }
    }

    // ==== Greeting shortcut ====
    if (GREETING_PATTERNS.test(lowerMsg)) {
      return `Hey ${profile.name || 'there'} 👋 How can I help?`;
    }

    // ==== Accommodation (live lookups) ====
    if (ACCO_PATTERNS.test(lowerMsg)) {
      const prefs = parseAccommodationQuery(messageText);
      if (!prefs.place_name) {
        return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      }
      const { listings } = await searchUKAccommodation(prefs);
      const reply = formatAccommodationReply(listings);
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    // ==== RAG over your dataset (always used for course/provider Qs) ====
    const retrieval = findRelevantData(messageText);
    const ragContext = buildRAGContext(retrieval);

    // If no retrieval hits at all, still ask model to respond carefully (it will say not found + guidance)
    const aiReply = await generateAIResponse(
      profile,
      messageText,
      profile.conversationHistory.slice(-10),
      ragContext
    );

    const cleaned = sanitizeLLMReply(aiReply);
    const finalReply = cleaned || "I don’t see that in my dataset. Want me to try similar subjects or another provider?";

    try { await saveConversation(uid, messageText, finalReply); } catch (_) {}
    profile.conversationHistory.push({ message: messageText, response: finalReply, timestamp: new Date() });
    if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
    if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }

    return finalReply;

  } catch (error) {
    console.error('getAIResponse error:', error.message);
    if (error.message.includes('Invalid userId')) return "Invalid user ID.";
    if (error.message.includes('Empty message')) return "Please send a text 🙂";
    if (error.message.includes('Message too long')) return "Too long—keep it under 1000 chars.";
    return "Sorry, something went wrong.";
  }
}

/* ============================
   Misc Utilities / Stats
============================= */
function clearUserData(userId) {
  try {
    const uid = validateUserId(userId);
    return activeSessions.delete(uid);
  } catch {
    return false;
  }
}
async function getUserStats() {
  try {
    const { count: totalUsers, error: countError } = await supabase
      .from('users').select('*', { count: 'exact', head: true });
    if (countError) throw countError;
    const { count: activeUsers, error: activeError } = await supabase
      .from('users').select('*', { count: 'exact', head: true })
      .gte('last_interaction', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (activeError) throw activeError;

    return { totalUsers: totalUsers || 0, activeUsers: activeUsers || 0, activeSessions: activeSessions.size };
  } catch (error) {
    console.error('Error getting user stats:', error);
    return { totalUsers: 0, activeUsers: 0, activeSessions: activeSessions.size };
  }
}

/* ============================
   Exports
============================= */
module.exports = {
  getAIResponse,
  clearUserData,
  getUserStats,
};
