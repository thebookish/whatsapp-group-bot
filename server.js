// server.js
const express = require("express");
const path = require("path");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { getAIResponse } = require("./openrouter");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = "auth_info_baileys";
const KEEP_ALIVE_MS = 10000;
const TRIGGER_KEYWORD = "heybot"; // change trigger word here

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

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

// Extract text from different WhatsApp message types
function extractTextFromMessage(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.buttonsResponseMessage?.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId;
  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (message.text?.body) return message.text.body;
  return "";
}

// Safe send message
async function sendMessageSafe(jid, content) {
  if (!sock || !sock.ws || sock.ws.readyState !== 1) {
    console.warn("⚠ Cannot send message: socket not ready.");
    return;
  }
  try {
    await sock.sendMessage(jid, content);
  } catch (err) {
    console.error("❌ Failed to send message:", err);
  }
}

// Start bot
async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = _saveCreds;

    if (sock) {
      try {
        if (sock.ws && sock.ws.readyState === 1) await sock.end();
      } catch {}
      sock = null;
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      keepAliveIntervalMs: KEEP_ALIVE_MS,
      browser: ["AI Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        broadcast({ type: "qr", qr });
        console.log("📷 New QR code generated.");
      }

      if (connection === "open") {
        console.log("✅ WhatsApp connected");
        broadcast({ type: "status", status: "connected" });
      } else if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const isLoggedOut = reason === DisconnectReason.loggedOut;

        console.log("🔌 Connection closed.", reason, "loggedOut:", isLoggedOut);
        broadcast({ type: "status", status: "disconnected", reason });

        if (!isLoggedOut && !shouldStop) {
          console.log("🔄 Reconnecting in 2s...");
          setTimeout(() => {
            isStarting = false;
            startBot();
          }, 2000);
        } else if (isLoggedOut) {
          console.log("❌ Logged out — delete auth_info_baileys to scan a new QR.");
        }
      } else if (connection === "connecting") {
        console.log("🔄 Connecting to WhatsApp...");
        broadcast({ type: "status", status: "connecting" });
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // Incoming message handler
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        if (!messages?.[0] || messages[0].key.fromMe) return;

        const msg = messages[0];
        const remoteJid = msg.key.remoteJid || "";
        const isGroup = remoteJid.endsWith("@g.us");
        const groupId = isGroup ? remoteJid : null;
        const participantId = msg.key.participant || remoteJid;
        const senderId = isGroup ? participantId : remoteJid;
        const conversationKey = isGroup ? `${groupId}_${participantId}` : senderId;

        let text = extractTextFromMessage(msg.message).trim();
        if (!text) return;
        lastMessageTimestamp = Date.now();

        let sendPrivately = false;

        if (isGroup) {
          if (!text.toLowerCase().startsWith(TRIGGER_KEYWORD.toLowerCase())) return;

          text = text.slice(TRIGGER_KEYWORD.length).trim();

          if (/reply\s+me\s+privately|dm\s+me|private\s+reply/i.test(text)) {
            sendPrivately = true;
            text = text.replace(/reply\s+me\s+privately|dm\s+me|private\s+reply/gi, "").trim();
          }
          if (!text) return;
        }

        const aiReply = await getAIResponse(conversationKey, text);

        if (isGroup) {
          if (sendPrivately) {
            await sendMessageSafe(senderId, { text: aiReply });
          } else {
            await sendMessageSafe(groupId, { text: aiReply });
          }
        } else {
          await sendMessageSafe(senderId, { text: aiReply });
        }
      } catch (err) {
        console.error("messages.upsert error:", err);
      }
    });

    // Heartbeat watchdog
    setInterval(async () => {
      const now = Date.now();

      if (now - lastMessageTimestamp > 120000 && !isStarting) {
        console.warn("⚠ No activity for 2 minutes — reconnecting...");
        try {
          if (sock?.ws && sock.ws.readyState === 1) await sock.end();
        } catch {}
        startBot();
      }

      try {
        if (sock?.ws && sock.ws.readyState === 1) sock.ws.ping();
      } catch {}
    }, 20000);

    console.log("🤖 Bot started.");
  } catch (err) {
    console.error("startBot error:", err);
    setTimeout(() => {
      isStarting = false;
      if (!shouldStop) startBot();
    }, 2000);
  } finally {
    isStarting = false;
  }
}

startBot();

process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  shouldStop = true;
  try {
    if (sock?.ws && sock.ws.readyState === 1) await sock.end();
  } catch {}
  server.close(() => process.exit(0));
});
