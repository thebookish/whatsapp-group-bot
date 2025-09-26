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

const activeSessions = new Map();

/* ============================
   Patterns
============================= */
const GREETING_PATTERNS = /\b(hello|hi|hey)\b/i;
const ACCO_PATTERNS =
  /\b(accommodation|accomodation|rent|room|flat|house|hall|student hall|dorm|hostel)\b/i;
const MORE_PATTERNS = /^(more|next|show me more|see more)\b/i;
const ACCEPT_PAT = /^accept\s+(\d{4,6})$/i;

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
   Supabase Helpers
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
    console.error("Error checking user existence:", error);
    return { exists: false, user: null };
  }
}
async function createUserInDB(userId, profile) {
  await supabase.from("users").insert([{
    user_id: userId,
    name: profile.name,
    interests: profile.interests,
    goals: profile.goals,
    country: profile.country,
    created_at: new Date(),
    last_interaction: new Date(),
  }]);
}
async function updateUserInDB(userId, updates) {
  await supabase.from("users").update({
    ...updates,
    last_interaction: new Date(),
  }).eq("user_id", userId);
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
  await supabase.from("conversations").insert([{
    user_id: userId,
    message,
    response,
    created_at: new Date(),
  }]);
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
   Accommodation
============================= */
function parseAccommodationQuery(text) {
  const q = normBase(text);
  const priceMatch = q.match(/\b(?:under|<=?|max|up to)\s*[£$]?\s*(\d{2,5})\b/);
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

async function searchUKAccommodation({ place_name, price_max, bedrooms, page = 1, num = 8 }) {
  if (!place_name) return { listings: [] };
  const params = {
    encoding: "json",
    action: "search_listings",
    country: "uk",
    listing_type: "rent",
    page,
    number_of_results: num,
    place_name,
  };
  if (price_max) params.price_max = price_max;
  if (typeof bedrooms === "number") {
    if (bedrooms === 0) params.bedroom_max = 0;
    else {
      params.bedroom_min = bedrooms;
      params.bedroom_max = bedrooms;
    }
  }
  const r = await axios.get(NESTORIA_ENDPOINT, { params });
  const body = r.data?.response || {};
  return { listings: body.listings || [] };
}
function formatAccommodationReply(listings) {
  if (!listings.length) return "Couldn’t find live listings for that.";
  return listings.slice(0, 5).map(
    (l) => `• ${l.title || "Property"} – ${l.price_formatted || ""}\n  ${l.formatted_address || ""}${l.lister_url ? `\n  ${l.lister_url}` : ""}`
  ).join("\n");
}

/* ============================
   Intent Classifier
============================= */
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/remind|reminder|notify|alarm/.test(t)) return "reminder";
  if (/connect|find|match|buddy|peer|student|friend/.test(t) && /near|nearby|around|close|here/.test(t)) return "connect";
  if (/accommodation|room|flat|house|rent|hall|dorm|hostel/.test(t)) return "accommodation";
  if (/accept\s+\d{4,6}/.test(t)) return "accept";
  if (/hello|hi|hey/.test(t)) return "greeting";
  return "general";
}

/* ============================
   Main entry
============================= */
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);
    let messageText = typeof rawMessage === "object" ? extractTextFromMessage(rawMessage) : rawMessage;

    // Location messages
    const locMsg = rawMessage?.message?.locationMessage;
    if (!messageText) {
      if (locMsg && typeof locMsg.degreesLatitude === "number") {
        await upsertUserLocation(uid, {
          lat: locMsg.degreesLatitude,
          lon: locMsg.degreesLongitude,
          city: null,
          discoverable: true,
          radiusKm: 10,
        });
        return "📍 Got your location. You’re now discoverable to nearby students!";
      } else return "Text only please 🙂";
    }

    messageText = validateMessage(messageText);
    const lowerMsg = messageText.toLowerCase();

    const { exists, user } = await checkUserExists(uid);
    let profile;
    if (activeSessions.has(uid)) profile = activeSessions.get(uid);
    else if (exists && user) {
      profile = {
        name: user.name || "",
        interests: user.interests || "",
        goals: user.goals || "",
        country: user.country || "",
        onboardingStep: ONBOARDING_STEPS.COMPLETE,
        conversationHistory: await getConversationHistory(uid),
        lastRows: null,
        lastOffset: 0,
      };
      activeSessions.set(uid, profile);
      await updateUserInDB(uid, {});
    } else {
      profile = createUserProfile();
      activeSessions.set(uid, profile);
    }

    /* ==== Intent Detection ==== */
    const intent = detectIntent(messageText);

    if (intent === "connect") {
      const topicMatch = messageText.match(/\b(?:about|for)\s+(.{3,60})$/i);
      const topic = topicMatch ? topicMatch[1].trim() : "";
      return await handleConnectIntent({ requesterId: uid, topic, radiusKm: 10 });
    }

    if (intent === "accept") {
      const m = messageText.match(ACCEPT_PAT);
      if (m) return await handleAcceptCode(uid, m[1]);
    }

    if (intent === "reminder") {
      return await handleReminder(uid, messageText);
    }

    if (intent === "accommodation") {
      const prefs = parseAccommodationQuery(messageText);
      if (!prefs.place_name) return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      const { listings } = await searchUKAccommodation(prefs);
      return formatAccommodationReply(listings);
    }

    if (intent === "greeting") {
      return `Hey ${profile.name || "there"} 👋 How can I help?`;
    }

    /* ==== Onboarding ==== */
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME:
          if (isGreetingOnly(messageText)) return `Hey! I’m your study buddy. What’s your name?`;
          const name = extractNameFromText(messageText);
          if (!name) return `All good—tell me your name (e.g., "I'm Nabil Hasan").`;
          profile.name = name;
          profile.onboardingStep = ONBOARDING_STEPS.INTERESTS;
          return `Nice to meet you, ${profile.name}! What subjects are you into?`;
        case ONBOARDING_STEPS.INTERESTS:
          profile.interests = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.GOALS;
          return `Got it. What’s your main goal—scholarship, admission, job?`;
        case ONBOARDING_STEPS.GOALS:
          profile.goals = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COUNTRY;
          return `Cool. Which country are you in / targeting?`;
        case ONBOARDING_STEPS.COUNTRY:
          profile.country = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COMPLETE;
          await createUserInDB(uid, profile);
          return `Profile saved ✅ Ask me anything about courses, unis, or apps.`;
      }
    }

    /* ==== Dataset Fallback ==== */
    const result = await queryDataset(messageText, { max: 200 });
    if (result && Array.isArray(result.rows) && result.rows.length) {
      profile.lastRows = result.rows;
      profile.lastOffset = Math.min(5, result.rows.length);
      return result.text + "\n\n" + result.rows.map((r) => r.course_title).join("\n");
    }

    return "I’m not sure yet. Tell me subject, level, campus/city, and start month—I'll suggest options.";
  } catch (err) {
    console.error("getAIResponse error:", err.message);
    return "Sorry, something went wrong.";
  }
}

module.exports = {
  getAIResponse,
  clearUserData: (uid) => activeSessions.delete(uid),
};
