// ai.js
const axios = require('axios');
const { supabase, OPENROUTER_API_KEY, NESTORIA_ENDPOINT } = require('./config');
const { findRelevantData, sanitizeLLMReply, normBase, queryDataset } = require('./rag');

/* ============================
   Onboarding & App State
============================= */
const ONBOARDING_STEPS = { NAME: 1, INTERESTS: 2, GOALS: 3, COUNTRY: 4, COMPLETE: 0 };
const GREETING_PATTERNS = /\b(hello|hi|hey)\b/i;
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
   Analytics Formatter
============================= */
function formatAnalyticReply(result) {
  if (!result) return 'Not found in dataset.';
  const head = result.text || '';
  if (!result.rows || !result.rows.length) return head || 'Not found in dataset.';

  const previewLines = [];
  const limit = 6;
  for (const r of result.rows.slice(0, limit)) {
    const uni = r.raw?.provider_name || r.provider_name || '';
    const title = r.raw?.course_title || r.course_title || '';
    const start = r.raw?.start_date_raw || r.start_date || '';
    const qual = r.raw?.qualification || '';
    const line = [
      uni && title ? `${uni} — ${title}` : (title || uni || 'Course'),
      qual ? `(${qual})` : null,
      start ? `starts ${start}` : null
    ].filter(Boolean).join(' — ');
    previewLines.push(`• ${line}`);
  }
  const preview = previewLines.join('\n');
  return head ? `${head}\n${preview}` : preview;
}

/* ============================
   (Optional) LLM kept for future
============================= */
async function generateAIResponse(profile, studentMessage, conversationHistory = [], ragContext = '') {
  const historyContext = conversationHistory
    .map(h => `User: ${h.message}\nAssistant: ${h.response}`)
    .join('\n');

  const systemPrompt = `
You are a helpful Student Assistant. Keep answers short and natural.
Only rely on the context below for factual course details.
If missing, answer generally"

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

Respond plainly with course suggestions from the context above.
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
        max_tokens: 250,
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
   Main entry (ALL Q&A → RAG → Answer)
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

    // ==== Dataset-first (now analytical over full JSON) ====
    const result = await queryDataset(messageText, { max: 200 });
    if (result && (result.rows?.length || result.count !== undefined)) {
      const reply = formatAnalyticReply(result);
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    // ==== Generic fallback (no web) ====
    const subject = messageText;
    const genericReply = `I don’t know exactly about this. For ${subject}, check top UK universities’ course pages (e.g., Oxford, Cambridge, Imperial, UCL, Edinburgh) and look for upcoming intakes. I can also try a nearby subject or different keyword if you want.`;
    try { await saveConversation(uid, messageText, genericReply); } catch (_) {}
    profile.conversationHistory.push({ message: messageText, response: genericReply, timestamp: new Date() });
    if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
    if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
    return genericReply;

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
