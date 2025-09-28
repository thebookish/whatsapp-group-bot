const { supabase } = require("./config");

/* ============================
   Messaging adapter
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
  const { data, error } = await supabase.from("users").select("*").eq("user_id", userId).single();
  if (error) throw error;
  return data;
}
async function findNearby(userId, lat, lon, radiusKm = 10, limit = 5) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1e-6);
  const { data, error } = await supabase
    .from("users")
    .select("user_id,name,lat,lon,discoverable,discoverable_radius_km")
    .neq("user_id", userId)
    .eq("discoverable", true)
    .gte("lat", lat - dLat)
    .lte("lat", lat + dLat)
    .gte("lon", lon - dLon)
    .lte("lon", lon + dLon);
  if (error) throw error;
  return (data || [])
    .filter((u) => typeof u.lat === "number" && typeof u.lon === "number")
    .map((u) => ({ ...u, distance_km: haversineKm(lat, lon, u.lat, u.lon) }))
    .filter((u) => u.distance_km <= Math.min(radiusKm, u.discoverable_radius_km || radiusKm))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}
function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ============================
   Location save
============================= */
async function upsertUserLocation(userId, { lat, lon, city = null, discoverable = true, radiusKm = 10 }) {
  const updates = {
    lat,
    lon,
    city,
    discoverable,
    discoverable_radius_km: radiusKm,
    last_location_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("users").update(updates).eq("user_id", userId).select("user_id");
  if (error) throw error;

  if (!data || data.length === 0) {
    const { error: insErr } = await supabase.from("users").insert([{
      user_id: userId,
      name: "",
      interests: "",
      goals: "",
      country: "",
      created_at: new Date(),
      last_interaction: new Date(),
      ...updates,
    }]);
    if (insErr) throw insErr;
  }
  return true;
}

/* ============================
   Main connect flow
============================= */
async function handleConnectIntent({ requesterId, topic = "", radiusKm = 10 }) {
  if (!sendFn) return "Messaging not ready—try again later.";

  const me = await getUser(requesterId);
  if (!me?.lat || !me?.lon) {
    return `📍 Share your location first (Attach → Location), then say: "connect me to a student near me${topic ? " about " + topic : ""}".`;
  }

  const candidates = await findNearby(requesterId, me.lat, me.lon, radiusKm, 5);
  if (!candidates.length) {
    return `I couldn’t find discoverable students within ~${radiusKm} km.`;
  }

  for (const cand of candidates) {
    const code = makeCode();
    await supabase.from("match_invites").insert([{
      code,
      requester_id: requesterId,
      invitee_id: cand.user_id,
      topic,
      lat: me.lat,
      lon: me.lon,
      distance_km: cand.distance_km,
      accepted: false,
      created_at: new Date(),
    }]);

await sendFn(cand.user_id, {
  text: `👋 Hi ${cand.name || "student"}!\nA nearby student wants to connect${
    topic ? " about *" + topic + "*" : ""
  }.\nDistance: ~${Math.round(cand.distance_km)} km.`,
  footer: "Press below to accept",
  templateButtons: [
    {
      index: 1,
      quickReplyButton: {
        displayText: "✅ Connect Now",
        id: `ACCEPT_${code}`,
      },
    },
  ],
});



  }

  return `✅ I’ve invited a few nearby students${topic ? " about *" + topic + "*" : ""}. If someone accepts, I’ll share their contact with you.`;
}

/* ============================
   Accept handler
============================= */
async function handleAcceptCode(inviteeId, code) {
  if (!sendFn) return "Messaging not ready—try again later.";

  const { data, error } = await supabase
    .from("match_invites")
    .select("*")
    .eq("invitee_id", inviteeId)
    .eq("code", code)
    .eq("accepted", false)
    .limit(1);

  if (error) throw error;
  const invite = data?.[0];
  if (!invite) return `That invite is not valid anymore.`;

  await supabase.from("match_invites").update({ accepted: true }).eq("id", invite.id);

  const requester = await getUser(invite.requester_id);
  const invitee = await getUser(inviteeId);

  await sendFn(
    invite.requester_id,
    `✅ ${invitee?.name || "A student"} accepted! You can message them at 👉 wa.me/${inviteeId.split("@")[0]}`
  );

  await sendFn(
    inviteeId,
    `✅ Connected with ${requester?.name || "a student"}! You can message them at 👉 wa.me/${invite.requester_id.split("@")[0]}`
  );

  return "🎉 You’re now connected!";
}

/* ============================
   Exports
============================= */
module.exports = {
  initMatch,
  handleConnectIntent,
  handleAcceptCode,
  upsertUserLocation,
};
