import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO = 'claude-sonnet-4-6';

const SPEEDY_LIMITS = {
  TX: { days: 180, statute: 'Tex. Code Crim. Proc. Art. 32A.02' },
  IL: { days: 120, statute: 'Ill. Sup. Ct. R. 103(b)' },
  MO: { days: 180, statute: 'Mo. R. Crim. P. 33.01' },
};

const PROSECUTOR_ROLES = new Set([
  'prosecutor', 'district_attorney', 'state_attorney', 'ada', 'assistant_district_attorney',
]);

function loadAgentPrompt() {
  try {
    return readFileSync(resolve('./agents/pressure_map_agent.md'), 'utf-8');
  } catch {
    return 'You are the Pressure Map Engine. Identify leverage points and pressure strategies as JSON.';
  }
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function fetchPressureContext(case_id) {
  const [
    { data: caseRow },
    { data: flags },
    { data: events },
    { data: foia },
    { data: people },
    { data: stackNotes },
    { data: scenarioNotes },
    { data: researchNotes },
    { data: verificationNotes },
  ] = await Promise.all([
    supabase.from('cases').select('*').eq('id', case_id).single(),
    supabase.from('flags').select('*').eq('case_id', case_id).order('severity'),
    supabase.from('events').select('*').eq('case_id', case_id).order('event_date'),
    supabase.from('foia_requests').select('*').eq('case_id', case_id),
    supabase.from('people').select('id, full_name, role, organization').eq('case_id', case_id),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('author', 'defense_stack')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('author', 'scenario_engine')
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('note_type', 'research')
      .eq('author', 'research_agent')
      .order('created_at', { ascending: false })
      .limit(3),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('note_type', 'observation')
      .eq('author', 'verification_agent')
      .order('created_at', { ascending: false })
      .limit(3),
  ]);

  return {
    caseRow:           caseRow ?? {},
    flags:             flags   ?? [],
    events:            events  ?? [],
    foia:              foia    ?? [],
    people:            people  ?? [],
    stackNotes:        stackNotes        ?? [],
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
      ? { name: judge.full_name, ...judgeModel }
      : null,
    prosecutor: (prosecutorModel && !prosecutorModel.error)
      ? { name: prosecutor.full_name, ...prosecutorModel }
      : null,
  };
}

// ── Stage 1: Pressure map generation via Claude Pro ──────────────────────────

async function generatePressureMap(ctx, actorModels) {
  const { caseRow, flags, events, foia, stackNotes, scenarioNotes, researchNotes, verificationNotes } = ctx;
  const systemPrompt = loadAgentPrompt();

  const daysSince   = caseRow.filed_date
    ? Math.floor((Date.now() - new Date(caseRow.filed_date).getTime()) / 86_400_000)
    : null;
  const speedyLimit = SPEEDY_LIMITS[caseRow.state];

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
    case: {
      id:                 caseRow.id,
      state:              caseRow.state,
      county:             caseRow.county,
      status:             caseRow.status,
      filed_date:         caseRow.filed_date,
      days_since_filing:  daysSince,
      speedy_limit_days:  speedyLimit?.days ?? null,
      speedy_statute:     speedyLimit?.statute ?? null,
      pct_speedy_elapsed: daysSince && speedyLimit
        ? parseFloat((daysSince / speedyLimit.days).toFixed(3))
        : null,
    },
    flags: flags.map(f => ({
      type: f.flag_type, violation: f.violation_type,
      severity: f.severity, title: f.title,
      description: f.description, status: f.status,
    })),
    events: events.map(e => ({
      type: e.event_type, title: e.title, date: e.event_date,
      status: e.status, is_critical: e.is_critical, deadline_date: e.deadline_date,
    })),
    foia: foia.map(r => ({
      agency: r.agency, state: r.state, status: r.status, due_date: r.due_date,
    })),
    defense_stack_excerpt: stackNotes[0]?.body?.slice(0, 2500) ?? null,
    scenario_excerpts:     scenarioNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 500) })),
    verified_research:     researchNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
    verified_facts:        verificationNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
    behavioral_models:     Object.keys(behavioralModels).length ? behavioralModels : null,
  };

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 5000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(payload) }],
  });

  let data = { pressure_map: null };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.pressure_map ?? null;
}

// ── Stage 2: JS scoring of leverage points ────────────────────────────────────

function clampScore(v) {
  return Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
}

function scoreLeveragePoints(pressureMap, { flags, caseRow, actorModels }) {
  if (!pressureMap?.leverage_points?.length) return pressureMap;

  const judgeRisk      = actorModels?.judge?.risk_score      ?? 0;
  const prosecutorRisk = actorModels?.prosecutor?.risk_score ?? 0;
  const foiaOverdue    = actorModels?.prosecutor?.filing_patterns?.foia_overdue  ?? 0;
  const bradyFlags     = actorModels?.prosecutor?.behavior_profile?.by_flag_type?.brady ?? 0;
  const contRate       = actorModels?.judge?.delay_patterns?.continuation_rate ?? 0;

  const filedMs     = caseRow.filed_date ? new Date(caseRow.filed_date).getTime() : null;
  const daysSince   = filedMs ? Math.floor((Date.now() - filedMs) / 86_400_000) : 0;
  const speedyLimit = SPEEDY_LIMITS[caseRow.state]?.days ?? 180;
  const pctElapsed  = daysSince / speedyLimit;

  const openCritical = flags.filter(f => f.status === 'open' && f.severity === 'critical').length;
  const openBrady    = flags.filter(f => f.status === 'open' && f.flag_type === 'brady').length;

  pressureMap.leverage_points = pressureMap.leverage_points.map(lp => {
    let score = clampScore(lp.pressure_score ?? 50);

    // Actor vulnerability adjustments
    if (lp.target_actor === 'judge') {
      if (judgeRisk >= 76) score += 15;
      else if (judgeRisk >= 51) score += 10;
      if (contRate >= 0.3) score += 5;
    }
    if (lp.target_actor === 'prosecutor') {
      if (prosecutorRisk >= 76) score += 15;
      else if (prosecutorRisk >= 51) score += 10;
      if (foiaOverdue > 0) score += Math.min(foiaOverdue * 2, 10);
      if (bradyFlags > 0) score += Math.min(bradyFlags * 3, 9);
    }

    // Speedy trial urgency
    const isSpeedyLinked =
      String(lp.leverage_id ?? '').includes('speedy') ||
      (lp.linked_theories ?? []).some(t => String(t).includes('speedy'));
    if (isSpeedyLinked) {
      if (pctElapsed >= 1.0)  score += 25;
      else if (pctElapsed >= 0.9)  score += 18;
      else if (pctElapsed >= 0.75) score += 10;
    }

    // Open critical / Brady flags raise all leverage scores
    score += Math.min(openCritical * 2, 8);
    if (lp.type === 'legal' || lp.type === 'escalation_threat') {
      score += Math.min(openBrady * 3, 6);
    }

    return { ...lp, pressure_score: clampScore(score) };
  }).sort((a, b) => b.pressure_score - a.pressure_score);

  // Sort timing_synergies by amplification_score descending
  if (pressureMap.timing_synergies?.length) {
    pressureMap.timing_synergies = pressureMap.timing_synergies
      .map(ts => ({ ...ts, amplification_score: clampScore(ts.amplification_score ?? 50) }))
      .sort((a, b) => b.amplification_score - a.amplification_score);
  }

  return pressureMap;
}

// ── Note builder ──────────────────────────────────────────────────────────────

function buildPressureNote(pm, actorModels, caseRow) {
  if (!pm) return '*Pressure map failed — insufficient case data.*';

  const date  = new Date().toLocaleDateString('en-US');
  const state = caseRow.state ?? 'Multi-state';
  const lines = [
    `# Pressure Map — ${state} — ${date}`,
    `**Case:** ${caseRow.title ?? caseRow.id ?? 'Unknown'} | **Status:** ${caseRow.status ?? '?'}`,
    `**Leverage points:** ${pm.leverage_points?.length ?? 0}` +
    ` | **Escalation paths:** ${pm.escalation_paths?.length ?? 0}` +
    ` | **Timing synergies:** ${pm.timing_synergies?.length ?? 0}` +
    ` | **Systemic vulns:** ${pm.systemic_vulnerabilities?.length ?? 0}`,
    '',
  ];

  if (pm.summary) lines.push(pm.summary, '');

  // ── Priority actions ────────────────────────────────────────────────────────
  if (pm.priority_actions?.length) {
    lines.push('## Priority Actions');
    pm.priority_actions.forEach(a => {
      lines.push(
        `### [${a.rank}] ${a.action}`,
        a.rationale ?? '',
        a.deadline ? `**Deadline:** ${a.deadline}` : '',
        a.linked_leverage_ids?.length
          ? `**Leverage:** ${a.linked_leverage_ids.join(', ')}` : '',
        '',
      );
    });
  }

  // ── Actor pressure strategies ───────────────────────────────────────────────
  const aps = pm.actor_pressure_strategies ?? {};
  if (aps.judge || aps.prosecutor) {
    lines.push('## Actor Pressure Strategies');
    if (aps.judge) {
      const j = aps.judge;
      lines.push(
        `### Judge: ${j.actor_name ?? actorModels?.judge?.name ?? 'Unknown'}` +
        ` — risk ${actorModels?.judge?.risk_score ?? '?'}/100 (${actorModels?.judge?.risk_level ?? '?'})`,
        `**Strategy:** \`${j.strategy_type ?? '?'}\` | **Ceiling:** ${j.escalation_ceiling ?? '?'}`,
        `**Timing:** ${j.timing ?? '?'}`,
        '',
        j.primary_pressure ?? '',
        '',
      );
      if (j.behavioral_triggers?.length) {
        lines.push('**Behavioral triggers:**');
        j.behavioral_triggers.forEach(t => lines.push(`- ${t}`));
      }
      if (j.recommended_actions?.length) {
        lines.push('**Recommended actions:**');
        j.recommended_actions.forEach(a => lines.push(`- ${a}`));
      }
      lines.push('');
    }
    if (aps.prosecutor) {
      const p = aps.prosecutor;
      lines.push(
        `### Prosecutor: ${p.actor_name ?? actorModels?.prosecutor?.name ?? 'Unknown'}` +
        ` — risk ${actorModels?.prosecutor?.risk_score ?? '?'}/100 (${actorModels?.prosecutor?.risk_level ?? '?'})`,
        `**Strategy:** \`${p.strategy_type ?? '?'}\` | **Ceiling:** ${p.escalation_ceiling ?? '?'}`,
        `**Timing:** ${p.timing ?? '?'}`,
        '',
        p.primary_pressure ?? '',
        '',
      );
      if (p.behavioral_triggers?.length) {
        lines.push('**Behavioral triggers:**');
        p.behavioral_triggers.forEach(t => lines.push(`- ${t}`));
      }
      if (p.recommended_actions?.length) {
        lines.push('**Recommended actions:**');
        p.recommended_actions.forEach(a => lines.push(`- ${a}`));
      }
      lines.push('');
    }
  }

  // ── Timing synergies ────────────────────────────────────────────────────────
  if (pm.timing_synergies?.length) {
    lines.push('## Timing Synergies');
    pm.timing_synergies.forEach(ts => {
      lines.push(
        `### ${ts.title} (amplification: ${ts.amplification_score ?? '?'}/100)`,
        ts.combined_effect ?? '',
        `**Actions:** ${(ts.actions ?? []).join(' ＋ ')}`,
        ts.optimal_window ? `**Window:** ${ts.optimal_window}` : '',
        '',
      );
    });
  }

  // ── Leverage points ─────────────────────────────────────────────────────────
  if (pm.leverage_points?.length) {
    lines.push('## Leverage Points');
    pm.leverage_points.forEach(lp => {
      lines.push(
        `### [${lp.pressure_score ?? '?'}/100] ${lp.title}`,
        `**Type:** \`${lp.type ?? '?'}\` | **Target:** ${lp.target_actor ?? '?'}`,
        lp.description ?? '',
        '',
      );
      if (lp.vulnerability_basis?.length) {
        lines.push('**Vulnerability basis:**');
        lp.vulnerability_basis.forEach(b => lines.push(`- ${b}`));
      }
      if (lp.behavioral_basis) lines.push(`**Behavioral:** ${lp.behavioral_basis}`);
      if (lp.action_triggers?.length) {
        lines.push('**Activates via:**');
        lp.action_triggers.forEach(t => lines.push(`- ${t}`));
      }
      if (lp.linked_theories?.length)
        lines.push(`**Linked theories:** ${lp.linked_theories.join(', ')}`);
      if (lp.linked_scenarios?.length)
        lines.push(`**Linked scenarios:** ${lp.linked_scenarios.join(', ')}`);
      lines.push('', '---', '');
    });
  }

  // ── Escalation paths ────────────────────────────────────────────────────────
  if (pm.escalation_paths?.length) {
    lines.push('## Escalation Paths');
    pm.escalation_paths.forEach(ep => {
      lines.push(`### ${ep.title ?? ep.path_id} → ${ep.target ?? '?'}`);
      (ep.steps ?? []).forEach(s => {
        lines.push(
          `**Step ${s.step}:** ${s.action}`,
          `  Triggers: ${s.triggers ?? '?'}`,
          `  If no response: ${s.escalation_if_no_response ?? '?'}`,
          `  Timing: ${s.timing ?? '?'}`,
          '',
        );
      });
    });
  }

  // ── Systemic vulnerabilities ────────────────────────────────────────────────
  if (pm.systemic_vulnerabilities?.length) {
    lines.push('## Systemic Vulnerabilities');
    pm.systemic_vulnerabilities.forEach(sv => {
      lines.push(
        `### ${sv.title}`,
        `**States:** ${(sv.states_affected ?? []).join(', ')}`,
        sv.description ?? '',
        sv.exploitation_method ? `**Exploit:** ${sv.exploitation_method}` : '',
        sv.risk_to_defense    ? `**Risk:** ${sv.risk_to_defense}`          : '',
        '',
      );
      if (sv.evidence_basis?.length) {
        lines.push('**Evidence basis:**');
        sv.evidence_basis.forEach(b => lines.push(`- ${b}`));
        lines.push('');
      }
    });
  }

  // ── Cross-case patterns ─────────────────────────────────────────────────────
  if (pm.cross_case_patterns?.length) {
    lines.push('## Cross-Case Pressure Patterns');
    pm.cross_case_patterns.forEach(cp => {
      lines.push(
        `### ${cp.title}`,
        `**States:** ${(cp.states_involved ?? []).join(', ')}`,
        cp.description ?? '',
        cp.unified_pressure_theory ? `**Unified theory:** ${cp.unified_pressure_theory}` : '',
        cp.leverage_amplification  ? `**Amplification:** ${cp.leverage_amplification}`   : '',
        cp.exploitation_strategy   ? `**Strategy:** ${cp.exploitation_strategy}`         : '',
        '',
      );
    });
  }

  return lines.join('\n');
}

// ── Cross-case synthesis ──────────────────────────────────────────────────────

async function synthesizeCrossCasePatterns(perCaseResults) {
  const valid = perCaseResults.filter(r => !r.error && r.pressure_map);
  if (!valid.length) return { cross_case_patterns: [], unified_priority_actions: [] };

  const system = `You are the Pressure Map cross-case synthesis engine for B.R.O. Advocacy.
Given pressure maps from multiple states (TX, IL, MO), identify unified cross-state pressure
patterns that are more powerful than any single-state issue.

Output ONLY valid JSON:
{
  "cross_case_patterns": [
    {
      "pattern_id": "ccp_short_id",
      "title": "Pattern title",
      "states_involved": ["TX", "IL", "MO"],
      "description": "What makes this a cross-case pattern rather than a single-state issue",
      "exploitation_strategy": "How to use this pattern across all affected states simultaneously",
      "unified_pressure_theory": "Single legal theory that ties all states together",
      "leverage_amplification": "How filing in one state amplifies pressure in the others"
    }
  ],
  "unified_priority_actions": [
    {
      "rank": 1,
      "action": "Specific multi-state action",
      "states": ["TX", "IL"],
      "rationale": "Why this is the top cross-state priority",
      "timing": "When to execute"
    }
  ]
}`;

  const summaries = valid.map(r => ({
    case_id:       r.case_id,
    case_state:    r.case_state,
    top_leverage:  (r.pressure_map.leverage_points ?? []).slice(0, 5).map(lp => ({
      id: lp.leverage_id, title: lp.title, score: lp.pressure_score, target: lp.target_actor,
    })),
    existing_cross_case: r.pressure_map.cross_case_patterns ?? [],
    priority_actions:    (r.pressure_map.priority_actions ?? []).slice(0, 3),
    systemic_vulns:      (r.pressure_map.systemic_vulnerabilities ?? []).map(sv => sv.title),
  }));

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 2000,
    system,
    messages:   [{ role: 'user', content: JSON.stringify({ per_case: summaries }) }],
  });

  let data = { cross_case_patterns: [], unified_priority_actions: [] };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runPressureMap({ case_id }) {
  const ctx         = await fetchPressureContext(case_id);
  const actorModels = await fetchActorModels(ctx.people);

  const raw         = await generatePressureMap(ctx, actorModels);
  const pressureMap = scoreLeveragePoints(raw, {
    flags:       ctx.flags,
    caseRow:     ctx.caseRow,
    actorModels,
  });

  if (!pressureMap) {
    return { error: 'Pressure map generation failed — insufficient case data' };
  }

  await createNote({
    case_id,
    note_type: 'strategy',
    title:     `Pressure Map — ${ctx.caseRow.state ?? 'multi'} — ${new Date().toLocaleDateString('en-US')}`,
    body:      buildPressureNote(pressureMap, actorModels, ctx.caseRow),
    author:    'pressure_map',
  });

  const topLeverage = (pressureMap.leverage_points ?? []).slice(0, 3).map(lp => ({
    title: lp.title, score: lp.pressure_score, target: lp.target_actor, type: lp.type,
  }));

  return {
    workflow:     'pressure_map',
    case_id,
    generated_at: new Date().toISOString(),
    case_state:   ctx.caseRow.state,
    pressure_map: pressureMap,
    actor_models: actorModels,
    summary: {
      leverage_count:      pressureMap.leverage_points?.length          ?? 0,
      escalation_paths:    pressureMap.escalation_paths?.length         ?? 0,
      timing_synergies:    pressureMap.timing_synergies?.length         ?? 0,
      systemic_vulns:      pressureMap.systemic_vulnerabilities?.length ?? 0,
      cross_case_patterns: pressureMap.cross_case_patterns?.length      ?? 0,
      priority_actions:    pressureMap.priority_actions?.length         ?? 0,
      top_leverage:        topLeverage,
      judge_risk:      actorModels.judge
        ? { name: actorModels.judge.name,  risk_score: actorModels.judge.risk_score,  risk_level: actorModels.judge.risk_level }
        : null,
      prosecutor_risk: actorModels.prosecutor
        ? { name: actorModels.prosecutor.name, risk_score: actorModels.prosecutor.risk_score, risk_level: actorModels.prosecutor.risk_level }
        : null,
    },
  };
}

export async function runCrossCasePressureMap({ person_id, case_ids }) {
  const perCaseResults = await Promise.all(
    case_ids.map(id =>
      runPressureMap({ case_id: id })
        .catch(e => ({ case_id: id, error: e.message }))
    )
  );

  const synthesis = await synthesizeCrossCasePatterns(perCaseResults);

  const allLeverage = perCaseResults
    .filter(r => !r.error && r.pressure_map?.leverage_points?.length)
    .flatMap(r => r.pressure_map.leverage_points.map(lp => ({
      ...lp,
      source_case_id: r.case_id,
      source_state:   r.case_state,
    })))
    .sort((a, b) => b.pressure_score - a.pressure_score);

  const allPaths = perCaseResults
    .filter(r => !r.error && r.pressure_map?.escalation_paths?.length)
    .flatMap(r => r.pressure_map.escalation_paths.map(ep => ({
      ...ep,
      source_case_id: r.case_id,
      source_state:   r.case_state,
    })));

  return {
    workflow:                 'cross_case_pressure_map',
    person_id,
    case_ids,
    generated_at:             new Date().toISOString(),
    per_case:                 perCaseResults,
    unified_leverage_points:  allLeverage,
    unified_escalation_paths: allPaths,
    cross_case_patterns:      synthesis.cross_case_patterns      ?? [],
    unified_priority_actions: synthesis.unified_priority_actions ?? [],
    summary: {
      total_leverage_points: allLeverage.length,
      total_escalation_paths: allPaths.length,
      cross_case_patterns:   synthesis.cross_case_patterns?.length ?? 0,
      states_covered:        [...new Set(allLeverage.map(lp => lp.source_state).filter(Boolean))],
      top_unified_leverage:  allLeverage.slice(0, 5).map(lp => ({
        title: lp.title, score: lp.pressure_score, state: lp.source_state, target: lp.target_actor,
      })),
    },
  };
}

export async function getLatestPressureMap(case_id) {
  const { data } = await supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('case_id', case_id)
    .eq('author', 'pressure_map')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
