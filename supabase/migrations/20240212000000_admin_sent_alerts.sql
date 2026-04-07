-- Migration: Add admin_alert support to user_alerts
-- Adds admin_alert as a new category, plus columns for targeting and email tracking

-- 1. Add new columns to user_alerts
ALTER TABLE user_alerts
  ADD COLUMN IF NOT EXISTS sent_by       uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_type   text         NOT NULL DEFAULT 'individual'
      CHECK (target_type IN ('all', 'by_stage', 'individual')),
  ADD COLUMN IF NOT EXISTS target_stage  text         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS email_sent    boolean      NOT NULL DEFAULT false;

-- 2. Update the category check constraint to include admin_alert
-- Drop old constraint (name may vary; wrapped in DO block for safety)
DO $$
BEGIN
  -- Try dropping if a check constraint exists on category
  ALTER TABLE user_alerts DROP CONSTRAINT IF EXISTS user_alerts_category_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE user_alerts
  ADD CONSTRAINT user_alerts_category_check
  CHECK (category IN (
    'platform_notification',
    'enrollment',
    'lead',
    'payment',
    'compliance',
    'admin_alert'
  ));

-- 3. Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_user_alerts_category
  ON user_alerts (category);

CREATE INDEX IF NOT EXISTS idx_user_alerts_target_type
  ON user_alerts (target_type);

CREATE INDEX IF NOT EXISTS idx_user_alerts_sent_by
  ON user_alerts (sent_by);

CREATE INDEX IF NOT EXISTS idx_user_alerts_target_stage
  ON user_alerts (target_stage)
  WHERE target_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_alerts_unread
  ON user_alerts (university_id, read)
  WHERE read = false;

-- 4. Enable realtime for user_alerts (so Supabase Realtime picks up INSERTs)
ALTER PUBLICATION supabase_realtime ADD TABLE user_alerts;
