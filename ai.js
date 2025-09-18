const axios = require("axios");
const { supabase, OPENROUTER_API_KEY, NESTORIA_ENDPOINT } = require("./config");
const { normBase, queryDataset } = require("./rag");
const { addReminder } = require("./reminders");
const chrono = require("chrono-node");

/* ============================
   Messaging adapters (injected from server.js)
============================= */
let sendFn = null;         // (jid, text) => Promise
let createGroupFn = null;  // (subject, jids[]) => Promise<{ id }>
function setMessagingAdapters({ send, createGroup }) {
  sendFn = send;
  createGroupFn = createGroup;
}

/* ============================
   Onboarding & App State
============================= */
const ONBOARDING_STEPS = { NAME: 1, INTERESTS: 2, GOALS: 3, COUNTRY: 4, COMPLETE: 0 };
const GREETING_PATTERNS = /\b(hello|hi|hey)\b/i;
const ACCO_PATTERNS = /\b(accommodation|accomodation|rent|room|flat|house|hall|student hall|dorm|hostel)\b/i;
const MORE_PATTERNS = /^(more|next|show me more|see more)\b/i;

const CONNECT_PAT = /\b(connect|find|match)\b.*\b(student|buddy|peer|friend)\b.*\b(near|nearby|around|close)\b/i;
const ACCEPT_PAT  = /^accept\s+(\d{4,6})$/i;

const activeSessions = new Map();

/* ============================
   Helpers
============================= */
function createUserProfile() {
  return {
    name: "",
    interests: "",
    goals: "",
    country: "",
    onboardingStep: ONBOARDING_STEPS.NAME,
    lastInteraction: new Date(),
    conversationHistory: [],
    lastRows: null,
    lastOffset: 0
  };
}

function extractTextFromMessage(message) {
  if (!message) return null;
  if (typeof message === "string") return message.trim();
  if (typeof message.conversation === "string") return message.conversation.trim();
  if (message.message?.extendedTextMessage?.text) return message.message.extendedTextMessage.text.trim();
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text.trim();
  if (message.imageMessage?.caption) return message.imageMessage.caption.trim();
  if (message.message?.imageMessage?.caption) return message.message.imageMessage.caption.trim();
  if (message.videoMessage?.caption) return message.videoMessage.caption.trim();
  if (message.message?.videoMessage?.caption) return message.message.videoMessage.caption.trim();
  if (message.text) {
    if (typeof message.text === "string") return message.text.trim();
    if (message.text.body) return message.text.body.trim();
  }
  if (message.message?.conversation) return message.message.conversation.trim();
  return null;
}

function validateUserId(userId) {
  if (!userId || typeof userId !== "string") throw new Error("Invalid userId");
  return userId;
}
function validateMessage(msg) {
  if (!msg || typeof msg !== "string" || !msg.trim()) throw new Error("Empty message");
  if (msg.length > 1000) throw new Error("Message too long");
  return msg.trim();
}
function isGreetingOnly(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z\s']/g, " ").trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => /(hello|hi|hey|start|begin)/.test(w));
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
  return "";
}

/* ============================
   Supabase DB Helpers
============================= */
async function checkUserExists(userId) {
  try {
    const { data, error } = await supabase.from("users").select("*").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") throw error;
    return { exists: !!data, user: data || null };
  } catch (error) {
    console.error("Error checking user existence:", error);
    return { exists: false, user: null };
  }
}
async function createUserInDB(userId, profile) {
  try {
    const { data, error } = await supabase
      .from("users")
      .insert([{
        user_id: userId,
        name: profile.name,
        interests: profile.interests,
        goals: profile.goals,
        country: profile.country,
        created_at: new Date(),
        last_interaction: new Date()
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error creating user in DB:", error);
    throw error;
  }
}
async function updateUserInDB(userId, updates) {
  try {
    const { data, error } = await supabase
      .from("users")
      .update({ ...updates, last_interaction: new Date() })
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error updating user in DB:", error);
    throw error;
  }
}
async function getConversationHistory(userId) {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error getting conversation history:", error);
    return [];
  }
}
async function saveConversation(userId, message, response) {
  try {
    const { error } = await supabase.from("conversations").insert([{
      user_id: userId, message, response, created_at: new Date()
    }]);
    if (error) throw error;
  } catch (error) {
    console.error("Error saving conversation:", error);
  }
}

/* ============================
   Nearby student matching (folded in)
============================= */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
async function upsertUserLocation(userId, { lat, lon, city = null, discoverable = true, radiusKm = 10 }) {
  const updates = {
    lat, lon, city,
    discoverable,
    discoverable_radius_km: radiusKm,
    last_location_at: new Date().toISOString()
  };
  const { error } = await supabase.from('users').update(updates).eq('user_id', userId);
  if (error) throw error;
  return true;
}
async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
  if (error) throw error;
  return data;
}
async function findNearby(userId, lat, lon, radiusKm = 10, limit = 5) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1e-6);

  const { data, error } = await supabase
    .from('users')
    .select('user_id,name,lat,lon,interests,discoverable,discoverable_radius_km')
    .neq('user_id', userId)
    .eq('discoverable', true)
    .gte('lat', lat - dLat).lte('lat', lat + dLat)
    .gte('lon', lon - dLon).lte('lon', lon + dLon);

  if (error) throw error;

  const withDist = (data || [])
    .filter(u => typeof u.lat === 'number' && typeof u.lon === 'number')
    .map(u => ({ ...u, distance_km: haversineKm(lat, lon, u.lat, u.lon) }))
    .filter(u => u.distance_km <= Math.min(radiusKm, u.discoverable_radius_km || radiusKm))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);

  return withDist;
}
function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
async function handleConnectIntent({ requesterId, topic = '', radiusKm = 10 }) {
  if (!sendFn) return "Messaging not ready—try again in a moment.";

  const me = await getUser(requesterId);
  if (!me?.lat || !me?.lon) {
    return `Share your location first (Attach → Location), then say: "connect me to a student near me${topic ? ' about ' + topic : ''}".`;
  }

  const candidates = await findNearby(requesterId, me.lat, me.lon, radiusKm, 5);
  if (!candidates.length) {
    return `I couldn’t find discoverable students within ~${radiusKm} km. Ask friends to enable discoverability or widen the radius.`;
  }

  for (const cand of candidates) {
    const code = makeCode();
    const { error } = await supabase.from('match_invites').insert([{
      code,
      requester_id: requesterId,
      invitee_id: cand.user_id,
      topic,
      lat: me.lat, lon: me.lon,
      distance_km: cand.distance_km
    }]);
    if (error) { console.error('invite insert error:', error); continue; }

    const intro = [
      `👋 Hi${cand.name ? ' ' + cand.name : ''}!`,
      `A nearby student wants to connect${topic ? ' about *' + topic + '*' : ''}.`,
      `Distance: ~${Math.round(cand.distance_km)} km.`,
      `If you’re open, reply: *accept ${code}*`,
      `To ignore, just do nothing.`
    ].join('\n');
    await sendFn(cand.user_id, intro);
  }

  return `I’ve messaged a few nearby students${topic ? ' about *' + topic + '*' : ''}. If someone accepts, I’ll intro you both in a new WhatsApp chat.`;
}
async function handleAcceptCode(inviteeId, code) {
  if (!sendFn || !createGroupFn) return 'Messaging not ready—try again shortly.';

  const { data, error } = await supabase
    .from('match_invites')
    .select('*')
    .eq('invitee_id', inviteeId)
    .eq('code', code)
    .eq('accepted', false)
    .limit(1);
  if (error) { console.error('invite fetch error:', error); return 'Something went wrong looking up that code.'; }
  const invite = data?.[0];
  if (!invite) return `That code isn't valid anymore.`;

  const { error: updErr } = await supabase.from('match_invites').update({ accepted: true }).eq('id', invite.id);
  if (updErr) { console.error('invite update error:', updErr); return 'Could not accept that invite (db error).'; }

  const requester = await getUser(invite.requester_id);
  const invitee   = await getUser(inviteeId);

  const subject = `Study Buddy${invite.topic ? ': ' + invite.topic : ''}`;
  try {
    const group = await createGroupFn(subject, [invite.requester_id, inviteeId]);
    const groupJid = group?.id || group;
    await sendFn(groupJid, [
      `🎉 Intro time!`,
      `${requester?.name || 'Student A'} ↔ ${invitee?.name || 'Student B'}`,
      invite.topic ? `Topic: *${invite.topic}*` : null,
      `Say hi and take it from here.`
    ].filter(Boolean).join('\n'));
  } catch (e) {
    console.error('groupCreate error:', e);
    await sendFn(invite.requester_id, `✅ ${invitee?.name || 'A student'} accepted your request${invite.topic ? ' about ' + invite.topic : ''}. You can message them directly here.`);
    await sendFn(inviteeId, `✅ Intro created with ${requester?.name || 'a student'}. You can message them directly here.`);
  }
  return `You’re connected! I made a group so you can chat.`;
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
  if (locMatch) place_name = locMatch[1].trim();
  else {
    const cap = (text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [])[0];
    if (cap) place_name = cap.trim();
  }
  return { place_name, price_max, bedrooms };
}

async function searchUKAccommodation({ place_name, price_max, bedrooms, page = 1, num = 8 }) {
  if (!place_name) return { listings: [], meta: { message: "No location provided" } };
  const params = {
    encoding: "json", action: "search_listings", country: "uk", listing_type: "rent",
    page, number_of_results: Math.max(3, Math.min(num, 20)), place_name
  };
  if (price_max) params.price_max = price_max;
  if (typeof bedrooms === "number") {
    if (bedrooms === 0) params.bedroom_max = 0;
    else { params.bedroom_min = bedrooms; params.bedroom_max = bedrooms; }
  }

  try {
    const r = await axios.get(NESTORIA_ENDPOINT, { params, timeout: 15000 });
    const body = r.data && r.data.response ? r.data.response : {};
    const listings = (body.listings || []).map(x => ({
      title: x.title || `${x.bedroom_number || ""} bed ${x.property_type || "property"}`.trim(),
      price: x.price,
      price_formatted: x.price_formatted || (x.price ? `£${x.price} pcm` : ""),
      bedrooms: x.bedroom_number,
      bathrooms: x.bathroom_number,
      property_type: x.property_type,
      address: x.formatted_address || x.summary || "",
      url: x.lister_url || x.url || "",
      thumbnail: x.thumb_url || x.img_url || "",
      latitude: x.latitude,
      longitude: x.longitude
    }));
    return { listings, meta: { total: body.total_results, page: body.page, pages: body.total_pages } };
  } catch (e) {
    console.error("Accommodation API error:", e?.response?.data || e.message);
    return { listings: [], meta: { error: true, message: "Failed to fetch listings" } };
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
   Course result formatting + pagination
============================= */
function formatCourseSlice(rows, start = 0, size = 5, head = "") {
  const slice = rows.slice(start, start + size);
  if (!slice.length) return "No more results.";

  const lines = slice.map((r) => {
    const title = r.raw?.course_title || r.course_title || "Course";
    const qual = r.raw?.qualification || r.qualification || "";
    const campus = r.raw?.campus || r.campus || "";
    const startDate = r.raw?.start_date_raw || r.start_date || "";
    const app = r.raw?.application_code || r.application_code || "";

    let out = `*${title}*`;
    if (qual) out += `\n  Qualification: ${qual}`;
    if (campus) out += `\n  Campus: ${campus}`;
    if (startDate) out += `\n  Start: ${startDate}`;
    if (app) out += `\n  Code: ${app}`;
    return out;
  });

  const footer = `\n\nReply "more" to see more options.`;
  return head ? `${head}\n\n${lines.join("\n\n")}${footer}` : `${lines.join("\n\n")}${footer}`;
}

/* ============================
   LLM (general + fallback)
============================= */
async function generateAIResponse(profile, studentMessage, conversationHistory = [], ragContext = "") {
  const historyContext = conversationHistory.map(h => `User: ${h.message}\nAssistant: ${h.response}`).join("\n");
  const systemPrompt = `
You are a helpful Student Assistant. Keep answers short and natural.
If RAG context is provided, rely on it for factual course details.
If it's missing or irrelevant, answer generally and helpfully.
`.trim();
  const ragBlock = ragContext ? `\nRAG Context:\n${ragContext}\n` : "";
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
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 250,
        temperature: 0.4
      },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    return res.data?.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
  } catch (error) {
    console.error("AI API error:", error?.response?.data || error.message);
    return "Sorry, I couldn't process that right now.";
  }
}

/* ============================
   Main entry (router + logic)
============================= */
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);

    // capture text
    let messageText = typeof rawMessage === "object" ? extractTextFromMessage(rawMessage) : rawMessage;
    if (!messageText) return "Text only please 🙂";
    messageText = validateMessage(messageText);
    const lowerMsg = messageText.toLowerCase();

    // ensure profile
    const { exists, user } = await checkUserExists(uid);
    let profile;
    if (activeSessions.has(uid)) {
      profile = activeSessions.get(uid);
    } else if (exists && user) {
      profile = {
        name: user.name || "",
        interests: user.interests || "",
        goals: user.goals || "",
        country: user.country || "",
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

    // 1) Location capture (when user shares WhatsApp location)
    const locMsg = rawMessage?.message?.locationMessage;
    if (locMsg && typeof locMsg.degreesLatitude === 'number' && typeof locMsg.degreesLongitude === 'number') {
      try {
        await upsertUserLocation(uid, {
          lat: locMsg.degreesLatitude,
          lon: locMsg.degreesLongitude,
          city: null, discoverable: true, radiusKm: 10
        });
        // not altering normal flow; optional confirmation:
        // return "📍 Got your location. You’re now discoverable to nearby students.";
      } catch (e) { console.error('upsertUserLocation error:', e); }
    }

    // 2) Reminder detection
    if (/^(remind me|add reminder)\b/i.test(messageText)) {
      const parsed = chrono.parse(messageText);
      let date = null; let task = null;
      if (parsed.length > 0) {
        date = parsed[0].start.date();
        const textTime = parsed[0].text;
        task = messageText.replace(/^(remind me|add reminder)\b/i, "").replace(textTime, "").trim();
      }
      if (!date) return "I couldn’t detect a valid time. Try: 'remind me tomorrow at 9am to check mail'.";
      if (!task) return "What should I remind you about?";
      const saved = await addReminder(uid, task, date);
      if (!saved) return "❌ Failed to save reminder. Please try again.";
      return `✅ Got it! I’ll remind you to *${task}* at ${date.toLocaleString()}.`;
    }

    // 3) Accept code (match)
    const acceptHit = messageText.match(ACCEPT_PAT);
    if (acceptHit) {
      const code = acceptHit[1];
      const res = await handleAcceptCode(uid, code);
      return res;
    }

    // 4) Connect me intent
    if (CONNECT_PAT.test(messageText)) {
      const topicMatch = messageText.match(/\b(?:about|for)\s+(.{3,60})$/i);
      const topic = topicMatch ? topicMatch[1].trim() : '';
      const reply = await handleConnectIntent({ requesterId: uid, topic, radiusKm: 10 });
      return reply;
    }

    // Optional discoverability toggles
    if (/make me discoverable/i.test(messageText)) {
      const { error } = await supabase.from('users').update({ discoverable: true }).eq('user_id', uid);
      return error ? 'Could not update discoverability.' : 'You’re now discoverable to nearby students.';
    }
    if (/stop discoverable|hide me/i.test(messageText)) {
      const { error } = await supabase.from('users').update({ discoverable: false }).eq('user_id', uid);
      return error ? 'Could not update discoverability.' : 'Got it. You’re no longer discoverable.';
    }

    // 5) More pagination
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

    // 6) Onboarding
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
          try { await createUserInDB(uid, profile); }
          catch (e) {
            try { await updateUserInDB(uid, {
              name: profile.name, interests: profile.interests, goals: profile.goals, country: profile.country
            }); } catch (_) {}
          }
          return `Profile saved ✅ Ask me anything about courses, unis, or apps.`;
        }
      }
    }

    // 7) Greeting shortcut
    if (GREETING_PATTERNS.test(lowerMsg)) {
      return `Hey ${profile.name || "there"} 👋 How can I help?`;
    }

    // 8) Accommodation lookup
    if (ACCO_PATTERNS.test(lowerMsg)) {
      const prefs = parseAccommodationQuery(messageText);
      if (!prefs.place_name) return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      const { listings } = await searchUKAccommodation(prefs);
      const reply = formatAccommodationReply(listings);
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    // 9) Dataset (rag)
    const result = await queryDataset(messageText, { max: 200 });

    if (result && result.intent === "GENERAL") {
      const reply = await generateAIResponse(profile, messageText, profile.conversationHistory, "");
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    if (result && Array.isArray(result.rows) && result.rows.length) {
      const head = result.text || "";
      const reply = formatCourseSlice(result.rows, 0, 5, head);
      profile.lastRows = result.rows;
      profile.lastOffset = Math.min(5, result.rows.length);
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    if (result && (!result.rows || !result.rows.length)) {
      const reply = await generateAIResponse(profile, messageText, profile.conversationHistory, "");
      try { await saveConversation(uid, messageText, reply); } catch (_) {}
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
      if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
      return reply;
    }

    // 10) Final fallback
    const genericReply = `I’m not sure yet. Tell me the subject, level (UG/PG), preferred campus/city, and start month—I'll suggest options.`;
    try { await saveConversation(uid, messageText, genericReply); } catch (_) {}
    profile.conversationHistory.push({ message: messageText, response: genericReply, timestamp: new Date() });
    if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();
    if (exists) { try { await updateUserInDB(uid, {}); } catch (_) {} }
    return genericReply;

  } catch (error) {
    console.error("getAIResponse error:", error.message);
    if (error.message.includes("Invalid userId")) return "Invalid user ID.";
    if (error.message.includes("Empty message")) return "Please send a text 🙂";
    if (error.message.includes("Message too long")) return "Too long—keep it under 1000 chars.";
    return "Sorry, something went wrong.";
  }
}

/* ============================
   Exports
============================= */
module.exports = {
  getAIResponse,
  setMessagingAdapters,
  clearUserData: (userId) => activeSessions.delete(userId),
  getUserStats: async () => {
    try {
      const { count: totalUsers } = await supabase.from("users").select("*", { count: "exact", head: true });
      const { count: activeUsers } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true })
        .gte("last_interaction", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      return { totalUsers: totalUsers || 0, activeUsers: activeUsers || 0, activeSessions: 0 };
    } catch {
      return { totalUsers: 0, activeUsers: 0, activeSessions: 0 };
    }
  }
};
