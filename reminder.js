// reminders.js
const { supabase } = require('./config');

async function addReminder(userId, message, remindAt) {
  const { error } = await supabase.from('reminders').insert([{
    user_id: userId,
    message,
    remind_at: new Date(remindAt).toISOString()
  }]);
  if (error) console.error('Error adding reminder:', error);
}

async function getDueReminders() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .lte('remind_at', now)
    .eq('sent', false);

  if (error) {
    console.error('Error fetching reminders:', error);
    return [];
  }
  return data || [];
}

async function markReminderSent(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ sent: true })
    .eq('id', id);
  if (error) console.error('Error marking reminder sent:', error);
}

module.exports = { addReminder, getDueReminders, markReminderSent };
