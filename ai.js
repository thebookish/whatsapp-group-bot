const axios = require('axios');
const { supabase, OPENROUTER_API_KEY, NESTORIA_ENDPOINT } = require('./config');
const { normBase, queryDataset } = require('./rag');
const { addReminder } = require('./reminder');   // make sure file is reminders.js
const chrono = require('chrono-node');

/* ============================
   Onboarding & App State
============================= */
const ONBOARDING_STEPS = { NAME: 1, INTERESTS: 2, GOALS: 3, COUNTRY: 4, COMPLETE: 0 };
const GREETING_PATTERNS = /\b(hello|hi|hey)\b/i;
const ACCO_PATTERNS = /\b(accommodation|accomodation|rent|room|flat|house|hall|student hall|dorm|hostel)\b/i;
const MORE_PATTERNS = /^(more|next|show me more|see more)\b/i;

const activeSessions = new Map();

/* ============================
   Helpers
============================= */
function createUserProfile() {
  return {
    name: '',
    interests: '',
    goals: '',
    country: '',
    onboardingStep: ONBOARDING_STEPS.NAME,
    lastInteraction: new Date(),
    conversationHistory: [],
    lastRows: null,
    lastOffset: 0
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
   Reminder Handling
============================= */
async function handleReminder(uid, messageText) {
  console.log("🔔 Reminder intent detected:", messageText);

  const parsed = chrono.parse(messageText);
  let date = null;
  let task = null;

  if (parsed.length > 0) {
    date = parsed[0].start.date();
    const textTime = parsed[0].text;
    task = messageText
      .replace(/^(remind me|add reminder)\b/i, '')
      .replace(textTime, '')
      .trim();
  }

  if (!date) {
    return "I couldn’t detect a valid time. Try: 'remind me tomorrow at 9am to check mail'.";
  }
  if (!task) {
    return "What should I remind you about?";
  }

  await addReminder(uid, task, date);
  // if (!saved) {
  //   return "❌ Failed to save reminder. Please try again.";
  // }

  return `✅ Got it! I’ll remind you to *${task}* at ${date.toLocaleString()}.`;
}

/* ============================
   Course result formatting
============================= */
function formatCourseSlice(rows, start = 0, size = 5, head = '') {
  const slice = rows.slice(start, start + size);
  if (!slice.length) return 'No more results.';

  const lines = slice.map(r => {
    const title = r.raw?.course_title || r.course_title || 'Course';
    const qual = r.raw?.qualification || r.qualification || '';
    const campus = r.raw?.campus || r.campus || '';
    const startDate = r.raw?.start_date_raw || r.start_date || '';
    const app = r.raw?.application_code || r.application_code || '';

    let out = `*${title}*`;
    if (qual) out += `\n  Qualification: ${qual}`;
    if (campus) out += `\n  Campus: ${campus}`;
    if (startDate) out += `\n  Start: ${startDate}`;
    if (app) out += `\n  Code: ${app}`;
    return out;
  });

  const footer = `\n\nReply "more" to see more options.`;
  return head ? `${head}\n\n${lines.join('\n\n')}${footer}` : `${lines.join('\n\n')}${footer}`;
}

/* ============================
   LLM
============================= */
async function generateAIResponse(profile, studentMessage, conversationHistory = [], ragContext = '') {
  const historyContext = conversationHistory
    .map(h => `User: ${h.message}\nAssistant: ${h.response}`)
    .join('\n');

  const systemPrompt = `
You are a helpful Student Assistant. Keep answers short and natural.
If RAG context is provided, rely on it for factual course details.
If it's missing or irrelevant, answer generally and helpfully.
`.trim();

  const ragBlock = ragContext ? `\nRAG Context:\n${ragContext}\n` : '';

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
${ragBlock}
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
   Main entry
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
        conversationHistory: await getConversationHistory(uid),
        lastRows: null,
        lastOffset: 0
      };
      activeSessions.set(uid, profile);
      try { await updateUserInDB(uid, {}); } catch (_) {}
    } else {
      profile = createUserProfile();
      activeSessions.set(uid, profile);
    }

    /* ==== Reminder ==== */
    if (/^(remind me|add reminder)\b/i.test(messageText)) {
      return await handleReminder(uid, messageText);
    }

    /* ==== More pagination ==== */
    if (MORE_PATTERNS.test(lowerMsg) && Array.isArray(profile.lastRows) && profile.lastRows.length) {
      const start = profile.lastOffset || 0;
      const reply = formatCourseSlice(profile.lastRows, start, 5);
      profile.lastOffset = Math.min(start + 5, profile.lastRows.length);
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    } else {
      profile.lastRows = null;
      profile.lastOffset = 0;
    }

    /* ==== Onboarding ==== */
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      // ... (same as before, unchanged)
    }

    /* ==== Greeting ==== */
    if (GREETING_PATTERNS.test(lowerMsg)) {
      return `Hey ${profile.name || 'there'} 👋 How can I help?`;
    }

    /* ==== Accommodation ==== */
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

    /* ==== Dataset ==== */
    const result = await queryDataset(messageText, { max: 200 });
    // ... same as before (LLM fallback + course results)

    return "I’m not sure yet. Tell me the subject, level (UG/PG), preferred campus/city, and start month—I'll suggest options.";
  } catch (error) {
    console.error('getAIResponse error:', error.message);
    return "Sorry, something went wrong.";
  }
}

/* ============================
   Exports
============================= */
module.exports = {
  getAIResponse,
  clearUserData: (userId) => activeSessions.delete(userId),
  getUserStats: async () => {
    try {
      const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { count: activeUsers } = await supabase
        .from('users').select('*', { count: 'exact', head: true })
        .gte('last_interaction', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      return { totalUsers: totalUsers || 0, activeUsers: activeUsers || 0, activeSessions: activeSessions.size };
    } catch (error) {
      return { totalUsers: 0, activeUsers: 0, activeSessions: activeSessions.size };
    }
  }
};
