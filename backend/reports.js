import { supabase } from './supabase_client.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function groupCount(arr, key) {
  return arr.reduce((acc, item) => {
    const val = item[key] ?? 'unknown';
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}

// ── case reports ─────────────────────────────────────────────────────────────

export async function caseSummary() {
  const { data, error } = await supabase
    .from('cases')
    .select('id, status, state, case_type, filed_date, closed_date');
  if (error) return { error: error.message };

  return {
    total:     data.length,
    by_status: groupCount(data, 'status'),
    by_state:  groupCount(data, 'state'),
    by_type:   groupCount(data, 'case_type')
  };
}

// ── foia reports ─────────────────────────────────────────────────────────────

export async function foiaSummary() {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('foia_requests')
    .select('id, agency, state, status, request_date, due_date, response_date');
  if (error) return { error: error.message };

  const fulfilled = data.filter(r => r.response_date && r.request_date);
  const avgResponseDays = fulfilled.length
    ? Math.round(fulfilled.reduce((s, r) => s + daysBetween(r.request_date, r.response_date), 0) / fulfilled.length)
    : null;

  return {
    total:              data.length,
    by_status:          groupCount(data, 'status'),
    by_agency:          groupCount(data, 'agency'),
    overdue_count:      data.filter(r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today).length,
    avg_response_days:  avgResponseDays
  };
}

// ── deadline reports ──────────────────────────────────────────────────────────

export async function upcomingDeadlines(days = 30) {
  const now  = new Date().toISOString();
  const ceil = new Date(Date.now() + days * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('events')
    .select('id, case_id, court_id, event_type, title, description, event_date, deadline_date, is_critical, status')
    .not('deadline_date', 'is', null)
    .gte('deadline_date', now)
    .lte('deadline_date', ceil)
    .neq('status', 'completed')
    .order('deadline_date');

  return { count: data?.length ?? 0, days_window: days, data: data ?? [], error: error?.message ?? null };
}

export async function missedDeadlines() {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('events')
    .select('id, case_id, court_id, event_type, title, description, event_date, deadline_date, is_critical, status')
    .not('deadline_date', 'is', null)
    .lt('deadline_date', now)
    .not('status', 'in', '("completed")')
    .order('deadline_date', { ascending: false });

  return { count: data?.length ?? 0, data: data ?? [], error: error?.message ?? null };
}

export async function criticalEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id, case_id, court_id, event_type, title, description, event_date, deadline_date, status, created_at')
    .eq('is_critical', true)
    .order('event_date', { ascending: false });

  return { count: data?.length ?? 0, data: data ?? [], error: error?.message ?? null };
}

// ── flag reports ──────────────────────────────────────────────────────────────

export async function flagSummary() {
  const { data, error } = await supabase
    .from('flags')
    .select('id, flag_type, violation_type, severity, status, raised_by, requires_redaction, created_at');
  if (error) return { error: error.message };

  return {
    total:                   data.length,
    by_severity:             groupCount(data, 'severity'),
    by_status:               groupCount(data, 'status'),
    by_flag_type:            groupCount(data, 'flag_type'),
    by_violation_type:       groupCount(data, 'violation_type'),
    by_raised_by:            groupCount(data, 'raised_by'),
    requires_redaction_count: data.filter(f => f.requires_redaction).length
  };
}

// ── judge / prosecutor stats ──────────────────────────────────────────────────

export async function judgeStats() {
  const [{ data: courts, error: cErr }, { data: flags, error: fErr }] = await Promise.all([
    supabase
      .from('courts')
      .select('id, case_id, name, state, county, judge_id, judge:judge_id(id, full_name, organization)'),
    supabase
      .from('flags')
      .select('case_id, severity, flag_type')
  ]);

  if (cErr) return { error: cErr.message };
  if (fErr) return { error: fErr.message };

  const flagsByCase = flags.reduce((acc, f) => {
    (acc[f.case_id] ??= []).push(f);
    return acc;
  }, {});

  const byJudge = {};
  for (const court of courts) {
    if (!court.judge) continue;
    const j = court.judge;
    if (!byJudge[j.id]) {
      byJudge[j.id] = {
        judge_id: j.id, full_name: j.full_name, organization: j.organization,
        court_count: 0, courts: [], states: new Set(),
        case_ids: new Set(), flag_count: 0, critical_flags: 0
      };
    }
    const entry = byJudge[j.id];
    entry.court_count++;
    entry.courts.push({ id: court.id, name: court.name, state: court.state, county: court.county });
    if (court.state)   entry.states.add(court.state);
    if (court.case_id) entry.case_ids.add(court.case_id);
  }

  for (const entry of Object.values(byJudge)) {
    for (const case_id of entry.case_ids) {
      const cf = flagsByCase[case_id] ?? [];
      entry.flag_count    += cf.length;
      entry.critical_flags += cf.filter(f => f.severity === 'critical').length;
    }
    entry.states   = [...entry.states];
    entry.case_ids = [...entry.case_ids];
  }

  const judges = Object.values(byJudge).sort((a, b) => b.flag_count - a.flag_count);
  return { count: judges.length, judges };
}

export async function prosecutorStats() {
  const [{ data: prosecutors, error: pErr }, { data: flags, error: fErr }] = await Promise.all([
    supabase.from('people').select('id, full_name, organization, case_id').eq('role', 'prosecutor'),
    supabase.from('flags').select('case_id, severity, flag_type')
  ]);

  if (pErr) return { error: pErr.message };
  if (fErr) return { error: fErr.message };

  const flagsByCase = flags.reduce((acc, f) => {
    (acc[f.case_id] ??= []).push(f);
    return acc;
  }, {});

  const result = prosecutors.map(p => {
    const cf = flagsByCase[p.case_id] ?? [];
    return {
      person_id:      p.id,
      full_name:      p.full_name,
      organization:   p.organization,
      case_id:        p.case_id,
      flag_count:     cf.length,
      critical_flags: cf.filter(f => f.severity === 'critical').length,
      high_flags:     cf.filter(f => f.severity === 'high').length,
      brady_flags:    cf.filter(f => f.flag_type === 'brady').length
    };
  }).sort((a, b) => b.flag_count - a.flag_count);

  return { count: result.length, prosecutors: result };
}

export async function peopleByRole() {
  const { data, error } = await supabase
    .from('people')
    .select('id, role, full_name, organization, case_id');
  if (error) return { error: error.message };

  const grouped = data.reduce((acc, p) => {
    const role = p.role ?? 'unknown';
    (acc[role] ??= []).push({ id: p.id, full_name: p.full_name, organization: p.organization, case_id: p.case_id });
    return acc;
  }, {});

  return { total: data.length, by_role: groupCount(data, 'role'), people: grouped };
}
