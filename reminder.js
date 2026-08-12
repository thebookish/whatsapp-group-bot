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
  // `withRetry` was never defined or imported here, so this threw a
  // ReferenceError on every call: the reminder was never marked sent, and the
  // scheduler re-delivered it every 30 seconds, forever. Retry inline instead.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase
        .from('reminders')
        .update({ sent: true })
        .eq('id', id);

      if (!error) {
        console.log('\u2714\ufe0f Marked reminder sent:', id);
        return true;
      }
      console.error(`\u274c Error marking reminder sent (attempt ${attempt}):`, error.message || error);
    } catch (err) {
      console.error(`\u274c markReminderSent threw (attempt ${attempt}):`, err.message || err);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return false;
}

/**
 * Start background reminder scheduler
 */
function startReminderScheduler(sendFn) {
  setInterval(async () => {
    try {
      const due = await getDueReminders();
      for (const r of due) {
        try {
          await sendFn(r.user_id, `\u23f0 Reminder: ${r.message}`);
        } catch (err) {
          // Leave it unsent so it retries once WhatsApp is back, and keep
          // going: one undeliverable reminder must not block the batch.
          console.error('\u274c Reminder send failed, will retry:', r.id, err.message || err);
          continue;
        }
        await markReminderSent(r.id);
      }
    } catch (err) {
      console.error("Reminder check error:", err);
    }
  }, 30_000); // every 30s
}

module.exports = { addReminder, getDueReminders, markReminderSent, startReminderScheduler };
