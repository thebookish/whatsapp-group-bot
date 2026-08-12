// uniportal.js
// Thin client for the uniportal-server API.
//
// The bot holds no Firebase credential. It authenticates with a shared service
// token and can only do three things: ask for a link code to be mailed, submit
// a code that came back over WhatsApp, and ask who a number belongs to. Every
// tenant decision is made server-side against the real student registry — the
// bot never sees another university's data.

const BASE_URL = (process.env.UNIPORTAL_API_URL || '').replace(/\/$/, '');
const SERVICE_TOKEN = process.env.UNIPORTAL_SERVICE_TOKEN || '';
const TIMEOUT_MS = 10000;

function isConfigured() {
  return Boolean(BASE_URL && SERVICE_TOKEN);
}

async function call(path, body) {
  if (!isConfigured()) {
    throw new Error('uniportal bridge not configured (UNIPORTAL_API_URL / UNIPORTAL_SERVICE_TOKEN)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': SERVICE_TOKEN,
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

module.exports = { isConfigured, startLink, verifyLink, identify };
