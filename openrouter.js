// aiAssistant.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// === Supabase Configuration (use env if available) ===
const supabaseUrl = process.env.SUPABASE_URL || 'https://jlznlwkluocqjnepxwbv.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsem5sd2tsdW9jcWpuZXB4d2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MDA3MDAsImV4cCI6MjA3MTI3NjcwMH0.8gFwwwcV9w2Pcs-QObN2uyuxnf9lGjzhRotR56BMTwo';
const supabase = createClient(supabaseUrl, supabaseKey);

// === OpenRouter API Key (use env if available) ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';

// === Local Provider Data (providers_with_courses.json) ===
const DATA_FILE = process.env.PROVIDERS_DATA_PATH || path.join(process.cwd(), 'providers_with_courses.json');
let PROVIDERS_CACHE = null;

// === Accommodation (UK) via public API ===
const NESTORIA_ENDPOINT = 'https://api.nestoria.co.uk/api'; // public, no API key

// ---------------- Providers Data ----------------
function loadProvidersData() {
  if (PROVIDERS_CACHE) return PROVIDERS_CACHE;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    PROVIDERS_CACHE = Object.values(parsed || {}).map(p => ({
      id: p.id,
      name: p.name || p.aliasName || '',
      institutionCode: p.institutionCode || '',
      websiteUrl: p.websiteUrl || '',
      logoUrl: p.logoUrl || '',
      address: p.address || {},
      aliases: p.aliases || [],
      aboutUs: p.aboutUs || '',
      whatMakesUsDifferent: p.whatMakesUsDifferent || '',
      courseLocations: p.courseLocations || [],
      courses: (p.courses || []).map(c => ({
        id: c.id,
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

// ---------------- Retrieval over Providers ----------------
function norm(s) { return (s || '').toString().toLowerCase(); }

function scoreText(text, queryTerms) {
  const t = norm(text);
  let score = 0;
  for (const q of queryTerms) if (q && t.includes(q)) score += q.length;
  return score;
}

function findRelevantData(query, opts = { topProviders: 2, topCourses: 4 }) {
  const providers = loadProvidersData();
  const terms = norm(query).split(/[^a-z0-9&+]+/).filter(Boolean);

  const providerRank = providers
    .map(p => {
      const fields = [
        p.name, p.institutionCode, p.aboutUs, p.whatMakesUsDifferent,
        ...(p.aliases || []),
        ...(p.courseLocations?.map(l => `${l.title} ${l.address}`) || [])
      ].join(' | ');
      return { p, score: scoreText(fields, terms) };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topProviders);

  const candidateCourses = [];
  for (const pv of providers) {
    for (const c of pv.courses) {
      const text = [
        pv.name, c.title, c.destination, c.applicationCode,
        ...c.options.map(o => `${o.studyMode} ${o.durationQty} ${o.durationType} ${o.location} ${o.startDate} ${o.outcome}`)
      ].join(' | ');
      const s = scoreText(text, terms);
      if (s > 0) candidateCourses.push({ provider: pv, course: c, score: s });
    }
  }

  const courseRank = candidateCourses.sort((a, b) => b.score - a.score).slice(0, opts.topCourses);

  return { providers: providerRank.map(x => x.p), courses: courseRank.map(x => ({ provider: x.provider, course: x.course })) };
}

function formatCourseLine(providerName, course, opt) {
  const bits = [];
  bits.push(`• ${course.title}`);
  if (opt?.outcome) bits.push(`(${opt.outcome})`);
  if (opt?.studyMode) bits.push(`– ${opt.studyMode}`);
  if (opt?.durationQty && opt?.durationType) bits.push(`– ${opt.durationQty} ${opt.durationType}`);
  if (opt?.location) bits.push(`– ${opt.location}`);
  if (opt?.startDate) bits.push(`– starts ${opt.startDate}`);
  if (course.applicationCode) bits.push(`– UCAS: ${course.applicationCode}`);
  return bits.join(' ');
}

function buildDirectAnswer(query, results) {
  const { providers, courses } = results;
  const q = norm(query);
  const providerMention = providers.find(p => q.includes(norm(p.name)));
  const targetProvider = providerMention || providers[0];

  if (targetProvider) {
    const provCourses = (courses.filter(c => c.provider.id === targetProvider.id).map(c => c.course));
    const fallbackProvCourses = targetProvider.courses.slice(0, 3);
    const chosen = (provCourses.length ? provCourses : fallbackProvCourses).slice(0, 3);

    const lines = [];
    lines.push(`For *${targetProvider.name}*:`);
    for (const c of chosen) {
      const opt = c.options?.[0];
      lines.push(formatCourseLine(targetProvider.name, c, opt));
    }
    if (targetProvider.websiteUrl) lines.push(`More info: ${targetProvider.websiteUrl}`);
    return lines.join('\n');
  }

  if (courses.length) {
    return courses.slice(0, 4).map(({ provider, course }) => {
      const opt = course.options?.[0];
      return formatCourseLine(provider.name, course, opt);
    }).join('\n');
  }

  return '';
}

function buildDataContext(results) {
  const { providers, courses } = results;
  const lines = [];

  for (const p of providers.slice(0, 3)) {
    lines.push(`Provider: ${p.name} (Code: ${p.institutionCode})`);
    const locs = (p.courseLocations || []).map(l => `${l.title} – ${l.address}`).slice(0, 2);
    if (locs.length) lines.push(`Locations: ${locs.join(' | ')}`);
  }

  for (const { provider, course } of courses.slice(0, 6)) {
    const o = course.options?.[0];
    const bits = [
      `Course: ${course.title}`,
      provider?.name ? `Provider: ${provider.name}` : null,
      course.applicationCode ? `UCAS: ${course.applicationCode}` : null,
      o?.outcome ? `Outcome: ${o.outcome}` : null,
      o?.studyMode ? `Mode: ${o.studyMode}` : null,
      (o?.durationQty && o?.durationType) ? `Duration: ${o.durationQty} ${o.durationType}` : null,
      o?.location ? `Campus: ${o.location}` : null,
      o?.startDate ? `Start: ${o.startDate}` : null
    ].filter(Boolean);
    lines.push(bits.join(' | '));
  }
  return lines.join('\n');
}

// ---------------- Onboarding & App State ----------------
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

// ---------------- DB helpers ----------------
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

// ---------------- Accommodation helpers ----------------
function parseAccommodationQuery(text) {
  const q = norm(text);

  // Extract max price like "under 900", "<=1200", "max 1000", "up to £850"
  const priceMatch = q.match(/\b(?:under|<=?|max|up to)\s*[£$]?\s*(\d{2,5})\b/) || q.match(/\b[£$]\s*(\d{2,5})\b/);
  const price_max = priceMatch ? parseInt(priceMatch[1], 10) : undefined;

  // Extract bedrooms "1 bed", "2 beds", "studio" (studio -> 0 or 1)
  let bedrooms;
  const bedMatch = q.match(/\b(\d)\s*(?:bed|beds|bedroom|bedrooms)\b/);
  if (bedMatch) bedrooms = parseInt(bedMatch[1], 10);
  else if (/\bstudio\b/.test(q)) bedrooms = 0;

  // Rough location: last meaningful word group after "in", "at", "near"
  let place_name;
  const locMatch = q.match(/\b(?:in|at|near|around)\s+([a-z\s\-&']{2,})$/i);
  if (locMatch) {
    place_name = locMatch[1].trim();
  } else {
    // fallback: first capitalized token(s) (very heuristic)
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
    // For 0 beds (studio), restrict bedroom_max=0; else set both min/max to bedrooms for tighter match
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

function formatAccommodationReply(listings, opts = {}) {
  if (!listings.length) return 'Couldn’t find live listings for that—try a nearby area or raise budget a bit?';

  // WhatsApp-style: 4–6 concise lines
  const top = listings.slice(0, 5);
  const lines = top.map(l =>
    `• ${l.title} – ${l.price_formatted}${l.bedrooms != null ? `, ${l.bedrooms} bed` : ''}\n  ${l.address}${l.url ? `\n  ${l.url}` : ''}`
  );
  return lines.join('\n');
}

// ---------------- OpenRouter (grounded) ----------------
async function generateAIResponse(profile, studentMessage, conversationHistory = [], dataContext = '') {
  const historyContext = conversationHistory.map(h => `User: ${h.message}\nAssistant: ${h.response}`).join('\n');

  const systemPrompt = `
You are a helpful Student Assistant.
- Keep replies short and human, WhatsApp-like. 1–2 lines if simple; bullets for lists.
- Use the provided "College Data Context" first. If not available, answer generally.
- When listing a course: Title, Outcome, Mode, Duration, Campus, Start, UCAS code.
- If user mentions a specific provider, prioritise it.
- Avoid long paragraphs.
College Data Context:
${dataContext || '(none)'}
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

If data is missing, be brief and honest.
  `.trim();

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'mistralai/mistral-7b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.5
      },
      {
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    return res.data?.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
  } catch (error) {
    console.error('AI API error:', error?.response?.data || error.message);
    return "Sorry, I couldn't process that right now.";
  }
}

// ---------------- Main entry ----------------
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

    // ==== Accommodation intent (UK real-time) ====
    if (ACCO_PATTERNS.test(lowerMsg)) {
      const prefs = parseAccommodationQuery(messageText);
      if (!prefs.place_name) {
        return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      }
      const { listings, meta } = await searchUKAccommodation(prefs);
      const reply = formatAccommodationReply(listings);
      // Save conversation
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    // ==== Data-first answering from providers file ====
    const retrieval = findRelevantData(messageText);
    const direct = buildDirectAnswer(messageText, retrieval);
    if (direct) {
      try { await saveConversation(uid, messageText, direct); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: direct, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return direct;
    }

    // ==== Fall back to OpenRouter with grounded context ====
    const dataCtx = buildDataContext(retrieval);
    const aiReply = await generateAIResponse(profile, messageText, profile.conversationHistory.slice(-10), dataCtx);

    try { await saveConversation(uid, messageText, aiReply); } catch (_) {}
    profile.conversationHistory.push({ message: messageText, response: aiReply, timestamp: new Date() });
    if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
    if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }

    return aiReply;

  } catch (error) {
    console.error('getAIResponse error:', error.message);
    if (error.message.includes('Invalid userId')) return "Invalid user ID.";
    if (error.message.includes('Empty message')) return "Please send a text 🙂";
    if (error.message.includes('Message too long')) return "Too long—keep it under 1000 chars.";
    return "Sorry, something went wrong.";
  }
}

// ---------------- Utilities ----------------
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

// ---------------- Exports ----------------
module.exports = {
  getAIResponse,
  clearUserData,
  getUserStats,
};
