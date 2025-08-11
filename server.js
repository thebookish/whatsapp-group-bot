// server.js
const express = require('express');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./openrouter');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = 3000;
const AUTH_DIR = 'auth_info_baileys';
const KEEP_ALIVE_MS = 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

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

let sock = null;
let saveCreds = null;
let isStarting = false;
let shouldStop = false;

let lastMessageTimestamp = Date.now();

function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (message?.text?.body) return message.text.body;
  return '';
}

async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    const stateRes = await useMultiFileAuthState(AUTH_DIR);
    const { state, saveCreds: _saveCreds } = stateRes;
    saveCreds = _saveCreds;

    if (sock) {
      try {
        if (sock.ws && sock.ws.readyState === 1) {
          await sock.end();
        }
      } catch (err) {
        if (!/WebSocket was closed before the connection/.test(String(err))) {
          console.error('Error ending socket:', err);
        }
      }
      sock = null;
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      keepAliveIntervalMs: KEEP_ALIVE_MS,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        broadcast({ type: 'qr', qr });
        console.log('📷 New QR generated.');
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp connected');
        broadcast({ type: 'status', status: 'connected' });
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = reason === DisconnectReason.loggedOut;

        console.log('🔌 Connection closed.', reason, 'loggedOut:', isLoggedOut);
        broadcast({ type: 'status', status: 'disconnected', reason });

        setTimeout(() => {
          isStarting = false;
          if (!shouldStop) startBot();
        }, 2000);
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        broadcast({ type: 'status', status: 'connecting' });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handling
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        if (!messages?.[0] || messages[0].key.fromMe) return;
        const msg = messages[0];
        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');
        const groupId = isGroup ? remoteJid : null;
        const participantId = msg.key.participant || remoteJid;
        const senderId = isGroup ? participantId : remoteJid;
        const conversationKey = isGroup ? `${groupId}_${participantId}` : senderId;

        let text;
        try {
          text = extractTextFromMessage(msg.message);
        } catch (err) {
          if (String(err).includes('No session record')) {
            console.warn('⚠ Skipping undecryptable message (No session record). Requesting retry...');
            await sock.sendMessage(senderId, { text: 'Please resend your message, I could not decrypt it.' });
            return;
          }
          throw err;
        }

        if (!text?.trim()) return;
        text = text.trim();
        lastMessageTimestamp = Date.now();

        let sendPrivately = false;
        if (isGroup) {
          const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const botJid = sock?.user?.id;
          const isMentioned = mentionedJids.includes(botJid);
          if (!isMentioned) return;

          const botNumber = sock?.user?.id?.split('@')[0];
          text = text.replace(new RegExp(`@${botNumber}`, 'g'), '').trim();

          if (/reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
            sendPrivately = true;
            text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
          }
          if (!text) return;
        }

        const aiReply = await getAIResponse(conversationKey, text);

        if (isGroup) {
          if (sendPrivately) {
            await sock.sendMessage(senderId, { text: aiReply });
          } else {
            const participantNumber = participantId.split('@')[0];
            await sock.sendMessage(groupId, {
              text: `@${participantNumber} ${aiReply}`,
              mentions: [participantId]
            });
          }
        } else {
          await sock.sendMessage(senderId, { text: aiReply });
        }
      } catch (err) {
        if (String(err).includes('No session record')) {
          console.warn('⚠ Missing session key — ignoring message.');
        } else {
          console.error('messages.upsert error:', err);
        }
      }
    });

    // Heartbeat watchdog to keep socket alive and reconnect after idle
    setInterval(async () => {
      const now = Date.now();

      // If no message in last 2 mins, reconnect
      if (now - lastMessageTimestamp > 120000) {
        console.warn('⚠ No activity for 2 minutes — reconnecting...');
        try {
          if (sock?.ws && sock.ws.readyState === 1) {
            await sock.end();
          } else {
            console.warn('⚠ Socket not open, skipping end().');
          }
        } catch (err) {
          if (!/WebSocket was closed before the connection/.test(String(err))) {
            console.error('Error ending socket:', err);
          }
        }
        startBot();
        return;
      }

      try {
        // ping to keep connection alive
        if (sock?.ws && sock.ws.readyState === 1) {
          sock.ws.ping();
        }
      } catch (err) {
        console.error('⚠ Heartbeat failed:', err);
      }
    }, 20000);

    console.log('Bot started.');
  } catch (err) {
    console.error('startBot error:', err);
    setTimeout(() => {
      isStarting = false;
      if (!shouldStop) startBot();
    }, 2000);
  } finally {
    isStarting = false;
  }
}

startBot();

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  shouldStop = true;
  try {
    if (sock) {
      if (sock.ws && sock.ws.readyState === 1) {
        await sock.end();
      }
    }
  } catch {}
  server.close(() => process.exit(0));
});
