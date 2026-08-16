const OpenAI = require("openai");
const { supabase, OPENROUTER_API_KEY, NESTORIA_ENDPOINT } = require("./config");
const { normBase, queryDataset } = require("./rag");
const { addReminder } = require("./reminder");
const chrono = require("chrono-node");
const {
  handleConnectIntent,
  handleAcceptCode,
  upsertUserLocation,
} = require("./match");
const axios = require("axios");
const uniportal = require("./uniportal");

/* ============================
   OpenAI Client (lazy)

   Same reason as vectorstore.js: `new OpenAI()` throws without a key, and this
   module is required by server.js, so constructing it eagerly crashed the
   process at startup and no QR could ever be served.
============================= */
let _openai;
function openaiClient() {
  if (_openai) return _openai;
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set \u2014 AI replies unavailable.');
  }
  _openai = new OpenAI({ apiKey: OPENROUTER_API_KEY }); // same env variable as requested
  return _openai;
}

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
   Supabase DB Helpers
============================= */
async function checkUserExists(userId) {
  try {
    const { data, error } = await supabase.from("users").select("*").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") throw error;
    return { exists: !!data, user: data || null };
  } catch {
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
    const body = r.data?.response || {};
    const listings = (body.listings || []).map((x) => ({
      title: x.title || `${x.bedroom_number || ""} bed ${x.property_type || "property"}`.trim(),
      price_formatted: x.price_formatted || (x.price ? `£${x.price} pcm` : ""),
      bedrooms: x.bedroom_number,
      address: x.formatted_address || x.summary || "",
      url: x.lister_url || x.url || "",
    }));
    return { listings, meta: { total: body.total_results, page: body.page } };
  } catch {
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
  return head
    ? `${head}\n\n${lines.join("\n\n")}\n\nReply "more" to see more options.`
    : `${lines.join("\n\n")}\n\nReply "more" to see more options.`;
}

/* ============================
   Main entry with Tool Calls
============================= */
/**
 * System prompt.
 *
 * When the sender has linked their WorldLynk/uniportal account, their own
 * verified account facts are appended so the assistant can answer about their
 * documents, milestones, tasks and obligations instead of speaking generically.
 * Without a link there is no account section at all — an unverified chat must
 * not be told anything about anyone.
 */

const LINK_REQUIRED_MESSAGE =
  "🔗 Connect your student account first — send: link your-university-email@example.ac.uk";

/**
 * Posts staged for confirmation, keyed by jid. Held in memory on purpose: an
 * unconfirmed draft should not outlive a restart, and a stale one is better
 * lost than published later without the student meaning it.
 */
const pendingPosts = new Map();
const PENDING_POST_TTL_MS = 10 * 60 * 1000;

function stagePendingPost(jid, text, anonymous) {
  pendingPosts.set(jid, { text, anonymous, at: Date.now() });
}

function takePendingPost(jid) {
  const pending = pendingPosts.get(jid);
  if (!pending) return null;
  pendingPosts.delete(jid);
  return Date.now() - pending.at > PENDING_POST_TTL_MS ? null : pending;
}

function hasPendingPost(jid) {
  const pending = pendingPosts.get(jid);
  if (!pending) return false;
  if (Date.now() - pending.at > PENDING_POST_TTL_MS) {
    pendingPosts.delete(jid);
    return false;
  }
  return true;
}

/**
 * Handle POST/CANCEL for a staged community post. Returns a reply when the
 * message was a confirmation, or null to let normal handling continue.
 */
async function handlePendingPost(jid, text) {
  if (!jid || !hasPendingPost(jid)) return null;
  const answer = (text || "").trim().toLowerCase();

  if (answer === "cancel" || answer === "no") {
    pendingPosts.delete(jid);
    return "🗑️ Discarded — nothing was posted.";
  }
  if (answer !== "post" && answer !== "yes") return null;

  const pending = takePendingPost(jid);
  if (!pending) return "⌛ That draft expired. Tell me what you'd like to post and I'll draft it again.";

  try {
    await uniportal.postToCommunity(jid, pending.text, pending.anonymous);
    return "✅ Posted to the community feed.";
  } catch (err) {
    console.error("community post failed:", err.message);
    return "⚠️ I couldn't publish that. Please try again shortly.";
  }
}

/** Render a lookup result as a readable WhatsApp reply. */
function formatLookup(result) {
  if (!result || !Array.isArray(result.items) || result.items.length === 0) {
    return result?.note || "I couldn't find anything matching that.";
  }

  const heading = {
    events: "📅 Upcoming events",
    jobs: "💼 Job listings",
    accommodations: "🏠 Accommodation",
    journey: "🧭 Your journey",
  }[result.kind] || "Results";

  const lines = result.items.map((item) => {
    if (result.kind === "journey") {
      const mark = item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔄" : "⬜";
      return `${mark} ${item.title}`;
    }
    if (result.kind === "events") {
      return `• *${item.title}*${item.when ? ` — ${item.when}` : ""}${item.location ? ` @ ${item.location}` : ""}`;
    }
    if (result.kind === "jobs") {
      const bits = [item.employer, item.location, item.pay].filter(Boolean).join(" · ");
      return `• *${item.title}*${bits ? ` — ${bits}` : ""}`;
    }
    const bits = [item.city, item.cost ? `£${item.cost}` : null].filter(Boolean).join(" · ");
    return `• *${item.title}*${bits ? ` — ${bits}` : ""}`;
  });

  return [heading, ...lines, result.note ? `\n${result.note}` : ""].filter(Boolean).join("\n");
}

function buildSystemPrompt(accountContext) {
  const base =
    "You are a Student Assistant for WorldLynk. Use tools, not generic answers.\n" +
    "- Courses/universities → queryDataset\n" +
    "- WorldLynk events, job listings, accommodation listings, or the student's journey " +
    "tracker → lookupWorldlynk (this is WorldLynk's own data; prefer it)\n" +
    "- Wider UK rental market beyond WorldLynk listings → searchUKAccommodation\n" +
    "- Reminders → addReminder\n" +
    "- Meeting nearby students → handleConnectIntent\n" +
    "- Sharing something on the community feed → postToCommunity (drafts it; the student " +
    "confirms before anything is published)\n" +
    "Prefer calling a tool for anything you do not already know. Never invent an event, job, " +
    "listing or milestone that a tool did not return.";

  if (!accountContext) {
    return (
      base +
      " The person you are talking to has NOT linked their student account, so you know " +
      "nothing about them. If they ask about their application, documents, tasks or " +
      "university records, tell them to send: link their-university-email@example.ac.uk"
    );
  }

  return (
    base +
    "\n\n" +
    accountContext +
    "\n\nAnswer questions about their account from those facts, in full sentences. " +
    "Never reveal or discuss another student's information."
  );
}

async function getAIResponse(userId, rawMessage, accountContext = null, jid = null) {
  try {
    const uid = validateUserId(userId);
    let messageText =
      typeof rawMessage === "object"
        ? extractTextFromMessage(rawMessage)
        : rawMessage;
    if (typeof messageText !== "string") messageText = "";

    // 📍 Location handling
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
      } else return "Text only please 🙂";
    }

    // 🗂 Profile load
    const { exists, user } = await checkUserExists(uid);
    let profile;
    if (activeSessions.has(uid)) profile = activeSessions.get(uid);
    else if (exists && user) {
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

    // ✅ A staged community post is awaiting POST/CANCEL — settle that first,
    // before the model gets a chance to reinterpret a one-word reply.
    const postReply = await handlePendingPost(jid, messageText);
    if (postReply) return postReply;

    // 👋 Greeting check
    if (/^(hello|hi|hey)\b/i.test(messageText)) {
      if (profile.name && profile.onboardingStep === ONBOARDING_STEPS.COMPLETE) {
        return `Hey ${profile.name} 👋 How can I help you?`;
      } else {
        if (profile.onboardingStep === ONBOARDING_STEPS.NAME) {
          return `Hey! I’m your study buddy. What’s your name?`;
        }
      }
    }

    // 🤖 LLM call with tools
    const res = await openaiClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(accountContext),
        },
        { role: "user", content: messageText },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "queryDataset",
            description: "Get university or course info",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "searchUKAccommodation",
            description: "Find UK student accommodation",
            parameters: {
              type: "object",
              properties: {
                place_name: { type: "string" },
                price_max: { type: "number" },
                bedrooms: { type: "number" },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "addReminder",
            description: "Set a reminder",
            parameters: {
              type: "object",
              properties: {
                task: { type: "string" },
                datetime: { type: "string", format: "date-time" },
              },
              required: ["task", "datetime"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "handleConnectIntent",
            description: "Connect nearby students",
            parameters: {
              type: "object",
              properties: {
                topic: { type: "string" },
                radiusKm: { type: "number" },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "lookupWorldlynk",
            description:
              "Look up WorldLynk data for the signed-in student: upcoming events, job listings, " +
              "accommodation listings, or their own journey tracker progress. Use this for any " +
              "question about what events are on, what jobs or rooms are available, or how far " +
              "through their journey they are.",
            parameters: {
              type: "object",
              properties: {
                resource: {
                  type: "string",
                  enum: ["events", "jobs", "accommodations", "journey"],
                },
                query: {
                  type: "string",
                  description: "Optional keywords to filter by, e.g. a city, job type or category.",
                },
              },
              required: ["resource"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "postToCommunity",
            description:
              "Draft a post for the student to publish on the WorldLynk community feed. " +
              "Only call this when the student clearly asks to post or share something.",
            parameters: {
              type: "object",
              properties: {
                text: { type: "string", description: "The post body, in the student's own voice." },
                anonymous: { type: "boolean" },
              },
              required: ["text"],
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 200,
    });

    const msg = res.choices?.[0]?.message || {};
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length) {
      for (const call of toolCalls) {
        try {
          const fnName = call.function?.name;
          const argsRaw = call.function?.arguments;
          const args = argsRaw ? JSON.parse(argsRaw) : {};

          console.debug("🔧 Tool call:", fnName, args);

          switch (fnName) {
            case "queryDataset": {
              const result = await queryDataset(args.query, { max: 200 });
              if (result?.rows?.length) {
                profile.lastRows = result.rows;
                profile.lastOffset = Math.min(5, result.rows.length);
                return result.text;
              }
              return "No matching courses found.";
            }
            case "searchUKAccommodation": {
              const { listings } = await searchUKAccommodation(args);
              return formatAccommodationReply(listings);
            }
            case "addReminder": {
              await addReminder(uid, args.task, new Date(args.datetime));
              return `✅ Reminder set for "${args.task}" at ${new Date(
                args.datetime
              ).toLocaleString()}`;
            }
            case "handleConnectIntent": {
              return await handleConnectIntent({ requesterId: uid, ...args });
            }
            case "lookupWorldlynk": {
              if (!jid) return LINK_REQUIRED_MESSAGE;
              const result = await uniportal.lookup(jid, args.resource, args.query);
              return formatLookup(result);
            }
            case "postToCommunity": {
              if (!jid) return LINK_REQUIRED_MESSAGE;
              // Never publish straight from a model call. The student sees the
              // exact text and confirms it first — an LLM misreading "tell the
              // group" as an instruction to post would otherwise publish under
              // their name with no way to take it back.
              stagePendingPost(jid, args.text, args.anonymous === true);
              return (
                `📝 Here's your post:\n\n"${args.text}"\n\n` +
                (args.anonymous === true ? "_Posted anonymously._\n\n" : "") +
                "Reply *POST* to publish it, or *CANCEL* to discard."
              );
            }
            default:
              return "❌ I didn’t understand the tool request.";
          }
        } catch (err) {
          console.error("❌ Tool call error:", err);
          return "Sorry, I couldn’t process that request.";
        }
      }
    }

    // ✅ Accept handling
    if (ACCEPT_PAT.test(messageText)) {
      const m = messageText.match(ACCEPT_PAT);
      if (m) return await handleAcceptCode(uid, m[1]);
    }

    // 👨‍🎓 Onboarding
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME: {
          const name = extractNameFromText(messageText);
          if (!name)
            return `All good—tell me your name (e.g., "I'm Nabil Hasan").`;
          profile.name = name;
          profile.onboardingStep = ONBOARDING_STEPS.INTERESTS;
          return `Nice to meet you, ${profile.name}! What subjects/fields are you into?`;
        }
        case ONBOARDING_STEPS.INTERESTS:
          profile.interests = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.GOALS;
          return `Got it. Your main goal—scholarship, admission, job?`;
        case ONBOARDING_STEPS.GOALS:
          profile.goals = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COUNTRY;
          return `Cool. Which country are you in / targeting?`;
        case ONBOARDING_STEPS.COUNTRY:
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

    // 📜 Pagination
    if (
      MORE_PATTERNS.test(messageText) &&
      Array.isArray(profile.lastRows) &&
      profile.lastRows.length
    ) {
      const start = profile.lastOffset || 0;
      const reply = formatCourseSlice(profile.lastRows, start, 5);
      profile.lastOffset = Math.min(start + 5, profile.lastRows.length);
      return reply;
    }

    // 🚨 Fallback
    return msg.content || "Sorry, I couldn’t process that.";
  } catch (error) {
    console.error("getAIResponse error:", error.response?.data || error.message);
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
