import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO = 'claude-sonnet-4-6';

export const SCENARIO_TYPES = [
  'motion_outcome',
  'what_if',
  'motion_timing',
  'actor_response',
  'plea_leverage',
  'multi_state_conflict',
];

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
    return readFileSync(resolve('./agents/scenario_agent.md'), 'utf-8');
  } catch {
    return 'You are the Scenario Simulation Engine. Model legal outcomes as JSON.';
  }
}

// ── Context fetch ─────────────────────────────────────────────────────────────

async function fetchScenarioContext(case_id) {
  const [
    { data: caseRow },
    { data: flags },
    { data: events },
    { data: foia },
    { data: people },
    { data: stackNotes },
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

// ── Stage 1: Simulation via Claude Pro ───────────────────────────────────────

async function simulate(ctx, actorModels, { scenario_type, parameters, what_if_question }) {
  const { caseRow, flags, events, foia, stackNotes, researchNotes, verificationNotes } = ctx;
  const systemPrompt = loadAgentPrompt();

  const daysSince = caseRow.filed_date
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
    scenario: {
      type:             scenario_type,
      what_if_question: what_if_question ?? null,
      parameters:       parameters ?? {},
    },
    case: {
      id:                  caseRow.id,
      state:               caseRow.state,
      county:              caseRow.county,
      status:              caseRow.status,
      filed_date:          caseRow.filed_date,
      days_since_filing:   daysSince,
      speedy_limit_days:   speedyLimit?.days ?? null,
      speedy_statute:      speedyLimit?.statute ?? null,
      pct_speedy_elapsed:  daysSince && speedyLimit
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
    defense_stack_excerpt: stackNotes[0]?.body?.slice(0, 2000) ?? null,
    verified_research:     researchNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
    verified_facts:        verificationNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 400) })),
    behavioral_models:     Object.keys(behavioralModels).length ? behavioralModels : null,
  };

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 4000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(payload) }],
  });

  let data = { simulation: null };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.simulation ?? null;
}

// ── Stage 2: Probability normalization ───────────────────────────────────────

function clamp(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : Math.min(1, Math.max(0, n));
}

function normalizeSimulation(sim) {
  if (!sim) return null;

  if (sim.probability_estimate) {
    const pe = sim.probability_estimate;
    pe.favorable = clamp(pe.favorable);
    pe.neutral   = clamp(pe.neutral);
    pe.adverse   = clamp(pe.adverse);
  }

  (sim.outcomes ?? []).forEach(o => { o.probability = clamp(o.probability); });

  if (sim.actor_responses?.judge?.probability != null)
    sim.actor_responses.judge.probability = clamp(sim.actor_responses.judge.probability);
  if (sim.actor_responses?.prosecutor?.probability != null)
    sim.actor_responses.prosecutor.probability = clamp(sim.actor_responses.prosecutor.probability);

  (sim.what_if_variants ?? []).forEach(v => { v.probability = clamp(v.probability); });

  return sim;
}

// ── Note builder ──────────────────────────────────────────────────────────────

function pct(v) {
  return v == null ? '?' : `${Math.round(v * 100)}%`;
}

function buildSimulationNote(sim, actorModels, caseRow, scenario_type, what_if_question) {
  const date  = new Date().toLocaleDateString('en-US');
  const state = caseRow.state ?? 'Multi-state';
  const lines = [
    `# Scenario Simulation — ${state} — ${date}`,
    `**Type:** \`${scenario_type}\` | **Case:** ${caseRow.title ?? caseRow.id ?? 'Unknown'}`,
  ];

  if (what_if_question) lines.push(`**Question:** ${what_if_question}`);
  lines.push('');

  if (!sim) {
    lines.push('*Simulation failed — insufficient case data.*');
    return lines.join('\n');
  }

  lines.push(`## ${sim.title ?? scenario_type}`);
  if (sim.summary) lines.push('', sim.summary, '');

  // Probability estimate
  if (sim.probability_estimate) {
    const pe = sim.probability_estimate;
    lines.push(
      '## Probability Estimate',
      `**Favorable:** ${pct(pe.favorable)} | **Neutral:** ${pct(pe.neutral)} | **Adverse:** ${pct(pe.adverse)}`,
      `**Confidence:** ${pe.confidence ?? '?'} — ${pe.confidence_basis ?? ''}`,
      '',
    );
  }

  // Actor responses
  const { judge, prosecutor } = sim.actor_responses ?? {};
  if (judge || prosecutor) {
    lines.push('## Predicted Actor Responses');
    if (judge) {
      lines.push(
        `**Judge** (${actorModels?.judge?.name ?? 'Unknown'} — risk ${actorModels?.judge?.risk_score ?? '?'}/100):`,
        `${judge.predicted_response ?? '?'} — \`${judge.response_type ?? '?'}\` (${pct(judge.probability)})`,
      );
      if (judge.behavioral_basis) lines.push(`> ${judge.behavioral_basis}`);
    }
    if (prosecutor) {
      lines.push(
        `**Prosecutor** (${actorModels?.prosecutor?.name ?? 'Unknown'} — risk ${actorModels?.prosecutor?.risk_score ?? '?'}/100):`,
        `${prosecutor.predicted_response ?? '?'} — \`${prosecutor.response_type ?? '?'}\` (${pct(prosecutor.probability)})`,
      );
      if (prosecutor.behavioral_basis) lines.push(`> ${prosecutor.behavioral_basis}`);
    }
    lines.push('');
  }

  // Timing analysis
  if (sim.timing_analysis) {
    const ta = sim.timing_analysis;
    lines.push(
      '## Timing Analysis',
      `**Window:** ${ta.optimal_window ?? '?'} | **Urgency:** ${(ta.urgency ?? '?').toUpperCase()}`,
    );
    if (ta.deadline_risks?.length) {
      lines.push('**Risks of delay:**');
      ta.deadline_risks.forEach(r => lines.push(`- ${r}`));
    }
    if (ta.timing_synergies?.length) {
      lines.push('**Synergies:**');
      ta.timing_synergies.forEach(s => lines.push(`- ${s}`));
    }
    lines.push('');
  }

  // Outcomes
  if (sim.outcomes?.length) {
    lines.push('## Modeled Outcomes');
    sim.outcomes.forEach(o => {
      lines.push(`### ${o.label} (${pct(o.probability)})`);
      if (o.trigger_conditions?.length)
        lines.push('**Triggers:** ' + o.trigger_conditions.join('; '));
      (o.downstream_effects ?? []).forEach(e => lines.push(`- ${e}`));
      if (o.next_actions?.length) {
        lines.push('**Next actions:**');
        o.next_actions.forEach(a => lines.push(`  - ${a}`));
      }
      lines.push('');
    });
  }

  // What-if variants
  if (sim.what_if_variants?.length) {
    lines.push('## What-If Variants');
    sim.what_if_variants.forEach(v => {
      lines.push(
        `### ${(v.variant ?? '?').toUpperCase()} (${pct(v.probability)})`,
        `**Assumption:** ${v.assumption ?? '?'}`,
        v.outcome ?? '',
        '',
      );
    });
  }

  // Stacking opportunities
  if (sim.stacking_opportunities?.length) {
    lines.push('## Defense Stack Interactions');
    sim.stacking_opportunities.forEach(s => lines.push(`- ${s}`));
    lines.push('');
  }

  // Recommendations
  if (sim.recommendations?.length) {
    lines.push('## Recommendations');
    sim.recommendations.forEach(r => lines.push(`- ${r}`));
    lines.push('');
  }

  // Warnings
  if (sim.warnings?.length) {
    lines.push('## Warnings');
    sim.warnings.forEach(w => lines.push(`- **[WARNING]** ${w}`));
  }

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runScenario({ case_id, scenario_type, parameters, what_if_question }) {
  if (!SCENARIO_TYPES.includes(scenario_type)) {
    return { error: `Unknown scenario_type. Valid: ${SCENARIO_TYPES.join(', ')}` };
  }

  const [ctx, ] = await Promise.all([fetchScenarioContext(case_id)]);
  const actorModels = await fetchActorModels(ctx.people);

  const raw        = await simulate(ctx, actorModels, { scenario_type, parameters, what_if_question });
  const simulation = normalizeSimulation(raw);

  if (!simulation) {
    return { error: 'Simulation failed — model returned no structured output' };
  }

  const noteTitle = `Scenario [${scenario_type}] — ${simulation.title ?? what_if_question ?? 'simulation'} — ${new Date().toLocaleDateString('en-US')}`;

  await createNote({
    case_id,
    note_type: 'strategy',
    title:     noteTitle.slice(0, 200),
    body:      buildSimulationNote(simulation, actorModels, ctx.caseRow, scenario_type, what_if_question),
    author:    'scenario_engine',
  });

  return {
    workflow:         'scenario_simulation',
    case_id,
    generated_at:     new Date().toISOString(),
    scenario_type,
    what_if_question: what_if_question ?? null,
    simulation,
    actor_models:     actorModels,
  };
}

export async function runWhatIf({ case_id, question }) {
  return runScenario({ case_id, scenario_type: 'what_if', what_if_question: question });
}

export async function runMotionTiming({ case_id, motion_type, theory_id }) {
  return runScenario({
    case_id,
    scenario_type: 'motion_timing',
    parameters:    { motion_type, theory_id },
  });
}

export async function predictActorResponse({ case_id, action_type, actor_type }) {
  return runScenario({
    case_id,
    scenario_type: 'actor_response',
    parameters:    { action_type, actor_type },
  });
}

export async function getLatestSimulation(case_id) {
  const { data } = await supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('case_id', case_id)
    .eq('author', 'scenario_engine')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
