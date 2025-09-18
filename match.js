const { supabase } = require("./config");

/* ============================
   Messaging adapter (injected from server.js)
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
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
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
  const dLon =
    radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1e-6);

  const { data, error } = await supabase
    .from("users")
    .select("user_id,name,lat,lon,interests,discoverable,discoverable_radius_km")
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

/* ============================
   Main function
============================= */
async function handleConnectIntent({ requesterId, topic = "", radiusKm = 10 }) {
  if (!sendFn) return "Messaging not ready—try again in a moment.";

  const me = await getUser(requesterId);
  if (!me?.lat || !me?.lon) {
    return `Share your location first (Attach → Location), then say: "connect me to a student near me${topic ? " about " + topic : ""}".`;
  }

  const candidates = await findNearby(
    requesterId,
    me.lat,
    me.lon,
    radiusKm,
    5
  );
  if (!candidates.length) {
    return `I couldn’t find discoverable students within ~${radiusKm} km. Ask friends to enable discoverability or widen the radius.`;
  }

  // Send each candidate’s info directly
  let replyLines = [`Here are some nearby students${topic ? " about *" + topic + "*" : ""}:`];
  for (const cand of candidates) {
    replyLines.push(
      `\n👤 ${cand.name || "Student"}\n📍 ~${Math.round(cand.distance_km)} km away\n💬 wa.me/${cand.user_id.split("@")[0]}`
    );

    // Optionally also DM the candidate that someone might contact them
    await sendFn(
      cand.user_id,
      `👋 A nearby student may reach out to you${topic ? " about *" + topic + "*" : ""}.`
    );
  }

  return replyLines.join("\n");
}

/* ============================
   Exports
============================= */
module.exports = {
  initMatch,
  handleConnectIntent,
};
