import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_LIGHT = 'claude-haiku-4-5-20251001';

const SPEEDY_LIMITS = {
  TX: { days: 180, statute: 'Tex. Code Crim. Proc. Art. 32A.02' },
  IL: { days: 120, statute: 'Ill. Sup. Ct. R. 103(b)' },
  MO: { days: 180, statute: 'Mo. R. Crim. P. 33.01' },
};

export const ALERT_TYPES = [
  'speedy_trial_violation',
  'speedy_trial_warning',
  'speedy_trial_approaching',
  'foia_brady_risk',
  'brady_risk',
  'hearing_upcoming',
  'hearing_missed',
  'hearing_continuations',
  'extradition_conflict',
  'extradition_violation',
  'service_failure',
  'facility_delay',
];

// Severity rank for sorting
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Alert type rank for prioritization (lower = more urgent)
const TYPE_RANK = {
  speedy_trial_violation:  0,
  brady_risk:              1,
  foia_brady_risk:         2,
  hearing_missed:          3,
  hearing_upcoming:        4,
  extradition_violation:   5,
  extradition_conflict:    6,
  service_failure:         7,
  facility_delay:          8,
  speedy_trial_warning:    9,
  hearing_continuations:   10,
  speedy_trial_approaching: 11,
};

const RECOMMENDATIONS = {
  speedy_trial_violation:  (s) => `File motion to dismiss with prejudice under ${s} immediately — statutory limit exceeded.`,
  speedy_trial_warning:    (s) => `Prepare and file speedy trial motion under ${s} within 7 days to preserve dismissal rights.`,
  speedy_trial_approaching:(s) => `Calendar speedy trial deadline under ${s} and prepare motion for filing within 30 days.`,
  foia_brady_risk:         ()  => 'Send Brady demand letter and file motion to compel FOIA response; request in camera review of withheld materials.',
  brady_risk:              ()  => 'File formal Brady motion and request court-ordered disclosure; document all withholding for sanctions record.',
  hearing_upcoming:        ()  => 'Confirm hearing attendance with court clerk; prepare all documents and ensure transport is arranged.',
  hearing_missed:          ()  => 'File immediate motion explaining absence and move to quash any bench warrant; document reason for non-appearance.',
  hearing_continuations:   ()  => 'File objection to further continuances citing pattern of delay; include in speedy trial motion as supporting evidence.',
  extradition_conflict:    ()  => 'File motion to resolve detainer conflict under IADA; demand single-jurisdiction custody determination.',
  extradition_violation:   ()  => 'Challenge extradition via habeas corpus petition in holding state; cite IAD 180-day rule and due process.',
  service_failure:         ()  => 'Document service failure with affidavit; use as basis to vacate any resulting FTA or bench warrant.',
  facility_delay:          ()  => 'Request transport/facility incident report; use documented delays to challenge FTA findings and bench warrants.',
};

function loadAgentPrompt() {
  try {
    return readFileSync(resolve('./agents/watchdog_agent.md'), 'utf-8');
  } catch {
    return 'You are the Watchdog narrative engine. Summarize alerts as JSON.';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function daysUntil(dateStr) {
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function fetchWatchdogContext(case_ids) {
  const [
    { data: cases },
    { data: flags },
    { data: events },
    { data: foia },
    { data: docs },
  ] = await Promise.all([
    supabase.from('cases').select('id, state, county, status, filed_date').in('id', case_ids),
    supabase.from('flags').select('*').in('case_id', case_ids).eq('status', 'open'),
    supabase.from('events').select('*').in('case_id', case_ids).order('event_date'),
    supabase.from('foia_requests').select('*').in('case_id', case_ids),
    supabase.from('documents')
      .select('id, case_id, is_brady, doc_type, summary')
      .in('case_id', case_ids)
      .eq('is_brady', true),
  ]);

  return {
    cases:  cases  ?? [],
    flags:  flags  ?? [],
    events: events ?? [],
    foia:   foia   ?? [],
    docs:   docs   ?? [],
  };
}

// ── Deduplication ─────────────────────────────────────────────────────────────

async function getExistingAlertKeys(case_ids) {
  const { data } = await supabase
    .from('notifications')
    .select('entity_id, alert_type')
    .in('case_id', case_ids)
    .eq('is_dismissed', false);

  return new Set((data ?? []).map(n => `${n.entity_id}::${n.alert_type}`));
}

// ── Check functions (pure JS, no API calls) ───────────────────────────────────

function checkSpeedyTrial(cases) {
  const alerts = [];
  const today  = Date.now();

  for (const c of cases) {
    if (!c.filed_date || c.status === 'closed') continue;
    const limit = SPEEDY_LIMITS[c.state];
    if (!limit) continue;

    const elapsed     = Math.floor((today - new Date(c.filed_date).getTime()) / 86_400_000);
    const pct         = elapsed / limit.days;
    const daysLeft    = limit.days - elapsed;

    if (pct >= 1.0) {
      alerts.push({
        case_id:     c.id,
        state:       c.state,
        entity_type: 'case',
        entity_id:   c.id,
        alert_type:  'speedy_trial_violation',
        severity:    'critical',
        title:       `Speedy trial limit EXCEEDED — ${c.state} (${elapsed - limit.days} days over)`,
        body:        `Case filed ${c.filed_date}. ${elapsed} days elapsed vs. ${limit.days}-day limit (${limit.statute}). Limit exceeded by ${elapsed - limit.days} days.`,
        days_elapsed: elapsed,
        days_over:   elapsed - limit.days,
        pct_elapsed: pct,
        statute:     limit.statute,
        recommended_action: RECOMMENDATIONS.speedy_trial_violation(limit.statute),
        creates_flag: true,
      });
    } else if (pct >= 0.75) {
      alerts.push({
        case_id:     c.id,
        state:       c.state,
        entity_type: 'case',
        entity_id:   c.id,
        alert_type:  'speedy_trial_warning',
        severity:    'high',
        title:       `Speedy trial warning — ${c.state} (${daysLeft} days remaining)`,
        body:        `${elapsed} of ${limit.days} days elapsed (${Math.round(pct * 100)}%) under ${limit.statute}. ${daysLeft} days remaining.`,
        days_elapsed: elapsed,
        days_remaining: daysLeft,
        pct_elapsed: pct,
        statute:     limit.statute,
        recommended_action: RECOMMENDATIONS.speedy_trial_warning(limit.statute),
        creates_flag: false,
      });
    } else if (pct >= 0.5) {
      alerts.push({
        case_id:     c.id,
        state:       c.state,
        entity_type: 'case',
        entity_id:   c.id,
        alert_type:  'speedy_trial_approaching',
        severity:    'medium',
        title:       `Speedy trial approaching — ${c.state} (${daysLeft} days remaining)`,
        body:        `${elapsed} of ${limit.days} days elapsed (${Math.round(pct * 100)}%) under ${limit.statute}.`,
        days_elapsed: elapsed,
        days_remaining: daysLeft,
        pct_elapsed: pct,
        statute:     limit.statute,
        recommended_action: RECOMMENDATIONS.speedy_trial_approaching(limit.statute),
        creates_flag: false,
      });
    }
  }
  return alerts;
}

function checkFoiaBradyRisk(foia) {
  const today   = new Date().toISOString().split('T')[0];
  const alerts  = [];

  for (const r of foia) {
    if (!r.due_date || !['sent', 'acknowledged'].includes(r.status)) continue;
    if (r.due_date >= today) continue;

    const daysOver = daysAgo(r.due_date);
    const severity = daysOver > 30 ? 'critical' : daysOver > 7 ? 'high' : 'medium';

    alerts.push({
      case_id:     r.case_id,
      entity_type: 'foia_request',
      entity_id:   r.id,
      alert_type:  'foia_brady_risk',
      severity,
      title:       `FOIA overdue — ${r.agency} (${daysOver}d) — Brady risk`,
      body:        `FOIA request to ${r.agency} (${r.state ?? '?'}) is ${daysOver} days overdue. Withheld material may constitute Brady violation under Brady v. Maryland, 373 U.S. 83 (1963).`,
      due_at:      new Date(r.due_date).toISOString(),
      days_overdue: daysOver,
      agency:      r.agency,
      state:       r.state,
      recommended_action: RECOMMENDATIONS.foia_brady_risk(),
      creates_flag: daysOver > 30,
    });
  }
  return alerts;
}

function checkBradyRisk(flags, docs) {
  const alerts = [];

  // Open Brady flags
  for (const f of flags.filter(f => f.flag_type === 'brady')) {
    const age = f.created_at ? daysAgo(f.created_at) : 0;
    alerts.push({
      case_id:     f.case_id,
      entity_type: 'flag',
      entity_id:   f.id,
      alert_type:  'brady_risk',
      severity:    age > 30 ? 'critical' : 'high',
      title:       `Brady violation flag open — ${f.title ?? 'Brady flag'}`,
      body:        f.description ?? `Open Brady violation flag (${age} days old). Disclosure may be required.`,
      days_open:   age,
      recommended_action: RECOMMENDATIONS.brady_risk(),
      creates_flag: false, // flag already exists
    });
  }

  // Brady documents without corresponding response
  for (const d of docs) {
    alerts.push({
      case_id:     d.case_id,
      entity_type: 'document',
      entity_id:   d.id,
      alert_type:  'brady_risk',
      severity:    'high',
      title:       `Brady material on file — verify disclosure`,
      body:        `Document marked is_brady=true: ${d.summary?.slice(0, 120) ?? d.doc_type ?? 'Brady document'}. Confirm prosecution has disclosed this material.`,
      recommended_action: RECOMMENDATIONS.brady_risk(),
      creates_flag: false,
    });
  }
  return alerts;
}

function checkHearingRisk(events) {
  const alerts = [];
  const now    = Date.now();

  // Upcoming hearings (next 7 days)
  const upcoming = events.filter(e =>
    e.event_type === 'hearing' &&
    e.status === 'scheduled' &&
    e.event_date
  );
  for (const e of upcoming) {
    const days = daysUntil(e.event_date);
    if (days > 7 || days < 0) continue;
    alerts.push({
      case_id:     e.case_id,
      entity_type: 'event',
      entity_id:   e.id,
      alert_type:  'hearing_upcoming',
      severity:    days <= 2 ? 'high' : 'medium',
      title:       `Hearing in ${days} day${days === 1 ? '' : 's'}: ${e.title ?? 'Scheduled hearing'}`,
      body:        `Hearing scheduled for ${e.event_date}. ${days <= 2 ? 'URGENT: Confirm attendance and all filings immediately.' : 'Confirm attendance and prepare all documentation.'}`,
      due_at:      new Date(e.event_date).toISOString(),
      days_until:  days,
      recommended_action: RECOMMENDATIONS.hearing_upcoming(),
      creates_flag: false,
    });
  }

  // Missed hearings
  const missed = events.filter(e => e.event_type === 'hearing' && e.status === 'missed');
  for (const e of missed) {
    const age = e.event_date ? daysAgo(e.event_date) : 0;
    alerts.push({
      case_id:     e.case_id,
      entity_type: 'event',
      entity_id:   e.id,
      alert_type:  'hearing_missed',
      severity:    'high',
      title:       `Hearing missed — ${e.title ?? 'Hearing'} (${age}d ago)`,
      body:        `Hearing on ${e.event_date} marked missed. A bench warrant or FTA order may be outstanding.`,
      days_ago:    age,
      recommended_action: RECOMMENDATIONS.hearing_missed(),
      creates_flag: true,
    });
  }

  // Continuation pattern (3+ continuations per hearing title in same case)
  const byCase = {};
  for (const e of events.filter(e => e.event_type === 'hearing' && e.status === 'continued')) {
    const key = `${e.case_id}::${(e.title ?? '').toLowerCase()}`;
    byCase[key] = (byCase[key] ?? []);
    byCase[key].push(e);
  }
  for (const [, group] of Object.entries(byCase)) {
    if (group.length < 3) continue;
    const last = group[group.length - 1];
    alerts.push({
      case_id:     last.case_id,
      entity_type: 'event',
      entity_id:   last.id,
      alert_type:  'hearing_continuations',
      severity:    'high',
      title:       `${group.length} continuations — ${last.title ?? 'Hearing'}`,
      body:        `${group.length} continuations of "${last.title ?? 'hearing'}" detected. This constitutes a systemic delay pattern supporting speedy trial and due process claims.`,
      continuation_count: group.length,
      recommended_action: RECOMMENDATIONS.hearing_continuations(),
      creates_flag: false,
    });
  }

  return alerts;
}

function checkExtraditionConflict(cases) {
  const alerts  = [];
  const active  = cases.filter(c => c.status === 'active');
  const byState = {};
  for (const c of active) (byState[c.state ?? 'unknown'] ??= []).push(c);

  const activeStates = Object.keys(byState).filter(s => s !== 'unknown');
  if (activeStates.length < 2) return alerts;

  // Multi-state active custody conflict
  for (const c of active) {
    const otherStates = activeStates.filter(s => s !== c.state);
    alerts.push({
      case_id:     c.id,
      state:       c.state,
      entity_type: 'case',
      entity_id:   c.id,
      alert_type:  'extradition_conflict',
      severity:    'high',
      title:       `Multi-state custody conflict — ${c.state} + ${otherStates.join('/')}`,
      body:        `Active cases in ${activeStates.join(', ')} simultaneously. Multi-state detainer may violate IADA and create unconstitutional custody conditions.`,
      states_in_conflict: activeStates,
      recommended_action: RECOMMENDATIONS.extradition_conflict(),
      creates_flag: false,
    });
    // Only create one alert per unique state pair to avoid flooding
    break;
  }

  // IADA 180-day rule: if any case has been active 180+ days alongside another state's active case
  for (const c of active) {
    if (!c.filed_date) continue;
    const elapsed = daysAgo(c.filed_date);
    if (elapsed >= 180 && activeStates.length >= 2) {
      alerts.push({
        case_id:     c.id,
        state:       c.state,
        entity_type: 'case',
        entity_id:   c.id,
        alert_type:  'extradition_violation',
        severity:    'critical',
        title:       `IADA 180-day rule — ${c.state} case ${elapsed} days active`,
        body:        `Case in ${c.state} has been active ${elapsed} days while detainers exist in ${otherStates.join('/')}. IADA 180-day speedy trial right may be violated.`,
        days_elapsed: elapsed,
        recommended_action: RECOMMENDATIONS.extradition_violation(),
        creates_flag: true,
      });
    }
  }

  return alerts;
}

function checkServiceFailure(events, flags) {
  const alerts = [];

  // Events marked as service failures
  const svcEvents = events.filter(e =>
    ['service', 'process_service'].includes(e.event_type) &&
    ['failed', 'missed'].includes(e.status)
  );
  for (const e of svcEvents) {
    alerts.push({
      case_id:     e.case_id,
      entity_type: 'event',
      entity_id:   e.id,
      alert_type:  'service_failure',
      severity:    'high',
      title:       `Service failure — ${e.title ?? 'Process service'}`,
      body:        `Service of process event on ${e.event_date ?? '?'} marked ${e.status}. Any resulting FTA or bench warrant may be challengeable.`,
      recommended_action: RECOMMENDATIONS.service_failure(),
      creates_flag: false,
    });
  }

  // FTA flags that may be service-related
  const ftaFlags = flags.filter(f => f.flag_type === 'fta' || contains(f.title ?? '', 'service'));
  for (const f of ftaFlags) {
    alerts.push({
      case_id:     f.case_id,
      entity_type: 'flag',
      entity_id:   f.id,
      alert_type:  'service_failure',
      severity:    f.severity ?? 'high',
      title:       `Service/FTA risk — ${f.title ?? 'FTA flag'}`,
      body:        f.description ?? 'Open FTA or service-related flag. Verify service documentation before any warrant is issued.',
      recommended_action: RECOMMENDATIONS.service_failure(),
      creates_flag: false,
    });
  }
  return alerts;
}

function checkFacilityDelay(events, flags) {
  const alerts = [];

  // Missed or delayed transport events
  const transport = events.filter(e =>
    ['transport', 'transfer', 'extradition'].includes(e.event_type) &&
    ['missed', 'delayed', 'cancelled'].includes(e.status)
  );
  for (const e of transport) {
    alerts.push({
      case_id:     e.case_id,
      entity_type: 'event',
      entity_id:   e.id,
      alert_type:  'facility_delay',
      severity:    'high',
      title:       `Facility/transport delay — ${e.title ?? e.event_type}`,
      body:        `Transport/transfer event on ${e.event_date ?? '?'} marked ${e.status}. This delay may affect court appearances and is documentable for FTA defense.`,
      recommended_action: RECOMMENDATIONS.facility_delay(),
      creates_flag: false,
    });
  }

  // Open custody flags
  const custodyFlags = flags.filter(f => f.flag_type === 'custody');
  for (const f of custodyFlags) {
    alerts.push({
      case_id:     f.case_id,
      entity_type: 'flag',
      entity_id:   f.id,
      alert_type:  'facility_delay',
      severity:    f.severity ?? 'medium',
      title:       `Custody condition flag — ${f.title ?? 'Custody flag'}`,
      body:        f.description ?? 'Open custody condition flag. Document facility conditions for conditions-of-confinement motion.',
      recommended_action: RECOMMENDATIONS.facility_delay(),
      creates_flag: false,
    });
  }
  return alerts;
}

function contains(str, kw) { return str.toLowerCase().includes(kw.toLowerCase()); }

// ── Alert deduplication + sorting ─────────────────────────────────────────────

function deduplicateAlerts(alerts, existingKeys) {
  const seen = new Set();
  return alerts
    .filter(a => {
      const key = `${a.entity_id}::${a.alert_type}`;
      if (existingKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      (TYPE_RANK[a.alert_type]   ?? 99) - (TYPE_RANK[b.alert_type]  ?? 99)
    );
}

// ── Notification creation ─────────────────────────────────────────────────────

async function createNotifications(alerts) {
  if (!alerts.length) return 0;

  const rows = alerts.map(a => ({
    case_id:     a.case_id,
    entity_type: a.entity_type,
    entity_id:   a.entity_id,
    alert_type:  a.alert_type,
    severity:    a.severity,
    title:       a.title,
    body:        a.body,
    due_at:      a.due_at ?? null,
    is_read:     false,
    is_dismissed: false,
  }));

  const { data, error } = await supabase.from('notifications').insert(rows).select('id');
  if (error) console.error('[watchdog] notification insert error:', error.message);
  return data?.length ?? 0;
}

// ── Flag creation for critical violations ─────────────────────────────────────

async function createCriticalFlags(alerts) {
  const critical = alerts.filter(a => a.creates_flag && a.severity === 'critical');
  if (!critical.length) return 0;

  const FLAG_TYPE_MAP = {
    speedy_trial_violation:  { flag_type: 'deadline',  violation_type: 'constitutional' },
    foia_brady_risk:         { flag_type: 'brady',     violation_type: 'constitutional' },
    extradition_violation:   { flag_type: 'detainer',  violation_type: 'constitutional' },
    hearing_missed:          { flag_type: 'fta',       violation_type: 'procedural' },
  };

  const rows = critical.map(a => {
    const types = FLAG_TYPE_MAP[a.alert_type] ?? { flag_type: 'alert', violation_type: 'procedural' };
    return {
      case_id:        a.case_id,
      flag_type:      types.flag_type,
      violation_type: types.violation_type,
      severity:       'critical',
      title:          a.title.slice(0, 120),
      description:    a.body,
      raised_by:      'watchdog_engine',
      status:         'open',
    };
  });

  const { data, error } = await supabase.from('flags').insert(rows).select('id');
  if (error) console.error('[watchdog] flag insert error:', error.message);
  return data?.length ?? 0;
}

// ── Claude Haiku narrative ────────────────────────────────────────────────────

async function generateDigestNarrative(alerts) {
  if (!alerts.length) {
    return { threat_level: 'low', narrative: 'No active alerts detected across monitored cases.', top_actions: [] };
  }

  const systemPrompt = loadAgentPrompt();

  const compactAlerts = alerts.slice(0, 20).map(a => ({
    type:       a.alert_type,
    severity:   a.severity,
    title:      a.title,
    state:      a.state ?? null,
    days_over:  a.days_over ?? a.days_overdue ?? a.days_open ?? null,
    pct:        a.pct_elapsed ? Math.round(a.pct_elapsed * 100) : null,
  }));

  const resp = await anthropic.messages.create({
    model:      MODEL_LIGHT,
    max_tokens: 600,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify({ alerts: compactAlerts }) }],
  });

  let data = { digest: null };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.digest ?? { threat_level: 'unknown', narrative: null, top_actions: [] };
}

// ── Note builder ──────────────────────────────────────────────────────────────

const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

function buildAlertNote(alerts, digest, cases) {
  const date   = new Date().toLocaleDateString('en-US');
  const states = [...new Set(cases.map(c => c.state).filter(Boolean))].join('/');
  const critical = alerts.filter(a => a.severity === 'critical');
  const high     = alerts.filter(a => a.severity === 'high');

  const lines = [
    `# Watchdog Alert Digest — ${states} — ${date}`,
    `**Threat level:** ${(digest?.threat_level ?? 'unknown').toUpperCase()} | **Total alerts:** ${alerts.length} (${critical.length} critical, ${high.length} high)`,
    '',
  ];

  if (digest?.narrative) lines.push(digest.narrative, '');

  if (digest?.top_actions?.length) {
    lines.push('## Top Actions');
    digest.top_actions.forEach(a => {
      lines.push(
        `### [${a.rank}] ${a.action}`,
        a.rationale  ?? '',
        a.deadline ? `**Deadline:** ${a.deadline}` : '',
        '',
      );
    });
  }

  if (alerts.length) {
    lines.push('## All Alerts');
    const grouped = {};
    for (const a of alerts) (grouped[a.alert_type] ??= []).push(a);

    for (const [type, group] of Object.entries(grouped).sort(([a], [b]) =>
      (TYPE_RANK[a] ?? 99) - (TYPE_RANK[b] ?? 99)
    )) {
      lines.push(`### ${type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`);
      for (const a of group) {
        lines.push(
          `${SEV_ICON[a.severity] ?? '⚪'} **${a.title}**`,
          a.body ?? '',
          a.recommended_action ? `> ${a.recommended_action}` : '',
          '',
        );
      }
    }
  }

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runWatchdog({ person_id, case_ids }) {
  const [ctx, existingKeys] = await Promise.all([
    fetchWatchdogContext(case_ids),
    getExistingAlertKeys(case_ids),
  ]);

  const rawAlerts = [
    ...checkSpeedyTrial(ctx.cases),
    ...checkFoiaBradyRisk(ctx.foia),
    ...checkBradyRisk(ctx.flags, ctx.docs),
    ...checkHearingRisk(ctx.events),
    ...checkExtraditionConflict(ctx.cases),
    ...checkServiceFailure(ctx.events, ctx.flags),
    ...checkFacilityDelay(ctx.events, ctx.flags),
  ];

  const alerts = deduplicateAlerts(rawAlerts, existingKeys);

  // Create notifications + flags + narrative in parallel
  const [notificationsCreated, flagsCreated, digest] = await Promise.all([
    createNotifications(alerts),
    createCriticalFlags(alerts),
    generateDigestNarrative(alerts),
  ]);

  await createNote({
    person_id,
    note_type: 'alert',
    title:     `Watchdog Digest — ${digest?.threat_level?.toUpperCase() ?? '?'} — ${new Date().toLocaleDateString('en-US')}`,
    body:      buildAlertNote(alerts, digest, ctx.cases),
    author:    'watchdog_engine',
  });

  const byType     = {};
  const bySeverity = {};
  for (const a of alerts) {
    byType[a.alert_type]   = (byType[a.alert_type]   ?? 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
  }

  return {
    workflow:              'watchdog',
    person_id,
    case_ids,
    generated_at:          new Date().toISOString(),
    threat_level:          digest?.threat_level ?? 'unknown',
    alerts,
    digest,
    notifications_created: notificationsCreated,
    flags_created:         flagsCreated,
    summary: {
      total_alerts:          alerts.length,
      by_severity:           bySeverity,
      by_type:               byType,
      critical_count:        bySeverity.critical ?? 0,
      high_count:            bySeverity.high     ?? 0,
      notifications_created: notificationsCreated,
      flags_created:         flagsCreated,
      top_alert:             alerts[0]
        ? { type: alerts[0].alert_type, severity: alerts[0].severity, title: alerts[0].title }
        : null,
    },
  };
}

export async function getLatestAlerts(person_id) {
  const { data } = await supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('person_id', person_id)
    .eq('author', 'watchdog_engine')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
