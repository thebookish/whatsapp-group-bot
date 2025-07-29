const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
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
  // add more cases if needed

  return '';
}

// WhatsApp + Baileys
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    // Remove this line:
    // qrcode.generate(qr, { small: true });
    
    broadcast({ type: 'qr', qr });
  }

  if (connection === 'open') {
    console.log('✅ WhatsApp connected');
    broadcast({ type: 'status', status: 'connected' });
  } else if (connection === 'close') {
    console.log('🔌 Connection closed, reconnecting...');
    broadcast({ type: 'status', status: 'disconnected' });
    startBot(); // auto-reconnect
  }
});


  sock.ev.on('creds.update', saveCreds);

 sock.ev.on('messages.upsert', async ({ messages, type }) => {
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return;

  const text = extractTextFromMessage(msg.message).trim();
  if (!text) return; // no valid text to process

  const sender = msg.key.remoteJid;
  const isGroup = sender.endsWith('@g.us');
  const from = isGroup ? msg.pushName || sender : sender;

  broadcast({
    type: 'message',
    from,
    text,
    isGroup
  });

  // Pass user ID and message text to your getAIResponse (update signature if needed)
  const aiReply = await getAIResponse(sender, text);

  await sock.sendMessage(sender, { text: aiReply });
  broadcast({
    type: 'reply',
    to: from,
    text: aiReply
  });
});

}

startBot();
