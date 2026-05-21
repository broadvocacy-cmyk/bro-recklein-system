import { supabase } from './supabase_client.js';

// ── private helpers ───────────────────────────────────────────────────────────

function buildIndex(arr, key) {
  return arr.reduce((acc, item) => {
    (acc[item[key]] ??= []).push(item);
    return acc;
  }, {});
}

function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const v = item[key] ?? 'unknown';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

function riskLevel(score) {
  if (score >= 76) return 'critical';
  if (score >= 51) return 'high';
  if (score >= 26) return 'medium';
  return 'low';
}

function behaviorProfile(flags) {
  return {
    flag_total:          flags.length,
    by_severity:         countBy(flags, 'severity'),
    by_flag_type:        countBy(flags, 'flag_type'),
    by_violation_type:   countBy(flags, 'violation_type'),
    open_flags:          flags.filter(f => f.status === 'open').length,
    resolved_flags:      flags.filter(f => f.status === 'resolved').length,
    open_critical_flags: flags.filter(f => f.status === 'open' && f.severity === 'critical').length
  };
}

function delayPatterns(events) {
  const now       = Date.now();
  const total     = events.length;
  const missed    = events.filter(e => e.status === 'missed').length;
  const continued = events.filter(e => e.status === 'continued').length;
  const completed = events.filter(e => e.status === 'completed').length;
  const scheduled = events.filter(e => e.status === 'scheduled').length;

  const withDeadline = events.filter(e => e.deadline_date);
  const overdue      = withDeadline.filter(
    e => e.status !== 'completed' && new Date(e.deadline_date) < now
  );
  const overdueDays  = overdue.map(e =>
    Math.max(0, Math.round((now - new Date(e.deadline_date)) / 86_400_000))
  );
  const avgOverdueDays = overdueDays.length
    ? Math.round(overdueDays.reduce((a, b) => a + b, 0) / overdueDays.length)
    : null;

  return {
    total_events:         total,
    missed_events:        missed,
    continued_events:     continued,
    completed_events:     completed,
    scheduled_events:     scheduled,
    miss_rate:            total > 0 ? parseFloat((missed / total).toFixed(3)) : 0,
    continuation_rate:    total > 0 ? parseFloat((continued / total).toFixed(3)) : 0,
    events_with_deadline: withDeadline.length,
    overdue_events:       overdue.length,
    avg_overdue_days:     avgOverdueDays
  };
}

// Motion outcome tendencies — judge-specific
function motionTendencies(events, docs) {
  const hearings          = events.filter(e => e.event_type === 'hearing');
  const completedHearings = hearings.filter(e => e.status === 'completed');
  const missedHearings    = hearings.filter(e => e.status === 'missed');
  const continuedHearings = hearings.filter(e => e.status === 'continued');
  const orders            = docs.filter(d => d.doc_type === 'order').length;
  const motions           = docs.filter(d => d.doc_type === 'motion').length;

  return {
    total_documents:          docs.length,
    by_doc_type:              countBy(docs, 'doc_type'),
    orders_issued:            orders,
    motions_on_docket:        motions,
    order_to_motion_ratio:    motions > 0 ? parseFloat((orders / motions).toFixed(3)) : null,
    hearing_count:            hearings.length,
    hearings_completed:       completedHearings.length,
    hearings_missed:          missedHearings.length,
    hearings_continued:       continuedHearings.length,
    hearing_completion_rate:  hearings.length > 0
      ? parseFloat((completedHearings.length / hearings.length).toFixed(3))
      : null,
    hearing_miss_rate:        hearings.length > 0
      ? parseFloat((missedHearings.length / hearings.length).toFixed(3))
      : null,
    filing_events:            events.filter(e => e.event_type === 'filing').length,
    order_events:             events.filter(e => e.event_type === 'order').length,
    critical_events:          events.filter(e => e.is_critical).length
  };
}

// Filing and FOIA tendencies — prosecutor-specific
function filingPatterns(events, docs, foia) {
  const today       = new Date().toISOString().split('T')[0];
  const overdueFoia = foia.filter(
    r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  );

  return {
    total_documents:    docs.length,
    by_doc_type:        countBy(docs, 'doc_type'),
    motions_filed:      docs.filter(d => d.doc_type === 'motion').length,
    briefs_filed:       docs.filter(d => d.doc_type === 'brief').length,
    brady_documents:    docs.filter(d => d.is_brady).length,
    foia_total:         foia.length,
    foia_fulfilled:     foia.filter(r => r.status === 'fulfilled').length,
    foia_denied:        foia.filter(r => r.status === 'denied').length,
    foia_overdue:       overdueFoia.length,
    foia_response_rate: foia.length > 0
      ? parseFloat((foia.filter(r => r.response_date).length / foia.length).toFixed(3))
      : null,
    filing_events:      events.filter(e => e.event_type === 'filing').length
  };
}

function judgeRiskScore(flags, events) {
  const judicialConduct = flags.filter(f => f.flag_type === 'judicial_conduct').length;
  const critical        = flags.filter(f => f.severity === 'critical').length;
  const high            = flags.filter(f => f.severity === 'high').length;
  const brady           = flags.filter(f => f.flag_type === 'brady').length;
  const missed          = events.filter(e => e.status === 'missed').length;
  const continued       = events.filter(e => e.status === 'continued').length;
  const total           = events.length;

  const raw   = (judicialConduct * 20) + (critical * 10) + (brady * 8) + (high * 5) + (missed * 4) + (continued * 2);
  const score = Math.min(100, raw);

  const factors = [];
  if (judicialConduct > 0)
    factors.push(`${judicialConduct} judicial conduct flag${judicialConduct > 1 ? 's' : ''}`);
  if (critical > 0)
    factors.push(`${critical} critical flag${critical > 1 ? 's' : ''} in associated cases`);
  if (brady > 0)
    factors.push(`${brady} Brady violation${brady > 1 ? 's' : ''} in associated cases`);
  if (high > 0)
    factors.push(`${high} high-severity flag${high > 1 ? 's' : ''}`);
  if (missed > 0 && total > 0)
    factors.push(`${Math.round(missed / total * 100)}% hearing miss rate (${missed}/${total})`);
  if (continued > 0)
    factors.push(`${continued} event${continued > 1 ? 's' : ''} continued/postponed`);

  return { risk_score: score, risk_level: riskLevel(score), risk_factors: factors };
}

function prosecutorRiskScore(flags, events, foia) {
  const today          = new Date().toISOString().split('T')[0];
  const brady          = flags.filter(f => f.flag_type === 'brady').length;
  const critical       = flags.filter(f => f.severity === 'critical').length;
  const high           = flags.filter(f => f.severity === 'high').length;
  const constitutional = flags.filter(f => f.violation_type === 'constitutional').length;
  const missed         = events.filter(e => e.status === 'missed').length;
  const total          = events.length;
  const overdueFoia    = foia.filter(
    r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  ).length;

  const raw   = (brady * 15) + (critical * 10) + (constitutional * 12) + (high * 5) + (overdueFoia * 8) + (missed * 3);
  const score = Math.min(100, raw);

  const factors = [];
  if (brady > 0)
    factors.push(`${brady} Brady violation${brady > 1 ? 's' : ''}`);
  if (critical > 0)
    factors.push(`${critical} critical severity flag${critical > 1 ? 's' : ''}`);
  if (constitutional > 0)
    factors.push(`${constitutional} constitutional violation${constitutional > 1 ? 's' : ''}`);
  if (overdueFoia > 0)
    factors.push(`${overdueFoia} overdue FOIA request${overdueFoia > 1 ? 's' : ''}`);
  if (high > 0)
    factors.push(`${high} high-severity flag${high > 1 ? 's' : ''}`);
  if (missed > 0 && total > 0)
    factors.push(`${Math.round(missed / total * 100)}% event miss rate (${missed}/${total})`);

  return { risk_score: score, risk_level: riskLevel(score), risk_factors: factors };
}

function assembleJudgeProfile(meta, caseIds, flags, events, docs) {
  return {
    person_id:         meta.person_id,
    full_name:         meta.full_name,
    organization:      meta.organization,
    role:              'judge',
    case_count:        caseIds.length,
    case_ids:          caseIds,
    courts:            meta.courts ?? [],
    behavior_profile:  behaviorProfile(flags),
    motion_tendencies: motionTendencies(events, docs),
    delay_patterns:    delayPatterns(events),
    ...judgeRiskScore(flags, events)
  };
}

function assembleProsecutorProfile(meta, caseIds, flags, events, docs, foia) {
  return {
    person_id:        meta.person_id,
    full_name:        meta.full_name,
    organization:     meta.organization,
    role:             'prosecutor',
    case_count:       caseIds.length,
    case_ids:         caseIds,
    behavior_profile: behaviorProfile(flags),
    filing_patterns:  filingPatterns(events, docs, foia),
    delay_patterns:   delayPatterns(events),
    ...prosecutorRiskScore(flags, events, foia)
  };
}

// Bulk fetch all case data in 5 parallel queries for use in "all profiles" endpoints
async function fetchAllCaseData() {
  const [
    { data: courts },
    { data: flags },
    { data: events },
    { data: docs },
    { data: foia }
  ] = await Promise.all([
    supabase
      .from('courts')
      .select('id, case_id, name, state, county, judge_id, judge:judge_id(id, full_name, organization)'),
    supabase
      .from('flags')
      .select('case_id, flag_type, violation_type, severity, status, created_at'),
    supabase
      .from('events')
      .select('case_id, event_type, status, event_date, deadline_date, is_critical'),
    supabase
      .from('documents')
      .select('case_id, doc_type, is_brady, created_at'),
    supabase
      .from('foia_requests')
      .select('case_id, agency, status, request_date, due_date, response_date')
  ]);

  return {
    courts:      courts ?? [],
    flagsByCase: buildIndex(flags   ?? [], 'case_id'),
    evtByCase:   buildIndex(events  ?? [], 'case_id'),
    docsByCase:  buildIndex(docs    ?? [], 'case_id'),
    foiaByCase:  buildIndex(foia    ?? [], 'case_id')
  };
}

// ── public API ────────────────────────────────────────────────────────────────

export async function judgeProfile(person_id) {
  const [{ data: person }, { data: courts }] = await Promise.all([
    supabase.from('people').select('id, full_name, organization').eq('id', person_id).single(),
    supabase.from('courts').select('id, case_id, name, state, county').eq('judge_id', person_id)
  ]);

  if (!person) return { error: 'Judge not found' };

  const caseIds = [...new Set((courts ?? []).map(c => c.case_id).filter(Boolean))];
  if (!caseIds.length) {
    return assembleJudgeProfile(
      { person_id, full_name: person.full_name, organization: person.organization, courts: courts ?? [] },
      [], [], [], []
    );
  }

  const [{ data: flags }, { data: events }, { data: docs }] = await Promise.all([
    supabase.from('flags').select('case_id, flag_type, violation_type, severity, status, created_at').in('case_id', caseIds),
    supabase.from('events').select('case_id, event_type, status, event_date, deadline_date, is_critical').in('case_id', caseIds),
    supabase.from('documents').select('case_id, doc_type, is_brady, created_at').in('case_id', caseIds)
  ]);

  return assembleJudgeProfile(
    { person_id, full_name: person.full_name, organization: person.organization, courts: courts ?? [] },
    caseIds, flags ?? [], events ?? [], docs ?? []
  );
}

export async function prosecutorProfile(person_id) {
  const { data: person } = await supabase
    .from('people')
    .select('id, full_name, organization, case_id')
    .eq('id', person_id)
    .eq('role', 'prosecutor')
    .single();

  if (!person) return { error: 'Prosecutor not found' };

  const caseIds = person.case_id ? [person.case_id] : [];
  if (!caseIds.length) {
    return assembleProsecutorProfile(
      { person_id, full_name: person.full_name, organization: person.organization },
      [], [], [], [], []
    );
  }

  const [{ data: flags }, { data: events }, { data: docs }, { data: foia }] = await Promise.all([
    supabase.from('flags').select('case_id, flag_type, violation_type, severity, status, created_at').in('case_id', caseIds),
    supabase.from('events').select('case_id, event_type, status, event_date, deadline_date, is_critical').in('case_id', caseIds),
    supabase.from('documents').select('case_id, doc_type, is_brady, created_at').in('case_id', caseIds),
    supabase.from('foia_requests').select('case_id, agency, status, request_date, due_date, response_date').in('case_id', caseIds)
  ]);

  return assembleProsecutorProfile(
    { person_id, full_name: person.full_name, organization: person.organization },
    caseIds, flags ?? [], events ?? [], docs ?? [], foia ?? []
  );
}

export async function allJudgeProfiles() {
  const { courts, flagsByCase, evtByCase, docsByCase } = await fetchAllCaseData();

  const byJudge = {};
  for (const court of courts) {
    if (!court.judge) continue;
    const id = court.judge.id;
    if (!byJudge[id]) {
      byJudge[id] = {
        person_id:    id,
        full_name:    court.judge.full_name,
        organization: court.judge.organization,
        case_ids:     new Set(),
        courts:       []
      };
    }
    byJudge[id].case_ids.add(court.case_id);
    byJudge[id].courts.push({ id: court.id, name: court.name, state: court.state, county: court.county });
  }

  const profiles = Object.values(byJudge).map(meta => {
    const caseIds = [...meta.case_ids];
    const flags   = caseIds.flatMap(id => flagsByCase[id] ?? []);
    const events  = caseIds.flatMap(id => evtByCase[id]   ?? []);
    const docs    = caseIds.flatMap(id => docsByCase[id]  ?? []);
    return assembleJudgeProfile({ ...meta, courts: meta.courts }, caseIds, flags, events, docs);
  }).sort((a, b) => b.risk_score - a.risk_score);

  return { count: profiles.length, profiles };
}

export async function allProsecutorProfiles() {
  const [{ data: prosecutors }, caseData] = await Promise.all([
    supabase.from('people').select('id, full_name, organization, case_id').eq('role', 'prosecutor'),
    fetchAllCaseData()
  ]);

  const { flagsByCase, evtByCase, docsByCase, foiaByCase } = caseData;

  // Merge same-name/org prosecutors across multiple case records
  const byActor = {};
  for (const p of prosecutors ?? []) {
    const key = `${p.full_name.toLowerCase()}::${(p.organization ?? '').toLowerCase()}`;
    if (!byActor[key]) {
      byActor[key] = {
        person_id:    p.id,
        full_name:    p.full_name,
        organization: p.organization,
        case_ids:     new Set()
      };
    }
    if (p.case_id) byActor[key].case_ids.add(p.case_id);
  }

  const profiles = Object.values(byActor).map(meta => {
    const caseIds = [...meta.case_ids];
    const flags   = caseIds.flatMap(id => flagsByCase[id] ?? []);
    const events  = caseIds.flatMap(id => evtByCase[id]   ?? []);
    const docs    = caseIds.flatMap(id => docsByCase[id]  ?? []);
    const foia    = caseIds.flatMap(id => foiaByCase[id]  ?? []);
    return assembleProsecutorProfile(meta, caseIds, flags, events, docs, foia);
  }).sort((a, b) => b.risk_score - a.risk_score);

  return { count: profiles.length, profiles };
}
