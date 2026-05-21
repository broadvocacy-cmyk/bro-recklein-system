import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO = 'claude-sonnet-4-6';

export const REPORT_TYPES = [
  'misconduct_report',
  'foia_compliance_summary',
  'judicial_behavior_report',
  'prosecutor_behavior_report',
  'facility_report',
  'systemic_summary',
];

const PROSECUTOR_ROLES = new Set([
  'prosecutor', 'district_attorney', 'state_attorney', 'ada', 'assistant_district_attorney',
]);

function loadAgentPrompt() {
  try {
    return readFileSync(resolve('./agents/oversight_agent.md'), 'utf-8');
  } catch {
    return 'You are the Oversight & Reporting Engine. Generate formal oversight reports as JSON.';
  }
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function fetchOversightContext(case_ids, person_id) {
  const [
    { data: cases },
    { data: flags },
    { data: foia },
    { data: people },
    // Module R — stored by person_id
    { data: patternNotes },
    // Modules O, Q, P, M, N — stored by case_id
    { data: stackNotes },
    { data: pressureNotes },
    { data: scenarioNotes },
    { data: researchNotes },
    { data: verificationNotes },
  ] = await Promise.all([
    supabase.from('cases').select('id, title, state, county, status, filed_date').in('id', case_ids),
    supabase.from('flags').select('*').in('case_id', case_ids),
    supabase.from('foia_requests').select('*').in('case_id', case_ids),
    supabase.from('people').select('id, full_name, role, organization, case_id').in('case_id', case_ids),
    supabase.from('notes')
      .select('title, body, created_at')
      .eq('person_id', person_id)
      .eq('author', 'pattern_engine')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', 'defense_stack')
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', 'pressure_map')
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', 'scenario_engine')
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', 'research_agent')
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', 'verification_agent')
      .order('created_at', { ascending: false })
      .limit(6),
  ]);

  return {
    cases:             cases             ?? [],
    flags:             flags             ?? [],
    foia:              foia              ?? [],
    people:            people            ?? [],
    patternNotes:      patternNotes      ?? [],
    stackNotes:        stackNotes        ?? [],
    pressureNotes:     pressureNotes     ?? [],
    scenarioNotes:     scenarioNotes     ?? [],
    researchNotes:     researchNotes     ?? [],
    verificationNotes: verificationNotes ?? [],
  };
}

async function fetchActorModels(people) {
  const judge      = people.find(p => p.role === 'judge');
  const prosecutor = people.find(p => PROSECUTOR_ROLES.has(p.role?.toLowerCase()));

  const [judgeModel, prosecutorModel] = await Promise.all([
    judge      ? judgeProfile(judge.id).catch(() => null)           : Promise.resolve(null),
    prosecutor ? prosecutorProfile(prosecutor.id).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    judge: (judgeModel && !judgeModel.error)
      ? { name: judge.full_name, ...judgeModel } : null,
    prosecutor: (prosecutorModel && !prosecutorModel.error)
      ? { name: prosecutor.full_name, ...prosecutorModel } : null,
  };
}

// ── FOIA pre-aggregation ──────────────────────────────────────────────────────

function buildFoiaSnapshot(foia) {
  const today   = new Date().toISOString().split('T')[0];
  const overdue = foia.filter(r =>
    ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  );
  return {
    total:         foia.length,
    overdue:       overdue.length,
    denied:        foia.filter(r => r.status === 'denied').length,
    fulfilled:     foia.filter(r => r.status === 'fulfilled').length,
    pending:       foia.filter(r => ['sent', 'acknowledged'].includes(r.status) && !overdue.find(o => o.id === r.id)).length,
    response_rate: foia.length > 0
      ? parseFloat((foia.filter(r => r.response_date).length / foia.length).toFixed(3))
      : null,
    overdue_items: overdue.map(r => ({
      agency: r.agency, state: r.state, due_date: r.due_date, status: r.status,
      days_overdue: Math.floor((Date.now() - new Date(r.due_date).getTime()) / 86_400_000),
    })),
  };
}

// ── Report generation ─────────────────────────────────────────────────────────

async function generateReport(ctx, report_type, actorModels) {
  const {
    cases, flags, foia, patternNotes, stackNotes, pressureNotes,
    scenarioNotes, researchNotes, verificationNotes,
  } = ctx;

  const systemPrompt = loadAgentPrompt();
  const foiaSnapshot = buildFoiaSnapshot(foia);

  const behavioralModels = {};
  if (actorModels?.judge) {
    const j = actorModels.judge;
    behavioralModels.judge = {
      name:                    j.name ?? j.full_name,
      risk_score:              j.risk_score,
      risk_level:              j.risk_level,
      risk_factors:            j.risk_factors ?? [],
      continuation_rate:       j.delay_patterns?.continuation_rate ?? null,
      hearing_completion_rate: j.motion_tendencies?.hearing_completion_rate ?? null,
      judicial_conduct_flags:  j.behavior_profile?.by_flag_type?.judicial_conduct ?? 0,
    };
  }
  if (actorModels?.prosecutor) {
    const p = actorModels.prosecutor;
    behavioralModels.prosecutor = {
      name:               p.name ?? p.full_name,
      risk_score:         p.risk_score,
      risk_level:         p.risk_level,
      risk_factors:       p.risk_factors ?? [],
      brady_flags:        p.behavior_profile?.by_flag_type?.brady ?? 0,
      brady_documents:    p.filing_patterns?.brady_documents ?? 0,
      foia_overdue:       p.filing_patterns?.foia_overdue ?? 0,
      foia_response_rate: p.filing_patterns?.foia_response_rate ?? null,
    };
  }

  const payload = {
    report_type,
    cases: cases.map(c => ({
      id: c.id, state: c.state, county: c.county, status: c.status, filed_date: c.filed_date,
    })),
    flags: flags.map(f => ({
      type: f.flag_type, violation: f.violation_type,
      severity: f.severity, title: f.title, description: f.description, status: f.status,
    })),
    foia_snapshot:    foiaSnapshot,
    behavioral_models: Object.keys(behavioralModels).length ? behavioralModels : null,
    module_notes: {
      // Module R is the richest — give it the most space
      pattern_analysis:  patternNotes[0]?.body?.slice(0, 3000) ?? null,
      defense_stack:     stackNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 1000) })),
      pressure_map:      pressureNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 800) })),
      scenario:          scenarioNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
      research:          researchNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
      verification:      verificationNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
    },
  };

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 4000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(payload) }],
  });

  let data = { report: null };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.report ?? null;
}

// ── Note / document builder ───────────────────────────────────────────────────

const SEVERITY_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
const STATUS_LABEL  = { confirmed: '[CONFIRMED]', probable: '[PROBABLE]', alleged: '[ALLEGED]' };
const PRIORITY_ORDER = { immediate: 0, urgent: 1, standard: 2 };

function buildReportNote(report, report_type, cases) {
  if (!report) return `*Report generation failed for type: ${report_type}*`;

  const date   = new Date().toLocaleDateString('en-US');
  const states = [...new Set(cases.map(c => c.state).filter(Boolean))].join('/');

  const lines = [
    `# ${report.title ?? report_type}`,
    report.subtitle ? `## ${report.subtitle}` : '',
    '',
    `**Report type:** \`${report_type}\` | **Date:** ${date} | **States:** ${states}`,
    `**Prepared for:** ${report.prepared_for ?? 'Internal Use'}`,
    `**Findings:** ${report.findings?.length ?? 0} | **Recommendations:** ${report.recommendations?.length ?? 0}`,
    '',
  ];

  // Case references
  if (report.case_references?.length) {
    lines.push('**Cases:**');
    report.case_references.forEach(c =>
      lines.push(`- ${c.state ?? '?'} / ${c.county ?? '?'} — ${c.status ?? '?'} (filed ${c.filed_date ?? '?'})`)
    );
    lines.push('');
  }

  // Executive summary
  if (report.executive_summary) {
    lines.push('## Executive Summary', '', report.executive_summary, '');
  }

  // Findings
  if (report.findings?.length) {
    lines.push('## Findings');
    const sorted = [...report.findings].sort((a, b) => {
      const sev = { critical: 0, high: 1, medium: 2, low: 3 };
      return (sev[a.severity] ?? 4) - (sev[b.severity] ?? 4);
    });
    sorted.forEach(f => {
      const icon   = SEVERITY_ICON[f.severity] ?? '⚪';
      const status = STATUS_LABEL[f.status]    ?? `[${f.status ?? '?'}]`;
      lines.push(
        `### ${f.finding_id ?? '?'}: ${f.title}`,
        `${icon} **${(f.severity ?? '?').toUpperCase()}** ${status}`,
        '',
        f.description ?? '',
        '',
      );
      if (f.evidence?.length) {
        lines.push('**Evidence:**');
        f.evidence.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }
      if (f.legal_basis)    lines.push(`**Legal basis:** ${f.legal_basis}`);
      if (f.source_modules?.length)
        lines.push(`**Sources:** ${f.source_modules.join(' | ')}`);
      if (f.remediation)    lines.push(`**Remediation:** ${f.remediation}`);
      lines.push('');
    });
  }

  // Pattern summary
  if (report.pattern_summary) {
    lines.push('## Pattern Summary (Module R)', '', report.pattern_summary, '');
  }

  // Recommendations
  if (report.recommendations?.length) {
    lines.push('## Recommendations');
    const sorted = [...report.recommendations].sort((a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3)
    );
    sorted.forEach(r => {
      lines.push(
        `### ${r.recommendation_id ?? '?'}: ${r.action}`,
        `**Target:** ${r.target ?? '?'} | **Priority:** ${(r.priority ?? '?').toUpperCase()}`,
        r.legal_basis    ? `**Legal basis:** ${r.legal_basis}` : '',
        r.deadline_note  ? `**Deadline:** ${r.deadline_note}` : '',
        '',
      );
    });
  }

  // Supporting citations
  if (report.supporting_citations?.length) {
    lines.push('## Supporting Citations');
    report.supporting_citations.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  // Conclusion
  if (report.conclusion) {
    lines.push('## Conclusion', '', report.conclusion);
  }

  return lines.join('\n');
}

// ── Save helper ───────────────────────────────────────────────────────────────

async function saveReport(person_id, cases, report_type, report) {
  const date   = new Date().toLocaleDateString('en-US');
  const states = [...new Set(cases.map(c => c.state).filter(Boolean))].join('/');
  const title  = `[${report_type}] ${report?.title ?? report_type} — ${states} — ${date}`;

  await createNote({
    person_id,
    note_type: 'report',
    title:     title.slice(0, 200),
    body:      buildReportNote(report, report_type, cases),
    author:    'oversight_engine',
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runReport({ person_id, case_ids, report_type }) {
  if (!REPORT_TYPES.includes(report_type)) {
    return { error: `Unknown report_type. Valid: ${REPORT_TYPES.join(', ')}` };
  }

  const ctx         = await fetchOversightContext(case_ids, person_id);
  const actorModels = await fetchActorModels(ctx.people);
  const report      = await generateReport(ctx, report_type, actorModels);

  if (!report) return { error: `Report generation failed for type: ${report_type}` };

  await saveReport(person_id, ctx.cases, report_type, report);

  return {
    workflow:     'oversight_report',
    person_id,
    case_ids,
    generated_at: new Date().toISOString(),
    report_type,
    report,
    actor_models: actorModels,
    summary: {
      findings:        report.findings?.length        ?? 0,
      recommendations: report.recommendations?.length ?? 0,
      critical_findings: (report.findings ?? []).filter(f => f.severity === 'critical').length,
      confirmed_findings: (report.findings ?? []).filter(f => f.status === 'confirmed').length,
      immediate_actions: (report.recommendations ?? []).filter(r => r.priority === 'immediate').length,
    },
  };
}

export async function runAllReports({ person_id, case_ids }) {
  // Fetch context once, share across all 6 report generation calls
  const ctx         = await fetchOversightContext(case_ids, person_id);
  const actorModels = await fetchActorModels(ctx.people);

  const results = await Promise.all(
    REPORT_TYPES.map(async report_type => {
      try {
        const report = await generateReport(ctx, report_type, actorModels);
        if (report) await saveReport(person_id, ctx.cases, report_type, report);
        return { report_type, report: report ?? null, error: report ? null : 'No output' };
      } catch (e) {
        return { report_type, report: null, error: e.message };
      }
    })
  );

  const reports    = Object.fromEntries(results.map(r => [r.report_type, r.report]));
  const errors     = results.filter(r => r.error).map(r => ({ type: r.report_type, error: r.error }));
  const allFindings = results.flatMap(r => r.report?.findings ?? []);

  return {
    workflow:     'oversight_all_reports',
    person_id,
    case_ids,
    generated_at: new Date().toISOString(),
    reports,
    errors:       errors.length ? errors : null,
    summary: {
      reports_generated:  results.filter(r => !r.error).length,
      total_findings:     allFindings.length,
      critical_findings:  allFindings.filter(f => f.severity === 'critical').length,
      confirmed_findings: allFindings.filter(f => f.status === 'confirmed').length,
      immediate_actions:  results.flatMap(r => r.report?.recommendations ?? []).filter(r => r.priority === 'immediate').length,
      report_types:       REPORT_TYPES,
    },
  };
}

export async function getLatestReport(person_id, report_type) {
  const query = supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('person_id', person_id)
    .eq('author', 'oversight_engine')
    .eq('note_type', 'report')
    .order('created_at', { ascending: false });

  if (report_type) {
    query.ilike('title', `[${report_type}]%`);
  }

  const { data } = await query.limit(report_type ? 1 : 10);
  return report_type ? (data?.[0] ?? null) : (data ?? []);
}
