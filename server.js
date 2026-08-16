// server.js
require('./polyfills'); // must precede the Baileys require — see polyfills.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./ai');
const { initMatch, handleAcceptCode } = require('./match');
const { WebSocketServer } = require('ws');
const { startReminderScheduler } = require('./reminder');
const uniportal = require('./uniportal');
const {
  initNotifications,
  stopRealtimeSubscription,
  getRecentAlerts,
  markAlertRead,
  dismissAlert,
} = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';
const SERVICE_TOKEN = process.env.UNIPORTAL_SERVICE_TOKEN || '';
const KEEP_ALIVE_MS = 30000;
const TRIGGER_KEYWORD = 'heybot';
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 min

/* ============================
   Connection state
============================= */
let sock = null;
let saveCreds = null;
let isStarting = false;
let shouldStop = false;
let botJid = null;
let isRegistered = false;         // true once this device is paired
let activeConversations = new Map();
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 60000;
let lastQr = null;
let lastQrAt = 0;
let connectionStatus = 'disconnected';
let reconnectTimer = null;
let qrWatchdogTimer = null;
let presenceTimer = null;
let sweepTimer = null;

/**
 * WhatsApp rotates the pairing QR roughly every 20s and Baileys closes the
 * socket once its refs are spent. Anything older than this is unscannable, so
 * we stop advertising it rather than showing the user a dead code.
 */
const QR_MAX_AGE_MS = 60_000;

function currentQr() {
  if (!lastQr) return null;
  return Date.now() - lastQrAt < QR_MAX_AGE_MS ? lastQr : null;
}

/* ============================
   HTTP
============================= */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => res.json({
  ok: true,
  connectionStatus,
  hasQr: !!currentQr(),
  registered: isRegistered,
  wsClients: wss?.clients?.size ?? 0,
  botJid: botJid ? '***' : null,
  uniportalBridge: uniportal.isConfigured(),
  uniportalBridgeMissing: uniportal.missingConfig(),
  sendEndpointReady: Boolean(SERVICE_TOKEN),
  uptime: process.uptime(),
}));

/**
 * Polling fallback for the QR. The dashboard prefers the WebSocket, but a
 * proxy that buffers or drops upgrades would otherwise leave the operator with
 * no way to see a code at all.
 */
app.get('/api/qr', (req, res) => {
  const qr = currentQr();
  res.json({ ok: true, qr, connectionStatus, registered: isRegistered });
});

/** Force a fresh pairing attempt without restarting the process. */
app.post('/api/restart', async (req, res) => {
  console.log('🔁 Restart requested via API');
  clearReconnect();
  await teardownSocket();
  lastQr = null;
  connectionStatus = 'disconnected';
  broadcast({ type: 'status', status: 'restarting' });
  scheduleReconnect(250);
  res.json({ ok: true });
});

/** Drop the stored session so the next connect issues a brand-new QR. */
app.post('/api/logout', async (req, res) => {
  console.log('🚪 Logout requested via API — clearing stored session');
  clearReconnect();
  try { if (sock) await sock.logout().catch(() => {}); } catch {}
  await teardownSocket();
  clearAuthState();
  lastQr = null;
  isRegistered = false;
  connectionStatus = 'disconnected';
  broadcast({ type: 'status', status: 'disconnected' });
  scheduleReconnect(250);
  res.json({ ok: true });
});

/**
 * Outbound send, called by uniportal-server to mirror a student's notification
 * onto WhatsApp. Service-token protected: without it, anyone who can reach this
 * port could message every linked student.
 */
app.post('/api/send', async (req, res) => {
  const provided = req.get('x-service-token') || '';
  if (!SERVICE_TOKEN || provided !== SERVICE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { jid, text } = req.body || {};
  if (!jid || !text) {
    return res.status(400).json({ ok: false, error: 'jid and text are required' });
  }
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ ok: false, error: 'whatsapp not connected' });
  }
  try {
    await sock.sendMessage(normalizeJid(jid), { text: String(text) });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /api/send failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ============================
   Notification REST API
============================= */
app.get('/api/notifications', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const alerts = await getRecentAlerts(limit);
    res.json({ ok: true, alerts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/notifications/:id/read', async (req, res) => {
  try {
    res.json({ ok: await markAlertRead(req.params.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/notifications/:id/dismiss', async (req, res) => {
  try {
    res.json({ ok: await dismissAlert(req.params.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  reportBridgeConfig();
});

/**
 * State the bridge configuration at boot. Without this the only symptom of a
 * missing env var is a student being told "not available right now" — with
 * nothing in the logs to say why.
 */
function reportBridgeConfig() {
  const missing = uniportal.missingConfig();
  if (missing.length) {
    console.warn(
      `⚠️  uniportal bridge DISABLED — missing ${missing.join(' and ')}. ` +
      'Students cannot link their account until these are set.',
    );
  } else {
    console.log('🔗 uniportal bridge configured');
  }
  if (!SERVICE_TOKEN) {
    console.warn(
      '⚠️  UNIPORTAL_SERVICE_TOKEN is not set — POST /api/send will reject every ' +
      'request, so uniportal alerts cannot be delivered to WhatsApp.',
    );
  }
}

const wss = new WebSocketServer({ server });
function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(str);
  });
}
wss.on('connection', (client) => {
  const qr = currentQr();
  if (connectionStatus === 'connected') {
    client.send(JSON.stringify({ type: 'status', status: 'connected' }));
  } else if (qr) {
    client.send(JSON.stringify({ type: 'qr', qr }));
  } else {
    client.send(JSON.stringify({ type: 'status', status: connectionStatus }));
  }
});

/* ============================
   Utils
============================= */
function normalizeJid(jid) {
  if (!jid) return null;
  try {
    return jidNormalizedUser(jid); // always returns xxx@s.whatsapp.net
  } catch {
    return jid;
  }
}

/** Baileys' socket wrapper exposes isOpen/isClosed — it has no `readyState`. */
function socketIsOpen() {
  return Boolean(sock?.ws?.isOpen);
}

/**
 * Detach and close the live socket.
 *
 * Every reconnect MUST come through here. The previous implementation guarded
 * teardown behind `sock.ws.readyState === 1`, a property Baileys' WebSocketClient
 * does not have, so the check was always false and the old socket was never
 * closed: each reconnect leaked a socket that kept its event handlers, which is
 * why messages got answered two or three times and the connection kept dropping.
 */
async function teardownSocket() {
  if (!sock) return;
  const dying = sock;
  sock = null;
  try { dying.ev.removeAllListeners(); } catch {}
  try { dying.end(new Error('socket replaced')); } catch {}
}

function clearAuthState() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('🗑️  Cleared stored auth state');
  } catch (err) {
    console.warn('Could not clear auth state:', err.message);
  }
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (qrWatchdogTimer) { clearTimeout(qrWatchdogTimer); qrWatchdogTimer = null; }
}

function scheduleReconnect(delay) {
  if (reconnectTimer || shouldStop) return;
  console.log(`⏭️  Next connect attempt in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isStarting = false;
    if (!shouldStop) startBot();
  }, delay);
}

/* ============================
   Message utils
============================= */
function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.message?.conversation) return message.message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (message.message?.extendedTextMessage?.text) return message.message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (message.message?.imageMessage?.caption) return message.message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (message.message?.videoMessage?.caption) return message.message.videoMessage.caption;
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (message?.text?.body) return message.text.body;
  return '';
}

function isBotMentioned(message, botJid) {
  if (!message || !botJid) return false;
  if (message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid)) return true;
  if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid)) return true;
  if (message.contextInfo?.mentionedJid?.includes(botJid)) return true;
  return false;
}

function isBotRepliedTo(message, botJid) {
  if (!message || !botJid) return false;
  const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage
    || message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const stanzaId = message.extendedTextMessage?.contextInfo?.stanzaId
    || message.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const participant = message.extendedTextMessage?.contextInfo?.participant
    || message.message?.extendedTextMessage?.contextInfo?.participant;
  if (participant === botJid || (quotedMsg && stanzaId)) return true;
  return false;
}

/* ============================
   Conversation tracking
============================= */
function isConversationActive(conversationKey) {
  const conversation = activeConversations.get(conversationKey);
  if (!conversation) return false;
  const isActive = Date.now() - conversation.lastActivity < CONVERSATION_TIMEOUT;
  if (!isActive) {
    activeConversations.delete(conversationKey);
    console.log(`⏰ Conversation timeout: ${conversationKey}`);
  }
  return isActive;
}
function startConversation(conversationKey) {
  activeConversations.set(conversationKey, { startTime: Date.now(), lastActivity: Date.now() });
  console.log(`🆕 Started conversation: ${conversationKey}`);
}
function updateConversationActivity(conversationKey) {
  const conversation = activeConversations.get(conversationKey);
  if (conversation) conversation.lastActivity = Date.now();
}

/* ============================
   uniportal account linking
   A student connects here exactly as they do in the app: they prove the
   university email (the code is mailed to the address on their record) and the
   WhatsApp number (the code comes back from it).
============================= */
const LINK_HELP =
  '🔗 To connect your student account, send:\n\n*link your.name@university.ac.uk*\n\n' +
  "I'll email a 6-digit code to that address — reply with the code here.";

function looksLikeLinkCommand(text) {
  return /^link\b/i.test((text || '').trim());
}

function extractLinkEmail(text) {
  const m = (text || '').trim().match(/^link\b[:\s]+(\S+@\S+\.\S+)$/i);
  return m ? m[1].toLowerCase() : null;
}

function isSixDigitCode(text) {
  return /^\d{6}$/.test((text || '').trim());
}

/** Numbers we have mailed a code to, so a bare 6-digit reply is unambiguous. */
const awaitingCode = new Map();
const AWAITING_CODE_TTL = 15 * 60 * 1000;

function markAwaitingCode(jid) {
  awaitingCode.set(jid, Date.now());
}
function isAwaitingCode(jid) {
  const at = awaitingCode.get(jid);
  if (!at) return false;
  if (Date.now() - at > AWAITING_CODE_TTL) {
    awaitingCode.delete(jid);
    return false;
  }
  return true;
}

/**
 * Returns a reply string when the message was part of the linking flow, or null
 * to let normal AI handling take over.
 */
async function handleLinking(jid, text) {
  const missing = uniportal.missingConfig();
  if (missing.length) {
    if (!looksLikeLinkCommand(text)) return null;
    // The student gets a neutral message; the operator gets the actual cause.
    console.error(
      `❌ Link attempt refused: uniportal bridge not configured (missing ${missing.join(' and ')})`,
    );
    return '⚠️ Account connection is not available right now. Please try again later.';
  }

  if (looksLikeLinkCommand(text)) {
    const email = extractLinkEmail(text);
    if (!email) return LINK_HELP;
    try {
      await uniportal.startLink(jid, email);
      markAwaitingCode(jid);
      // Deliberately uniform: we never confirm whether an address belongs to a
      // real student, so this can't be used to enumerate them.
      return `📧 If *${email}* belongs to a student account, a 6-digit code is on its way.\n\nReply with the code to finish connecting.`;
    } catch (err) {
      console.error('link start failed:', err.message);
      return '⚠️ Something went wrong sending your code. Please try again in a moment.';
    }
  }

  if (isSixDigitCode(text) && isAwaitingCode(jid)) {
    try {
      const result = await uniportal.verifyLink(jid, text.trim());
      if (result?.ok) {
        awaitingCode.delete(jid);
        const name = result.name ? `, ${result.name}` : '';
        return `✅ Connected${name}! Your university updates and alerts will now reach you here as well as in the app.\n\nSend *unlink* any time to stop.`;
      }
      const reason = {
        expired: '⌛ That code has expired. Send *link your@email* to get a new one.',
        too_many_attempts: '🚫 Too many attempts. Send *link your@email* to start again.',
        wrong_code: "❌ That code doesn't match. Check the email and try again.",
        no_request: 'ℹ️ I have no pending connection for this number. Send *link your@email* to start.',
      }[result?.reason];
      return reason || '❌ Could not verify that code.';
    } catch (err) {
      console.error('link verify failed:', err.message);
      return '⚠️ Something went wrong checking your code. Please try again.';
    }
  }

  return null;
}

/* ============================
   Bot start
============================= */
async function startBot() {
  if (isStarting || reconnectTimer) return;
  isStarting = true;

  try {
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = _saveCreds;
    isRegistered = Boolean(state.creds?.registered);

    await teardownSocket();

    // Always fetch the live WhatsApp Web version — a stale one is rejected with
    // a 405 handshake error and no QR is ever produced.
    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
      console.log(`📦 Using WhatsApp Web version ${version.join('.')} (latest: ${v.isLatest})`);
    } catch (e) {
      console.warn('Could not fetch latest WA version, using Baileys default:', e.message);
    }

    sock = makeWASocket({
      auth: state,
      version,
      keepAliveIntervalMs: KEEP_ALIVE_MS,
      // A standard browser tuple — custom names trigger 405 handshake rejections.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    armQrWatchdog();

    /* === init match system with send + createGroup === */
    initMatch({
      send: async (jid, content) => {
        if (typeof content === 'string') {
          await sock.sendMessage(jid, { text: content });
        } else {
          await sock.sendMessage(jid, content); // allow buttons, lists, etc
        }
      },
      createGroup: async (subject, jids) => await sock.groupCreate(subject, jids),
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        clearWatchdog();
        lastQr = qr;
        lastQrAt = Date.now();
        connectionStatus = 'qr';
        broadcast({ type: 'qr', qr });
        console.log(`📷 QR ready — sent to ${wss.clients.size} dashboard client(s). Waiting for scan...`);
      }

      if (connection === 'open') {
        clearWatchdog();
        console.log('✅ WhatsApp connected');
        reconnectAttempt = 0;
        lastQr = null;
        isRegistered = true;
        connectionStatus = 'connected';
        botJid = normalizeJid(sock.user?.id);
        console.log('🤖 Bot JID:', botJid);
        broadcast({ type: 'status', status: 'connected' });

        // The WhatsApp sender is wired up for outbound alerts. The old
        // Supabase realtime fan-out is intentionally NOT started: it pushed
        // every alert to every registered number regardless of which student
        // (or which university) it concerned. Alerts now arrive per-recipient
        // from uniportal-server via POST /api/send.
        initNotifications({
          send: async (jid, text) => { await sock.sendMessage(jid, { text }); },
          broadcast,
        });
      } else if (connection === 'close') {
        handleDisconnect(lastDisconnect);
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        connectionStatus = 'connecting';
        broadcast({ type: 'status', status: 'connecting' });
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', onMessages);

    startBackgroundTimers();
    console.log('Bot started.');
  } catch (err) {
    console.error('startBot error:', err);
    scheduleReconnect(2000);
  } finally {
    isStarting = false;
  }
}

/* ============================
   Disconnect handling
============================= */
function handleDisconnect(lastDisconnect) {
  const reason = lastDisconnect?.error?.output?.statusCode;
  const isLoggedOut = reason === DisconnectReason.loggedOut;
  console.log('🔌 Connection closed. reason:', reason, 'loggedOut:', isLoggedOut);

  connectionStatus = 'disconnected';
  clearWatchdog();
  broadcast({ type: 'status', status: 'disconnected', reason });

  // 515: WhatsApp requires a reconnect immediately after a successful pairing.
  if (reason === DisconnectReason.restartRequired || reason === 515) {
    console.log('🔁 Restart required after pairing — reconnecting immediately...');
    lastQr = null;
    reconnectAttempt = 0;
    scheduleReconnect(500);
    return;
  }

  // Logged out from the phone: the stored session is dead. Wipe it and come
  // straight back with a fresh QR instead of sitting idle until someone
  // restarts the process by hand.
  if (isLoggedOut) {
    console.log('❌ Logged out — clearing session and preparing a new QR.');
    clearAuthState();
    isRegistered = false;
    lastQr = null;
    reconnectAttempt = 0;
    scheduleReconnect(1000);
    return;
  }

  // Unpaired socket timed out: WhatsApp expired the pairing QR. Reconnect at
  // once for a new one. The previous code nulled the QR and waited a full
  // minute here, so the dashboard sat on "waiting for QR" and the code could
  // never be scanned — the reported "QR won't generate" symptom.
  if (!isRegistered) {
    lastQr = null;
    console.log('⌛ Pairing code expired — requesting a fresh QR...');
    scheduleReconnect(1000);
    return;
  }

  lastQr = null;
  reconnectAttempt++;
  const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
  console.log(`🔄 Reconnecting (attempt ${reconnectAttempt})...`);
  scheduleReconnect(delay);
}

/* ============================
   QR watchdog
   Only ever fires for an UNPAIRED socket that produced no QR at all. A paired
   session never emits one, so the old unconditional watchdog deleted working
   credentials whenever a reconnect ran slow — forcing a re-scan for no reason.
============================= */
function clearWatchdog() {
  if (qrWatchdogTimer) { clearTimeout(qrWatchdogTimer); qrWatchdogTimer = null; }
}

function armQrWatchdog() {
  clearWatchdog();
  qrWatchdogTimer = setTimeout(() => {
    qrWatchdogTimer = null;
    if (connectionStatus === 'connected' || currentQr()) return;

    if (isRegistered) {
      console.warn('⚠️  Paired session has not connected in 60s — retrying (session kept).');
      teardownSocket().then(() => scheduleReconnect(2000));
      return;
    }

    console.warn('⚠️  No QR within 60s on an unpaired socket — clearing partial state and retrying.');
    teardownSocket().then(() => {
      clearAuthState();
      scheduleReconnect(2000);
    });
  }, 60000);
}

/* ============================
   Background timers (started once)
============================= */
let timersStarted = false;
function startBackgroundTimers() {
  if (timersStarted) return;
  timersStarted = true;

  // Baileys handles its own websocket keep-alive (keepAliveIntervalMs); the
  // previous `sock.ws.ping()` call threw on every tick because the wrapper has
  // no ping method. Presence is enough to look alive to WhatsApp.
  presenceTimer = setInterval(async () => {
    try { if (socketIsOpen() && sock?.user) await sock.sendPresenceUpdate('available'); } catch {}
  }, 60000);

  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, conv] of activeConversations.entries()) {
      if (now - conv.lastActivity >= CONVERSATION_TIMEOUT) {
        activeConversations.delete(key);
        console.log(`🧹 Expired conversation: ${key}`);
      }
    }
    for (const [jid, at] of awaitingCode.entries()) {
      if (now - at > AWAITING_CODE_TTL) awaitingCode.delete(jid);
    }
  }, 5 * 60 * 1000);
}

/* ============================
   Messages
============================= */
async function onMessages({ messages }) {
  try {
    if (!messages?.[0] || messages[0].key.fromMe) return;
    const msg = messages[0];
    const remoteJid = normalizeJid(msg.key.remoteJid || '');
    if (!remoteJid) return;
    const isGroup = remoteJid.endsWith('@g.us');
    const groupId = isGroup ? remoteJid : null;
    const participantId = normalizeJid(msg.key.participant || remoteJid);
    const senderId = isGroup ? participantId : remoteJid;
    const userId = isGroup ? participantId : remoteJid;

    const conversationKey = isGroup ? `${remoteJid}_${participantId}` : remoteJid;

    /* === Catch Accept button === */
    if (msg.message?.buttonsResponseMessage?.selectedButtonId?.startsWith('ACCEPT_')) {
      const code = msg.message.buttonsResponseMessage.selectedButtonId.replace('ACCEPT_', '');
      const reply = await handleAcceptCode(userId, code);
      await sock.sendMessage(userId, { text: reply });
      return;
    }

    let text = extractTextFromMessage(msg.message);
    if (text) text = text.trim();

    let shouldRespond = false;
    let sendPrivately = false;
    let isNewConversation = false;

    if (isGroup) {
      const conversationActive = isConversationActive(conversationKey);
      const startsWithTrigger = text?.toLowerCase().startsWith(TRIGGER_KEYWORD.toLowerCase());
      if (startsWithTrigger) {
        if (!conversationActive) { startConversation(conversationKey); isNewConversation = true; }
        shouldRespond = true;
        text = text.slice(TRIGGER_KEYWORD.length).trim();
        console.log(`🎯 Trigger in ${groupId} by ${participantId}`);
      } else if (conversationActive) {
        const isMentioned = isBotMentioned(msg.message, botJid);
        const isRepliedTo = isBotRepliedTo(msg.message, botJid);
        if (isMentioned || isRepliedTo) {
          shouldRespond = true;
          updateConversationActivity(conversationKey);
          console.log(`🎯 Bot ${isMentioned ? 'mentioned' : 'replied'} in ${conversationKey}`);
          if (isMentioned && text) text = text.replace(/@\d+/g, '').trim();
        }
      }
      if (shouldRespond && /reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
        sendPrivately = true;
        text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
      }
    } else {
      // Account linking is a private-chat flow only: a code sent into a group
      // would be readable by everyone in it.
      const linkReply = await handleLinking(senderId, text);
      if (linkReply) {
        await sock.sendMessage(senderId, { text: linkReply });
        return;
      }

      if (!isConversationActive(conversationKey)) { startConversation(conversationKey); isNewConversation = true; }
      else updateConversationActivity(conversationKey);
      shouldRespond = true;
      console.log(`💬 Private message from ${senderId}`);
    }

    if (!shouldRespond) return;

    // Pass the full message when there is no text (captures locationMessage).
    const inputForAI = text || msg;
    console.log(`🤖 Processing: "${text || '[non-text message]'}" ${isNewConversation ? '(New)' : '(Cont.)'}`);
    const aiReply = await getAIResponse(userId, inputForAI);

    const target = isGroup ? (sendPrivately ? senderId : groupId) : senderId;
    await sock.sendMessage(target, { text: aiReply });
    console.log(`📤 Reply to ${target}`);
  } catch (err) {
    console.error('messages.upsert error:', err);
  }
}

startBot();

/* === Reminders === */
startReminderScheduler(async (userId, text) => {
  if (!socketIsOpen()) throw new Error('WhatsApp not connected');
  await sock.sendMessage(userId, { text });
});

/* === Graceful shutdown === */
async function shutdown() {
  console.log('\n👋 Shutting down...');
  shouldStop = true;
  clearReconnect();
  if (presenceTimer) clearInterval(presenceTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  await stopRealtimeSubscription().catch(() => {});
  await teardownSocket();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
