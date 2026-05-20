-- Recklein Case Engine — Notifications & Reminders
-- Migration: 003_notifications

CREATE TABLE notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  entity_type   text        NOT NULL,  -- foia_request | event | flag
  entity_id     uuid        NOT NULL,
  alert_type    text        NOT NULL,  -- foia_deadline | foia_overdue | court_date | flag_escalation | follow_up
  severity      text        NOT NULL,  -- critical | high | medium | low
  title         text        NOT NULL,
  body          text,
  due_at        timestamptz,
  is_read       boolean     DEFAULT false,
  is_dismissed  boolean     DEFAULT false,
  created_at    timestamptz DEFAULT now()
);

-- Prevent duplicate active alerts for the same source record + alert type
CREATE UNIQUE INDEX idx_notifications_dedup
  ON notifications (entity_id, alert_type)
  WHERE is_dismissed = false;

CREATE INDEX idx_notifications_case_id    ON notifications (case_id);
CREATE INDEX idx_notifications_unread     ON notifications (is_read, is_dismissed) WHERE is_dismissed = false;
CREATE INDEX idx_notifications_alert_type ON notifications (alert_type);
CREATE INDEX idx_notifications_severity   ON notifications (severity);
