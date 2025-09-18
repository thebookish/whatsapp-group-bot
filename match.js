// match.js
const crypto = require('crypto');
const { supabase } = require('./config');

let sendFn = null;         // (jid, text) => Promise
let createGroupFn = null;  // (subject, jids[]) => Promise<{ id: string }>

/** Call once from server.js after sock connects */
function initMatch({ send, createGroup }) {
  sendFn = send;
  createGroupFn = createGroup;
  console.log('🔗 Match system initialised');
}

/** Upsert user location + discoverable settings */
async function upsertUserLocation(userId, { lat, lon, city = null, discoverable = true, radiusKm = 10 }) {
  const updates = {
    lat, lon, city,
    discoverable,
    discoverable_radius_km: radiusKm,
    last_location_at: new Date().toISOString()
  };
  // Try update
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('user_id', userId)
    .select('user_id');
  if (error) throw error;

  // If no row, insert a minimal user row
  if (!data || data.length === 0) {
    const { error: insErr } = await supabase.from('users').insert([{
      user_id: userId,
      name: '',
      interests: '',
      goals: '',
      country: '',
      created_at: new Date(),
      last_interaction: new Date(),
      ...updates
    }]);
    if (insErr) throw insErr;
  }
  return true;
}

/** Get a user's profile row */
async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return data;
}

/** Haversine distance (km) */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Find discoverable students nearby (rough bounding box + client sort) */
async function findNearby(userId, lat, lon, radiusKm = 10, limit = 5) {
  const dLat = radiusKm / 111; // ~111km per degree
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

/** Create a short acceptance code */
function makeCode() {
  return String(crypto.randomInt(100000, 999999)); // 6 digits
}

/** Handle "connect me..." intent */
async function handleConnectIntent({ requesterId, topic = '', radiusKm = 10 }) {
  if (!sendFn) throw new Error('sendFn not initialised (call initMatch in server.js)');

  const me = await getUser(requesterId);
  if (!me?.lat || !me?.lon) {
    return `Share your location (Attach → Location), then say: "connect me to a student near me${topic ? ' about ' + topic : ''}".`;
  }

  const candidates = await findNearby(requesterId, me.lat, me.lon, radiusKm, 5);

  if (!candidates.length) {
    return `I couldn’t find discoverable students within ~${radiusKm} km. Ask friends to enable discoverability or widen the radius.`;
  }

  // Invite each candidate with a unique code
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
    if (error) {
      console.error('invite insert error:', error);
      continue;
    }

    // DM invitee
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

/** Handle "accept 123456" from invitee; create intro group on success */
async function handleAcceptCode(inviteeId, code) {
  if (!sendFn || !createGroupFn) throw new Error('match not initialised');

  const { data, error } = await supabase
    .from('match_invites')
    .select('*')
    .eq('invitee_id', inviteeId)
    .eq('code', code)
    .eq('accepted', false)
    .limit(1);

  if (error) {
    console.error('invite fetch error:', error);
    return 'Something went wrong looking up that code.';
  }
  const invite = data?.[0];
  if (!invite) return `That code isn't valid anymore.`;

  // mark accepted
  const { error: updErr } = await supabase
    .from('match_invites')
    .update({ accepted: true })
    .eq('id', invite.id);
  if (updErr) {
    console.error('invite update error:', updErr);
    return 'Could not accept that invite (db error).';
  }

  // create intro group
  const subject = `Study Buddy${invite.topic ? ': ' + invite.topic : ''}`;
  const participants = [invite.requester_id, inviteeId];

  try {
    const group = await createGroupFn(subject, participants);
    const groupJid = group?.id || group;

    // greet in group
    await sendFn(groupJid, [
      `🎉 Intro time!`,
      `Say hi and take it from here.`,
      invite.topic ? `Topic: *${invite.topic}*` : null,
    ].filter(Boolean).join('\n'));

    return `You’re connected! I made a group so you can chat.`;
  } catch (e) {
    console.error('groupCreate error:', e);
    // fallback: DM both users to start a 1:1 if group fails
    await sendFn(invite.requester_id, `✅ Someone accepted your request${invite.topic ? ' about ' + invite.topic : ''}. You can message them directly here.`);
    await sendFn(inviteeId, `✅ Intro created. You can message them directly here.`);
    return `You’re connected!`;
  }
}

module.exports = {
  initMatch,
  upsertUserLocation,
  handleConnectIntent,
  handleAcceptCode,
};
