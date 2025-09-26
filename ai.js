const axios = require("axios");
const { supabase, OPENROUTER_API_KEY, NESTORIA_ENDPOINT } = require("./config");
const { normBase, queryDataset } = require("./rag");
const { addReminder } = require("./reminder");
const chrono = require("chrono-node");
const {
  handleConnectIntent,
  handleAcceptCode,
  upsertUserLocation,
} = require("./match");

/* ============================
   Onboarding & App State
============================= */
const ONBOARDING_STEPS = {
  NAME: 1,
  INTERESTS: 2,
  GOALS: 3,
  COUNTRY: 4,
  COMPLETE: 0,
};
const GREETING_PATTERNS = /\b(hello|hi|hey)\b/i;
const ACCO_PATTERNS =
  /\b(accommodation|accomodation|rent|room|flat|house|hall|student hall|dorm|hostel)\b/i;
const MORE_PATTERNS = /^(more|next|show me more|see more)\b/i;
const ACCEPT_PAT = /^accept\s+(\d{4,6})$/i;

const activeSessions = new Map();

/* ============================
   Intent Classifier (LLM)
============================= */
async function classifyIntent(messageText) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Classify the student's intent into one of:
[reminder, connect, accommodation, course, general].
Rules:
- "connect" also covers: find me someone nearby, match me, buddy, peer, student, friend, etc.
- "reminder" also covers: set reminder, remind me, alarm, notify me.
- "accommodation" also covers: housing, rent, dorm, hostel, flat, hall.
- If it's about courses, unis, applications → "course".
- Otherwise → "general".
Respond with only one word.`,
          },
          { role: "user", content: messageText },
        ],
        max_tokens: 5,
        temperature: 0,
      },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } }
    );

    return res.data?.choices?.[0]?.message?.content?.toLowerCase().trim() || "general";
  } catch (err) {
    console.error("intent classify error:", err.message);
    return "general";
  }
}

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
    lastOffset: 0,
  };
}

function extractTextFromMessage(message) {
  if (!message) return null;
  if (typeof message === "string") return message.trim();
  if (typeof message.conversation === "string") return message.conversation.trim();
  if (message.message?.conversation) return message.message.conversation.trim();
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text.trim();
  if (message.message?.extendedTextMessage?.text) return message.message.extendedTextMessage.text.trim();
  if (message.imageMessage?.caption) return message.imageMessage.caption.trim();
  if (message.message?.imageMessage?.caption) return message.message.imageMessage.caption.trim();
  if (message.videoMessage?.caption) return message.videoMessage.caption.trim();
  if (message.message?.videoMessage?.caption) return message.message.videoMessage.caption.trim();
  if (message.text) {
    if (typeof message.text === "string") return message.text.trim();
    if (message.text.body) return message.text.body.trim();
  }
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

/* ============================
   Supabase DB Helpers
============================= */
async function checkUserExists(userId) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    return { exists: !!data, user: data || null };
  } catch (error) {
    return { exists: false, user: null };
  }
}
async function createUserInDB(userId, profile) {
  await supabase.from("users").insert([
    {
      user_id: userId,
      name: profile.name,
      interests: profile.interests,
      goals: profile.goals,
      country: profile.country,
      created_at: new Date(),
      last_interaction: new Date(),
    },
  ]);
}
async function updateUserInDB(userId, updates) {
  await supabase
    .from("users")
    .update({ ...updates, last_interaction: new Date() })
    .eq("user_id", userId);
}
async function getConversationHistory(userId) {
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(20);
  return data || [];
}
async function saveConversation(userId, message, response) {
  await supabase.from("conversations").insert([
    { user_id: userId, message, response, created_at: new Date() },
  ]);
}

/* ============================
   Reminder Handling
============================= */
async function handleReminder(uid, messageText) {
  const parsed = chrono.parse(messageText);
  let date = null;
  let task = null;
  if (parsed.length > 0) {
    date = parsed[0].start.date();
    const textTime = parsed[0].text;
    task = messageText.replace(textTime, "").trim();
  }
  if (!date) return "I couldn’t detect a valid time. Try: 'remind me tomorrow at 9am to check mail'.";
  if (!task) return "What should I remind you about?";
  await addReminder(uid, task, date);
  return `✅ Got it! I’ll remind you to *${task}* at ${date.toLocaleString()}.`;
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
  return { place_name, price_max, bedrooms };
}
async function searchUKAccommodation(prefs) {
  if (!prefs.place_name) return { listings: [], meta: { message: "No location provided" } };
  const params = {
    encoding: "json",
    action: "search_listings",
    country: "uk",
    listing_type: "rent",
    page: 1,
    number_of_results: 8,
    place_name: prefs.place_name,
  };
  if (prefs.price_max) params.price_max = prefs.price_max;
  try {
    const r = await axios.get(NESTORIA_ENDPOINT, { params, timeout: 15000 });
    const body = r.data?.response || {};
    const listings = (body.listings || []).map((x) => ({
      title: x.title || `${x.bedroom_number || ""} bed ${x.property_type || "property"}`.trim(),
      price_formatted: x.price_formatted || `£${x.price} pcm`,
      address: x.formatted_address || "",
      url: x.lister_url || "",
    }));
    return { listings };
  } catch {
    return { listings: [] };
  }
}
function formatAccommodationReply(listings) {
  if (!listings.length) return "Couldn’t find live listings—try another area or raise budget.";
  return listings
    .slice(0, 5)
    .map((l) => `• ${l.title} – ${l.price_formatted}\n  ${l.address}${l.url ? `\n  ${l.url}` : ""}`)
    .join("\n");
}

/* ============================
   Main entry
============================= */
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);
    let messageText = typeof rawMessage === "object" ? extractTextFromMessage(rawMessage) : rawMessage;

    // ✅ Special-case: location messages
    const locMsg = rawMessage?.message?.locationMessage;
    if (!messageText) {
      if (locMsg) {
        await upsertUserLocation(uid, {
          lat: locMsg.degreesLatitude,
          lon: locMsg.degreesLongitude,
          city: null,
          discoverable: true,
          radiusKm: 10,
        });
        return "📍 Got your location. You’re now discoverable to nearby students!";
      }
      return "Text only please 🙂";
    }

    messageText = validateMessage(messageText);
    const lowerMsg = messageText.toLowerCase();

    /* ==== Intent detection ==== */
    const intent = await classifyIntent(messageText);

    // Accept code
    const acceptHit = messageText.match(ACCEPT_PAT);
    if (acceptHit) return await handleAcceptCode(uid, acceptHit[1]);

    // Reminder
    if (intent === "reminder" || /remind|reminder|alarm/i.test(lowerMsg)) {
      return await handleReminder(uid, messageText);
    }

    // Connect
    if (intent === "connect") {
      const topicMatch = messageText.match(/\b(?:about|on|for)\s+(.{3,60})$/i);
      const topic = topicMatch ? topicMatch[1].trim() : "";
      return await handleConnectIntent({ requesterId: uid, topic, radiusKm: 10 });
    }

    // Accommodation
    if (intent === "accommodation" || ACCO_PAT.test(lowerMsg)) {
      const prefs = parseAccommodationQuery(messageText);
      if (!prefs.place_name) return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      const { listings } = await searchUKAccommodation(prefs);
      return formatAccommodationReply(listings);
    }

    // Course / Dataset
    if (intent === "course") {
      const result = await queryDataset(messageText, { max: 200 });
      if (result?.rows?.length) return formatCourseSlice(result.rows, 0, 5, result.text || "");
    }

    // Greeting
    if (GREETING_PATTERNS.test(lowerMsg)) return `Hey 👋 How can I help?`;

    // Default fallback: general AI
    return "I’ll try to help! Could you clarify your request?";
  } catch (err) {
    console.error("getAIResponse error:", err);
    return "Sorry, something went wrong.";
  }
}

/* ============================
   Exports
============================= */
module.exports = {
  getAIResponse,
};
