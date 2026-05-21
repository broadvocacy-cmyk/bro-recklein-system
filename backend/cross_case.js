import { supabase } from './supabase_client.js';

// ── private helpers ───────────────────────────────────────────────────────────

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    (acc[item[key] ?? 'unknown'] ??= []).push(item);
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

// Normalize name+org to a stable dedup key across multiple people records
function actorKey(full_name, organization) {
  return `${(full_name ?? '').toLowerCase()}::${(organization ?? '').toLowerCase()}`;
}

// Attach flag counts to a list of case IDs using a pre-built flagsByCase map
function flagStatsForCases(caseIds, flagsByCase) {
  const all = caseIds.flatMap(id => flagsByCase[id] ?? []);
  return {
    total_flags:            all.length,
    critical_flags:         all.filter(f => f.severity === 'critical').length,
    high_flags:             all.filter(f => f.severity === 'high').length,
    brady_flags:            all.filter(f => f.flag_type === 'brady').length,
    judicial_conduct_flags: all.filter(f => f.flag_type === 'judicial_conduct').length,
    misconduct_flags:       all.filter(f => ['pattern', 'inconsistency'].includes(f.flag_type)).length,
    by_flag_type:           countBy(all, 'flag_type'),
    by_violation_type:      countBy(all, 'violation_type')
  };
}

function bucketByDate(rows, dateField, interval) {
  const counts = {};
  for (const row of rows) {
    if (!row[dateField]) continue;
    const d = new Date(row[dateField]);
    let key;
    if (interval === 'week') {
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      key = monday.toISOString().split('T')[0];
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

async function fetchFlagsByCase() {
  const { data } = await supabase
    .from('flags')
    .select('case_id, flag_type, violation_type, severity');
  return (data ?? []).reduce((acc, f) => {
    (acc[f.case_id] ??= []).push(f);
    return acc;
  }, {});
}

// ── repeated actors ───────────────────────────────────────────────────────────

export async function repeatedJudges() {
  const [{ data: courts }, flagsByCase] = await Promise.all([
    supabase
      .from('courts')
      .select('id, case_id, name, state, county, judge_id, judge:judge_id(id, full_name, organization)'),
    fetchFlagsByCase()
  ]);

  const byJudge = {};
  for (const court of courts ?? []) {
    if (!court.judge) continue;
    const key = actorKey(court.judge.full_name, court.judge.organization);
    if (!byJudge[key]) {
      byJudge[key] = {
        full_name:    court.judge.full_name,
        organization: court.judge.organization,
        judge_ids:    new Set(),
        case_ids:     new Set(),
        courts:       []
      };
    }
    byJudge[key].judge_ids.add(court.judge.id);
    byJudge[key].case_ids.add(court.case_id);
    byJudge[key].courts.push({
      id: court.id, name: court.name, state: court.state, county: court.county, case_id: court.case_id
    });
  }

  const judges = Object.values(byJudge).map(j => {
    const caseIds = [...j.case_ids];
    return {
      full_name:    j.full_name,
      organization: j.organization,
      judge_ids:    [...j.judge_ids],
      case_count:   caseIds.length,
      case_ids:     caseIds,
      courts:       j.courts,
      ...flagStatsForCases(caseIds, flagsByCase)
    };
  }).sort((a, b) => b.case_count - a.case_count || b.total_flags - a.total_flags);

  return { count: judges.length, judges };
}

export async function repeatedProsecutors() {
  const [{ data: people }, flagsByCase] = await Promise.all([
    supabase.from('people').select('id, full_name, organization, case_id').eq('role', 'prosecutor'),
    fetchFlagsByCase()
  ]);

  const byProsecutor = {};
  for (const p of people ?? []) {
    const key = actorKey(p.full_name, p.organization);
    if (!byProsecutor[key]) {
      byProsecutor[key] = {
        full_name:    p.full_name,
        organization: p.organization,
        person_ids:   new Set(),
        case_ids:     new Set()
      };
    }
    byProsecutor[key].person_ids.add(p.id);
    if (p.case_id) byProsecutor[key].case_ids.add(p.case_id);
  }

  const prosecutors = Object.values(byProsecutor).map(p => {
    const caseIds = [...p.case_ids];
    return {
      full_name:    p.full_name,
      organization: p.organization,
      person_ids:   [...p.person_ids],
      case_count:   caseIds.length,
      case_ids:     caseIds,
      ...flagStatsForCases(caseIds, flagsByCase)
    };
  }).sort((a, b) => b.case_count - a.case_count || b.brady_flags - a.brady_flags);

  return { count: prosecutors.length, prosecutors };
}

export async function repeatedOfficers() {
  const [{ data: people }, flagsByCase] = await Promise.all([
    supabase
      .from('people')
      .select('id, full_name, organization, role, case_id')
      .in('role', ['investigator', 'officer', 'witness', 'contact']),
    fetchFlagsByCase()
  ]);

  const byOfficer = {};
  for (const p of people ?? []) {
    const key = actorKey(p.full_name, p.organization);
    if (!byOfficer[key]) {
      byOfficer[key] = {
        full_name:    p.full_name,
        organization: p.organization,
        roles:        new Set(),
        person_ids:   new Set(),
        case_ids:     new Set()
      };
    }
    byOfficer[key].person_ids.add(p.id);
    byOfficer[key].roles.add(p.role);
    if (p.case_id) byOfficer[key].case_ids.add(p.case_id);
  }

  const officers = Object.values(byOfficer).map(o => {
    const caseIds = [...o.case_ids];
    return {
      full_name:    o.full_name,
      organization: o.organization,
      roles:        [...o.roles],
      person_ids:   [...o.person_ids],
      case_count:   caseIds.length,
      case_ids:     caseIds,
      ...flagStatsForCases(caseIds, flagsByCase)
    };
  }).sort((a, b) => b.case_count - a.case_count || b.total_flags - a.total_flags);

  return { count: officers.length, officers };
}

export async function repeatedFacilities() {
  // Facilities are identified by source_system + case. No location columns in schema.
  const [{ data: docs }, flagsByCase] = await Promise.all([
    supabase
      .from('documents')
      .select('id, case_id, source_system, doc_type, created_at')
      .in('source_system', ['JAIL_LOG', 'TRANSPORT']),
    fetchFlagsByCase()
  ]);

  const byFacility = {};
  for (const doc of docs ?? []) {
    const key = `${doc.source_system}::${doc.case_id}`;
    if (!byFacility[key]) {
      byFacility[key] = {
        facility_type:  doc.source_system,
        case_id:        doc.case_id,
        document_count: 0,
        doc_types:      new Set()
      };
    }
    byFacility[key].document_count++;
    if (doc.doc_type) byFacility[key].doc_types.add(doc.doc_type);
  }

  // Aggregate across cases per facility type
  const byType = {};
  for (const entry of Object.values(byFacility)) {
    const t = entry.facility_type;
    if (!byType[t]) {
      byType[t] = { facility_type: t, case_ids: new Set(), total_documents: 0, doc_types: new Set() };
    }
    byType[t].case_ids.add(entry.case_id);
    byType[t].total_documents += entry.document_count;
    entry.doc_types.forEach(dt => byType[t].doc_types.add(dt));
  }

  const facilities = Object.values(byType).map(f => {
    const caseIds = [...f.case_ids];
    return {
      facility_type:   f.facility_type,
      case_count:      caseIds.length,
      case_ids:        caseIds,
      total_documents: f.total_documents,
      doc_types:       [...f.doc_types],
      ...flagStatsForCases(caseIds, flagsByCase)
    };
  }).sort((a, b) => b.case_count - a.case_count);

  return { count: facilities.length, facilities };
}

// ── misconduct patterns ───────────────────────────────────────────────────────

export async function misconductPatterns() {
  const { data: flags } = await supabase
    .from('flags')
    .select('id, case_id, flag_type, violation_type, severity, title, raised_by, created_at')
    .order('created_at');

  const byViolation = groupBy(flags ?? [], 'violation_type');
  const byFlagType  = groupBy(flags ?? [], 'flag_type');

  const violations = Object.entries(byViolation).map(([violation_type, items]) => {
    const caseIds = [...new Set(items.map(f => f.case_id))];
    return {
      violation_type,
      total_count:  items.length,
      case_count:   caseIds.length,
      case_ids:     caseIds,
      is_recurring: caseIds.length > 1,
      by_severity:  countBy(items, 'severity'),
      by_flag_type: countBy(items, 'flag_type'),
      latest:       items.at(-1)?.created_at ?? null,
      examples:     items.slice(0, 3).map(f => ({ id: f.id, title: f.title, severity: f.severity }))
    };
  }).sort((a, b) => b.case_count - a.case_count || b.total_count - a.total_count);

  const flagTypes = Object.entries(byFlagType).map(([flag_type, items]) => ({
    flag_type,
    count:      items.length,
    case_count: new Set(items.map(f => f.case_id)).size,
    by_severity: countBy(items, 'severity')
  })).sort((a, b) => b.count - a.count);

  return {
    total_flags:          (flags ?? []).length,
    recurring_violations: violations.filter(v => v.is_recurring),
    all_violations:       violations,
    by_flag_type:         flagTypes
  };
}

export async function bradyViolationPatterns() {
  const [{ data: flags }, { data: prosecutors }] = await Promise.all([
    supabase
      .from('flags')
      .select('id, case_id, flag_type, violation_type, severity, title, description, created_at')
      .eq('flag_type', 'brady')
      .order('created_at'),
    supabase
      .from('people')
      .select('id, full_name, organization, case_id')
      .eq('role', 'prosecutor')
  ]);

  const prosecutorsByCase = (prosecutors ?? []).reduce((acc, p) => {
    (acc[p.case_id] ??= []).push({ id: p.id, full_name: p.full_name, organization: p.organization });
    return acc;
  }, {});

  const byCase = groupBy(flags ?? [], 'case_id');

  const cases = Object.entries(byCase).map(([case_id, caseFlags]) => ({
    case_id,
    brady_count:    caseFlags.length,
    critical_count: caseFlags.filter(f => f.severity === 'critical').length,
    by_severity:    countBy(caseFlags, 'severity'),
    prosecutors:    prosecutorsByCase[case_id] ?? [],
    flags:          caseFlags.map(f => ({ id: f.id, title: f.title, severity: f.severity, created_at: f.created_at }))
  })).sort((a, b) => b.brady_count - a.brady_count);

  return {
    total_brady_flags: (flags ?? []).length,
    cases_with_brady:  cases.length,
    by_case:           cases
  };
}

// ── time-series trends ────────────────────────────────────────────────────────

export async function flagTrend(interval = 'month') {
  const { data } = await supabase
    .from('flags')
    .select('id, flag_type, violation_type, severity, created_at')
    .order('created_at');

  const rows = data ?? [];
  const bySeverity = {};
  for (const s of ['critical', 'high', 'medium', 'low']) {
    bySeverity[s] = bucketByDate(rows.filter(f => f.severity === s), 'created_at', interval);
  }

  const byFlagType = {};
  for (const ft of [...new Set(rows.map(f => f.flag_type).filter(Boolean))]) {
    byFlagType[ft] = bucketByDate(rows.filter(f => f.flag_type === ft), 'created_at', interval);
  }

  return {
    interval,
    total:        bucketByDate(rows, 'created_at', interval),
    by_severity:  bySeverity,
    by_flag_type: byFlagType
  };
}

export async function eventTrend(interval = 'month') {
  const { data } = await supabase
    .from('events')
    .select('id, event_type, is_critical, status, event_date')
    .order('event_date');

  const rows = data ?? [];
  return {
    interval,
    total:    bucketByDate(rows, 'event_date', interval),
    missed:   bucketByDate(rows.filter(e => e.status === 'missed'), 'event_date', interval),
    critical: bucketByDate(rows.filter(e => e.is_critical), 'event_date', interval),
    by_type:  Object.fromEntries(
      [...new Set(rows.map(e => e.event_type).filter(Boolean))].map(
        t => [t, bucketByDate(rows.filter(e => e.event_type === t), 'event_date', interval)]
      )
    )
  };
}

export async function foiaTrend(interval = 'month') {
  const { data } = await supabase
    .from('foia_requests')
    .select('id, agency, status, request_date, response_date, due_date')
    .order('request_date');

  const rows = data ?? [];
  return {
    interval,
    filed:     bucketByDate(rows, 'request_date', interval),
    responded: bucketByDate(rows.filter(r => r.response_date), 'response_date', interval),
    overdue:   bucketByDate(rows.filter(r => r.status === 'overdue'), 'due_date', interval),
    by_agency: Object.fromEntries(
      [...new Set(rows.map(r => r.agency).filter(Boolean))].map(
        a => [a, bucketByDate(rows.filter(r => r.agency === a), 'request_date', interval)]
      )
    )
  };
}

export async function violationTrend(interval = 'month') {
  const { data } = await supabase
    .from('flags')
    .select('id, violation_type, flag_type, severity, created_at')
    .order('created_at');

  const rows = data ?? [];
  const violationTypes = [...new Set(rows.map(f => f.violation_type).filter(Boolean))];

  return {
    interval,
    all:                bucketByDate(rows, 'created_at', interval),
    by_violation_type:  Object.fromEntries(
      violationTypes.map(vt => [
        vt,
        bucketByDate(rows.filter(f => f.violation_type === vt), 'created_at', interval)
      ])
    )
  };
}
