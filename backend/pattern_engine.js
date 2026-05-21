import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO = 'claude-sonnet-4-6';

const PROSECUTOR_ROLES = new Set([
  'prosecutor', 'district_attorney', 'state_attorney', 'ada', 'assistant_district_attorney',
]);

// Authors produced by Modules M–Q — used to pull their notes
const MODULE_AUTHORS = {
  research:      'research_agent',
  verification:  'verification_agent',
  defense_stack: 'defense_stack',
  scenario:      'scenario_engine',
  pressure_map:  'pressure_map',
};

function loadAgentPrompt() {
  try {
    return readFileSync(resolve('./agents/pattern_engine_agent.md'), 'utf-8');
  } catch {
    return 'You are the Multi-Case Pattern Engine. Detect patterns and return JSON.';
  }
}

// ── JS helpers ────────────────────────────────────────────────────────────────

function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const v = item[key] ?? 'unknown';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

function actorKey(name, org) {
  return `${(name ?? '').toLowerCase().trim()}::${(org ?? '').toLowerCase().trim()}`;
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function fetchPatternContext(case_ids) {
  // Fetch all cross-case data in parallel
  const [
    { data: cases },
    { data: flags },
    { data: events },
    { data: foia },
    { data: people },
    { data: courts },
    // Module M–Q notes — 2 most recent per module per person (stored by case_id or person_id)
    { data: researchNotes },
    { data: verificationNotes },
    { data: stackNotes },
    { data: scenarioNotes },
    { data: pressureNotes },
  ] = await Promise.all([
    supabase.from('cases').select('id, title, state, county, status, filed_date').in('id', case_ids),
    supabase.from('flags').select('*').in('case_id', case_ids),
    supabase.from('events').select('*').in('case_id', case_ids),
    supabase.from('foia_requests').select('*').in('case_id', case_ids),
    supabase.from('people').select('id, full_name, role, organization, case_id').in('case_id', case_ids),
    supabase.from('courts').select('id, name, state, county, judge_id, case_id').in('case_id', case_ids),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', MODULE_AUTHORS.research)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', MODULE_AUTHORS.verification)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', MODULE_AUTHORS.defense_stack)
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', MODULE_AUTHORS.scenario)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('notes')
      .select('case_id, title, body')
      .in('case_id', case_ids)
      .eq('author', MODULE_AUTHORS.pressure_map)
      .order('created_at', { ascending: false })
      .limit(3),
  ]);

  return {
    cases:             cases             ?? [],
    flags:             flags             ?? [],
    events:            events            ?? [],
    foia:              foia              ?? [],
    people:            people            ?? [],
    courts:            courts            ?? [],
    researchNotes:     researchNotes     ?? [],
    verificationNotes: verificationNotes ?? [],
    stackNotes:        stackNotes        ?? [],
    scenarioNotes:     scenarioNotes     ?? [],
    pressureNotes:     pressureNotes     ?? [],
  };
}

// ── JS pre-aggregation ────────────────────────────────────────────────────────

function buildActorIndex(people, flags, events) {
  const byActor = {};

  for (const p of people) {
    const key = actorKey(p.full_name, p.organization);
    if (!byActor[key]) {
      byActor[key] = {
        id:         p.id,
        name:       p.full_name,
        org:        p.organization ?? null,
        roles:      new Set(),
        cases:      new Set(),
        raw_flags:  [],
        raw_events: [],
      };
    }
    byActor[key].roles.add(p.role);
    if (p.case_id) byActor[key].cases.add(p.case_id);
  }

  // Index flags and events by case_id for fast lookup
  const flagsByCase  = {};
  const eventsByCase = {};
  for (const f of flags)  (flagsByCase[f.case_id]  ??= []).push(f);
  for (const e of events) (eventsByCase[e.case_id] ??= []).push(e);

  // Attach case-level data to each actor
  for (const actor of Object.values(byActor)) {
    for (const cid of actor.cases) {
      actor.raw_flags.push(...(flagsByCase[cid]  ?? []));
      actor.raw_events.push(...(eventsByCase[cid] ?? []));
    }
  }

  return Object.values(byActor)
    .map(a => {
      const total = a.raw_events.length;
      return {
        id:                a.id,
        name:              a.name,
        org:               a.org,
        roles:             [...a.roles],
        case_count:        a.cases.size,
        case_ids:          [...a.cases],
        flag_count:        a.raw_flags.length,
        flags_by_type:     countBy(a.raw_flags, 'flag_type'),
        flags_by_severity: countBy(a.raw_flags, 'severity'),
        miss_rate:         total > 0
          ? parseFloat((a.raw_events.filter(e => e.status === 'missed').length / total).toFixed(3))
          : 0,
        continuation_rate: total > 0
          ? parseFloat((a.raw_events.filter(e => e.status === 'continued').length / total).toFixed(3))
          : 0,
      };
    })
    .sort((a, b) => b.case_count - a.case_count || b.flag_count - a.flag_count)
    .slice(0, 20); // top 20 actors by appearance
}

function buildFoiaSummary(foia) {
  const today    = new Date().toISOString().split('T')[0];
  const overdue  = foia.filter(r =>
    ['sent', 'acknowledged'].includes(r.status) && r.due_date && r.due_date < today
  );

  const byAgency = {};
  for (const r of foia) {
    const key = `${(r.agency ?? '?')}::${r.state ?? '?'}`;
    if (!byAgency[key]) {
      byAgency[key] = { agency: r.agency, state: r.state, total: 0, overdue: 0, denied: 0, fulfilled: 0 };
    }
    byAgency[key].total++;
    if (overdue.some(o => o.id === r.id)) byAgency[key].overdue++;
    if (r.status === 'denied')    byAgency[key].denied++;
    if (r.status === 'fulfilled') byAgency[key].fulfilled++;
  }

  return {
    total:         foia.length,
    overdue:       overdue.length,
    denied:        foia.filter(r => r.status === 'denied').length,
    fulfilled:     foia.filter(r => r.status === 'fulfilled').length,
    response_rate: foia.length > 0
      ? parseFloat((foia.filter(r => r.response_date).length / foia.length).toFixed(3))
      : null,
    by_agency: Object.values(byAgency)
      .sort((a, b) => b.overdue - a.overdue || b.total - a.total),
  };
}

function buildFlagSummary(flags, case_ids) {
  return {
    total:          flags.length,
    by_type:        countBy(flags, 'flag_type'),
    by_severity:    countBy(flags, 'severity'),
    by_case:        Object.fromEntries(
      case_ids.map(id => [id, flags.filter(f => f.case_id === id).length])
    ),
    open_critical:  flags.filter(f => f.status === 'open' && f.severity === 'critical').length,
    open_brady:     flags.filter(f => f.status === 'open' && f.flag_type === 'brady').length,
    open_deadline:  flags.filter(f => f.status === 'open' && f.flag_type === 'deadline').length,
  };
}

function buildEventSummary(events) {
  const total     = events.length;
  const missed    = events.filter(e => e.status === 'missed').length;
  const continued = events.filter(e => e.status === 'continued').length;
  return {
    total,
    missed,
    continued,
    miss_rate:         total > 0 ? parseFloat((missed    / total).toFixed(3)) : 0,
    continuation_rate: total > 0 ? parseFloat((continued / total).toFixed(3)) : 0,
    critical_count:    events.filter(e => e.is_critical).length,
  };
}

// ── Resolve behavioral profiles for top repeated actors ───────────────────────

async function resolveTopActorProfiles(actorIndex) {
  const judges      = actorIndex.filter(a => a.roles.includes('judge')).slice(0, 2);
  const prosecutors = actorIndex.filter(a =>
    a.roles.some(r => PROSECUTOR_ROLES.has(r?.toLowerCase()))
  ).slice(0, 2);

  const judgeProfiles = await Promise.all(
    judges.map(a =>
      a.id ? judgeProfile(a.id).catch(() => null) : Promise.resolve(null)
    )
  );
  const prosecutorProfiles = await Promise.all(
    prosecutors.map(a =>
      a.id ? prosecutorProfile(a.id).catch(() => null) : Promise.resolve(null)
    )
  );

  return {
    judges:      judges.map((a, i) => judgeProfiles[i] && !judgeProfiles[i].error
      ? { name: a.name, ...judgeProfiles[i] } : { name: a.name, error: 'profile unavailable' }
    ),
    prosecutors: prosecutors.map((a, i) => prosecutorProfiles[i] && !prosecutorProfiles[i].error
      ? { name: a.name, ...prosecutorProfiles[i] } : { name: a.name, error: 'profile unavailable' }
    ),
  };
}

// ── Stage 1: Pattern detection via Claude Pro ─────────────────────────────────

async function detectPatterns(ctx, actorIndex, foiaSummary, flagSummary, eventSummary, actorProfiles) {
  const { cases, stackNotes, scenarioNotes, pressureNotes, researchNotes, verificationNotes } = ctx;
  const systemPrompt = loadAgentPrompt();

  // Compact actor profiles for payload
  const compactProfiles = {
    judges: (actorProfiles.judges ?? []).filter(p => !p.error).map(p => ({
      name:                    p.name ?? p.full_name,
      risk_score:              p.risk_score,
      risk_level:              p.risk_level,
      risk_factors:            (p.risk_factors ?? []).slice(0, 4),
      continuation_rate:       p.delay_patterns?.continuation_rate ?? null,
      hearing_completion_rate: p.motion_tendencies?.hearing_completion_rate ?? null,
      judicial_conduct_flags:  p.behavior_profile?.by_flag_type?.judicial_conduct ?? 0,
      case_count:              p.case_count,
    })),
    prosecutors: (actorProfiles.prosecutors ?? []).filter(p => !p.error).map(p => ({
      name:               p.name ?? p.full_name,
      risk_score:         p.risk_score,
      risk_level:         p.risk_level,
      risk_factors:       (p.risk_factors ?? []).slice(0, 4),
      brady_flags:        p.behavior_profile?.by_flag_type?.brady ?? 0,
      foia_overdue:       p.filing_patterns?.foia_overdue ?? 0,
      foia_response_rate: p.filing_patterns?.foia_response_rate ?? null,
      case_count:         p.case_count,
    })),
  };

  // Group module notes by case for compact presentation
  function groupNotes(notes, charLimit) {
    return notes.map(n => ({
      case_id: n.case_id,
      title:   n.title,
      excerpt: (n.body ?? '').slice(0, charLimit),
    }));
  }

  const payload = {
    cases: cases.map(c => ({
      id:         c.id,
      state:      c.state,
      county:     c.county,
      status:     c.status,
      filed_date: c.filed_date,
    })),
    actor_index:    actorIndex.slice(0, 15), // top 15 for token budget
    flag_summary:   flagSummary,
    event_summary:  eventSummary,
    foia_summary:   foiaSummary,
    actor_profiles: compactProfiles,
    module_notes: {
      defense_stack: groupNotes(stackNotes,    2000),
      pressure_map:  groupNotes(pressureNotes, 1500),
      scenario:      groupNotes(scenarioNotes,  500),
      research:      groupNotes(researchNotes,  400),
      verification:  groupNotes(verificationNotes, 400),
    },
  };

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 5000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(payload) }],
  });

  let data = { pattern_analysis: null };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.pattern_analysis ?? null;
}

// ── Stage 2: JS scoring ───────────────────────────────────────────────────────

function scorePatterns(pa, { actorIndex, flagSummary }) {
  if (!pa) return pa;

  // Score repeated_actors by case_count × severity weight
  if (pa.repeated_actors?.length) {
    const severityWeight = { critical: 4, high: 3, medium: 2, low: 1, unknown: 1 };
    pa.repeated_actors = pa.repeated_actors.map(ra => {
      // Find matching actor in index for factual case_count
      const indexed = actorIndex.find(a =>
        a.name?.toLowerCase() === ra.actor_name?.toLowerCase()
      );
      const caseCount = indexed?.case_count ?? ra.case_count ?? 1;
      const flagCount = indexed?.flag_count ?? ra.flag_count ?? 0;
      const topSeverity = Object.entries(indexed?.flags_by_severity ?? {})
        .sort((a, b) => (severityWeight[b[0]] ?? 1) - (severityWeight[a[0]] ?? 1))[0]?.[0] ?? 'low';

      return {
        ...ra,
        case_count:     caseCount,
        flag_count:     flagCount,
        pattern_score:  Math.min(100, (caseCount * 20) + (flagCount * 5) + (severityWeight[topSeverity] ?? 1) * 5),
      };
    }).sort((a, b) => b.pattern_score - a.pattern_score);
  }

  // Score systemic_patterns by frequency × flag density
  if (pa.systemic_patterns?.length) {
    pa.systemic_patterns = pa.systemic_patterns.map(sp => ({
      ...sp,
      pattern_score: Math.min(100,
        (sp.cases_affected?.length ?? 1) * 25 +
        (flagSummary.open_critical ?? 0) * 5 +
        (sp.actionability === 'high' ? 20 : sp.actionability === 'medium' ? 10 : 3)
      ),
    })).sort((a, b) => b.pattern_score - a.pattern_score);
  }

  return pa;
}

// ── Note builder ──────────────────────────────────────────────────────────────

function buildPatternNote(pa, cases) {
  if (!pa) return '*Pattern analysis failed — insufficient cross-case data.*';

  const date   = new Date().toLocaleDateString('en-US');
  const states = [...new Set(cases.map(c => c.state).filter(Boolean))].join('/');
  const lines  = [
    `# Multi-Case Pattern Analysis — ${states} — ${date}`,
    `**Cases analyzed:** ${cases.length} | **States:** ${states}`,
    `**Repeated actors:** ${pa.repeated_actors?.length ?? 0}` +
    ` | **Systemic patterns:** ${pa.systemic_patterns?.length ?? 0}` +
    ` | **Cross-module insights:** ${pa.cross_module_insights?.length ?? 0}`,
    '',
  ];

  if (pa.summary) lines.push(pa.summary, '');

  // ── Priority findings ───────────────────────────────────────────────────────
  if (pa.priority_findings?.length) {
    lines.push('## Priority Findings');
    pa.priority_findings.forEach(f => {
      lines.push(
        `### [${f.rank}] ${f.finding} — ${(f.urgency ?? '?').toUpperCase()}`,
        f.legal_basis ? `**Legal basis:** ${f.legal_basis}` : '',
        f.recommended_action ? `**Action:** ${f.recommended_action}` : '',
        '',
      );
      if (f.evidence?.length) {
        lines.push('**Evidence:**');
        f.evidence.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }
    });
  }

  // ── Cross-module insights ───────────────────────────────────────────────────
  if (pa.cross_module_insights?.length) {
    lines.push('## Cross-Module Insights (Modules M–Q)');
    pa.cross_module_insights.forEach(cmi => {
      lines.push(
        `### ${cmi.title} — ${cmi.convergence_type ?? '?'}`,
        `**Modules:** ${(cmi.source_modules ?? []).join(', ')} | **Confidence:** ${cmi.confidence ?? '?'} | **Actionability:** ${cmi.actionability ?? '?'}`,
        cmi.description ?? '',
        cmi.recommended_action ? `**Action:** ${cmi.recommended_action}` : '',
        '',
      );
    });
  }

  // ── Repeated actors ─────────────────────────────────────────────────────────
  if (pa.repeated_actors?.length) {
    lines.push('## Repeated Actors');
    pa.repeated_actors.forEach(ra => {
      lines.push(
        `### ${ra.actor_name} (${ra.role ?? '?'}) — score ${ra.pattern_score ?? '?'}/100`,
        `**Cases:** ${ra.case_count} | **Flags:** ${ra.flag_count} | **States:** ${(ra.states ?? []).join(', ')}`,
        `**Pattern:** \`${ra.pattern_type ?? '?'}\` | **Severity:** ${ra.severity_level ?? '?'} | **Actionability:** ${ra.actionability ?? '?'}`,
        ra.pattern_description ?? '',
        ra.legal_basis ? `**Legal basis:** ${ra.legal_basis}` : '',
        ra.recommended_action ? `**Action:** ${ra.recommended_action}` : '',
        '',
      );
    });
  }

  // ── Systemic patterns ───────────────────────────────────────────────────────
  if (pa.systemic_patterns?.length) {
    lines.push('## Systemic Patterns');
    pa.systemic_patterns.forEach(sp => {
      lines.push(
        `### ${sp.title} — score ${sp.pattern_score ?? '?'}/100`,
        `**Type:** \`${sp.pattern_type ?? '?'}\` | **Cases:** ${sp.cases_affected?.length ?? 0} | **States:** ${(sp.states_affected ?? []).join(', ')}`,
        `**Frequency:** ${sp.frequency ?? '?'} | **Actionability:** ${sp.actionability ?? '?'}`,
        sp.legal_theory ? `**Legal theory:** ${sp.legal_theory}` : '',
        sp.recommended_filing ? `**Filing:** ${sp.recommended_filing}` : '',
        '',
      );
      if (sp.evidence_basis?.length) {
        lines.push('**Evidence:**');
        sp.evidence_basis.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }
    });
  }

  // ── FOIA patterns ───────────────────────────────────────────────────────────
  if (pa.foia_patterns) {
    const fp = pa.foia_patterns;
    lines.push(
      '## FOIA Pattern Analysis',
      `**Total:** ${fp.total_requests ?? 0} | **Overdue:** ${fp.overdue_count ?? 0} | **Denied:** ${fp.denied_count ?? 0} | **Response rate:** ${fp.response_rate != null ? `${Math.round(fp.response_rate * 100)}%` : '?'}`,
      `**Classification:** \`${fp.pattern_classification ?? '?'}\``,
      fp.brady_implication ? `**Brady implication:** ${fp.brady_implication}` : '',
      fp.recommended_action ? `**Action:** ${fp.recommended_action}` : '',
      '',
    );
    if (fp.worst_offenders?.length) {
      lines.push('**Worst offenders:**');
      fp.worst_offenders.forEach(o =>
        lines.push(`- ${o.agency} (${o.state}): ${o.overdue} overdue, ${o.denied} denied / ${o.total} total`)
      );
      lines.push('');
    }
  }

  // ── Prosecutorial / judicial trends ────────────────────────────────────────
  const pt = pa.prosecutorial_trends;
  const jt = pa.judicial_trends;
  if (pt?.actor_name || jt?.actor_name) {
    lines.push('## Actor Behavior Trends');
    if (pt?.actor_name) {
      lines.push(
        `### Prosecutor: ${pt.actor_name} (${pt.organization ?? '?'}) — risk ${pt.risk_score ?? '?'}/100`,
        `**Trend:** ${pt.trend_direction ?? '?'} | **Cases with violations:** ${pt.cases_with_violations ?? 0}`,
        pt.brady_pattern         ? `**Brady pattern:** ${pt.brady_pattern}` : '',
        pt.foia_compliance_trend ? `**FOIA trend:** ${pt.foia_compliance_trend}` : '',
        pt.recommended_strategy  ? `**Strategy:** ${pt.recommended_strategy}` : '',
        '',
      );
    }
    if (jt?.actor_name) {
      lines.push(
        `### Judge: ${jt.actor_name} (${jt.organization ?? '?'}) — risk ${jt.risk_score ?? '?'}/100`,
        `**Trend:** ${jt.trend_direction ?? '?'} | **Cases with adverse rulings:** ${jt.cases_with_adverse_rulings ?? 0}`,
        jt.delay_pattern              ? `**Delay pattern:** ${jt.delay_pattern}` : '',
        jt.hearing_completion_trend   ? `**Hearing completion:** ${jt.hearing_completion_trend}` : '',
        jt.recommended_strategy       ? `**Strategy:** ${jt.recommended_strategy}` : '',
        '',
      );
    }
  }

  // ── Facility patterns ───────────────────────────────────────────────────────
  if (pa.facility_patterns?.length) {
    lines.push('## Facility Patterns');
    pa.facility_patterns.forEach(fp => {
      lines.push(
        `### ${fp.facility_name} (${fp.state ?? '?'})`,
        `**Cases:** ${fp.case_count ?? 0} | **Adverse events:** ${fp.adverse_event_count ?? 0} | **Actionability:** ${fp.actionability ?? '?'}`,
        fp.pattern_description ?? '',
        fp.recommended_action ? `**Action:** ${fp.recommended_action}` : '',
        '',
      );
      if (fp.issues?.length) {
        fp.issues.forEach(i => lines.push(`- ${i}`));
        lines.push('');
      }
    });
  }

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runPatternAnalysis({ person_id, case_ids }) {
  const ctx = await fetchPatternContext(case_ids);

  // Build JS aggregations in parallel with actor profile resolution
  const actorIndex    = buildActorIndex(ctx.people, ctx.flags, ctx.events);
  const foiaSummary   = buildFoiaSummary(ctx.foia);
  const flagSummary   = buildFlagSummary(ctx.flags, case_ids);
  const eventSummary  = buildEventSummary(ctx.events);
  const actorProfiles = await resolveTopActorProfiles(actorIndex);

  const raw          = await detectPatterns(ctx, actorIndex, foiaSummary, flagSummary, eventSummary, actorProfiles);
  const patternAnalysis = scorePatterns(raw, { actorIndex, flagSummary });

  if (!patternAnalysis) {
    return { error: 'Pattern analysis failed — insufficient cross-case data' };
  }

  await createNote({
    person_id,
    note_type: 'strategy',
    title:     `Pattern Analysis — ${[...new Set(ctx.cases.map(c => c.state).filter(Boolean))].join('/')} — ${new Date().toLocaleDateString('en-US')}`,
    body:      buildPatternNote(patternAnalysis, ctx.cases),
    author:    'pattern_engine',
  });

  return {
    workflow:         'multi_case_pattern_analysis',
    person_id,
    case_ids,
    generated_at:     new Date().toISOString(),
    states_analyzed:  [...new Set(ctx.cases.map(c => c.state).filter(Boolean))],
    pattern_analysis: patternAnalysis,
    actor_profiles:   actorProfiles,
    summary: {
      repeated_actors:      patternAnalysis.repeated_actors?.length      ?? 0,
      systemic_patterns:    patternAnalysis.systemic_patterns?.length     ?? 0,
      cross_module_insights: patternAnalysis.cross_module_insights?.length ?? 0,
      priority_findings:    patternAnalysis.priority_findings?.length     ?? 0,
      foia_overdue:         foiaSummary.overdue,
      foia_response_rate:   foiaSummary.response_rate,
      open_critical_flags:  flagSummary.open_critical,
      top_actors:           (patternAnalysis.repeated_actors ?? []).slice(0, 3).map(a => ({
        name:    a.actor_name,
        role:    a.role,
        cases:   a.case_count,
        pattern: a.pattern_type,
        score:   a.pattern_score,
      })),
      top_systemic_pattern: (patternAnalysis.systemic_patterns ?? [])[0]
        ? { title: patternAnalysis.systemic_patterns[0].title, type: patternAnalysis.systemic_patterns[0].pattern_type, score: patternAnalysis.systemic_patterns[0].pattern_score }
        : null,
    },
  };
}

export async function getLatestPatternAnalysis(person_id) {
  const { data } = await supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('person_id', person_id)
    .eq('author', 'pattern_engine')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
