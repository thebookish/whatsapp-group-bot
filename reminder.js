// reminders.js
const { supabase } = require("./config");
const chrono = require("chrono-node");

/**
 * Find due reminders from conversations
 */
async function getDueReminders() {
  try {
    const now = new Date();
    const { data, error } = await supabase
      .from("conversations")
      .select("id, user_id, message, created_at, reminder_sent")
      .eq("reminder_sent", false);

    if (error) {
      console.error("❌ Supabase fetch error:", error);
      return [];
    }

    const due = [];
    for (const row of data || []) {
      // Only check messages starting with "remind me" or "add reminder"
      if (!/^(remind me|add reminder)/i.test(row.message)) continue;

      const parsed = chrono.parse(row.message, new Date(row.created_at));
      if (parsed.length === 0) continue;

      const remindAt = parsed[0].start.date();
      if (remindAt <= now) {
        // Extract the task by removing the time text
        const textTime = parsed[0].text;
        const task = row.message
          .replace(/^(remind me|add reminder)/i, "")
          .replace(textTime, "")
          .trim();

        due.push({
          id: row.id,
          user_id: row.user_id,
          message: task || row.message,
        });
      }
    }

    console.log(`⏰ Found ${due.length} due reminders`);
    return due;
  } catch (err) {
    console.error("❌ getDueReminders error:", err);
    return [];
  }
}

/**
 * Mark reminder as sent
 */
async function markReminderSent(id) {
  try {
    const { error } = await supabase
      .from("conversations")
      .update({ reminder_sent: true })
      .eq("id", id);

    if (error) console.error("❌ Error marking reminder sent:", error);
  } catch (err) {
    console.error("❌ markReminderSent error:", err);
  }
}

/**
 * Start background scheduler
 */
function startReminderScheduler(sendFn, intervalMs = 60000) {
  console.log("⏳ Reminder scheduler started, interval", intervalMs);

  setInterval(async () => {
    const due = await getDueReminders();
    for (const r of due) {
      try {
        await sendFn(r.user_id, `⏰ Reminder: ${r.message}`);
        await markReminderSent(r.id);
      } catch (err) {
        console.error("❌ Failed to send reminder:", err);
      }
    }
  }, intervalMs);
}

module.exports = { startReminderScheduler };
