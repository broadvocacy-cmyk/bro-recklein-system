import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO   = 'claude-sonnet-4-6';
const SYSTEM_PROMPT = readFileSync(resolve('agents/dashboard_agent.md'), 'utf8');

// ── Note helpers ────────────────────────────────────────────────────────────

async function latestNoteBy(person_id, author, titlePrefix = null) {
  let q = supabase.from('notes')
    .select('content, title, created_at')
    .eq('person_id', person_id)
    .eq('author', author)
    .order('created_at', { ascending: false })
    .limit(1);
  if (titlePrefix) q = q.ilike('title', `${titlePrefix}%`);
  const { data } = await q;
  return data?.[0] ?? null;
}

async function latestCaseNoteBy(case_id, author) {
  const { data } = await supabase.from('notes')
    .select('content, title, created_at')
    .eq('case_id', case_id)
    .eq('author', author)
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

function excerpt(note, maxChars) {
  if (!note?.content) return null;
  const c = note.content;
  return c.length > maxChars ? c.slice(0, maxChars) + '…' : c;
}

// ── Module note fetch (all 8 person-level + 3×N case-level) ────────────────

async function fetchModuleNotes(person_id, case_ids) {
  const [personNotes, ...perCaseResults] = await Promise.all([
    Promise.all([
      latestNoteBy(person_id, 'watchdog_engine'),
      latestNoteBy(person_id, 'pattern_engine'),
      latestNoteBy(person_id, 'oversight_engine', '[misconduct_report]'),
      latestNoteBy(person_id, 'oversight_engine', '[foia_compliance_summary]'),
      latestNoteBy(person_id, 'oversight_engine', '[judicial_behavior_report]'),
      latestNoteBy(person_id, 'oversight_engine', '[prosecutor_behavior_report]'),
      latestNoteBy(person_id, 'oversight_engine', '[facility_report]'),
      latestNoteBy(person_id, 'oversight_engine', '[systemic_summary]'),
    ]),
    ...case_ids.map(cid => Promise.all([
      latestCaseNoteBy(cid, 'defense_stack'),
      latestCaseNoteBy(cid, 'scenario_engine'),
      latestCaseNoteBy(cid, 'pressure_map'),
    ])),
  ]);

  const [
    alertNote, patternNote,
    misconductNote, foiaCompNote, judicialNote,
    prosecutorNote, facilityNote, systemicNote,
  ] = personNotes;

  return {
    alerts:   alertNote,
    patterns: patternNote,
    reports: {
      misconduct:      misconductNote,
      foia_compliance: foiaCompNote,
      judicial:        judicialNote,
      prosecutor:      prosecutorNote,
      facility:        facilityNote,
      systemic:        systemicNote,
    },
    per_case: case_ids.map((cid, i) => ({
      case_id:  cid,
      stack:    perCaseResults[i][0],
      scenario: perCaseResults[i][1],
      pressure: perCaseResults[i][2],
    })),
  };
}

// ── Live DB fetch ───────────────────────────────────────────────────────────

async function fetchLiveData(case_ids) {
  const now          = new Date();
  const nowIso       = now.toISOString();
  const sevenDaysOut = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysOut= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const [
    casesR, flagsR, upcoming7R, timelineR,
    foiaR, notifR, peopleR, docsR,
  ] = await Promise.all([
    supabase.from('cases')
      .select('id, case_number, jurisdiction, state, status, charge, arraignment_date, trial_date, created_at')
      .in('id', case_ids),

    supabase.from('flags')
      .select('id, case_id, flag_type, severity, description, status, raised_at')
      .in('case_id', case_ids)
      .eq('status', 'open')
      .order('raised_at', { ascending: false })
      .limit(100),

    supabase.from('events')
      .select('id, case_id, event_type, event_date, description, status')
      .in('case_id', case_ids)
      .gte('event_date', nowIso)
      .lte('event_date', sevenDaysOut)
      .order('event_date', { ascending: true }),

    supabase.from('events')
      .select('id, case_id, event_type, event_date, description, status')
      .in('case_id', case_ids)
      .gte('event_date', sixtyDaysAgo)
      .lte('event_date', thirtyDaysOut)
      .order('event_date', { ascending: true })
      .limit(100),

    supabase.from('foia_requests')
      .select('id, case_id, agency, status, submitted_at, due_at, is_brady_material')
      .in('case_id', case_ids)
      .eq('status', 'overdue'),

    supabase.from('notifications')
      .select('id, case_id, alert_type, severity, title, body, due_at, created_at')
      .in('case_id', case_ids)
      .eq('is_dismissed', false)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase.from('people')
      .select('id, full_name, role, organization, case_id')
      .in('case_id', case_ids),

    supabase.from('documents')
      .select('id, case_id, doc_type, title, filed_at')
      .in('case_id', case_ids)
      .order('filed_at', { ascending: false })
      .limit(20),
  ]);

  return {
    cases:        casesR.data  ?? [],
    flags:        flagsR.data  ?? [],
    upcoming_7d:  upcoming7R.data ?? [],
    timeline:     timelineR.data  ?? [],
    overdue_foia: foiaR.data   ?? [],
    notifications:notifR.data  ?? [],
    people:       peopleR.data ?? [],
    recent_docs:  docsR.data   ?? [],
  };
}

// ── Processing helpers ──────────────────────────────────────────────────────

function determineThreatLevel(flags, notifications) {
  const sev = (arr) => arr.map(x => x.severity);
  const all  = [...sev(flags), ...sev(notifications)];
  if (all.includes('critical')) return 'critical';
  if (all.includes('high'))     return 'high';
  if (all.includes('medium'))   return 'medium';
  return 'low';
}

function buildFlagSummary(flags) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byType = {};
  for (const f of flags) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byType[f.flag_type]    = (byType[f.flag_type]    ?? 0) + 1;
  }
  return { counts_by_severity: bySeverity, counts_by_type: byType, total: flags.length };
}

function buildActorCards(people) {
  const PROSECUTOR_ROLES = new Set([
    'prosecutor', 'district_attorney', 'state_attorney', 'ada', 'assistant_district_attorney',
  ]);
  const merge = (acc, p) => {
    const key = `${p.full_name}::${p.organization ?? ''}`;
    if (!acc[key]) acc[key] = { id: p.id, full_name: p.full_name, role: p.role, organization: p.organization, case_ids: [] };
    acc[key].case_ids.push(p.case_id);
    return acc;
  };
  const judges      = Object.values(people.filter(p => p.role === 'judge').reduce(merge, {}));
  const prosecutors = Object.values(people.filter(p => PROSECUTOR_ROLES.has(p.role?.toLowerCase())).reduce(merge, {}));
  return { judges, prosecutors };
}

function buildCaseCards(cases, liveData, moduleNotes) {
  const { flags, overdue_foia, upcoming_7d } = liveData;
  return cases.map(c => {
    const cFlagCount  = flags.filter(f => f.case_id === c.id).length;
    const cCritical   = flags.filter(f => f.case_id === c.id && f.severity === 'critical').length;
    const cFoia       = overdue_foia.filter(f => f.case_id === c.id).length;
    const cHearings   = upcoming_7d.filter(e => e.case_id === c.id);
    const cNotes      = moduleNotes.per_case.find(p => p.case_id === c.id) ?? {};
    return {
      id:                  c.id,
      case_number:         c.case_number,
      jurisdiction:        c.jurisdiction,
      state:               c.state,
      status:              c.status,
      charge:              c.charge,
      arraignment_date:    c.arraignment_date,
      trial_date:          c.trial_date,
      open_flags:          cFlagCount,
      critical_flags:      cCritical,
      overdue_foia:        cFoia,
      upcoming_hearings_7d:cHearings.length,
      next_hearing:        cHearings[0] ?? null,
      has_defense_stack:   !!cNotes.stack,
      has_scenario:        !!cNotes.scenario,
      has_pressure_map:    !!cNotes.pressure,
      stack_updated_at:    cNotes.stack?.created_at    ?? null,
      scenario_updated_at: cNotes.scenario?.created_at ?? null,
      pressure_updated_at: cNotes.pressure?.created_at ?? null,
    };
  });
}

// ── Synthesis (Claude Pro) ──────────────────────────────────────────────────

async function synthesizeHub(liveData, moduleNotes) {
  const flagSummary = buildFlagSummary(liveData.flags);

  const payload = {
    case_count:           liveData.cases.length,
    states:               [...new Set(liveData.cases.map(c => c.state).filter(Boolean))],
    open_flags:           flagSummary.counts_by_severity,
    upcoming_hearings_7d: liveData.upcoming_7d.length,
    overdue_foia_count:   liveData.overdue_foia.length,
    alert_digest:         excerpt(moduleNotes.alerts, 2000),
    pattern_summary:      excerpt(moduleNotes.patterns, 1500),
    oversight_summaries: {
      misconduct:      excerpt(moduleNotes.reports.misconduct, 500),
      foia_compliance: excerpt(moduleNotes.reports.foia_compliance, 500),
      judicial:        excerpt(moduleNotes.reports.judicial, 500),
      prosecutor:      excerpt(moduleNotes.reports.prosecutor, 500),
      facility:        excerpt(moduleNotes.reports.facility, 300),
      systemic:        excerpt(moduleNotes.reports.systemic, 500),
    },
    per_case: moduleNotes.per_case.map(pc => {
      const c = liveData.cases.find(x => x.id === pc.case_id);
      return {
        case_id:          pc.case_id,
        jurisdiction:     c?.jurisdiction ?? 'Unknown',
        state:            c?.state        ?? 'Unknown',
        stack_summary:    excerpt(pc.stack, 600),
        scenario_summary: excerpt(pc.scenario, 400),
        pressure_summary: excerpt(pc.pressure, 400),
      };
    }),
  };

  const response = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  const raw     = response.content[0]?.text ?? '{}';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned).hub ?? {};
  } catch {
    return {
      priority_brief:    raw.slice(0, 400),
      immediate_actions: [],
      case_risk_summary: [],
      key_gaps:          ['Synthesis parse error — check raw output'],
    };
  }
}

// ── Note builder ────────────────────────────────────────────────────────────

function buildDashboardNote(synthesis, liveData, moduleNotes, threatLevel) {
  const flagSummary  = buildFlagSummary(liveData.flags);
  const { cases, upcoming_7d, overdue_foia } = liveData;
  const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

  const lines = [
    `INTELLIGENCE HUB — ${new Date().toISOString().slice(0, 10)}`,
    `Threat Level: ${threatLevel.toUpperCase()}`,
    '',
    '═══ PRIORITY BRIEF ═══',
    synthesis.priority_brief ?? '(synthesis not available)',
    '',
    '═══ IMMEDIATE ACTIONS ═══',
  ];

  for (const a of (synthesis.immediate_actions ?? [])) {
    lines.push(`[${a.rank}] [${(a.source_module ?? '').toUpperCase()}] ${a.action}`);
    lines.push(`    → ${a.case_context ?? ''} | ${a.deadline ?? ''}`);
  }

  lines.push('', '═══ CASE STATUS ═══');
  for (const c of (synthesis.case_risk_summary ?? [])) {
    const icon = SEV_ICON[c.risk_level] ?? '⚪';
    lines.push(`${icon} ${c.jurisdiction}: ${c.one_liner}`);
  }

  lines.push('', '═══ LIVE METRICS ═══');
  lines.push(`Cases: ${cases.length} | Upcoming hearings (7d): ${upcoming_7d.length} | Overdue FOIA: ${overdue_foia.length}`);
  lines.push(
    `Flags — Critical: ${flagSummary.counts_by_severity.critical}` +
    ` | High: ${flagSummary.counts_by_severity.high}` +
    ` | Medium: ${flagSummary.counts_by_severity.medium}` +
    ` | Low: ${flagSummary.counts_by_severity.low}`
  );

  const moduleStatus = [
    moduleNotes.alerts          ? `Watchdog:  ${moduleNotes.alerts.created_at?.slice(0,10)}`          : 'Watchdog:  not run',
    moduleNotes.patterns        ? `Patterns:  ${moduleNotes.patterns.created_at?.slice(0,10)}`        : 'Patterns:  not run',
    moduleNotes.reports.systemic? `Oversight: ${moduleNotes.reports.systemic.created_at?.slice(0,10)}`  : 'Oversight: not run',
  ];
  lines.push('', '═══ MODULE STATUS ═══');
  lines.push(...moduleStatus);

  lines.push('');
  for (const pc of moduleNotes.per_case) {
    const c = cases.find(x => x.id === pc.case_id);
    const label = c?.jurisdiction ?? pc.case_id.slice(0, 8);
    const parts = [
      pc.stack    ? `Stack ✓` : 'Stack ✗',
      pc.scenario ? `Scenario ✓` : 'Scenario ✗',
      pc.pressure ? `Pressure ✓` : 'Pressure ✗',
    ];
    lines.push(`  ${label}: ${parts.join(' | ')}`);
  }

  if ((synthesis.key_gaps ?? []).length > 0) {
    lines.push('', '═══ KEY GAPS ═══');
    for (const g of synthesis.key_gaps) lines.push(`• ${g}`);
  }

  return lines.join('\n');
}

// ── Main entry: full multi-case dashboard ───────────────────────────────────

export async function runDashboard({ person_id, case_ids }) {
  if (!person_id)        return { error: 'person_id required' };
  if (!case_ids?.length) return { error: 'case_ids required' };

  const [moduleNotes, liveData] = await Promise.all([
    fetchModuleNotes(person_id, case_ids),
    fetchLiveData(case_ids),
  ]);

  const threatLevel   = determineThreatLevel(liveData.flags, liveData.notifications);
  const flagSummary   = buildFlagSummary(liveData.flags);
  const actorCards    = buildActorCards(liveData.people);
  const caseCards     = buildCaseCards(liveData.cases, liveData, moduleNotes);
  const synthesis     = await synthesizeHub(liveData, moduleNotes);
  const noteContent   = buildDashboardNote(synthesis, liveData, moduleNotes, threatLevel);

  await createNote({
    person_id,
    title:     `[dashboard] Intelligence Hub — ${new Date().toISOString().slice(0, 10)}`,
    content:   noteContent,
    note_type: 'strategy',
    author:    'dashboard_engine',
  });

  return {
    generated_at:    new Date().toISOString(),
    person_id,
    threat_level:    threatLevel,
    intelligence_hub: {
      priority_brief:    synthesis.priority_brief     ?? null,
      immediate_actions: synthesis.immediate_actions  ?? [],
      case_risk_summary: synthesis.case_risk_summary  ?? [],
      key_gaps:          synthesis.key_gaps            ?? [],
    },
    cases:           caseCards,
    flags: {
      summary: flagSummary,
      open:    liveData.flags,
    },
    actor_intelligence: actorCards,
    upcoming_hearings:  liveData.upcoming_7d,
    timeline:           liveData.timeline,
    overdue_foia:       liveData.overdue_foia,
    notifications:      liveData.notifications,
    recent_documents:   liveData.recent_docs,
    module_outputs: {
      alerts:   moduleNotes.alerts   ? { title: moduleNotes.alerts.title,   updated_at: moduleNotes.alerts.created_at,   excerpt: excerpt(moduleNotes.alerts, 300)   } : null,
      patterns: moduleNotes.patterns ? { title: moduleNotes.patterns.title, updated_at: moduleNotes.patterns.created_at, excerpt: excerpt(moduleNotes.patterns, 300) } : null,
      reports:  Object.fromEntries(
        Object.entries(moduleNotes.reports).map(([k, v]) => [
          k, v ? { title: v.title, updated_at: v.created_at } : null,
        ])
      ),
      per_case: moduleNotes.per_case.map(pc => ({
        case_id:  pc.case_id,
        stack:    pc.stack    ? { updated_at: pc.stack.created_at }    : null,
        scenario: pc.scenario ? { updated_at: pc.scenario.created_at } : null,
        pressure: pc.pressure ? { updated_at: pc.pressure.created_at } : null,
      })),
    },
  };
}

// ── Single-case dashboard (live, no synthesis) ──────────────────────────────

export async function getCaseDashboard(case_id) {
  const now          = new Date();
  const nowIso       = now.toISOString();
  const sevenDaysOut = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysOut= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const [
    caseR, flagsR, upcoming7R, timelineR,
    foiaR, notifR, peopleR, docsR,
    stackNote, scenarioNote, pressureNote,
  ] = await Promise.all([
    supabase.from('cases').select('*').eq('id', case_id).single(),
    supabase.from('flags').select('id, flag_type, severity, description, status, raised_at').eq('case_id', case_id).eq('status', 'open').order('raised_at', { ascending: false }),
    supabase.from('events').select('id, event_type, event_date, description, status').eq('case_id', case_id).gte('event_date', nowIso).lte('event_date', sevenDaysOut).order('event_date', { ascending: true }),
    supabase.from('events').select('id, event_type, event_date, description, status').eq('case_id', case_id).gte('event_date', sixtyDaysAgo).lte('event_date', thirtyDaysOut).order('event_date', { ascending: true }),
    supabase.from('foia_requests').select('id, agency, status, submitted_at, due_at, is_brady_material').eq('case_id', case_id).eq('status', 'overdue'),
    supabase.from('notifications').select('id, alert_type, severity, title, body, due_at, created_at').eq('case_id', case_id).eq('is_dismissed', false).order('created_at', { ascending: false }).limit(20),
    supabase.from('people').select('id, full_name, role, organization').eq('case_id', case_id),
    supabase.from('documents').select('id, doc_type, title, filed_at').eq('case_id', case_id).order('filed_at', { ascending: false }).limit(20),
    latestCaseNoteBy(case_id, 'defense_stack'),
    latestCaseNoteBy(case_id, 'scenario_engine'),
    latestCaseNoteBy(case_id, 'pressure_map'),
  ]);

  const flags = flagsR.data ?? [];
  const notif = notifR.data ?? [];
  const threatLevel = determineThreatLevel(flags, notif);

  return {
    generated_at:     new Date().toISOString(),
    case_id,
    threat_level:     threatLevel,
    case:             caseR.data ?? null,
    flags: {
      summary: buildFlagSummary(flags),
      open:    flags,
    },
    actor_intelligence: buildActorCards(peopleR.data ?? []),
    upcoming_hearings:  upcoming7R.data ?? [],
    timeline:           timelineR.data  ?? [],
    overdue_foia:       foiaR.data      ?? [],
    notifications:      notif,
    people:             peopleR.data    ?? [],
    recent_documents:   docsR.data      ?? [],
    module_outputs: {
      stack:    stackNote    ? { updated_at: stackNote.created_at,    excerpt: excerpt(stackNote, 600)    } : null,
      scenario: scenarioNote ? { updated_at: scenarioNote.created_at, excerpt: excerpt(scenarioNote, 400) } : null,
      pressure: pressureNote ? { updated_at: pressureNote.created_at, excerpt: excerpt(pressureNote, 400) } : null,
    },
  };
}

// ── Retrieve cached dashboard note ──────────────────────────────────────────

export async function getLatestDashboard(person_id) {
  const { data } = await supabase.from('notes')
    .select('content, title, created_at')
    .eq('person_id', person_id)
    .eq('author', 'dashboard_engine')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
