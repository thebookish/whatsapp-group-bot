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
const MORE_PATTERNS = /^(more|next|show me more|see more)\b/i;
const ACCEPT_PAT = /^accept\s+(\d{4,6})$/i;

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
   Intent Detection
============================= */
function detectIntent(text) {
  const t = text.toLowerCase();

  if (/\b(remind|reminder|notify|alarm|remember)\b/.test(t)) return "reminder";

  if (
    /\b(connect|find|match|buddy|peer|student|friend|someone|anyone|people)\b/.test(t) &&
    (/\b(near|nearby|around|close|here|doing|interested in)\b/.test(t) || /find someone/.test(t))
  ) return "connect";

  if (
    /\b(accommodation|accomodation|rent|room|flat|house|hall|student hall|dorm|hostel|housing|place to live)\b/.test(t)
  ) return "accommodation";

  if (/^accept\s+\d{4,6}/.test(t)) return "accept";

  if (/\b(hello|hi|hey)\b/.test(t)) return "greeting";

  return "general";
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
    return { exists: false, user: null };
  }
}
async function createUserInDB(userId, profile) {
  const { data, error } = await supabase
    .from("users")
    .insert([{
      user_id: userId,
      name: profile.name,
      interests: profile.interests,
      goals: profile.goals,
      country: profile.country,
      created_at: new Date(),
      last_interaction: new Date(),
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}
async function updateUserInDB(userId, updates) {
  const { data, error } = await supabase
    .from("users")
    .update({ ...updates, last_interaction: new Date() })
    .eq("user_id", userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}
async function getConversationHistory(userId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  return data || [];
}
async function saveConversation(userId, message, response) {
  try {
    const { error } = await supabase.from("conversations").insert([{
      user_id: userId,
      message,
      response,
      created_at: new Date(),
    }]);
    if (error) throw error;
  } catch (error) {
    console.error("Error saving conversation:", error);
  }
}

/* ============================
   Reminder Handling
============================= */
async function handleReminder(uid, messageText) {
  const parsed = chrono.parse(messageText);
  let date = null, task = null;
  if (parsed.length > 0) {
    date = parsed[0].start.date();
    const textTime = parsed[0].text;
    task = messageText.replace(/^(remind me|add reminder|can you remind me)\b/i, "").replace(textTime, "").trim();
  }
  if (!date) return "I couldn’t detect a valid time. Try: 'remind me tomorrow at 9am to check mail'.";
  if (!task) return "What should I remind you about?";
  await addReminder(uid, task, date);
  return `✅ Got it! I’ll remind you to *${task}* at ${date.toLocaleString()}.`;
}

/* ============================
   Accommodation Helpers
============================= */
function parseAccommodationQuery(text) {
  const q = normBase(text);
  const priceMatch =
    q.match(/\b(?:under|<=?|max|up to)\s*[£$]?\s*(\d{2,5})\b/) ||
    q.match(/\b[£$]\s*(\d{2,5})\b/);
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
  if (!place_name) return { listings: [], meta: { message: "No location provided" } };
  const params = {
    encoding: "json",
    action: "search_listings",
    country: "uk",
    listing_type: "rent",
    page,
    number_of_results: Math.max(3, Math.min(num, 20)),
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
  try {
    const r = await axios.get(NESTORIA_ENDPOINT, { params, timeout: 15000 });
    const body = r.data && r.data.response ? r.data.response : {};
    const listings = (body.listings || []).map((x) => ({
      title: x.title || `${x.bedroom_number || ""} bed ${x.property_type || "property"}`.trim(),
      price_formatted: x.price_formatted || (x.price ? `£${x.price} pcm` : ""),
      bedrooms: x.bedroom_number,
      address: x.formatted_address || x.summary || "",
      url: x.lister_url || x.url || "",
    }));
    return { listings, meta: { total: body.total_results, page: body.page } };
  } catch (e) {
    return { listings: [], meta: { error: true, message: "Failed to fetch listings" } };
  }
}
function formatAccommodationReply(listings) {
  if (!listings.length) return "Couldn’t find live listings for that—try a nearby area or raise budget a bit?";
  return listings.slice(0, 5).map(
    (l) => `• ${l.title} – ${l.price_formatted}${l.bedrooms != null ? `, ${l.bedrooms} bed` : ""}\n  ${l.address}${l.url ? `\n  ${l.url}` : ""}`
  ).join("\n");
}

/* ============================
   Course results
============================= */
function formatCourseSlice(rows, start = 0, size = 5, head = "") {
  const slice = rows.slice(start, start + size);
  if (!slice.length) return "No more results.";
  const lines = slice.map((r) => {
    const title = r.raw?.course_title || r.course_title || "Course";
    const qual = r.raw?.qualification || r.qualification || "";
    const campus = r.raw?.campus || r.campus || "";
    let out = `*${title}*`;
    if (qual) out += `\n  Qualification: ${qual}`;
    if (campus) out += `\n  Campus: ${campus}`;
    return out;
  });
  return head ? `${head}\n\n${lines.join("\n\n")}\n\nReply "more" to see more options.` : `${lines.join("\n\n")}\n\nReply "more" to see more options.`;
}

/* ============================
   LLM
============================= */
async function generateAIResponse(profile, studentMessage, conversationHistory = [], ragContext = "") {
  const historyContext = conversationHistory.map((h) => `User: ${h.message}\nAssistant: ${h.response}`).join("\n");
  const systemPrompt = `You are a helpful Student Assistant. Keep answers short and natural. If RAG context is provided, rely on it for factual course details. If it's missing or irrelevant, answer generally.`;
  const userPrompt = `Student Info:\n- Name: ${profile.name}\n- Interests: ${profile.interests}\n- Goals: ${profile.goals}\n- Country: ${profile.country}\n\nRecent Chat History:\n${historyContext}\n\nStudent's Latest Question:\n"${studentMessage}"${ragContext ? `\nRAG Context:\n${ragContext}` : ""}`;
  try {
    const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 250,
      temperature: 0.4,
    }, { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, timeout: 15000 });
    return res.data?.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
  } catch {
    return "Sorry, I couldn't process that right now.";
  }
}

/* ============================
   Main entry
============================= */
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);

    // Extract text safely
    let messageText =
      typeof rawMessage === "object"
        ? extractTextFromMessage(rawMessage)
        : rawMessage;

    // 🔒 Always force string
    if (typeof messageText !== "string") {
      messageText = "";
    }

    // Handle location messages
    const locMsg = rawMessage?.message?.locationMessage;
    if (!messageText.trim()) {
      if (
        locMsg &&
        typeof locMsg.degreesLatitude === "number" &&
        typeof locMsg.degreesLongitude === "number"
      ) {
        try {
          await upsertUserLocation(uid, {
            lat: locMsg.degreesLatitude,
            lon: locMsg.degreesLongitude,
            city: null,
            discoverable: true,
            radiusKm: 10,
          });
          return "📍 Got your location. You’re now discoverable to nearby students!";
        } catch {
          return "❌ Failed to save your location.";
        }
      } else {
        return "Text only please 🙂";
      }
    }

    // Validate + detect intent
    messageText = validateMessage(messageText);
    const intent = detectIntent(messageText);
    console.log("👉 Detected intent:", intent, "for:", messageText);

    // Load or create user profile
    const { exists, user } = await checkUserExists(uid);
    let profile;
    if (activeSessions.has(uid)) {
      profile = activeSessions.get(uid);
    } else if (exists && user) {
      profile = {
        ...user,
        onboardingStep: ONBOARDING_STEPS.COMPLETE,
        lastInteraction: new Date(),
        conversationHistory: await getConversationHistory(uid),
        lastRows: null,
        lastOffset: 0,
      };
      activeSessions.set(uid, profile);
      try {
        await updateUserInDB(uid, {});
      } catch {}
    } else {
      profile = createUserProfile();
      activeSessions.set(uid, profile);
    }

    /* ==== Intent routing ==== */
    if (intent === "connect") {
      let topic = "";
      const topicMatch = messageText.match(
        /\b(?:about|for|doing|interested in)\s+(.{3,60})$/i
      );
      if (topicMatch) topic = topicMatch[1].trim();
      return await handleConnectIntent({
        requesterId: uid,
        topic,
        radiusKm: 10,
      });
    }

    if (intent === "accommodation") {
      const prefs = parseAccommodationQuery(messageText || "");
      if (!prefs.place_name)
        return `Tell me the city/area + budget, e.g. "1 bed under £900 in Manchester".`;
      const { listings } = await searchUKAccommodation(prefs);
      return formatAccommodationReply(listings);
    }

    if (intent === "reminder") {
      return await handleReminder(uid, messageText);
    }

    if (intent === "accept") {
      if (messageText.startsWith("ACCEPT_")) {
        const code = messageText.replace("ACCEPT_", "");
        return await handleAcceptCode(uid, code);
      }
      const m = messageText.match(ACCEPT_PAT);
      if (m) return await handleAcceptCode(uid, m[1]);
    }

    if (intent === "greeting") {
      return `Hey ${profile.name || "there"} 👋 How can I help?`;
    }

    /* ==== Pagination ==== */
    if (
      MORE_PATTERNS.test(messageText) &&
      Array.isArray(profile.lastRows) &&
      profile.lastRows.length
    ) {
      const start = profile.lastOffset || 0;
      const reply = formatCourseSlice(profile.lastRows, start, 5);
      profile.lastOffset = Math.min(
        start + 5,
        profile.lastRows.length
      );
      return reply;
    } else {
      profile.lastRows = null;
      profile.lastOffset = 0;
    }

    /* ==== Onboarding ==== */
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME: {
          if (isGreetingOnly(messageText))
            return `Hey! I’m your study buddy. What’s your name?`;
          const name = extractNameFromText(messageText);
          if (!name)
            return `All good—tell me your name (e.g., "I'm Nabil Hasan").`;
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
          } catch {
            try {
              await updateUserInDB(uid, profile);
            } catch {}
          }
          return `Profile saved ✅ Ask me anything about courses, unis, or apps.`;
        }
      }
    }

    /* ==== Dataset fallback ==== */
    const result = await queryDataset(messageText, { max: 200 });
    if (result && result.intent === "GENERAL")
      return await generateAIResponse(
        profile,
        messageText,
        profile.conversationHistory,
        ""
      );

    if (result && Array.isArray(result.rows) && result.rows.length) {
      profile.lastRows = result.rows;
      profile.lastOffset = Math.min(5, result.rows.length);
      return formatCourseSlice(
        result.rows,
        0,
        5,
        result.text || ""
      );
    }

    return await generateAIResponse(
      profile,
      messageText,
      profile.conversationHistory,
      ""
    );
  } catch (error) {
    console.error("getAIResponse error:", error.message);
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
      const { count: totalUsers } = await supabase.from("users").select("*", { count: "exact", head: true });
      const { count: activeUsers } = await supabase.from("users").select("*", { count: "exact", head: true }).gte("last_interaction", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      return { totalUsers: totalUsers || 0, activeUsers: activeUsers || 0, activeSessions: activeSessions.size };
    } catch {
      return { totalUsers: 0, activeUsers: 0, activeSessions: activeSessions.size };
    }
  },
};
