const axios = require('axios');

// === API Key ===
const OPENROUTER_API_KEY = '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';

// Onboarding steps
const ONBOARDING_STEPS = {
  NAME: 1,
  INTERESTS: 2,
  GOALS: 3,
  COUNTRY: 4,
  COMPLETE: 0
};

const GREETING_PATTERNS = /(^|\W)(hello|hi|hey|start|begin)(\W|$)/i;

// Store all student profiles and history in memory
const userPrefs = new Map();

function createUserProfile() {
  return {
    name: '',
    interests: '',
    goals: '',
    country: '',
    onboardingStep: ONBOARDING_STEPS.NAME,
    lastInteraction: new Date(),
    conversationHistory: [] // stores { message, response, timestamp }
  };
}

// Extract text from WhatsApp message formats
function extractTextFromMessage(message) {
  if (!message) return null;

  if (typeof message.conversation === 'string') {
    return message.conversation.trim();
  }
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text.trim();
  }
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption.trim();
  }
  if (message.videoMessage?.caption) {
    return message.videoMessage.caption.trim();
  }
  if (message.text) {
    if (typeof message.text === 'string') return message.text.trim();
    if (message.text.body) return message.text.body.trim();
  }

  return null;
}

// Validate inputs
function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId');
  }
  return userId;
}

function validateMessage(msg) {
  if (!msg || typeof msg !== 'string' || !msg.trim()) {
    throw new Error('Empty message');
  }
  if (msg.length > 1000) {
    throw new Error('Message too long');
  }
  return msg.trim();
}

// Generate AI reply based on student profile + conversation history
async function generateAIResponse(profile, studentMessage) {
  const historyContext = profile.conversationHistory
    .map(h => `User: ${h.message}\nAssistant: ${h.response}`)
    .join('\n');

  const systemPrompt = `
You are a helpful Student Assistant.
You can help with university recommendations, scholarships, study tips, admission guidance, and anything a student needs.
You have access to the student's past interactions and preferences.
Always answer the student's question politely and clearly.
After answering, always add a friendly reminder to ask student-related questions so the assistant can be more helpful.
  `;

  const userPrompt = `
Student Info:
- Name: ${profile.name}
- Interests: ${profile.interests}
- Goals: ${profile.goals}
- Country: ${profile.country}

Chat History:
${historyContext}

Student's Latest Question:
"${studentMessage}"
  `;

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'mistralai/mistral-7b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 300,
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  return res.data.choices?.[0]?.message?.content || "Sorry, I couldn't process your question.";
}

// Main function
async function getAIResponse(userId, rawMessage) {
  try {
    const uid = validateUserId(userId);

    let messageText = null;
    if (typeof rawMessage === 'string') {
      messageText = rawMessage;
    } else if (typeof rawMessage === 'object') {
      messageText = extractTextFromMessage(rawMessage);
    }

    if (!messageText) {
      return "I can only respond to text messages. Please send me a text message!";
    }

    messageText = validateMessage(messageText);
    const lowerMsg = messageText.toLowerCase();

    // Create profile if new user
    if (!userPrefs.has(uid)) {
      userPrefs.set(uid, createUserProfile());
    }
    const profile = userPrefs.get(uid);
    profile.lastInteraction = new Date();

    // Greeting resets onboarding
    if (GREETING_PATTERNS.test(lowerMsg)) {
      profile.onboardingStep = ONBOARDING_STEPS.NAME;
      profile.conversationHistory = [];
      return `👋 Hello! I'm your Student Assistant.\nLet's get started!\n\nWhat's your name?`;
    }

    // Onboarding process
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME:
          profile.name = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.INTERESTS;
          return `Nice to meet you, ${profile.name}! 🎓\nWhat subjects or fields are you interested in?`;
        case ONBOARDING_STEPS.INTERESTS:
          profile.interests = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.GOALS;
          return `Got it! What are your main study or career goals? (e.g., scholarship, admission, job)`;
        case ONBOARDING_STEPS.GOALS:
          profile.goals = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COUNTRY;
          return `Great! Which country are you currently in or planning to study in?`;
        case ONBOARDING_STEPS.COUNTRY:
          profile.country = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.COMPLETE;
          return `✅ Profile saved!\nName: ${profile.name}\nInterests: ${profile.interests}\nGoals: ${profile.goals}\nCountry: ${profile.country}\n\nYou can now ask me anything related to your studies!`;
      }
    }

    // If onboarding is complete → answer question
    const aiReply = await generateAIResponse(profile, messageText);

    // Save chat history
    profile.conversationHistory.push({
      message: messageText,
      response: aiReply,
      timestamp: new Date()
    });
    if (profile.conversationHistory.length > 20) profile.conversationHistory.shift();

    return aiReply;

  } catch (error) {
    console.error('getAIResponse error:', error.message);
    if (error.message.includes('Invalid userId')) return "❌ Invalid user ID.";
    if (error.message.includes('Empty message')) return "❌ Please send a message.";
    if (error.message.includes('Message too long')) return "❌ Message too long. Keep it under 1000 chars.";
    return "❌ Sorry, something went wrong. Try again or say 'hello'.";
  }
}

// Utilities
function clearUserData(userId) {
  try {
    const uid = validateUserId(userId);
    return userPrefs.delete(uid);
  } catch {
    return false;
  }
}

function getUserStats() {
  return {
    totalUsers: userPrefs.size,
    activeUsers: Array.from(userPrefs.values()).filter(
      p => Date.now() - p.lastInteraction.getTime() < 24 * 60 * 60 * 1000
    ).length
  };
}

module.exports = {
  getAIResponse,
  clearUserData,
  getUserStats
};
