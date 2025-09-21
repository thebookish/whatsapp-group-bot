// match.js
const { supabase } = require("./config");

/* ============================
   Messaging adapters (from server.js)
============================= */
let sendFn = null;
function initMatch({ send }) {
  sendFn = send;
}

/* ============================
   Helpers
============================= */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Convert JID → phone number
function jidToPhone(jid) {
  return jid?.split("@")[0] || "";
}

async function getUser(userId) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error) throw error;
  return data;
}

async function findNearby(userId, lat, lon, radiusKm = 10, limit = 5) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1e-6);

  const { data, error } = await supabase
    .from("users")
    .select(
      "user_id,name,lat,lon,interests,discoverable,discoverable_radius_km"
    )
    .neq("user_id", userId)
    .eq("discoverable", true)
    .gte("lat", lat - dLat)
    .lte("lat", lat + dLat)
    .gte("lon", lon - dLon)
    .lte("lon", lon + dLon);

  if (error) throw error;

  return (data || [])
    .filter((u) => typeof u.lat === "number" && typeof u.lon === "number")
    .map((u) => ({
      ...u,
      distance_km: haversineKm(lat, lon, u.lat, u.lon),
    }))
    .filter(
      (u) =>
        u.distance_km <=
        Math.min(radiusKm, u.discoverable_radius_km || radiusKm)
    )
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ============================
   Main functions
============================= */
async function handleConnectIntent({ requesterId, topic = "", radiusKm = 10 }) {
  if (!sendFn) return "Messaging not ready—try again in a moment.";

  const me = await getUser(requesterId);
  if (!me?.lat || !me?.lon) {
    return `📍 Share your location (Attach → Location), then say: "connect me to a student near me${topic ? " about " + topic : ""}".`;
  }

  const candidates = await findNearby(requesterId, me.lat, me.lon, radiusKm, 5);
  if (!candidates.length) {
    return `❌ No discoverable students found within ~${radiusKm} km. Ask friends to enable discoverability or widen the radius.`;
  }

  for (const cand of candidates) {
    const code = makeCode();
    const { error } = await supabase.from("match_invites").insert([
      {
        code,
        requester_id: requesterId,
        invitee_id: cand.user_id,
        topic,
        lat: me.lat,
        lon: me.lon,
        distance_km: cand.distance_km,
      },
    ]);
    if (error) {
      console.error("invite insert error:", error);
      continue;
    }

    const intro = [
      `👋 Hi${cand.name ? " " + cand.name : ""}!`,
      `A nearby student wants to connect${
        topic ? " about *" + topic + "*" : ""
      }.`,
      `Distance: ~${Math.round(cand.distance_km)} km.`,
      `If you’re open, reply: *accept ${code}*`,
    ].join("\n");

    await sendFn(cand.user_id, intro);
  }

  return `✅ I’ve messaged a few nearby students${
    topic ? " about *" + topic + "*" : ""
  }. If someone accepts, I’ll share their WhatsApp number with you.`;
}

async function handleAcceptCode(inviteeId, code) {
  if (!sendFn) return "Messaging not ready—try again shortly.";

  const { data, error } = await supabase
    .from("match_invites")
    .select("*")
    .eq("invitee_id", inviteeId)
    .eq("code", code)
    .eq("accepted", false)
    .limit(1);

  if (error) {
    console.error("invite fetch error:", error);
    return "Something went wrong looking up that code.";
  }
  const invite = data?.[0];
  if (!invite) return `That code isn't valid anymore.`;

  const { error: updErr } = await supabase
    .from("match_invites")
    .update({ accepted: true })
    .eq("id", invite.id);
  if (updErr) {
    console.error("invite update error:", updErr);
    return "Could not accept that invite (db error).";
  }

  const requester = await getUser(invite.requester_id);
  const invitee = await getUser(inviteeId);

  // ✅ Share WhatsApp numbers directly
  await sendFn(
    invite.requester_id,
    `✅ ${invitee?.name || "A student"} accepted!\nYou can message them here 👉 https://wa.me/${jidToPhone(
      inviteeId
    )}`
  );

  await sendFn(
    inviteeId,
    `✅ Connected with ${
      requester?.name || "a student"
    }!\nYou can message them here 👉 https://wa.me/${jidToPhone(
      invite.requester_id
    )}`
  );

  return `🎉 You’re now connected directly!`;
}

/* ============================
   Exports
============================= */
module.exports = {
  initMatch,
  handleConnectIntent,
  handleAcceptCode,
};
