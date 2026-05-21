import { supabase } from './supabase_client.js';

// critical → high → medium → low for JS sort
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function sortBySeverity(arr) {
  return [...arr].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      new Date(b.created_at) - new Date(a.created_at)
  );
}

function daysFromNow(dateStr) {
  return Math.round((new Date(dateStr) - Date.now()) / 86_400_000);
}

function daysAgo(dateStr) {
  return Math.round((Date.now() - new Date(dateStr)) / 86_400_000);
}

// ── alert generators (each returns candidate notification objects) ─────────────

async function foiaDeadlineAlerts() {
  const { data } = await supabase
    .from('foia_requests')
    .select('id, case_id, agency, due_date, status')
    .not('due_date', 'is', null)
    .not('status', 'in', '("fulfilled","denied","appealed")');

  const candidates = [];
  for (const req of data ?? []) {
    const days = daysFromNow(req.due_date);

    if (days < 0) {
      candidates.push({
        case_id:     req.case_id,
        entity_type: 'foia_request',
        entity_id:   req.id,
        alert_type:  'foia_overdue',
        severity:    'critical',
        title:       `FOIA overdue: ${req.agency}`,
        body:        `FOIA request to ${req.agency} is ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} past due (status: ${req.status}).`,
        due_at:      new Date(req.due_date).toISOString()
      });
    } else if (days <= 14) {
      candidates.push({
        case_id:     req.case_id,
        entity_type: 'foia_request',
        entity_id:   req.id,
        alert_type:  'foia_deadline',
        severity:    days <= 3 ? 'high' : 'medium',
        title:       `FOIA due in ${days} day${days === 1 ? '' : 's'}: ${req.agency}`,
        body:        `FOIA request to ${req.agency} is due ${req.due_date}.`,
        due_at:      new Date(req.due_date).toISOString()
      });
    }
  }
  return candidates;
}

async function courtDateAlerts(windowDays = 7) {
  const now  = new Date().toISOString();
  const ceil = new Date(Date.now() + windowDays * 86_400_000).toISOString();

  const { data } = await supabase
    .from('events')
    .select('id, case_id, event_type, title, event_date, is_critical')
    .not('status', 'in', '("completed","missed")')
    .not('event_date', 'is', null)
    .gte('event_date', now)
    .lte('event_date', ceil);

  return (data ?? []).map(ev => {
    const days = Math.round((new Date(ev.event_date) - Date.now()) / 86_400_000);
    return {
      case_id:     ev.case_id,
      entity_type: 'event',
      entity_id:   ev.id,
      alert_type:  'court_date',
      severity:    ev.is_critical || days <= 1 ? 'critical' : days <= 3 ? 'high' : 'medium',
      title:       `Upcoming ${ev.event_type}: ${ev.title}`,
      body:        `Scheduled ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}.`,
      due_at:      ev.event_date
    };
  });
}

async function flagEscalationAlerts(staleDays = 7) {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

  const { data } = await supabase
    .from('flags')
    .select('id, case_id, flag_type, violation_type, severity, title, created_at')
    .in('severity', ['critical', 'high'])
    .eq('status', 'open')
    .lt('created_at', cutoff);

  return (data ?? []).map(flag => ({
    case_id:     flag.case_id,
    entity_type: 'flag',
    entity_id:   flag.id,
    alert_type:  'flag_escalation',
    severity:    flag.severity,
    title:       `Unresolved ${flag.severity} flag: ${flag.title}`,
    body:        `Open for ${daysAgo(flag.created_at)} days — type: ${flag.flag_type}, violation: ${flag.violation_type}.`,
    due_at:      null
  }));
}

async function followUpAlerts() {
  const { data } = await supabase
    .from('events')
    .select('id, case_id, event_type, title, event_date')
    .eq('status', 'missed');

  return (data ?? []).map(ev => ({
    case_id:     ev.case_id,
    entity_type: 'event',
    entity_id:   ev.id,
    alert_type:  'follow_up',
    severity:    'high',
    title:       `Missed event needs follow-up: ${ev.title}`,
    body:        `${ev.event_type} was marked missed. A follow-up action may be required.`,
    due_at:      ev.event_date
  }));
}

// ── public API ────────────────────────────────────────────────────────────────

export async function generateAll() {
  // Fetch existing active alert keys for deduplication.
  // The unique index on (entity_id, alert_type) WHERE is_dismissed = false
  // also enforces this at the DB level, but we filter here to avoid noisy errors.
  const { data: existing } = await supabase
    .from('notifications')
    .select('entity_id, alert_type')
    .eq('is_dismissed', false);

  const existingSet = new Set(
    (existing ?? []).map(n => `${n.entity_id}::${n.alert_type}`)
  );

  const [foia, courts, flags, followUps] = await Promise.all([
    foiaDeadlineAlerts(),
    courtDateAlerts(),
    flagEscalationAlerts(),
    followUpAlerts()
  ]);

  const toInsert = [...foia, ...courts, ...flags, ...followUps]
    .filter(n => !existingSet.has(`${n.entity_id}::${n.alert_type}`));

  if (!toInsert.length) return { created: 0, notifications: [] };

  const { data, error } = await supabase
    .from('notifications')
    .insert(toInsert)
    .select();

  return {
    created:       data?.length ?? 0,
    notifications: data ?? [],
    error:         error?.message ?? null
  };
}

export async function getPendingNotifications({ case_id, include_read = false } = {}) {
  let q = supabase
    .from('notifications')
    .select('*')
    .eq('is_dismissed', false);

  if (!include_read) q = q.eq('is_read', false);
  if (case_id)       q = q.eq('case_id', case_id);

  const { data, error } = await q;
  if (error) return { count: 0, data: [], error: error.message };

  const sorted = sortBySeverity(data ?? []);
  return { count: sorted.length, data: sorted, error: null };
}

export async function markRead(id) {
  return await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', id)
    .select()
    .single();
}

export async function dismiss(id) {
  return await supabase
    .from('notifications')
    .update({ is_dismissed: true })
    .eq('id', id)
    .select()
    .single();
}

export async function dismissAllForCase(case_id) {
  return await supabase
    .from('notifications')
    .update({ is_dismissed: true })
    .eq('case_id', case_id)
    .eq('is_dismissed', false);
}
