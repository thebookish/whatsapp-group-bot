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
let botJid = null; // Store bot's JID

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

function isBotMentioned(message, botJid) {
  if (!message || !botJid) return false;
  
  // Check for mentions in extendedTextMessage
  if (message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid)) {
    return true;
  }
  
  // Check for mentions in regular message
  if (message.contextInfo?.mentionedJid?.includes(botJid)) {
    return true;
  }
  
  return false;
}

function isBotRepliedTo(message, botJid) {
  if (!message || !botJid) return false;
  
  // Check if this is a reply to bot's message
  const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
  const stanzaId = message.extendedTextMessage?.contextInfo?.stanzaId;
  const participant = message.extendedTextMessage?.contextInfo?.participant;
  
  // If replying to a message from the bot
  if (participant === botJid || (quotedMsg && stanzaId)) {
    return true;
  }
  
  return false;
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
      } catch {}
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
        botJid = sock.user.id; // Store bot's JID when connected
        console.log('🤖 Bot JID:', botJid);
        broadcast({ type: 'status', status: 'connected' });
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = reason === DisconnectReason.loggedOut;

        console.log('🔌 Connection closed.', reason, 'loggedOut:', isLoggedOut);
        broadcast({ type: 'status', status: 'disconnected', reason });

        if (!isLoggedOut) {
          setTimeout(() => {
            isStarting = false;
            if (!shouldStop) startBot();
          }, 2000);
        } else {
          console.log('❌ Logged out — restart with new QR.');
        }
      } else if (connection === 'connecting') {
        console.log('🔄 WhatsApp connecting...');
        broadcast({ type: 'status', status: 'connecting' });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle messages
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

        let text = extractTextFromMessage(msg.message);
        if (!text?.trim()) return;
        text = text.trim();

        let shouldRespond = false;
        let sendPrivately = false;

        if (isGroup) {
          // In groups, only respond if bot is mentioned or replied to
          const isMentioned = isBotMentioned(msg.message, botJid);
          const isRepliedTo = isBotRepliedTo(msg.message, botJid);
          
          if (isMentioned || isRepliedTo) {
            shouldRespond = true;
            console.log(`🎯 Bot ${isMentioned ? 'mentioned' : 'replied to'} in group ${groupId}`);
            
            // Clean up mention from text if present
            if (isMentioned) {
              // Remove @mention from text (WhatsApp mentions appear as @[number])
              text = text.replace(/@\d+/g, '').trim();
            }
            
            // Check for private reply request
            if (/reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
              sendPrivately = true;
              text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
            }
          }
        } else {
          // In private chats, always respond
          shouldRespond = true;
          console.log(`💬 Private message from ${senderId}`);
        }

        if (!shouldRespond || !text) return;

        console.log(`🤖 Processing message: "${text}"`);
        const aiReply = await getAIResponse(conversationKey, text);

        if (isGroup) {
          if (sendPrivately) {
            await sock.sendMessage(senderId, { text: aiReply });
            console.log(`📤 Sent private reply to ${senderId}`);
          } else {
            await sock.sendMessage(groupId, { text: aiReply });
            console.log(`📤 Sent group reply to ${groupId}`);
          }
        } else {
          await sock.sendMessage(senderId, { text: aiReply });
          console.log(`📤 Sent private reply to ${senderId}`);
        }
      } catch (err) {
        console.error('messages.upsert error:', err);
      }
    });

    // Keep-alive ping
    setInterval(() => {
      try {
        if (sock?.ws && sock.ws.readyState === 1) {
          sock.ws.ping();
        }
      } catch {}
    }, 30000);

    // Presence update every minute to look active
    setInterval(async () => {
      try {
        if (sock?.user) {
          await sock.sendPresenceUpdate('available');
          console.log('🟢 Presence updated: available');
        }
      } catch (err) {
        console.error('Presence update error:', err);
      }
    }, 60000);

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
    if (sock && sock.ws && sock.ws.readyState === 1) {
      await sock.end();
    }
  } catch {}
  server.close(() => process.exit(0));
});