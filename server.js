// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./openrouter');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = 'auth_info_baileys';
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_MS || 10000);

// Keyword trigger(s) for group chats (comma separated in env) e.g. "@bot,bot"
const triggers = (process.env.KEYWORD_TRIGGER || '@bot,bot')
  .split(',')
  .map(t => t.trim().toLowerCase())
  .filter(Boolean);

// Serve frontend static (if any)
app.use(express.static(path.join(__dirname, 'public')));

// Simple health endpoint
app.get('/health', (req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Setup websocket for sending QR/status to frontend (optional)
const wss = new WebSocketServer({ server });
function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
}

let sock = null;
let saveCreds = null;
let isStarting = false;
let shouldStop = false;

function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId;
  // default fallbacks
  if (message?.text?.body) return message.text.body;
  return '';
}

async function startBot() {
  if (isStarting) {
    console.log('startBot called but already starting — ignoring duplicate call.');
    return;
  }
  isStarting = true;
  console.log('🔧 Starting WhatsApp bot...');

  try {
    const stateRes = await useMultiFileAuthState(AUTH_DIR);
    const { state, saveCreds: _saveCreds } = stateRes;
    saveCreds = _saveCreds;

    // close previous socket if exists
    if (sock) {
      try { await sock.logout(); } catch (e) { /* ignore */ }
      sock = null;
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we will handle QR ourselves
      keepAliveIntervalMs: KEEP_ALIVE_MS,
      // optional: add additional options per Baileys docs
    });

    // When QR comes in, broadcast it (frontend can render it)
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // optional: show QR in terminal too for manual scanning
        try { qrcode.generate(qr, { small: true }); } catch {}
        broadcast({ type: 'qr', qr });
        console.log('📷 New QR generated, sent to frontend.');
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp connected');
        broadcast({ type: 'status', status: 'connected' });
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        broadcast({ type: 'status', status: 'connecting' });
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = reason === DisconnectReason.loggedOut;
        console.log('🔌 Connection closed. Reason:', reason, 'loggedOut:', isLoggedOut);
        broadcast({ type: 'status', status: 'disconnected', reason });

        // If logged out, we must re-authenticate (QR)
        if (isLoggedOut) {
          console.log('❌ Session logged out. You will need to re-authenticate (remove auth_info_baileys to reset).');
          // Don't auto-restart if logged out. Let user scan QR.
          // But still try to restart to allow reauth flow
          setTimeout(() => {
            isStarting = false;
            startBot();
          }, 2000);
        } else {
          // Attempt reconnect after short delay
          console.log('🔄 Attempting reconnect in 2s...');
          setTimeout(() => {
            isStarting = false;
            if (!shouldStop) startBot();
          }, 2000);
        }
      }
    });

    // save credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // messages handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        if (!messages || !messages[0]) return;
        const msg = messages[0];

        // Only handle normal incoming messages
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');
        const groupId = isGroup ? remoteJid : null;
        const participantId = msg.key.participant; // only for groups
        const senderId = isGroup ? participantId : msg.key.remoteJid; // final recipient to reply
        const conversationKey = isGroup ? `${groupId}_${participantId}` : senderId;

        let text = extractTextFromMessage(msg.message);
        if (!text || !text.trim()) return;
        text = text.trim();

        // If it's a group, check for trigger keywords
        if (isGroup) {
          const lower = text.toLowerCase();
          const containsTrigger = triggers.some(t => {
            if (!t) return false;
            // check whole word or prefix; also allow '@' mention forms
            return lower.includes(t);
          });
          if (!containsTrigger) {
            // ignore group chatter without trigger
            return;
          }

          // remove trigger from text (first occurrence) so AI sees the clean prompt
          for (const t of triggers) {
            const idx = text.toLowerCase().indexOf(t);
            if (idx !== -1) {
              // remove that slice
              text = (text.slice(0, idx) + text.slice(idx + t.length)).trim();
              break;
            }
          }
          if (!text) {
            // If nothing left after removing trigger, do not call AI
            return;
          }
        }

        // Call AI
        try {
          const aiReply = await getAIResponse(conversationKey, text);

          if (isGroup) {
            // mention the participant in group reply
            // participantId is full jid like 12345@s.whatsapp.net
            const participantNumber = participantId.split('@')[0];
            await sock.sendMessage(groupId, {
              text: `@${participantNumber} ${aiReply}`,
              mentions: [participantId]
            });
          } else {
            await sock.sendMessage(senderId, { text: aiReply });
          }
        } catch (err) {
          console.error('❌ Error while getting AI reply:', err);
        }
      } catch (err) {
        console.error('messages.upsert handler error:', err);
      }
    });

    // extra keepalive ping — optional
    setInterval(() => {
      try {
        if (sock?.ws && sock.ws.readyState === 1) {
          sock.ws.ping();
        }
      } catch (e) { /* ignore */ }
    }, Math.max(5000, KEEP_ALIVE_MS));

    console.log('Bot started.');
  } catch (err) {
    console.error('startBot error:', err);
    // try to restart after delay
    setTimeout(() => {
      isStarting = false;
      if (!shouldStop) startBot();
    }, 2000);
  } finally {
    isStarting = false;
  }
}

// Start once
startBot();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  shouldStop = true;
  try {
    if (sock) {
      try { await sock.logout(); } catch (e) { /* ignore */ }
      sock = null;
    }
  } catch (e) { /* ignore */ }
  server.close(() => {
    process.exit(0);
  });
});
