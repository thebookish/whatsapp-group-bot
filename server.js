// server.js
const express = require('express');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./ai');
const { WebSocketServer } = require('ws');
const { getDueReminders, markReminderSent } = require('./reminder');
const app = express();
const PORT = 3000;
const AUTH_DIR = 'auth_info_baileys';
const KEEP_ALIVE_MS = 10000;
const TRIGGER_KEYWORD = 'heybot'; // Trigger word to start conversation
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout

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
let activeConversations = new Map(); // Track active conversations

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
  activeConversations.set(conversationKey, {
    startTime: Date.now(),
    lastActivity: Date.now()
  });
  console.log(`🆕 Started conversation: ${conversationKey}`);
}

function updateConversationActivity(conversationKey) {
  const conversation = activeConversations.get(conversationKey);
  if (conversation) {
    conversation.lastActivity = Date.now();
  }
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
        const userId = isGroup ? participantId : remoteJid;      // Always user’s JID (not group JID)

// Use different key for conversation state management
const conversationKey = isGroup ? `${remoteJid}_${participantId}` : remoteJid;

        let text = extractTextFromMessage(msg.message);
        if (!text?.trim()) return;
        text = text.trim();

        let shouldRespond = false;
        let sendPrivately = false;
        let isNewConversation = false;

        if (isGroup) {
          const conversationActive = isConversationActive(conversationKey);
          
          // Check if message starts with trigger word
          const startsWithTrigger = text.toLowerCase().startsWith(TRIGGER_KEYWORD.toLowerCase());
          
          if (startsWithTrigger) {
            // Start new conversation or continue existing one
            if (!conversationActive) {
              startConversation(conversationKey);
              isNewConversation = true;
            }
            shouldRespond = true;
            
            // Remove trigger word from text
            text = text.slice(TRIGGER_KEYWORD.length).trim();
            console.log(`🎯 Trigger word used in group ${groupId} by ${participantId}`);
            
          } else if (conversationActive) {
            // Check if bot is mentioned or replied to in active conversation
            const isMentioned = isBotMentioned(msg.message, botJid);
            const isRepliedTo = isBotRepliedTo(msg.message, botJid);
            
            if (isMentioned || isRepliedTo) {
              shouldRespond = true;
              updateConversationActivity(conversationKey);
              console.log(`🎯 Bot ${isMentioned ? 'mentioned' : 'replied to'} in active conversation ${conversationKey}`);
              
              // Clean up mention from text if present
              if (isMentioned) {
                text = text.replace(/@\d+/g, '').trim();
              }
            }
          }
          
          // Check for private reply request
          if (shouldRespond && /reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
            sendPrivately = true;
            text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, '').trim();
          }
          
        } else {
          // In private chats, always respond and maintain conversation
          if (!isConversationActive(conversationKey)) {
            startConversation(conversationKey);
            isNewConversation = true;
          } else {
            updateConversationActivity(conversationKey);
          }
          shouldRespond = true;
          console.log(`💬 Private message from ${senderId}`);
        }

        if (!shouldRespond || !text) return;

        console.log(`🤖 Processing message: "${text}" ${isNewConversation ? '(New conversation)' : '(Continuing conversation)'}`);
        const aiReply = await getAIResponse(userId, text);

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

    // Cleanup expired conversations every 5 minutes
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
// Check reminders every 30 seconds
setInterval(async () => {
  try {
    const due = await getDueReminders();
    for (const r of due) {
      console.log("📤 Sending reminder:", r);

      // Send reminder message to user
      await getAIResponse(r.user_id, { text: `⏰ Reminder: ${r.message}` });

      // Mark as sent
      await markReminderSent(r.id);
    }
  } catch (err) {
    console.error("Reminder check error:", err);
  }
}, 30000);

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