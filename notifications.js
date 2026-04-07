// notifications.js
// Real-time notification system: subscribes to Supabase Realtime on user_alerts,
// and broadcasts every new alert to all registered WhatsApp users.

const { supabase } = require('./config');

let sendFn = null;       // injected WhatsApp send function
let broadcastFn = null;  // injected WebSocket broadcast (for admin UI)
let subscription = null;

/**
 * Initialise the notification system.
 * @param {Object} opts
 * @param {Function} opts.send   – async (jid, text) => void  (WhatsApp sender)
 * @param {Function} opts.broadcast – (data) => void  (WebSocket broadcast to UI)
 */
function initNotifications({ send, broadcast }) {
  sendFn = send;
  broadcastFn = broadcast;
  console.log('🔔 Notification system initialised');
}

/**
 * Fetch all registered WhatsApp user JIDs from the users table.
 */
async function getAllUserJids() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('user_id');

    if (error) {
      console.error('❌ Error fetching users for notification:', error);
      return [];
    }
    return (data || []).map(u => u.user_id).filter(Boolean);
  } catch (err) {
    console.error('❌ getAllUserJids unexpected error:', err);
    return [];
  }
}

/**
 * Format an alert row into a readable WhatsApp message.
 */
function formatAlertMessage(alert) {
  const severityIcon = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '🚨',
    success: '✅',
  }[alert.severity] || '🔔';

  let msg = `${severityIcon} *${alert.title}*\n\n${alert.description}`;

  if (alert.action_url) {
    msg += `\n\n🔗 ${alert.action_label || 'View'}: ${alert.action_url}`;
  }

  return msg;
}

/**
 * Send a single alert to all registered WhatsApp users.
 */
async function broadcastAlertToUsers(alert) {
  if (!sendFn) {
    console.warn('⚠️ sendFn not set – skipping WhatsApp broadcast');
    return { sent: 0, failed: 0 };
  }

  const jids = await getAllUserJids();
  if (jids.length === 0) {
    console.log('⚠️ No registered users to notify');
    return { sent: 0, failed: 0 };
  }

  const message = formatAlertMessage(alert);
  let sent = 0;
  let failed = 0;

  console.log(`📤 Broadcasting alert "${alert.title}" to ${jids.length} users...`);

  for (const jid of jids) {
    try {
      await sendFn(jid, message);
      sent++;
    } catch (err) {
      console.error(`❌ Failed to send notification to ${jid}:`, err.message);
      failed++;
    }
  }

  console.log(`✅ Alert broadcast complete: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

/**
 * Start the Supabase Realtime subscription on user_alerts table.
 * Every INSERT triggers a WhatsApp broadcast to all registered users.
 */
function startRealtimeSubscription() {
  if (subscription) {
    console.log('⚠️ Realtime subscription already active');
    return;
  }

  subscription = supabase
    .channel('user_alerts_realtime')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'user_alerts',
      },
      async (payload) => {
        const alert = payload.new;
        console.log(`🔔 New alert received: "${alert.title}" [${alert.severity}] target=${alert.target_type}`);

        // Broadcast to admin UI via WebSocket
        if (broadcastFn) {
          broadcastFn({
            type: 'notification',
            alert: {
              id: alert.id,
              title: alert.title,
              description: alert.description,
              severity: alert.severity,
              category: alert.category,
              action_url: alert.action_url,
              action_label: alert.action_label,
              target_type: alert.target_type,
              created_at: alert.created_at,
            },
          });
        }

        // Send WhatsApp messages to all registered users
        try {
          const result = await broadcastAlertToUsers(alert);

          // Broadcast delivery stats to admin UI
          if (broadcastFn) {
            broadcastFn({
              type: 'notification_delivery',
              alertId: alert.id,
              sent: result.sent,
              failed: result.failed,
            });
          }
        } catch (err) {
          console.error('❌ Error during alert broadcast:', err);
        }
      }
    )
    .subscribe((status) => {
      console.log(`📡 Realtime subscription status: ${status}`);
    });

  console.log('📡 Subscribed to user_alerts realtime channel');
}

/**
 * Stop the realtime subscription.
 */
async function stopRealtimeSubscription() {
  if (subscription) {
    await supabase.removeChannel(subscription);
    subscription = null;
    console.log('📡 Realtime subscription stopped');
  }
}

/**
 * Fetch recent alerts (for initial UI load or polling).
 */
async function getRecentAlerts(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('user_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Error fetching recent alerts:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('❌ getRecentAlerts unexpected error:', err);
    return [];
  }
}

/**
 * Mark an alert as read for a specific user.
 */
async function markAlertRead(alertId) {
  try {
    const { error } = await supabase
      .from('user_alerts')
      .update({ read: true, updated_at: new Date().toISOString() })
      .eq('id', alertId);

    if (error) {
      console.error('❌ Error marking alert read:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('❌ markAlertRead unexpected error:', err);
    return false;
  }
}

/**
 * Dismiss an alert.
 */
async function dismissAlert(alertId) {
  try {
    const { error } = await supabase
      .from('user_alerts')
      .update({ dismissed: true, updated_at: new Date().toISOString() })
      .eq('id', alertId);

    if (error) {
      console.error('❌ Error dismissing alert:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('❌ dismissAlert unexpected error:', err);
    return false;
  }
}

module.exports = {
  initNotifications,
  startRealtimeSubscription,
  stopRealtimeSubscription,
  broadcastAlertToUsers,
  getRecentAlerts,
  markAlertRead,
  dismissAlert,
  formatAlertMessage,
};
