import { supabase } from './supabase_client.js';
import { executeAgent } from './agent_executor.js';
import { ingest } from './ingestion/router.js';
import { createNote } from './notes.js';
import { generateMorningBrief } from './morning_brief.js';
import { generateAll as generateNotifications, getPendingNotifications } from './notifications.js';
import { lookupCaseLaw, lookupStatute } from './research_agent.js';

// ── BRO domain constants ──────────────────────────────────────────────────────

const SPEEDY_TRIAL = {
  TX: { days: 180, statute: 'Tex. Code Crim. Proc. Art. 32A.02' },
  IL: { days: 120, statute: 'Ill. Sup. Ct. R. 103(b)' },
  MO: { days: 180, statute: 'Mo. R. Crim. P. 33.01' }
};

const ORG_STATES   = ['TX', 'IL', 'MO'];
const ORG_COUNTIES = { TX: ['Palo Pinto'], IL: ['St. Clair', 'Madison'], MO: ['St. Charles'] };

// ── private helpers ───────────────────────────────────────────────────────────

function contains(str, keyword) {
  return (str ?? '').toLowerCase().includes(keyword.toLowerCase());
}

function flagText(f) {
  return `${f.title ?? ''} ${f.description ?? ''}`;
}

function jsonBlock(val) {
  return typeof val === 'object' && val !== null
    ? JSON.stringify(val, null, 2)
    : String(val ?? '—');
}

async function fetchCaseContext(case_ids, opts = {}) {
  const queries = [
    supabase.from('flags').select('*').in('case_id', case_ids).order('severity'),
    supabase.from('events').select('*').in('case_id', case_ids).order('event_date'),
    supabase.from('documents')
      .select('id, case_id, title, doc_type, source_system, is_brady, summary')
      .in('case_id', case_ids).order('created_at', { ascending: false }),
    supabase.from('foia_requests').select('*').in('case_id', case_ids)
  ];

  if (opts.includeCases) {
    queries.push(supabase.from('cases').select('id, title, state, county, status, filed_date').in('id', case_ids));
    queries.push(supabase.from('courts').select('id, case_id, name, state, county, court_type').in('case_id', case_ids));
  }

  const results = await Promise.all(queries);
  const [flags, events, docs, foia, cases, courts] = results.map(r => r.data ?? []);
  return { flags, events, docs, foia, cases: cases ?? [], courts: courts ?? [] };
}

// ── 1. INTAKE WORKFLOW ────────────────────────────────────────────────────────
// Accepts an array of documents to ingest, runs notifications, and
// creates an intake summary note.

export async function runIntake({ case_id, person_id, documents = [] }) {
  const ingested = [];
  const flagsFound = [];
  const errors = [];

  for (const doc of documents) {
    try {
      const result = await ingest(doc.type, { case_id, person_id, ...doc.payload });
      ingested.push({ type: doc.type, document_id: result?.document?.data?.id ?? null });
      if (result?.flag) flagsFound.push(result.flag);
    } catch (err) {
      errors.push({ type: doc.type, error: err.message });
    }
  }

  const notifResult = await generateNotifications();
  const critCount   = flagsFound.filter(f => f?.severity === 'critical').length;

  await createNote({
    case_id,
    person_id,
    note_type: 'observation',
    title:     `Intake: ${documents.length} document${documents.length !== 1 ? 's' : ''} processed`,
    body: [
      `**Intake complete** — ${new Date().toUTCString()}`,
      '',
      `- Documents ingested: ${ingested.length}`,
      `- Flags detected: ${flagsFound.length} (${critCount} critical)`,
      `- Notifications generated: ${notifResult.created}`,
      `- Errors: ${errors.length}`,
      ...(errors.length ? ['', '**Errors:**', ...errors.map(e => `- ${e.type}: ${e.error}`)] : [])
    ].join('\n'),
    author: 'intake_workflow'
  });

  return {
    workflow:              'intake',
    case_id,
    person_id,
    documents_ingested:    ingested,
    flags_detected:        flagsFound,
    notifications_created: notifResult.created,
    errors
  };
}

// ── 2. RED FLAG ESCALATION WORKFLOW ──────────────────────────────────────────
// Fetches open critical/high flags, runs defense_strategist + brady_monitor
// in parallel, marks flags escalated, stores a strategy note.

export async function runFlagEscalation({ case_id, flag_ids }) {
  let q = supabase
    .from('flags').select('*')
    .eq('case_id', case_id)
    .eq('status', 'open');

  q = flag_ids?.length
    ? q.in('id', flag_ids)
    : q.in('severity', ['critical', 'high']);

  const { data: flags } = await q.order('severity');

  if (!flags?.length) {
    return { workflow: 'flag_escalation', message: 'No open critical/high flags found', escalated: 0 };
  }

  const { data: recentEvents } = await supabase
    .from('events').select('*')
    .eq('case_id', case_id)
    .order('event_date', { ascending: false })
    .limit(20);

  const flagPayload  = flags.map(f => ({ type: f.flag_type, violation: f.violation_type, severity: f.severity, title: f.title, description: f.description }));
  const eventPayload = (recentEvents ?? []).map(e => ({ type: e.event_type, title: e.title, status: e.status, date: e.event_date }));

  // Derive case state for jurisdiction-scoped research
  const { data: caseRow } = await supabase.from('cases').select('state').eq('id', case_id).single();
  const caseState = caseRow?.state ?? null;

  const violationTypes = [...new Set(flags.map(f => f.violation_type).filter(Boolean))];
  const flagTypes      = [...new Set(flags.map(f => f.flag_type).filter(Boolean))];
  const caseLawQuery   = `${flagTypes.join(' ')} ${violationTypes.join(' ')} criminal defense violation`.trim();

  // Parallel: defense agents + external case-law research
  const [strategyResult, bradyResult, caseLawResearch] = await Promise.all([
    executeAgent('defense_strategist', { case_id, flags: flagPayload, events: eventPayload }),
    executeAgent('brady_monitor', {
      case_id,
      flags:  flags.filter(f => f.flag_type === 'brady').map(f => ({ title: f.title, description: f.description })),
      events: eventPayload
    }),
    lookupCaseLaw(caseLawQuery, caseState).catch(e => ({ error: e.message })),
  ]);

  // Mark flags escalated
  const idsToEscalate = flag_ids?.length ? flag_ids : flags.map(f => f.id);
  await supabase.from('flags').update({ status: 'escalated' }).in('id', idsToEscalate);

  await createNote({
    case_id,
    note_type: 'strategy',
    title:     `Flag Escalation — ${flags.length} flag${flags.length !== 1 ? 's' : ''} (${flags.filter(f => f.severity === 'critical').length} critical)`,
    body: [
      `## Escalation Report`,
      `**Flags escalated:** ${flags.length} — Critical: ${flags.filter(f => f.severity === 'critical').length} | High: ${flags.filter(f => f.severity === 'high').length}`,
      '',
      '**Flags:**',
      ...flags.map(f => `- [${f.severity?.toUpperCase()}] ${f.title} (${f.flag_type})`),
      '',
      '## Defense Strategy',
      jsonBlock(strategyResult),
      '',
      '## Brady/Giglio Analysis',
      jsonBlock(bradyResult),
      '',
      '## External Case-Law Research',
      jsonBlock(caseLawResearch)
    ].join('\n'),
    author: 'escalation_workflow'
  });

  const notifResult = await generateNotifications();

  return {
    workflow:              'flag_escalation',
    case_id,
    escalated:             flags.length,
    critical_count:        flags.filter(f => f.severity === 'critical').length,
    high_count:            flags.filter(f => f.severity === 'high').length,
    escalated_ids:         idsToEscalate,
    strategy:              strategyResult,
    brady_analysis:        bradyResult,
    case_law_research:     caseLawResearch,
    notifications_created: notifResult.created
  };
}

// ── 3. ADVOCATE WORKFLOW ──────────────────────────────────────────────────────
// Single call that assembles the full daily advocate dashboard:
// morning brief + open flags + upcoming events + overdue FOIA + notifications.

export async function runAdvocateWorkflow({ person_id, case_ids }) {
  const today   = new Date().toISOString().split('T')[0];
  const now     = new Date().toISOString();
  const in14    = new Date(Date.now() + 14 * 86_400_000).toISOString();

  const [
    brief,
    { data: openFlags },
    { data: upcomingEvt },
    { data: missedEvt },
    { data: overdueFoia },
    notifications
  ] = await Promise.all([
    generateMorningBrief(person_id),

    supabase.from('flags')
      .select('id, case_id, flag_type, violation_type, severity, title, description, status, created_at')
      .in('case_id', case_ids)
      .in('severity', ['critical', 'high'])
      .eq('status', 'open')
      .order('severity'),

    supabase.from('events')
      .select('id, case_id, event_type, title, event_date, deadline_date, is_critical, status')
      .in('case_id', case_ids)
      .not('status', 'in', '("completed","missed")')
      .not('event_date', 'is', null)
      .gte('event_date', now)
      .lte('event_date', in14)
      .order('event_date'),

    supabase.from('events')
      .select('id, case_id, event_type, title, event_date, description')
      .in('case_id', case_ids)
      .eq('status', 'missed')
      .order('event_date', { ascending: false }),

    supabase.from('foia_requests')
      .select('id, case_id, agency, state, status, due_date, request_date')
      .in('case_id', case_ids)
      .in('status', ['sent', 'acknowledged'])
      .not('due_date', 'is', null)
      .lt('due_date', today)
      .order('due_date'),

    getPendingNotifications({ include_read: false })
  ]);

  return {
    workflow:             'advocate',
    generated_at:         new Date().toISOString(),
    person_id,
    case_ids,
    morning_brief:        brief,
    open_critical_flags:  (openFlags ?? []).filter(f => f.severity === 'critical'),
    open_high_flags:      (openFlags ?? []).filter(f => f.severity === 'high'),
    upcoming_events_14d:  upcomingEvt ?? [],
    missed_events:        missedEvt   ?? [],
    overdue_foia:         overdueFoia ?? [],
    notifications:        notifications.data ?? [],
    summary: {
      critical_flags:       (openFlags ?? []).filter(f => f.severity === 'critical').length,
      high_flags:           (openFlags ?? []).filter(f => f.severity === 'high').length,
      upcoming_events:      (upcomingEvt ?? []).length,
      critical_events:      (upcomingEvt ?? []).filter(e => e.is_critical).length,
      missed_events:        (missedEvt   ?? []).length,
      overdue_foia:         (overdueFoia ?? []).length,
      unread_notifications: (notifications.data ?? []).length
    }
  };
}

// ── 4. MULTI-STATE LOGIC ──────────────────────────────────────────────────────
// Detects conflicting detainers, overlapping court dates, speedy trial status
// per state, jurisdiction conflicts, and warrant conflicts across TX/IL/MO.

export async function runMultiStateAnalysis({ person_id, case_ids }) {
  const { flags, events, docs, foia, cases, courts } = await fetchCaseContext(case_ids, { includeCases: true });

  const caseById  = Object.fromEntries((cases ?? []).map(c => [c.id, c]));
  const courtsByCase = (courts ?? []).reduce((acc, ct) => {
    (acc[ct.case_id] ??= []).push(ct);
    return acc;
  }, {});

  const caseState = id => caseById[id]?.state ?? null;

  // ── 1. Conflicting detainers ────────────────────────────────────────────────
  const detainerFlags = flags.filter(f => contains(flagText(f), 'detainer'));
  const detainerStates = [...new Set(detainerFlags.map(f => caseState(f.case_id)).filter(Boolean))];
  const conflictingDetainers = {
    detected: detainerStates.length > 1,
    states:   detainerStates,
    severity: detainerStates.length > 1 ? 'critical' : 'none',
    flags:    detainerFlags.map(f => ({ id: f.id, case_id: f.case_id, title: f.title, severity: f.severity, state: caseState(f.case_id) }))
  };

  // ── 2. Overlapping court dates ──────────────────────────────────────────────
  const evtByDay = {};
  for (const e of events) {
    if (!e.event_date) continue;
    const day = e.event_date.split('T')[0];
    (evtByDay[day] ??= []).push(e);
  }
  const overlappingDates = Object.entries(evtByDay)
    .filter(([, evts]) => {
      const states = new Set(evts.map(e => {
        const ct = (courtsByCase[e.case_id] ?? [])[0];
        return ct?.state ?? caseState(e.case_id);
      }).filter(Boolean));
      return states.size > 1;
    })
    .map(([date, evts]) => ({
      date,
      states: [...new Set(evts.map(e => (courtsByCase[e.case_id] ?? [])[0]?.state ?? caseState(e.case_id)).filter(Boolean))],
      events: evts.map(e => ({ id: e.id, title: e.title, status: e.status, case_id: e.case_id }))
    }));

  // ── 3. Speedy trial status per state ───────────────────────────────────────
  const speedyTrialStatus = {};
  for (const state of ORG_STATES) {
    const rule        = SPEEDY_TRIAL[state];
    const stateCases  = cases.filter(c => c.state === state);
    const stateFlags  = flags.filter(f => stateCases.some(c => c.id === f.case_id) && contains(flagText(f), 'speedy'));
    const missedHrgs  = events.filter(e =>
      e.status === 'missed' &&
      e.event_type === 'hearing' &&
      stateCases.some(c => c.id === e.case_id)
    );

    speedyTrialStatus[state] = {
      statute:        rule?.statute ?? 'N/A',
      limit_days:     rule?.days   ?? null,
      counties:       ORG_COUNTIES[state] ?? [],
      active_cases:   stateCases.filter(c => c.status === 'active').length,
      speedy_flags:   stateFlags.map(f => ({ id: f.id, title: f.title, severity: f.severity })),
      missed_hearings: missedHrgs.map(e => ({ id: e.id, title: e.title, event_date: e.event_date })),
      risk:           stateFlags.some(f => f.severity === 'critical') ? 'critical'
                    : stateFlags.some(f => f.severity === 'high') ? 'high'
                    : stateFlags.length ? 'medium' : 'low'
    };
  }

  // ── 4. Jurisdiction + warrant conflicts ────────────────────────────────────
  const jurisdictionFlags = flags.filter(f =>
    f.flag_type === 'inconsistency' || contains(flagText(f), 'jurisdiction')
  );
  const warrantFlags = flags.filter(f => contains(flagText(f), 'warrant'));
  const extraditionFlags = flags.filter(f => contains(flagText(f), 'extradition'));

  // ── 5. Cross-state research: agent + parallel statutory lookups ────────────
  const activeStates   = [...new Set(cases.map(c => c.state).filter(s => ORG_STATES.includes(s)))];
  const conflictSummary = [
    detainerStates.length > 1 ? `Active conflicting detainers across ${detainerStates.join(', ')}.` : '',
    overlappingDates.length > 0 ? `${overlappingDates.length} overlapping court date${overlappingDates.length !== 1 ? 's' : ''} detected.` : '',
    warrantFlags.length > 0 ? `${warrantFlags.length} warrant flag${warrantFlags.length !== 1 ? 's' : ''} detected.` : ''
  ].filter(Boolean).join(' ');

  // Parallel: case_researcher agent + speedy-trial statute lookups per active state
  const speedyTrialStatutes = {
    TX: 'Tex. Code Crim. Proc. Art. 32A.02',
    IL: 'Ill. Sup. Ct. R. 103(b)',
    MO: 'Mo. R. Crim. P. 33.01',
  };

  const [researchResult, ...statuteResults] = await Promise.all([
    executeAgent('case_researcher', {
      legal_questions: [
        'What are the extradition obligations between TX, IL, and MO for a defendant with active multi-state holds?',
        'How are conflicting detainers resolved when multiple states claim jurisdiction?',
        'Does time spent held on an out-of-state detainer count toward speedy trial in the requesting state?'
      ],
      states:   ORG_STATES,
      counties: ORG_COUNTIES,
      context:  `B.R.O. Advocacy — Recklein matter. ${conflictSummary}`
    }),
    ...activeStates.map(state =>
      lookupStatute(speedyTrialStatutes[state], state).catch(e => ({ state, error: e.message }))
    ),
  ]);

  const statutesByState = Object.fromEntries(
    activeStates.map((state, i) => [state, statuteResults[i]])
  );

  return {
    workflow:                'multi_state',
    person_id,
    states_active:           [...new Set(cases.map(c => c.state).filter(Boolean))],
    cases_by_state:          Object.fromEntries(
      ORG_STATES.map(s => [s, cases.filter(c => c.state === s).map(c => ({ id: c.id, title: c.title, status: c.status, county: c.county }))])
    ),
    conflicting_detainers:   conflictingDetainers,
    overlapping_court_dates: overlappingDates,
    speedy_trial_by_state:   speedyTrialStatus,
    jurisdiction_conflicts:  jurisdictionFlags.map(f => ({ id: f.id, title: f.title, severity: f.severity, case_id: f.case_id, state: caseState(f.case_id) })),
    warrant_conflicts:       warrantFlags.map(f => ({ id: f.id, title: f.title, severity: f.severity, state: caseState(f.case_id) })),
    extradition_flags:       extraditionFlags.map(f => ({ id: f.id, title: f.title, severity: f.severity })),
    legal_research:          researchResult,
    statutory_research:      statutesByState,
    cross_state_flag_total:  flags.filter(f => f.flag_type === 'inconsistency' || f.violation_type === 'constitutional').length
  };
}

// ── 5. STRATEGY GENERATION WORKFLOW ──────────────────────────────────────────
// Four-stage agent pipeline:
//   Stage 1 (parallel): brady_monitor + judge_pattern
//   Stage 2:            defense_strategist (consumes stage 1 output)
//   Stage 3:            thought_partner_bridge (final synthesis)
// Stores full output as a strategy note.

export async function runStrategyGeneration({ case_id }) {
  const { flags, events, docs, foia } = await fetchCaseContext([case_id]);

  const openFlags   = flags.filter(f => f.status === 'open');
  const flagPayload  = openFlags.map(f => ({ type: f.flag_type, violation: f.violation_type, severity: f.severity, title: f.title, description: f.description }));
  const eventPayload = events.slice(0, 30).map(e => ({ type: e.event_type, title: e.title, status: e.status, date: e.event_date, is_critical: e.is_critical }));
  const docPayload   = docs.slice(0, 20).map(d => ({ type: d.doc_type, source: d.source_system, is_brady: d.is_brady, summary: d.summary }));
  const foiaPayload  = foia.map(r => ({ agency: r.agency, status: r.status, due_date: r.due_date, state: r.state }));

  // Build case-law query from highest-severity flags
  const topFlags     = openFlags.filter(f => ['critical', 'high'].includes(f.severity)).slice(0, 3);
  const caseLawQuery = topFlags.length
    ? topFlags.map(f => f.violation_type ?? f.flag_type).filter(Boolean).join(' ') + ' criminal defense case law'
    : 'speedy trial Brady violation criminal defense case law TX IL MO';

  // Stage 1: parallel intel — agents + external case-law research
  const [bradyResult, judgeResult, externalResearch] = await Promise.all([
    executeAgent('brady_monitor', { case_id, documents: docPayload, events: eventPayload }),
    executeAgent('judge_pattern',  { case_id, events: eventPayload, documents: docPayload }),
    lookupCaseLaw(caseLawQuery, null).catch(e => ({ error: e.message })),
  ]);

  // Stage 2: defense strategy synthesis (Claude Pro) — informed by external research
  const strategyResult = await executeAgent('defense_strategist', {
    case_id,
    flags:             flagPayload,
    events:            eventPayload,
    documents:         docPayload,
    foia:              foiaPayload,
    brady_analysis:    bradyResult,
    judge_patterns:    judgeResult,
    external_research: externalResearch,
  });

  // Stage 3: thought partner bridge — final reconciliation (Claude Pro)
  const synthesisResult = await executeAgent('thought_partner_bridge', {
    case_id,
    strategic_recommendations: strategyResult,
    brady_analysis:            bradyResult,
    judge_patterns:            judgeResult,
    flag_count:                openFlags.length,
    critical_count:            openFlags.filter(f => f.severity === 'critical').length,
    brady_count:               openFlags.filter(f => f.flag_type === 'brady').length,
    states:                    ORG_STATES,
    foia_summary:              { total: foia.length, overdue: foia.filter(r => r.status === 'overdue').length }
  });

  await createNote({
    case_id,
    note_type: 'strategy',
    title:     `Strategy Generation — ${new Date().toLocaleDateString('en-US')}`,
    body: [
      `## Stage 1A: Brady/Giglio Analysis`,
      jsonBlock(bradyResult),
      '',
      `## Stage 1B: Judge Pattern Analysis`,
      jsonBlock(judgeResult),
      '',
      `## Stage 1C: External Case-Law Research`,
      jsonBlock(externalResearch),
      '',
      `## Stage 2: Defense Strategy`,
      jsonBlock(strategyResult),
      '',
      `## Stage 3: Thought Partner Synthesis`,
      jsonBlock(synthesisResult)
    ].join('\n'),
    author: 'strategy_workflow'
  });

  return {
    workflow:        'strategy_generation',
    case_id,
    generated_at:   new Date().toISOString(),
    flags_analyzed: openFlags.length,
    critical_flags: openFlags.filter(f => f.severity === 'critical').length,
    brady_flags:    openFlags.filter(f => f.flag_type === 'brady').length,
    stage_1: {
      brady_analysis:    bradyResult,
      judge_patterns:    judgeResult,
      external_research: externalResearch,
    },
    stage_2: {
      strategy: strategyResult
    },
    stage_3: {
      synthesis: synthesisResult
    }
  };
}
