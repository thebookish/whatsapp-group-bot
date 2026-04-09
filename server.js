// server.js
const express = require('express');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./ai');
const { initMatch } = require('./match');
const { WebSocketServer } = require('ws');
const { startReminderScheduler } = require('./reminder');
const {
  initNotifications,
  startRealtimeSubscription,
  stopRealtimeSubscription,
  getRecentAlerts,
  markAlertRead,
  dismissAlert,
} = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = 'auth_info_baileys';
const KEEP_ALIVE_MS = 10000;
const TRIGGER_KEYWORD = 'heybot';
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 min

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => res.json({
  ok: true,
  connectionStatus,
  hasQr: !!lastQr,
  wsClients: wss?.clients?.size ?? 0,
  botJid: botJid ? '***' : null,
  uptime: process.uptime(),
}));

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
    const success = await markAlertRead(req.params.id);
    res.json({ ok: success });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/notifications/:id/dismiss', async (req, res) => {
  try {
    const success = await dismissAlert(req.params.id);
    res.json({ ok: success });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });
function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
}
wss.on('connection', (client) => {
  if (connectionStatus === 'connected') {
    client.send(JSON.stringify({ type: 'status', status: 'connected' }));
  } else if (lastQr) {
    client.send(JSON.stringify({ type: 'qr', qr: lastQr }));
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
/* ============================
   State
============================= */
let sock = null;
let saveCreds = null;
let isStarting = false;
let shouldStop = false;
let botJid = null;
let activeConversations = new Map();
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 60000;
let lastQr = null;
let connectionStatus = 'disconnected';
let qrPendingScan = false; // true when QR is displayed and waiting for user to scan

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
  const now = Date.now();
  const isActive = now - conversation.lastActivity < CONVERSATION_TIMEOUT;
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
   Bot start
============================= */
async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    const stateRes = await useMultiFileAuthState(AUTH_DIR);
    const { state, saveCreds: _saveCreds } = stateRes;
    saveCreds = _saveCreds;

    if (sock) {
      try { if (sock.ws && sock.ws.readyState === 1) await sock.end(); } catch {}
      sock = null;
    }

    sock = makeWASocket({
      auth: state,
      keepAliveIntervalMs: KEEP_ALIVE_MS,
      browser: ['WhatsApp Bot', 'Chrome', '22.04.4'],
    });

    // QR watchdog — if no QR or connection within 45s, clear stale auth and retry
    const qrWatchdog = setTimeout(() => {
      if (connectionStatus !== 'connected' && !lastQr && !qrPendingScan) {
        console.warn('\u26a0\ufe0f  No QR generated within 45s — clearing stale auth and retrying...');
        try { if (sock?.ws?.readyState === 1) sock.end(); } catch {}
        const fs = require('fs');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        isStarting = false;
        if (!shouldStop) startBot();
      }
    }, 45000);

    /* === init match system with send + createGroup === */
initMatch({
  send: async (jid, content) => {
    if (typeof content === "string") {
      await sock.sendMessage(jid, { text: content });
    } else {
      await sock.sendMessage(jid, content); // allow buttons, lists, etc
    }
  },
  createGroup: async (subject, jids) => await sock.groupCreate(subject, jids),
});


    sock.ev.on('connection.update', (update) => {
      console.log('🔔 connection.update:', JSON.stringify(Object.keys(update)));
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        clearTimeout(qrWatchdog);
        lastQr = qr;
        qrPendingScan = true;
        connectionStatus = 'disconnected';
        broadcast({ type: 'qr', qr });
        console.log('\ud83d\udcf7 New QR generated — broadcast to', wss.clients.size, 'client(s). Waiting for scan...');
      }
      if (connection === 'open') {
        clearTimeout(qrWatchdog);
        console.log('✅ WhatsApp connected');
        reconnectAttempt = 0;
        lastQr = null;        qrPendingScan = false;        connectionStatus = 'connected';
        botJid = sock.user.id;
        console.log('🤖 Bot JID:', botJid);
        broadcast({ type: 'status', status: 'connected' });

        // Start real-time notification system
        initNotifications({
          send: async (jid, text) => {
            await sock.sendMessage(jid, { text });
          },
          broadcast,
        });
        startRealtimeSubscription();
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = reason === DisconnectReason.loggedOut;
        console.log('🔌 Connection closed.', reason, 'loggedOut:', isLoggedOut);
        connectionStatus = 'disconnected';
        broadcast({ type: 'status', status: 'disconnected', reason });

        // If QR is pending scan, DON'T reconnect — just wait for user to scan
        if (qrPendingScan && !isLoggedOut) {
          console.log('\u23f3 QR is pending scan — not reconnecting. Open the dashboard to scan.');
          lastQr = null;
          qrPendingScan = false;
          // Wait longer then retry to get a fresh QR
          setTimeout(() => {
            isStarting = false;
            if (!shouldStop) startBot();
          }, 60000); // 60s cooldown before next QR attempt
          return;
        }

        lastQr = null;
        qrPendingScan = false;
        if (!isLoggedOut) {
          reconnectAttempt++;
          const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
          console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})...`);
          setTimeout(() => {
            isStarting = false;
            if (!shouldStop) startBot();
          }, delay);
        } else {
          console.log('❌ Logged out — restart with new QR.');
        }
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        connectionStatus = 'connecting';
        broadcast({ type: 'status', status: 'connecting' });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    /* === Handle messages === */
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        if (!messages?.[0] || messages[0].key.fromMe) return;
        const msg = messages[0];
        const remoteJid = normalizeJid(msg.key.remoteJid || '');
        const isGroup = remoteJid.endsWith('@g.us');
        const groupId = isGroup ? remoteJid : null;
        const participantId = normalizeJid(msg.key.participant || remoteJid);
        const senderId = isGroup ? participantId : remoteJid;
        const userId = isGroup ? participantId : remoteJid;

        const conversationKey = isGroup ? `${remoteJid}_${participantId}` : remoteJid;
        /* === Catch Accept button === */
        if (msg.message?.buttonsResponseMessage?.selectedButtonId?.startsWith("ACCEPT_")) {
          const code = msg.message.buttonsResponseMessage.selectedButtonId.replace("ACCEPT_", "");
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
          if (!isConversationActive(conversationKey)) { startConversation(conversationKey); isNewConversation = true; }
          else updateConversationActivity(conversationKey);
          shouldRespond = true;
          console.log(`💬 Private message from ${senderId}`);
        }

        if (!shouldRespond) return;

        // Important: pass full msg if no text (to capture locationMessage)
        const inputForAI = text || msg;
        console.log(`🤖 Processing: "${text || '[non-text message]'}" ${isNewConversation ? '(New)' : '(Cont.)'}`);
        const aiReply = await getAIResponse(userId, inputForAI);

        if (isGroup) {
          if (sendPrivately) {
            await sock.sendMessage(senderId, { text: aiReply });
            console.log(`📤 Private reply to ${senderId}`);
          } else {
            await sock.sendMessage(groupId, { text: aiReply });
            console.log(`📤 Group reply to ${groupId}`);
          }
        } else {
          await sock.sendMessage(senderId, { text: aiReply });
          console.log(`📤 Private reply to ${senderId}`);
        }
      } catch (err) {
        console.error('messages.upsert error:', err);
      }
    });

    /* === Keep alive / presence / cleanup === */
    setInterval(() => { try { if (sock?.ws && sock.ws.readyState === 1) sock.ws.ping(); } catch {} }, 30000);
    setInterval(async () => { try { if (sock?.user) await sock.sendPresenceUpdate('available'); } catch {} }, 60000);
    setInterval(() => {
      const now = Date.now();
      for (const [key, conv] of activeConversations.entries()) {
        if (now - conv.lastActivity >= CONVERSATION_TIMEOUT) {
          activeConversations.delete(key);
          console.log(`🧹 Expired conversation: ${key}`);
        }
      }
    }, 5 * 60 * 1000);

    console.log('Bot started.');
  } catch (err) {
    console.error('startBot error:', err);
    setTimeout(() => { isStarting = false; if (!shouldStop) startBot(); }, 2000);
  } finally {
    isStarting = false;
  }
}

startBot();

/* === Reminders === */
startReminderScheduler(async (userId, text) => {
  await sock.sendMessage(userId, { text });
});

/* === Graceful shutdown === */
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  shouldStop = true;
  await stopRealtimeSubscription();
  try { if (sock && sock.ws && sock.ws.readyState === 1) await sock.end(); } catch {}
  server.close(() => process.exit(0));
});
