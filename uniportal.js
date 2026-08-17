// uniportal.js
// Thin client for the uniportal-server API.
//
// The bot holds no Firebase credential. It authenticates with a shared service
// token and can only do three things: ask for a link code to be mailed, submit
// a code that came back over WhatsApp, and ask who a number belongs to. Every
// tenant decision is made server-side against the real student registry — the
// bot never sees another university's data.

const TIMEOUT_MS = 10000;

// Read lazily rather than at module load, so a platform that injects env vars
// late (or a restart after fixing them) needs no code change to take effect.
function baseUrl() {
  return (process.env.UNIPORTAL_API_URL || '').trim().replace(/\/$/, '');
}
function serviceToken() {
  return (process.env.UNIPORTAL_SERVICE_TOKEN || '').trim();
}

/** Names of the env vars that are missing — empty when the bridge is usable. */
function missingConfig() {
  const missing = [];
  if (!baseUrl()) missing.push('UNIPORTAL_API_URL');
  if (!serviceToken()) missing.push('UNIPORTAL_SERVICE_TOKEN');
  return missing;
}

function isConfigured() {
  return missingConfig().length === 0;
}

async function call(path, body) {
  const missing = missingConfig();
  if (missing.length) {
    throw new Error(`uniportal bridge not configured \u2014 missing ${missing.join(' and ')}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': serviceToken(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const detail = json?.detail || json?.title || text || `HTTP ${res.status}`;
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }

    // uniportal-server wraps every success as `{ data: ... }` via ok()/created().
    // Returning the envelope made `result.ok` undefined, so a link that had
    // genuinely succeeded was reported to the student as "could not verify".
    if (json && typeof json === 'object' && 'data' in json) return json.data;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the server to mail a connection code to the student who owns `email`. */
async function startLink(jid, email) {
  return call('/api/v1/whatsapp/link/start', { jid, email });
}

/** Submit the six-digit code the student replied with. */
async function verifyLink(jid, code) {
  return call('/api/v1/whatsapp/link/verify', { jid, code });
}

/** Which student, if any, this WhatsApp number belongs to. */
async function identify(jid) {
  return call('/api/v1/whatsapp/identify', { jid });
}

/**
 * The linked student's own account context, for the assistant to answer from.
 * `{ linked: false }` for an unlinked number — an unverified chat gets nothing.
 */
async function context(jid) {
  return call('/api/v1/whatsapp/context', { jid });
}

/** Read-only lookup of WorldLynk data on behalf of a linked student. */
async function lookup(jid, resource, query) {
  // jid is omitted for public resources — the server allows those unlinked.
  return call('/api/v1/whatsapp/lookup', { jid: jid || undefined, resource, query });
}

/** Take an action as the linked student (complete milestone, RSVP, apply...). */
async function act(jid, action, { target, text } = {}) {
  return call('/api/v1/whatsapp/act', { jid, action, target, text });
}

/** Publish a community post authored by the linked student. */
async function postToCommunity(jid, text, anonymous = false) {
  return call('/api/v1/whatsapp/community-post', { jid, text, anonymous });
}

module.exports = {
  isConfigured,
  missingConfig,
  startLink,
  verifyLink,
  identify,
  context,
  lookup,
  act,
  postToCommunity,
};
