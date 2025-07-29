const axios = require('axios');

// Load API keys from env variables or fallback (replace with your keys)
const OPENROUTER_API_KEY = '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';
const YOUTUBE_API_KEY = 'AIzaSyA6iFaCEc86hXCB0K6fM_NQyfsYzj7Oez8';

// Onboarding states
const ONBOARDING_STEPS = {
  INTERESTS: 1,
  GOALS: 2,
  LEVEL: 3,
  COMPLETE: 0
};

const GREETING_PATTERNS = /(^|\W)(hello|hi|hey|greetings|start|begin)(\W|$)/i;

// In-memory user prefs (Map is efficient)
const userPrefs = new Map();

function createUserProfile() {
  return {
    interests: '',
    goals: '',
    level: '',
    onboardingStep: ONBOARDING_STEPS.INTERESTS,
    lastInteraction: new Date(),
    conversationHistory: []
  };
}

// Extract text from various WhatsApp message types reliably
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
  if (message.audioMessage?.caption) {
    return message.audioMessage.caption.trim();
  }

  if (message.text) {
    if (typeof message.text === 'string') return message.text.trim();
    if (message.text.body) return message.text.body.trim();
  }

  return null; // No text found
}

// Normalize experience level input
function normalizeExperienceLevel(level) {
  if (!level) return 'unspecified';
  const l = level.toLowerCase().trim();
  const map = {
    beginner: 'beginner', begin: 'beginner', new: 'beginner', starter: 'beginner', novice: 'beginner',
    intermediate: 'intermediate', inter: 'intermediate', medium: 'intermediate', mid: 'intermediate',
    advanced: 'advanced',
    expert: 'expert', professional: 'expert', pro: 'expert'
  };
  return map[l] || l;
}

// Validate userId string
function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId');
  }
  return userId;
}

// Validate message text
function validateMessage(msg) {
  if (!msg || typeof msg !== 'string' || !msg.trim()) {
    throw new Error('Empty message');
  }
  if (msg.length > 1000) {
    throw new Error('Message too long');
  }
  return msg.trim();
}

// Extract course title from AI response (simple heuristic)
function extractCourseTitle(aiText) {
  if (!aiText) return 'online course';
  const patterns = [
    /course (on|about|titled|called)?\s*["“]?([a-zA-Z0-9\s\-:]{5,50})["”]?/i,
    /learn\s+([a-zA-Z0-9\s\-:]{5,50})/i,
    /study\s+([a-zA-Z0-9\s\-:]{5,50})/i,
    /"([a-zA-Z0-9\s\-:]{5,50})"/,
    /\*\*([a-zA-Z0-9\s\-:]{5,50})\*\*/
  ];
  for (const pat of patterns) {
    const m = aiText.match(pat);
    if (m) return (m[2] || m[1]).trim().replace(/[^\w\s\-:]/g, '');
  }
  return aiText.split('\n')[0].slice(0, 50);
}

// Search YouTube videos
async function searchYouTubeVideo(query, maxResults = 3) {
  if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'your_youtube_api_key') {
    return { videos: [], error: 'YouTube API key not set' };
  }
  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: `${query} tutorial course`,
        key: YOUTUBE_API_KEY,
        maxResults,
        type: 'video',
        order: 'relevance',
        videoDuration: 'medium'
      }
    });
    const videos = resp.data.items.map(v => ({
      title: v.snippet.title,
      url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
      channel: v.snippet.channelTitle,
      description: v.snippet.description.slice(0, 100) + '...'
    }));
    return { videos, error: null };
  } catch (e) {
    console.error('YouTube API error:', e.response?.data || e.message);
    return { videos: [], error: 'Failed to fetch YouTube videos' };
  }
}

// Call OpenRouter AI for recommendation
async function generateAIRecommendation(userProfile, userMessage) {
  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'your_openrouter_api_key') {
    throw new Error('OpenRouter API key not set');
  }
  const systemPrompt = `You are an expert educational advisor specializing in online course recommendations. Provide specific, actionable course recommendations with clear learning paths. Keep responses concise (2-3 sentences max). Mention platforms like Coursera, Udemy, edX, Khan Academy if possible.`;
  const userPrompt = `
User Profile:
- Interests: ${userProfile.interests}
- Goals: ${userProfile.goals}
- Experience Level: ${userProfile.level}
- Question: "${userMessage}"

Recommend a specific online course or learning path that fits their needs. Include course name and platform if possible.
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
  return res.data.choices?.[0]?.message?.content || 'No recommendation available.';
}

// === NEW: Helper to check if message is course-related ===
function isCourseRelated(msg) {
  const keywords = [
    'course', 'learn', 'tutorial', 'study', 'skill', 'programming', 'python', 'java',
    'javascript', 'data', 'machine learning', 'ml', 'deep learning', 'ai', 'artificial intelligence',
    'beginner', 'intermediate', 'advanced', 'expert', 'goal', 'interest', 'recommendation'
  ];
  msg = msg.toLowerCase();
  return keywords.some(keyword => msg.includes(keyword));
}

// === NEW: Generate short polite AI reply for off-topic messages ===
async function generateShortAIReply(msg) {
  const systemPrompt = `You are a polite assistant. Reply concisely to this message: "${msg}". Then politely ask the user to ask only course-related questions.`;
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'mistralai/mistral-7b-instruct',
      messages: [
        { role: 'system', content: systemPrompt }
      ],
      max_tokens: 60,
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
  return res.data.choices?.[0]?.message?.content || "Sorry, I can only answer course-related questions.";
}

// Main exported function: handles onboarding + recommendations + off-topic responses
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

    if (!userPrefs.has(uid)) {
      userPrefs.set(uid, createUserProfile());
    }
    const profile = userPrefs.get(uid);
    profile.lastInteraction = new Date();

    // Handle greeting: restart onboarding
    if (GREETING_PATTERNS.test(lowerMsg)) {
      profile.onboardingStep = ONBOARDING_STEPS.INTERESTS;
      profile.conversationHistory = [];
      return `👋 Hello! I'm your course recommendation assistant.\n\n🎯 What subject or skill are you interested in learning? (e.g., "Python programming")`;
    }

    // === NEW: Handle random/off-topic messages ===
    if (!isCourseRelated(messageText)) {
      // 20% chance to reply with short polite AI response
      if (Math.random() < 0.2) {
        const shortReply = await generateShortAIReply(messageText);
        return shortReply;
      } else {
        return "🤖 Please ask questions related to courses or learning topics. Say 'hello' to start.";
      }
    }

    // Onboarding steps
    if (profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.INTERESTS:
          profile.interests = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.GOALS;
          return `Great! ${messageText} is a valuable skill.\n\n🎯 What's your main learning goal?\n• Get a job\n• Build a project\n• Advance career\n• Hobby\n• Academic requirement`;
        case ONBOARDING_STEPS.GOALS:
          profile.goals = messageText;
          profile.onboardingStep = ONBOARDING_STEPS.LEVEL;
          return `Perfect! Now, what's your current experience level with ${profile.interests}?\n• Beginner\n• Intermediate\n• Advanced\n• Expert`;
        case ONBOARDING_STEPS.LEVEL:
          profile.level = normalizeExperienceLevel(messageText);
          profile.onboardingStep = ONBOARDING_STEPS.COMPLETE;
          return `✅ Profile saved:\n• Interest: ${profile.interests}\n• Goal: ${profile.goals}\n• Level: ${profile.level}\n\nYou can now ask me for course recommendations!`;
      }
    }

    // Post-onboarding: Generate recommendation
    if (profile.onboardingStep === ONBOARDING_STEPS.COMPLETE) {
      if (!profile.interests) {
        return "Please start by saying 'hello' to set your preferences.";
      }

      const aiResponse = await generateAIRecommendation(profile, messageText);
      const courseTitle = extractCourseTitle(aiResponse);

      const { videos, error: ytError } = await searchYouTubeVideo(courseTitle);

      let reply = `🎓 Course Recommendation:\n${aiResponse}\n\n`;

      if (videos.length) {
        reply += `🎥 Related YouTube videos:\n`;
        videos.slice(0, 2).forEach((v, i) => {
          reply += `${i + 1}. [${v.title}](${v.url}) by ${v.channel}\n`;
        });
      } else if (ytError) {
        reply += `🎥 YouTube videos: ${ytError}\n`;
      }

      reply += `\n💡 Ask for more recommendations or say 'hello' to update preferences.`;

      // Save to conversation history (limit 5)
      profile.conversationHistory.push({ message: messageText, response: reply, timestamp: new Date() });
      if (profile.conversationHistory.length > 5) profile.conversationHistory.shift();

      return reply;
    }

    return "Say 'hello' to get started!";
  } catch (error) {
    console.error('getAIResponse error:', error.message);
    if (error.message.includes('Invalid userId')) return "❌ Invalid user ID.";
    if (error.message.includes('Empty message')) return "❌ Please send a message.";
    if (error.message.includes('Message too long')) return "❌ Message too long. Keep it under 1000 chars.";
    return "❌ Sorry, something went wrong. Try again or say 'hello'.";
  }
}

// Optional utilities to clear user data or get stats
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
