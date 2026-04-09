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
      }]);

    if (error) {
      console.error('❌ Error adding reminder:', error);
      return null;
    }

    console.log('✅ Reminder saved:', data);
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

    const { error } = await withRetry(() =>
      supabase
        .from('reminders')
        .update({ sent: true })
        .eq('id', id)
    );

    if (error) {
      console.error('\u274c Error marking reminder sent:', error);
    }
  } catch (err) {
    console.error('\u274c markReminderSent unexpected error:', err.message || err);
  }
}

/**
 * Start background reminder scheduler
 */
function startReminderScheduler(sendFn) {
  setInterval(async () => {
    try {
      const due = await getDueReminders();
      for (const r of due) {
        console.log("📤 Sending reminder:", r);

        // ✅ Use injected sender function
        await sendFn(r.user_id, `⏰ Reminder: ${r.message}`);

        await markReminderSent(r.id);
      }
    } catch (err) {
      console.error("Reminder check error:", err);
    }
  }, 30_000); // every 30s
}

module.exports = { addReminder, getDueReminders, markReminderSent, startReminderScheduler };
