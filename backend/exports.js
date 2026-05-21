import { supabase } from './supabase_client.js';
import { anthropic } from './anthropic_client.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';

const MODEL = 'claude-sonnet-4-6';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// ── data assembly ─────────────────────────────────────────────────────────────

async function assembleCaseData(case_id) {
  const [
    { data: caseRow },
    { data: people },
    { data: courts },
    { data: events },
    { data: flags },
    { data: docs },
    { data: foia },
    { data: notes }
  ] = await Promise.all([
    supabase.from('cases').select('*').eq('id', case_id).single(),
    supabase.from('people').select('*').eq('case_id', case_id).order('role'),
    supabase.from('courts').select('*').eq('case_id', case_id).order('state'),
    supabase.from('events').select('*').eq('case_id', case_id).order('event_date'),
    supabase.from('flags').select('*').eq('case_id', case_id),
    supabase.from('documents')
      .select('id, title, doc_type, source_system, filed_date, is_brady, is_redacted, summary, bates_number')
      .eq('case_id', case_id).order('filed_date'),
    supabase.from('foia_requests').select('*').eq('case_id', case_id).order('created_at'),
    supabase.from('notes')
      .select('id, note_type, title, body, author, is_privileged, created_at')
      .eq('case_id', case_id).order('created_at', { ascending: false })
  ]);

  return {
    case:      caseRow,
    people:    people    ?? [],
    courts:    courts    ?? [],
    events:    events    ?? [],
    flags:     [...(flags ?? [])].sort((a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    ),
    documents: docs      ?? [],
    foia:      foia      ?? [],
    notes:     notes     ?? []
  };
}

// ── markdown helpers ──────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function generatedLine() {
  return `_Generated: ${new Date().toUTCString()}_`;
}

function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const v = item[key] ?? 'unknown';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

// ── markdown formatters ───────────────────────────────────────────────────────

function casePacketMarkdown(d) {
  const c          = d.case;
  const today      = new Date().toISOString().split('T')[0];
  const critFlags  = d.flags.filter(f => f.severity === 'critical');
  const highFlags  = d.flags.filter(f => f.severity === 'high');
  const pendingEvt = d.events.filter(e => e.status !== 'completed');
  const overdueEvt = d.events.filter(
    e => e.deadline_date && new Date(e.deadline_date) < Date.now() && e.status !== 'completed'
  );
  const overdueFoia = d.foia.filter(
    r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  );

  const roleGroups = ['judge', 'prosecutor', 'attorney', 'defendant', 'witness', 'investigator', 'contact'];

  return [
    `# Case Packet: ${c.title}`,
    generatedLine(),
    '',
    '---',
    '',
    '## Case Overview',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Case Number | ${c.case_number ?? 'TBD'} |`,
    `| Status | ${c.status ?? '—'} |`,
    `| Type | ${c.case_type ?? '—'} |`,
    `| Jurisdiction | ${c.jurisdiction ?? '—'} (${c.jurisdiction_type ?? '—'}) |`,
    `| State | ${c.state ?? '—'} | County | ${c.county ?? '—'} |`,
    `| Filed | ${fmtDate(c.filed_date)} |`,
    `| Closed | ${fmtDate(c.closed_date)} |`,
    '',
    '## Alert Summary',
    '',
    `- **${critFlags.length} critical flag${critFlags.length !== 1 ? 's' : ''}** — immediate action required`,
    `- **${highFlags.length} high-severity flag${highFlags.length !== 1 ? 's' : ''}**`,
    `- **${pendingEvt.length} pending event${pendingEvt.length !== 1 ? 's' : ''}** (${overdueEvt.length} past deadline)`,
    `- **${overdueFoia.length} FOIA request${overdueFoia.length !== 1 ? 's' : ''}** overdue`,
    '',
    '## Courts',
    '',
    ...d.courts.map(ct =>
      `- **${ct.name}** — ${ct.county ?? ''}, ${ct.state ?? ''} (${ct.court_type ?? ''}) · Docket: ${ct.docket_number ?? 'N/A'}`
    ),
    '',
    '## People',
    '',
    ...roleGroups.flatMap(role => {
      const group = d.people.filter(p => p.role === role);
      if (!group.length) return [];
      return [`**${role.charAt(0).toUpperCase() + role.slice(1)}s:** ${group.map(p => `${p.full_name}${p.organization ? ` (${p.organization})` : ''}`).join(', ')}`];
    }),
    '',
    '## Flags',
    '',
    ...d.flags.flatMap(f => [
      `### [${(f.severity ?? 'unknown').toUpperCase()}] ${f.title}`,
      `**Type:** ${f.flag_type ?? '—'} | **Violation:** ${f.violation_type ?? '—'} | **Status:** ${f.status ?? 'open'}${f.requires_redaction ? ' | ⚠️ REDACTION REQUIRED' : ''}`,
      f.description ?? '',
      ''
    ]),
    '## Events',
    '',
    ...d.events.map(e =>
      `- [${(e.status ?? 'unknown').toUpperCase()}] **${e.title}** (${e.event_type ?? '—'}) — ${fmtDate(e.event_date)}` +
      (e.deadline_date ? ` · Deadline: ${fmtDate(e.deadline_date)}` : '') +
      (e.is_critical ? ' ⚠️ CRITICAL' : '')
    ),
    '',
    '## FOIA Requests',
    '',
    ...d.foia.map(r =>
      `- [${(r.status ?? '—').toUpperCase()}] **${r.agency}** · Requested: ${fmtDate(r.request_date)} · Due: ${fmtDate(r.due_date)}` +
      (r.response_date ? ` · Responded: ${fmtDate(r.response_date)}` : '')
    ),
    '',
    '## Documents',
    '',
    ...d.documents.map(doc =>
      `- **${doc.title}** (${doc.doc_type ?? '—'}) · ${doc.source_system ?? '—'}` +
      (doc.is_brady ? ' 🔴 BRADY' : '') +
      (doc.is_redacted ? ' [REDACTED]' : '') +
      ` · Filed: ${fmtDate(doc.filed_date)}`
    ),
    '',
    '## Notes',
    '',
    ...d.notes.slice(0, 20).flatMap(n => [
      `### ${n.title ?? `[${n.note_type}]`}`,
      `_${n.author ?? 'unknown'} · ${fmtDate(n.created_at)}_`,
      '',
      (n.body ?? '').slice(0, 600) + ((n.body ?? '').length > 600 ? '\n\n_[truncated]_' : ''),
      ''
    ])
  ].join('\n');
}

function foiaBundleMarkdown(foia, caseTitle) {
  const today    = new Date().toISOString().split('T')[0];
  const overdue  = foia.filter(r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today);
  const pending  = foia.filter(r => ['drafted', 'sent', 'acknowledged', 'partial'].includes(r.status) && !overdue.includes(r));
  const resolved = foia.filter(r => ['fulfilled', 'denied', 'appealed'].includes(r.status));

  const block = r => [
    `#### ${r.agency}${r.state ? ` (${r.state})` : ''}`,
    `| Field | Value |`,
    `|---|---|`,
    `| Status | **${(r.status ?? '—').toUpperCase()}** |`,
    `| Requested | ${fmtDate(r.request_date)} |`,
    `| Due | ${fmtDate(r.due_date)} |`,
    `| Response | ${fmtDate(r.response_date)} |`,
    r.response_notes ? `\n**Response notes:** ${r.response_notes}` : '',
    ''
  ].filter(l => l !== '').join('\n');

  return [
    `# FOIA Bundle: ${caseTitle}`,
    generatedLine(),
    '',
    '## Summary',
    '',
    `| Status | Count |`,
    `|---|---|`,
    ...Object.entries(countBy(foia, 'status')).map(([s, n]) => `| ${s} | ${n} |`),
    `| **Overdue** | **${overdue.length}** |`,
    '',
    '## Agencies',
    '',
    ...Object.entries(countBy(foia, 'agency'))
      .sort(([, a], [, b]) => b - a)
      .map(([agency, n]) => `- **${agency}**: ${n} request${n !== 1 ? 's' : ''}`),
    '',
    '---',
    '',
    ...(overdue.length  ? ['## ⚠️ Overdue Requests', '', ...overdue.map(block)]   : []),
    ...(pending.length  ? ['## Pending Requests',     '', ...pending.map(block)]   : []),
    ...(resolved.length ? ['## Resolved Requests',    '', ...resolved.map(block)]  : [])
  ].join('\n');
}

function flagBundleMarkdown(flags, caseTitle) {
  const byType = flags.reduce((acc, f) => {
    (acc[f.flag_type ?? 'unknown'] ??= []).push(f);
    return acc;
  }, {});

  const block = f => [
    `#### ${f.title}`,
    `**Violation:** ${f.violation_type ?? '—'} | **Raised by:** ${f.raised_by ?? '—'} | **Status:** ${f.status ?? 'open'}` +
    (f.requires_redaction ? ' | ⚠️ REDACTION REQUIRED' : ''),
    f.description ? `\n${f.description}` : '',
    ''
  ].join('\n');

  const section = (label, sev) => {
    const group = flags.filter(f => f.severity === sev);
    return group.length ? [`## ${label} (${group.length})`, '', ...group.map(block)] : [];
  };

  return [
    `# Flag Bundle: ${caseTitle}`,
    generatedLine(),
    '',
    '## Summary',
    '',
    `- **Total:** ${flags.length} flags`,
    `- Open: ${flags.filter(f => f.status === 'open').length} | Resolved: ${flags.filter(f => f.status === 'resolved').length}`,
    `- Critical: ${flags.filter(f => f.severity === 'critical').length} | High: ${flags.filter(f => f.severity === 'high').length} | Medium: ${flags.filter(f => f.severity === 'medium').length} | Low: ${flags.filter(f => f.severity === 'low').length}`,
    '',
    '## By Flag Type',
    '',
    ...Object.entries(byType)
      .sort(([, a], [, b]) => b.length - a.length)
      .map(([type, items]) => `- **${type}**: ${items.length} (${items.filter(f => f.status === 'open').length} open)`),
    '',
    '---',
    '',
    ...section('🔴 Critical', 'critical'),
    ...section('🟠 High',     'high'),
    ...section('🟡 Medium',   'medium'),
    ...section('🟢 Low',      'low')
  ].join('\n');
}

function actorProfileMarkdown(profile) {
  const emoji    = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[profile.risk_level] ?? '⚪';
  const bp       = profile.behavior_profile  ?? {};
  const dp       = profile.delay_patterns    ?? {};
  const mt       = profile.motion_tendencies ?? {};
  const fp       = profile.filing_patterns   ?? {};
  const pct      = r => r != null ? `${(r * 100).toFixed(1)}%` : 'N/A';

  return [
    `# Actor Profile: ${profile.full_name}`,
    generatedLine(),
    '',
    `**Role:** ${(profile.role ?? '—').toUpperCase()}`,
    `**Organization:** ${profile.organization ?? 'N/A'}`,
    `**Cases:** ${profile.case_count ?? 0}`,
    '',
    `## ${emoji} Risk Score: ${profile.risk_score ?? 0}/100 (${(profile.risk_level ?? 'unknown').toUpperCase()})`,
    '',
    '**Risk factors:**',
    ...(profile.risk_factors ?? []).map(f => `- ${f}`),
    '',
    '## Behavior Profile',
    '',
    `- Total flags in associated cases: **${bp.flag_total ?? 0}**`,
    `- Open: ${bp.open_flags ?? 0} | Resolved: ${bp.resolved_flags ?? 0} | Open critical: **${bp.open_critical_flags ?? 0}**`,
    '',
    '| Severity | Count |', '|---|---|',
    ...Object.entries(bp.by_severity ?? {}).map(([s, n]) => `| ${s} | ${n} |`),
    '',
    '| Flag Type | Count |', '|---|---|',
    ...Object.entries(bp.by_flag_type ?? {}).map(([t, n]) => `| ${t} | ${n} |`),
    '',
    '## Delay Patterns',
    '',
    `| Metric | Value |`, `|---|---|`,
    `| Total events | ${dp.total_events ?? 0} |`,
    `| Missed | ${dp.missed_events ?? 0} (${pct(dp.miss_rate)}) |`,
    `| Continued | ${dp.continued_events ?? 0} (${pct(dp.continuation_rate)}) |`,
    `| Completed | ${dp.completed_events ?? 0} |`,
    `| Overdue events | ${dp.overdue_events ?? 0} |`,
    `| Avg days overdue | ${dp.avg_overdue_days ?? 'N/A'} |`,
    '',
    ...(profile.role === 'judge' ? [
      '## Motion & Outcome Tendencies',
      '',
      `| Metric | Value |`, `|---|---|`,
      `| Hearings total | ${mt.hearing_count ?? 0} |`,
      `| Completion rate | ${pct(mt.hearing_completion_rate)} |`,
      `| Miss rate | ${pct(mt.hearing_miss_rate)} |`,
      `| Orders issued | ${mt.orders_issued ?? 0} |`,
      `| Motions on docket | ${mt.motions_on_docket ?? 0} |`,
      `| Order-to-motion ratio | ${mt.order_to_motion_ratio ?? 'N/A'} |`,
      '',
      '| Doc Type | Count |', '|---|---|',
      ...Object.entries(mt.by_doc_type ?? {}).map(([t, n]) => `| ${t} | ${n} |`)
    ] : []),
    ...(profile.role === 'prosecutor' ? [
      '## Filing Patterns',
      '',
      `| Metric | Value |`, `|---|---|`,
      `| Total documents | ${fp.total_documents ?? 0} |`,
      `| Motions filed | ${fp.motions_filed ?? 0} |`,
      `| Briefs filed | ${fp.briefs_filed ?? 0} |`,
      `| Brady documents | **${fp.brady_documents ?? 0}** |`,
      `| FOIA total | ${fp.foia_total ?? 0} |`,
      `| FOIA fulfilled | ${fp.foia_fulfilled ?? 0} |`,
      `| FOIA denied | ${fp.foia_denied ?? 0} |`,
      `| FOIA overdue | ${fp.foia_overdue ?? 0} |`,
      `| FOIA response rate | ${pct(fp.foia_response_rate)} |`
    ] : [])
  ].join('\n');
}

// ── strategy brief (Claude-generated) ────────────────────────────────────────

const STRATEGY_SYSTEM = `You are the Defense Strategist for the Recklein Case Engine — a multi-state criminal defense advocacy system.

Analyze the structured case data provided and produce a professional legal strategy brief. Be specific, cite facts, and prioritize action items by urgency.

Structure your response exactly as:

# Strategy Brief

## 1. Immediate Action Items
Numbered list of what must happen within 7 days, ordered by urgency.

## 2. Constitutional & Due Process Issues
Specific violations — speedy trial, due process, right to counsel. Cite event dates and case facts.

## 3. Brady / Giglio Analysis
Withheld or late disclosures. What filings are needed. Which prosecutors are implicated.

## 4. FOIA Priority Actions
Overdue requests requiring follow-up. What to demand and from whom.

## 5. Judge & Prosecutor Assessment
Behavioral patterns and strategic considerations for each actor based on the data.

## 6. Multi-State Coordination
Conflicting orders, detainers, jurisdiction conflicts across TX / IL / MO.

## 7. Recommended Filings
Concrete motions, letters, or filings — ordered by impact.`;

function buildStrategyContext(d) {
  const today     = new Date().toISOString().split('T')[0];
  const critFlags = d.flags.filter(f => f.severity === 'critical');
  const highFlags  = d.flags.filter(f => f.severity === 'high');
  const bradyFlags = d.flags.filter(f => f.flag_type === 'brady');
  const overdueEvt = d.events.filter(
    e => e.deadline_date && new Date(e.deadline_date) < Date.now() && e.status !== 'completed'
  );
  const overdueFoia = d.foia.filter(
    r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  );
  const missedEvt = d.events.filter(e => e.status === 'missed');
  const c         = d.case;

  return [
    `CASE: ${c.title} | Status: ${c.status} | Type: ${c.case_type} | Jurisdiction: ${c.jurisdiction} (${c.jurisdiction_type})`,
    '',
    'PEOPLE:',
    ...d.people.map(p => `  ${(p.role ?? '—').toUpperCase()}: ${p.full_name} — ${p.organization ?? 'no org'}`),
    '',
    'COURTS:',
    ...d.courts.map(ct => `  ${ct.name}, ${ct.county ?? ''} ${ct.state ?? ''} (${ct.court_type ?? '—'}) docket: ${ct.docket_number ?? 'N/A'}`),
    '',
    `CRITICAL FLAGS (${critFlags.length}):`,
    ...critFlags.map(f => `  [${f.flag_type}/${f.violation_type}] ${f.title}: ${f.description ?? '—'}`),
    '',
    `HIGH FLAGS (${highFlags.length}):`,
    ...highFlags.map(f => `  [${f.flag_type}] ${f.title}: ${f.description ?? '—'}`),
    '',
    `BRADY FLAGS (${bradyFlags.length}):`,
    ...bradyFlags.map(f => `  ${f.title}: ${f.description ?? '—'}`),
    '',
    `MISSED EVENTS (${missedEvt.length}):`,
    ...missedEvt.map(e => `  ${e.title} (${e.event_type}) — was ${fmtDate(e.event_date)}`),
    '',
    `OVERDUE EVENTS (${overdueEvt.length}):`,
    ...overdueEvt.map(e => `  ${e.title} — deadline was ${fmtDate(e.deadline_date)}`),
    '',
    `OVERDUE FOIA (${overdueFoia.length}):`,
    ...overdueFoia.map(r => `  ${r.agency} — due ${r.due_date}, status: ${r.status}`),
    '',
    `ALL OPEN EVENTS (${d.events.filter(e => e.status !== 'completed').length}):`,
    ...d.events.filter(e => e.status !== 'completed').slice(0, 15).map(e =>
      `  [${(e.status ?? '—').toUpperCase()}] ${e.title} — ${fmtDate(e.event_date)}${e.is_critical ? ' ⚠️ CRITICAL' : ''}`
    )
  ].join('\n');
}

// ── public exports ────────────────────────────────────────────────────────────

export async function generateCasePacket(case_id, format = 'json') {
  const data = await assembleCaseData(case_id);
  if (!data.case) return { error: 'Case not found' };

  const generated_at = new Date().toISOString();
  const slug = data.case.title?.replace(/\s+/g, '_').toLowerCase() ?? case_id;
  const ext  = format === 'markdown' ? 'md' : 'json';
  const filename = `case_packet_${slug}_${generated_at.split('T')[0]}.${ext}`;

  if (format === 'markdown') {
    return { type: 'case_packet', format, case_id, generated_at, filename, content: casePacketMarkdown(data) };
  }
  return { type: 'case_packet', format: 'json', case_id, generated_at, filename, data };
}

export async function generateFOIABundle(case_id, format = 'json') {
  const [{ data: caseRow }, { data: foia }] = await Promise.all([
    supabase.from('cases').select('id, title').eq('id', case_id).single(),
    supabase.from('foia_requests').select('*').eq('case_id', case_id).order('created_at')
  ]);
  if (!caseRow) return { error: 'Case not found' };

  const generated_at = new Date().toISOString();
  const filename = `foia_bundle_${generated_at.split('T')[0]}.${format === 'markdown' ? 'md' : 'json'}`;
  const rows = foia ?? [];

  if (format === 'markdown') {
    return { type: 'foia_bundle', format, case_id, generated_at, filename, content: foiaBundleMarkdown(rows, caseRow.title) };
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    type: 'foia_bundle', format: 'json', case_id, generated_at, filename,
    data: {
      case_title: caseRow.title,
      total:      rows.length,
      by_status:  countBy(rows, 'status'),
      by_agency:  countBy(rows, 'agency'),
      overdue:    rows.filter(r => ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today),
      requests:   rows
    }
  };
}

export async function generateFlagBundle(case_id, format = 'json') {
  const [{ data: caseRow }, { data: flags }] = await Promise.all([
    supabase.from('cases').select('id, title').eq('id', case_id).single(),
    supabase.from('flags').select('*').eq('case_id', case_id)
  ]);
  if (!caseRow) return { error: 'Case not found' };

  const generated_at = new Date().toISOString();
  const filename = `flag_bundle_${generated_at.split('T')[0]}.${format === 'markdown' ? 'md' : 'json'}`;
  const sorted = [...(flags ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  );

  if (format === 'markdown') {
    return { type: 'flag_bundle', format, case_id, generated_at, filename, content: flagBundleMarkdown(sorted, caseRow.title) };
  }
  return {
    type: 'flag_bundle', format: 'json', case_id, generated_at, filename,
    data: {
      case_title:   caseRow.title,
      total:        sorted.length,
      by_severity:  countBy(sorted, 'severity'),
      by_flag_type: countBy(sorted, 'flag_type'),
      by_status:    countBy(sorted, 'status'),
      flags:        sorted
    }
  };
}

export async function generateActorProfileExport(person_id, role, format = 'json') {
  const profile = role === 'judge'
    ? await judgeProfile(person_id)
    : await prosecutorProfile(person_id);

  if (profile?.error) return { error: profile.error };

  const generated_at = new Date().toISOString();
  const slug = profile.full_name?.replace(/\s+/g, '_').toLowerCase() ?? person_id;
  const ext  = format === 'markdown' ? 'md' : 'json';
  const filename = `${role}_profile_${slug}_${generated_at.split('T')[0]}.${ext}`;

  if (format === 'markdown') {
    return { type: 'actor_profile', format, person_id, role, generated_at, filename, content: actorProfileMarkdown(profile) };
  }
  return { type: 'actor_profile', format: 'json', person_id, role, generated_at, filename, data: profile };
}

export async function generateStrategyBrief(case_id) {
  const data = await assembleCaseData(case_id);
  if (!data.case) return { error: 'Case not found' };

  const response = await anthropic.messages.create({
    model:    MODEL,
    max_tokens: 2000,
    system:   STRATEGY_SYSTEM,
    messages: [{ role: 'user', content: buildStrategyContext(data) }]
  });

  const generated_at = new Date().toISOString();
  const slug = data.case.title?.replace(/\s+/g, '_').toLowerCase() ?? case_id;
  return {
    type:         'strategy_brief',
    format:       'markdown',
    case_id,
    generated_at,
    filename:     `strategy_brief_${slug}_${generated_at.split('T')[0]}.md`,
    content:      response.content[0].text
  };
}
