const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// === Supabase Configuration ===
const supabaseUrl = 'https://jlznlwkluocqjnepxwbv.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsem5sd2tsdW9jcWpuZXB4d2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MDA3MDAsImV4cCI6MjA3MTI3NjcwMH0.8gFwwwcV9w2Pcs-QObN2uyuxnf9lGjzhRotR56BMTwo';
const supabase = createClient(supabaseUrl, supabaseKey);

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

// Store active sessions in memory
const activeSessions = new Map();

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

// Check if user exists in Supabase
async function checkUserExists(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      throw error;
    }

    return { exists: !!data, user: data };
  } catch (error) {
    console.error('Error checking user existence:', error);
    return { exists: false, user: null };
  }
}

// Create new user in Supabase
async function createUserInDB(userId, profile) {
  try {
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          user_id: userId,
          name: profile.name,
          interests: profile.interests,
          goals: profile.goals,
          country: profile.country,
          created_at: new Date(),
          last_interaction: new Date()
        }
      ])
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error creating user in DB:', error);
    throw error;
  }
}

// Update user in Supabase
async function updateUserInDB(userId, updates) {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({
        ...updates,
        last_interaction: new Date()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error updating user in DB:', error);
    throw error;
  }
}

// Get conversation history from Supabase
async function getConversationHistory(userId) {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting conversation history:', error);
    return [];
  }
}

// Save conversation to Supabase
async function saveConversation(userId, message, response) {
  try {
    const { error } = await supabase
      .from('conversations')
      .insert([
        {
          user_id: userId,
          message: message,
          response: response,
          created_at: new Date()
        }
      ]);

    if (error) throw error;
  } catch (error) {
    console.error('Error saving conversation:', error);
  }
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
async function generateAIResponse(profile, studentMessage, conversationHistory = []) {
  const historyContext = conversationHistory
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

Recent Chat History:
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

    // Check if user exists in database
    const { exists, user } = await checkUserExists(uid);
    
    let profile;
    let isOnboarding = false;

    if (!exists) {
      // New user - start onboarding regardless of message
      profile = createUserProfile();
      activeSessions.set(uid, profile);
      isOnboarding = true;
    } else {
      // Existing user - load from database or create session
      if (activeSessions.has(uid)) {
        profile = activeSessions.get(uid);
      } else {
        // Create session from DB data
        profile = {
          name: user.name,
          interests: user.interests,
          goals: user.goals,
          country: user.country,
          onboardingStep: ONBOARDING_STEPS.COMPLETE,
          lastInteraction: new Date(),
          conversationHistory: await getConversationHistory(uid)
        };
        activeSessions.set(uid, profile);
      }
      
      // Update last interaction in DB
      await updateUserInDB(uid, {});
    }

    // Handle new user onboarding
    if (isOnboarding || profile.onboardingStep !== ONBOARDING_STEPS.COMPLETE) {
      switch (profile.onboardingStep) {
        case ONBOARDING_STEPS.NAME:
          if (isOnboarding && GREETING_PATTERNS.test(lowerMsg)) {
            return `👋 Hello! I'm your Student Assistant.\nLet's get started!\n\nWhat's your name?`;
          }
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
          
          // Save new user to database
          await createUserInDB(uid, profile);
          
          return `✅ Profile saved!\nName: ${profile.name}\nInterests: ${profile.interests}\nGoals: ${profile.goals}\nCountry: ${profile.country}\n\nYou can now ask me anything related to your studies!`;
      }
    }

    // Handle existing user - they can use greeting words without restarting onboarding
    if (GREETING_PATTERNS.test(lowerMsg)) {
      return `👋 Hello ${profile.name}! Welcome back! I'm here to help with your studies.\n\nWhat can I assist you with today?`;
    }

    // If onboarding is complete → answer question
    const aiReply = await generateAIResponse(profile, messageText, profile.conversationHistory.slice(-10));

    // Save conversation to database and memory
    await saveConversation(uid, messageText, aiReply);
    
    profile.conversationHistory.push({
      message: messageText,
      response: aiReply,
      timestamp: new Date()
    });
    if (profile.conversationHistory.length > 20) {
      profile.conversationHistory.shift();
    }

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
    return activeSessions.delete(uid);
  } catch {
    return false;
  }
}

async function getUserStats() {
  try {
    const { count: totalUsers, error: countError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    const { count: activeUsers, error: activeError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gte('last_interaction', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (activeError) throw activeError;

    return {
      totalUsers: totalUsers || 0,
      activeUsers: activeUsers || 0,
      activeSessions: activeSessions.size
    };
  } catch (error) {
    console.error('Error getting user stats:', error);
    return {
      totalUsers: 0,
      activeUsers: 0,
      activeSessions: activeSessions.size
    };
  }
}

module.exports = {
  getAIResponse,
  clearUserData,
  getUserStats
};