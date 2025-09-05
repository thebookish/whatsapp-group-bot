// reminders.js
const { supabase } = require('./config');

/**
 * Add a reminder to Supabase
 */
async function addReminder(userId, message, remindAt) {
  try {
    console.log("📥 addReminder called:", { userId, message, remindAt });

    const { data, error } = await supabase
      .from('reminders')
      .insert([{
        user_id: userId,
        message,
        remind_at: new Date(remindAt).toISOString(),
        sent: false
      }])
      .select();

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return null;
    }

    console.log('✅ Reminder saved in DB:', data);
    return data?.[0] || null;
  } catch (err) {
    console.error("❌ addReminder unexpected error:", err);
    return null;
  }
}


/**
 * Fetch reminders that are due and not sent yet
 */
async function getDueReminders() {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('reminders')
      .select('*')
      .lte('remind_at', now)
      .eq('sent', false);

    if (error) {
      console.error('❌ Error fetching reminders:', error);
      return [];
    }

    console.log(`⏰ Found ${data?.length || 0} due reminders`);
    return data || [];
  } catch (err) {
    console.error("❌ getDueReminders unexpected error:", err);
    return [];
  }
}

/**
 * Mark a reminder as sent
 */
async function markReminderSent(id) {
  try {
    console.log("✔️ Marking reminder sent:", id);

    const { error } = await supabase
      .from('reminders')
      .update({ sent: true })
      .eq('id', id);

    if (error) {
      console.error('❌ Error marking reminder sent:', error);
    }
  } catch (err) {
    console.error("❌ markReminderSent unexpected error:", err);
  }
}

module.exports = { addReminder, getDueReminders, markReminderSent };
