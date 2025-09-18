const express = require('express');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./ai');
const { WebSocketServer } = require('ws');
const { initMatch } = require('./match'); // ✅ NEW

const app = express();
const PORT = 3000;
const AUTH_DIR = 'auth_info_baileys';
const KEEP_ALIVE_MS = 10000;
const TRIGGER_KEYWORD = 'heybot';
const CONVERSATION_TIMEOUT = 30 * 60 * 1000;

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
let botJid = null;
let activeConversations = new Map();

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
  if (message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botJid)) return true;
  if (message.contextInfo?.mentionedJid?.includes(botJid)) return true;
  return false;
}
function isBotRepliedTo(message, botJid) {
  if (!message || !botJid) return false;
  const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
  const stanzaId = message.extendedTextMessage?.contextInfo?.stanzaId;
  const participant = message.extendedTextMessage?.contextInfo?.participant;
  if (participant === botJid || (quotedMsg && stanzaId)) return true;
  return false;
}

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
        botJid = sock.user.id;
        console.log('🤖 Bot JID:', botJid);
        broadcast({ type: 'status', status: 'connected' });

        // ✅ init match after socket is ready
        initMatch({
          send: (jid, text) => sock.sendMessage(jid, { text }),
          createGroup: (subject, jids) => sock.groupCreate(subject, jids),
        });

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
        const userId = isGroup ? participantId : remoteJid;

        const conversationKey = isGroup ? `${remoteJid}_${participantId}` : remoteJid;

        let text = extractTextFromMessage(msg.message);
        if (!text && !msg.message?.locationMessage) return; // allow location-only

        let shouldRespond = false;
        let sendPrivately = false;
        let isNewConversation = false;

        if (isGroup) {
          const conversationActive = isConversationActive(conversationKey);
          const startsWithTrigger = (text || '').toLowerCase().startsWith(TRIGGER_KEYWORD.toLowerCase());

          if (startsWithTrigger) {
            if (!conversationActive) {
              startConversation(conversationKey);
              isNewConversation = true;
            }
            shouldRespond = true;
            text = (text || '').slice(TRIGGER_KEYWORD.length).trim();
            console.log(`🎯 Trigger word used in group ${groupId} by ${participantId}`);
          } else if (conversationActive) {
            const isMentioned = isBotMentioned(msg.message, botJid);
            const isRepliedTo = isBotRepliedTo(msg.message, botJid);
            if (isMentioned || isRepliedTo) {
              shouldRespond = true;
              updateConversationActivity(conversationKey);
              console.log(`🎯 Bot ${isMentioned ? 'mentioned' : 'replied to'} in active conversation ${conversationKey}`);
              if (isMentioned && text) text = text.replace(/@\d+/g, '').trim();
            }
          }

          if (shouldRespond && /reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text || '')) {
            sendPrivately = true;
            text = (text || '').replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
          }

        } else {
          if (!isConversationActive(conversationKey)) {
            startConversation(conversationKey);
            isNewConversation = true;
          } else {
            updateConversationActivity(conversationKey);
          }
          shouldRespond = true;
          console.log(`💬 Private message from ${senderId}`);
        }

        if (!shouldRespond) return;

        console.log(`🤖 Processing message: "${text || '[non-text]'}" ${isNewConversation ? '(New conversation)' : '(Continuing conversation)'}`);
        // ✅ pass the full msg so ai.js can read locationMessage when needed
        const aiReply = await getAIResponse(userId, msg);

        if (!aiReply) return;

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
      try { if (sock?.ws && sock.ws.readyState === 1) sock.ws.ping(); } catch {}
    }, 30000);

    // Presence update every minute
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

    // Cleanup expired conversations
    setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;
      for (const [key, conversation] of activeConversations.entries()) {
        if (now - conversation.lastActivity >= CONVERSATION_TIMEOUT) {
          activeConversations.delete(key);
          cleanedCount++;
        }
      }
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} expired conversations. Active: ${activeConversations.size}`);
      }
    }, 5 * 60 * 1000);

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
