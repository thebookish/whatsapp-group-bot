const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { getAIResponse } = require('./openrouter');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// WebSocket setup
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
}

function extractTextFromMessage(message) {
  if (!message) return '';

  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId;

  return '';
}

// WhatsApp + Baileys
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false // We send QR via WebSocket
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      broadcast({ type: 'qr', qr });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected');
      broadcast({ type: 'status', status: 'connected' });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('🔌 Connection closed. Reconnecting:', shouldReconnect);
      broadcast({ type: 'status', status: 'disconnected' });

      if (shouldReconnect) {
        setTimeout(() => startBot(), 2000); // Delay to prevent crash loop
      } else {
        console.log('❌ Logged out. Delete auth_info_baileys to re-authenticate.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const isGroup = msg.key.remoteJid.endsWith('@g.us');
    const groupId = msg.key.remoteJid;
    const participantId = msg.key.participant; // only in groups
    const senderId = isGroup ? participantId : msg.key.remoteJid;
    const conversationKey = isGroup ? `${groupId}_${participantId}` : senderId;

    const text = extractTextFromMessage(msg.message);
    if (!text) return;

    try {
      const aiReply = await getAIResponse(conversationKey, text);

      if (isGroup) {
        const participantNumber = participantId.split('@')[0];
        await sock.sendMessage(groupId, {
          text: `@${participantNumber} ${aiReply}`,
          mentions: [participantId]
        });
      } else {
        await sock.sendMessage(senderId, { text: aiReply });
      }
    } catch (err) {
      console.error('❌ AI Reply Error:', err);
    }
  });

  // Keep connection alive
  setInterval(() => {
    if (sock?.ws && sock.ws.readyState === 1) {
      sock.ws.ping();
    }
  }, 20_000);

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    await sock.logout();
    process.exit(0);
  });
}

startBot();
