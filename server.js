const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

// Optional: AI response logic
const { getAIResponse } = require('./openrouter');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve frontend if any
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// WebSocket for real-time updates (e.g., QR code)
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
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

// Main function to start bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📸 QR code received. Scan it in your WhatsApp app.');
      broadcast({ type: 'qr', qr });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      broadcast({ type: 'status', status: 'connected' });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Connection closed. Reconnecting:', shouldReconnect);
      broadcast({ type: 'status', status: 'disconnected' });

      if (shouldReconnect) {
        startBot(); // auto reconnect
      } else {
        console.log('❌ Logged out. Delete auth_info_baileys to re-authenticate.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const isGroup = msg.key.remoteJid.endsWith('@g.us');
    const groupId = msg.key.remoteJid;
    const participantId = msg.key.participant || msg.key.remoteJid;
    const senderId = isGroup ? participantId : msg.key.remoteJid;
    const conversationKey = isGroup ? `${groupId}_${participantId}` : senderId;

    const text = extractTextFromMessage(msg.message);
    if (!text) return;

    const aiReply = await getAIResponse(conversationKey, text);

    if (isGroup) {
      const number = participantId.split('@')[0];
      await sock.sendMessage(groupId, {
        text: `@${number} ${aiReply}`,
        mentions: [participantId],
      });
    } else {
      await sock.sendMessage(senderId, { text: aiReply });
    }
  });

  // Optional: Ping every 20 seconds to keep connection alive
  setInterval(() => {
    if (sock?.ws && sock.ws.readyState === 1) {
      sock.ws.ping();
    }
  }, 20_000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    await sock.logout();
    process.exit(0);
  });
}

startBot();
