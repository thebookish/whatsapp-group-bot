// server.js
/* eslint-disable no-console */
const express = require('express');
const path = require('path');
const P = require('pino');
const { WebSocketServer } = require('ws');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const { getAIResponse } = require('./openrouter');

const app = express();

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_MS || 10000);
const TRIGGER_KEYWORD = (process.env.TRIGGER_KEYWORD || 'heybot').toLowerCase();
const READ_MESSAGES = (process.env.READ_MESSAGES || 'true') === 'true'; // mark messages read
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // trace|debug|info|warn|error|fatal

// ───────────────────────────────────────────────────────────────────────────────
// HTTP + Static
// ───────────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (for QR + status)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(str);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Baileys state
// ───────────────────────────────────────────────────────────────────────────────
let sock = null;
let saveCreds = null;
let isStarting = false;
let shouldStop = false;
let lastActivity = Date.now();
let reconnectAttempt = 0;
let watchdogTimer = null;

// Helpful: normalize message text from many types
function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message?.conversation === 'string') return message.conversation;
  if (typeof message?.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message?.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (typeof message?.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (typeof message?.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message?.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (typeof message?.templateButtonReplyMessage?.selectedId === 'string') return message.templateButtonReplyMessage.selectedId;
  if (typeof message?.interactiveResponseMessage?.body?.text === 'string') return message.interactiveResponseMessage.body.text;
  if (typeof message?.conversationContextInfo?.response?.text === 'string') return message.conversationContextInfo.response.text;
  if (message?.messageContextInfo?.message?.conversation) return message.messageContextInfo.message.conversation;
  if (message?.text?.body) return message.text.body;
  return '';
}

// Pretty reason
function reasonName(code) {
  const map = DisconnectReason || {};
  const found = Object.entries(map).find(([k, v]) => v === code);
  return found ? found[0] : String(code);
}

// Stop + clear timers
async function stopCurrentSocket() {
  try {
    if (sock?.ws && sock.ws.readyState === 1) {
      await sock.end();
    }
  } catch { /* ignore */ }
  sock = null;
}

// Backoff
function nextBackoffMs() {
  const base = 1000; // 1s
  const max = 15000; // 15s
  const jitter = Math.floor(Math.random() * 500);
  const exp = Math.min(max, base * (2 ** reconnectAttempt));
  return exp + jitter;
}

// Watchdog to keep things healthy even when idle
function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    const now = Date.now();

    // If no activity for > 2 minutes, recycle connection
    if (now - lastActivity > 120000) {
      console.warn('⚠ No activity for 2 minutes — recycling connection...');
      await stopCurrentSocket();
      startBot(true);
      return;
    }

    // KeepAlive ping
    try {
      if (sock?.ws && sock.ws.readyState === 1) {
        sock.ws.ping();
      }
    } catch { /* ignore */ }
  }, 20000);
}

// ───────────────────────────────────────────────────────────────────────────────
// Start / Restart Bot
// ───────────────────────────────────────────────────────────────────────────────
async function startBot(isRestart = false) {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = _saveCreds;

    // Ensure only one socket
    await stopCurrentSocket();

    // Always fetch latest Baileys version for compatibility
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔧 Using WA version ${version.join('.')} (latest=${isLatest})`);

    // Pino logger
    const logger = P({ level: LOG_LEVEL });

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        /** cache keystore for perf */
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false, // we serve QR via WS
      browser: ['BotServer', 'Chrome', '1.0'], // stable browser signature
      keepAliveIntervalMs: KEEP_ALIVE_MS,
      // lower memory footprint in groups
      syncFullHistory: false,
      // Don’t advertise presence too often
      markOnlineOnConnect: true,
    });

    // creds persistence
    sock.ev.on('creds.update', saveCreds);

    // connection lifecycle
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        broadcast({ type: 'qr', qr });
        console.log('📷 New QR generated (scan with WhatsApp).');
      }

      if (connection === 'open') {
        reconnectAttempt = 0;
        lastActivity = Date.now();
        console.log('✅ WhatsApp connected');
        broadcast({ type: 'status', status: 'connected' });
      } else if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.status ||
          lastDisconnect?.error?.code ||
          lastDisconnect?.statusCode;

        const reason = reasonName(code);
        const isLoggedOut = code === DisconnectReason.loggedOut;

        console.warn(`🔌 Connection closed. reason=${reason} code=${code} loggedOut=${isLoggedOut}`);
        broadcast({ type: 'status', status: 'disconnected', reason, code });

        if (shouldStop) return;

        if (isLoggedOut) {
          // Session is invalid — require fresh QR
          console.error('❌ Logged out — remove auth folder to start fresh or rescan in-place.');
          // Let Baileys emit QR next start
        }

        // Handle conflict (replaced) explicitly: reconnect and take the latest session
        if (code === DisconnectReason.conflict) {
          console.warn('⚠ Conflict (replaced) — another client took over. Reconnecting to regain session…');
        }

        // schedule reconnect with backoff
        reconnectAttempt += 1;
        const wait = nextBackoffMs();
        setTimeout(() => startBot(true), wait);
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        broadcast({ type: 'status', status: 'connecting' });
      }
    });

    // messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!messages?.length) return;
      const msg = messages[0];

      try {
        // ignore from self / status updates
        if (msg.key.fromMe) return;
        if (type !== 'notify' && type !== 'append') return;

        lastActivity = Date.now();

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');
        const groupId = isGroup ? remoteJid : null;
        const participantId = msg.key.participant || remoteJid;
        const senderId = isGroup ? participantId : remoteJid;
        const safeSender = jidNormalizedUser(senderId);
        const conversationKey = isGroup ? `${groupId}_${participantId}` : safeSender;

        let text = extractTextFromMessage(msg.message);
        if (!text?.trim()) return;
        text = text.trim();

        // group: require trigger keyword
        let sendPrivately = false;
        if (isGroup) {
          if (!text.toLowerCase().startsWith(TRIGGER_KEYWORD)) return;
          text = text.slice(TRIGGER_KEYWORD.length).trim();
          if (!text) return;

          if (/reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
            sendPrivately = true;
            text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
            if (!text) return;
          }
        }

        if (READ_MESSAGES) {
          try {
            await sock.readMessages([msg.key]);
          } catch { /* ignore */ }
        }

        // AI response
        const aiReply = await getAIResponse(conversationKey, text);

        if (isGroup) {
          if (sendPrivately) {
            await sock.sendMessage(safeSender, { text: aiReply });
          } else {
            await sock.sendMessage(groupId, { text: aiReply }, { quoted: msg });
          }
        } else {
          await sock.sendMessage(safeSender, { text: aiReply }, { quoted: msg });
        }
      } catch (err) {
        console.error('messages.upsert error:', err);
      }
    });

    // Presence & receipts (optional, lightweight)
    sock.ev.on('messages.update', () => { lastActivity = Date.now(); });
    sock.ev.on('messaging-history.set', () => { lastActivity = Date.now(); });

    // Heartbeat watchdog
    startWatchdog();

    console.log(isRestart ? '🔁 Bot restarted.' : '🤖 Bot started.');
    broadcast({ type: 'status', status: 'started' });
  } catch (err) {
    console.error('startBot error:', err);
    reconnectAttempt += 1;
    const wait = nextBackoffMs();
    setTimeout(() => startBot(true), wait);
  } finally {
    isStarting = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Boot
// ───────────────────────────────────────────────────────────────────────────────
startBot();

// ───────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ───────────────────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  shouldStop = true;
  try { await stopCurrentSocket(); } catch {}
  if (watchdogTimer) clearInterval(watchdogTimer);
  server.close(() => process.exit(0));
});
