import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { judgeProfile, prosecutorProfile } from './actor_profiles.js';
import { lookupCaseLaw } from './research_agent.js';
import { verifyStrategyOutput } from './verification_agent.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MODEL_PRO = 'claude-sonnet-4-6';

const SPEEDY_LIMITS = {
  TX: { days: 180, statute: 'Tex. Code Crim. Proc. Art. 32A.02' },
  IL: { days: 120, statute: 'Ill. Sup. Ct. R. 103(b)' },
  MO: { days: 180, statute: 'Mo. R. Crim. P. 33.01' },
};

// Sequencing priority — lower number = file earlier
const SEQUENCE_PRIORITY = {
  speedy_trial:             1,
  jurisdiction_conflict:    2,
  detainer_conflict:        3,
  brady_violation:          4,
  fta_wrongful:             5,
  suppression:              6,
  evidentiary_challenge:    7,
  due_process:              8,
  constitutional_violation: 9,
  judicial_misconduct:      10,
  prosecutorial_misconduct: 11,
  ineffective_counsel:      12,
};

function loadAgentPrompt() {
  try {
    return readFileSync(resolve('./agents/defense_stack_agent.md'), 'utf-8');
  } catch {
    return 'You are the Defense Stack Engine. Generate all viable defense theories as JSON.';
  }
}

// ── Full case context fetch ───────────────────────────────────────────────────

async function fetchStackContext(case_id) {
  const [
    { data: caseRow },
    { data: flags },
    { data: events },
    { data: docs },
    { data: foia },
    { data: people },
    { data: researchNotes },
    { data: verificationNotes },
  ] = await Promise.all([
    supabase.from('cases').select('*').eq('id', case_id).single(),
    supabase.from('flags').select('*').eq('case_id', case_id).order('severity'),
    supabase.from('events').select('*').eq('case_id', case_id).order('event_date'),
    supabase.from('documents')
      .select('id, title, doc_type, source_system, is_brady, summary, filed_date')
      .eq('case_id', case_id).order('created_at', { ascending: false }).limit(20),
    supabase.from('foia_requests').select('*').eq('case_id', case_id),
    supabase.from('people').select('id, full_name, role, organization').eq('case_id', case_id),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('note_type', 'research')
      .eq('author', 'research_agent')
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('notes')
      .select('title, body')
      .eq('case_id', case_id)
      .eq('note_type', 'observation')
      .eq('author', 'verification_agent')
      .order('created_at', { ascending: false }).limit(3),
  ]);

  return {
    caseRow:           caseRow ?? {},
    flags:             flags   ?? [],
    events:            events  ?? [],
    docs:              docs    ?? [],
    foia:              foia    ?? [],
    people:            people  ?? [],
    researchNotes:     researchNotes     ?? [],
    verificationNotes: verificationNotes ?? [],
  };
}

// ── Actor behavioral model fetch ──────────────────────────────────────────────

const PROSECUTOR_ROLES = new Set(['prosecutor', 'district_attorney', 'state_attorney', 'ada', 'assistant_district_attorney']);

async function fetchActorModels(people) {
  const judge      = people.find(p => p.role === 'judge');
  const prosecutor = people.find(p => PROSECUTOR_ROLES.has(p.role?.toLowerCase()));

  const [judgeModel, prosecutorModel] = await Promise.all([
    judge      ? judgeProfile(judge.id).catch(() => null)           : Promise.resolve(null),
    prosecutor ? prosecutorProfile(prosecutor.id).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    judge:      (judgeModel && !judgeModel.error)
      ? { name: judge.full_name, ...judgeModel }
      : null,
    prosecutor: (prosecutorModel && !prosecutorModel.error)
      ? { name: prosecutor.full_name, ...prosecutorModel }
      : null,
  };
}

// ── Stage 1: Theory generation ───────────────────────────────────────────────

async function generateTheories(ctx, actorModels) {
  const { caseRow, flags, events, docs, foia, people, researchNotes, verificationNotes } = ctx;
  const systemPrompt = loadAgentPrompt();

  const behavioralModels = {};

  if (actorModels?.judge) {
    const j = actorModels.judge;
    behavioralModels.judge = {
      name:                    j.name ?? j.full_name,
      risk_score:              j.risk_score,
      risk_level:              j.risk_level,
      risk_factors:            j.risk_factors ?? [],
      continuation_rate:       j.delay_patterns?.continuation_rate ?? null,
      missed_events:           j.delay_patterns?.missed_events ?? null,
      hearing_completion_rate: j.motion_tendencies?.hearing_completion_rate ?? null,
      hearing_miss_rate:       j.motion_tendencies?.hearing_miss_rate ?? null,
      judicial_conduct_flags:  j.behavior_profile?.by_flag_type?.judicial_conduct ?? 0,
    };
  }

  if (actorModels?.prosecutor) {
    const p = actorModels.prosecutor;
    behavioralModels.prosecutor = {
      name:             p.name ?? p.full_name,
      risk_score:       p.risk_score,
      risk_level:       p.risk_level,
      risk_factors:     p.risk_factors ?? [],
      brady_flags:      p.behavior_profile?.by_flag_type?.brady ?? 0,
      brady_documents:  p.filing_patterns?.brady_documents ?? 0,
      foia_overdue:     p.filing_patterns?.foia_overdue ?? 0,
      foia_denied:      p.filing_patterns?.foia_denied ?? 0,
      foia_response_rate: p.filing_patterns?.foia_response_rate ?? null,
    };
  }

  const payload = {
    case: {
      id:          caseRow.id,
      state:       caseRow.state,
      county:      caseRow.county,
      status:      caseRow.status,
      filed_date:  caseRow.filed_date,
      closed_date: caseRow.closed_date,
      days_since_filing: caseRow.filed_date
        ? Math.floor((Date.now() - new Date(caseRow.filed_date).getTime()) / 86_400_000)
        : null,
      speedy_limit:   SPEEDY_LIMITS[caseRow.state]?.days ?? null,
      speedy_statute: SPEEDY_LIMITS[caseRow.state]?.statute ?? null,
    },
    flags: flags.map(f => ({
      type: f.flag_type, violation: f.violation_type,
      severity: f.severity, title: f.title,
      description: f.description, status: f.status,
    })),
    events: events.map(e => ({
      type: e.event_type, title: e.title,
      date: e.event_date, status: e.status, is_critical: e.is_critical,
    })),
    documents: docs.slice(0, 12).map(d => ({
      type: d.doc_type, is_brady: d.is_brady,
      summary: d.summary?.slice(0, 300) ?? null,
    })),
    foia: foia.map(r => ({ agency: r.agency, state: r.state, status: r.status, due_date: r.due_date })),
    people: people.map(p => ({ name: p.full_name, role: p.role, org: p.organization })),
    verified_research: researchNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 500) })),
    verified_facts:    verificationNotes.map(n => ({ title: n.title, excerpt: n.body?.slice(0, 500) })),
    behavioral_models: Object.keys(behavioralModels).length ? behavioralModels : null,
  };

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 4000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(payload) }],
  });

  let data = { theories: [] };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.theories ?? [];
}

// ── Stage 2: Ranking (pure JS) ────────────────────────────────────────────────

function rankTheories(theories, { flags, caseRow, actorModels }) {
  const filedMs    = caseRow.filed_date ? new Date(caseRow.filed_date).getTime() : null;
  const daysSince  = filedMs ? Math.floor((Date.now() - filedMs) / 86_400_000) : 0;
  const limit      = SPEEDY_LIMITS[caseRow.state]?.days ?? 180;
  const pctElapsed = daysSince / limit;

  // Behavioral model values for scoring adjustments
  const judgeRisk      = actorModels?.judge?.risk_score ?? 0;
  const contRate       = actorModels?.judge?.delay_patterns?.continuation_rate ?? 0;
  const hcrRate        = actorModels?.judge?.motion_tendencies?.hearing_completion_rate ?? 1;
  const judicialFlags  = actorModels?.judge?.behavior_profile?.by_flag_type?.judicial_conduct ?? 0;
  const prosecutorRisk = actorModels?.prosecutor?.risk_score ?? 0;
  const foiaOverdue    = actorModels?.prosecutor?.filing_patterns?.foia_overdue ?? 0;
  const bradyFlags     = actorModels?.prosecutor?.behavior_profile?.by_flag_type?.brady ?? 0;

  return theories.map(t => {
    let score = 0;

    // Evidence weight: supporting facts (0–25)
    score += Math.min((t.supporting_facts?.length ?? 0) * 5, 25);

    // Viability (0–20)
    score += t.viability === 'high' ? 20 : t.viability === 'medium' ? 10 : 3;

    // Urgency bonus for speedy trial (0–30)
    if (t.theory_type === 'speedy_trial') {
      score += pctElapsed >= 1.0 ? 30 : pctElapsed >= 0.75 ? 22 : pctElapsed >= 0.5 ? 12 : 5;
      // Continuation rate compounds speedy trial urgency
      if (contRate >= 0.3) score += 8;
    }

    // Brady always high leverage (0–15), boosted by behavioral data
    if (t.theory_type === 'brady_violation') {
      score += 15;
      if (prosecutorRisk >= 51) score += 15;
      else if (prosecutorRisk >= 26) score += 8;
      if (foiaOverdue > 0) score += Math.min(foiaOverdue * 3, 12);
      if (bradyFlags > 0) score += Math.min(bradyFlags * 5, 10);
    }

    // Prosecutorial misconduct boosted by high prosecutor risk
    if (t.theory_type === 'prosecutorial_misconduct') {
      if (prosecutorRisk >= 51) score += 10;
      else if (prosecutorRisk >= 26) score += 5;
    }

    // Judicial misconduct and due_process boosted by judge behavioral model
    if (t.theory_type === 'judicial_misconduct') {
      if (judgeRisk >= 51) score += 15;
      else if (judgeRisk >= 26) score += 8;
      if (judicialFlags > 0) score += Math.min(judicialFlags * 5, 10);
    }

    if (t.theory_type === 'due_process') {
      if (judgeRisk >= 51) score += 8;
      if (contRate >= 0.3) score += 6;
      if (hcrRate <= 0.5) score += 5;
    }

    // Multi-state issues carry extra weight (0–10)
    if (['jurisdiction_conflict', 'detainer_conflict'].includes(t.theory_type)) score += 10;

    // Matching open/escalated flags (0–10)
    const matchedFlags = flags.filter(f =>
      ['open', 'escalated'].includes(f.status) && (
        f.flag_type === t.theory_type ||
        (t.theory_type === 'brady_violation'     && f.flag_type === 'brady') ||
        (t.theory_type === 'speedy_trial'        && f.flag_type === 'deadline') ||
        (t.theory_type === 'fta_wrongful'        && contains(f.title ?? '', 'fta')) ||
        (t.theory_type === 'judicial_misconduct' && f.flag_type === 'judicial_conduct')
      )
    );
    score += Math.min(matchedFlags.length * 3, 10);

    return {
      ...t,
      strength_score: Math.min(Math.round(score), 100),
      matched_flags:  matchedFlags.length,
      base_sequence:  SEQUENCE_PRIORITY[t.theory_type] ?? 50,
    };
  }).sort((a, b) => b.strength_score - a.strength_score);
}

function contains(str, kw) { return (str ?? '').toLowerCase().includes(kw); }

// ── Stage 3: Stack plan — sequencing, leverage, timing ───────────────────────

async function buildStackPlan(ranked, { caseRow, events, foia, actorModels }) {
  const missedHrgs  = events.filter(e => e.status === 'missed').length;
  const overdueFoia = foia.filter(r => ['sent', 'acknowledged'].includes(r.status)).length;
  const daysSince   = caseRow.filed_date
    ? Math.floor((Date.now() - new Date(caseRow.filed_date).getTime()) / 86_400_000)
    : null;

  const behavioralContext = {};
  if (actorModels?.judge) {
    behavioralContext.judge = {
      name:            actorModels.judge.name ?? actorModels.judge.full_name,
      risk_level:      actorModels.judge.risk_level,
      risk_score:      actorModels.judge.risk_score,
      continuation_rate: actorModels.judge.delay_patterns?.continuation_rate ?? null,
    };
  }
  if (actorModels?.prosecutor) {
    behavioralContext.prosecutor = {
      name:         actorModels.prosecutor.name ?? actorModels.prosecutor.full_name,
      risk_level:   actorModels.prosecutor.risk_level,
      risk_score:   actorModels.prosecutor.risk_score,
      foia_overdue: actorModels.prosecutor.filing_patterns?.foia_overdue ?? 0,
    };
  }

  const system = `You are the Defense Stack Engine sequencing attorney for B.R.O. Advocacy.
Given ranked defense theories, produce the complete stacking plan for each theory.

Output ONLY valid JSON:
{
  "stack_plan": [
    {
      "theory_id": "...",
      "sequence_order": 1,
      "sequence_rationale": "why this filing order",
      "leverage_map": {
        "immediate_pressure": "what this filing does RIGHT NOW",
        "discovery_triggers": ["specific disclosure this forces"],
        "motion_type": "motion_to_dismiss|motion_to_suppress|habeas|writ|pretrial_motion|hearing_request|interlocutory_appeal",
        "plea_leverage": "high|medium|low",
        "plea_leverage_reason": "...",
        "dismissal_potential": "high|medium|low",
        "appeal_preservation": true
      },
      "timing_window": {
        "urgency": "critical|high|medium|low",
        "must_file_by_note": "Human-readable: e.g. 'File immediately — 12 days past TX 180-day limit'",
        "days_remaining": null,
        "deadline_basis": "statute|court_rule|strategic|waiver_risk"
      },
      "stacking_synergies": ["theory_id", "theory_id"],
      "filing_sequence_note": "One-line tactical note for the advocate"
    }
  ]
}

Sequencing rules:
1. Speedy trial first — the most time-critical, creates immediate dismissal leverage
2. Jurisdiction/detainer second — threshold question that affects all other claims
3. Brady/discovery third — forces prosecution to open files, enabling downstream theories
4. FTA wrongful fourth — undercuts any bond revocation or new warrants
5. Suppression fifth — needs Brady disclosure to be complete first
6. Evidentiary/due process sixth — pretrial motions, preserve for appeal
7. Misconduct/ineffective counsel last — primarily appeal preservation

If behavioral models show a high-risk judge (risk_score >= 51), prioritize judicial_misconduct and due_process theories higher and note recusal or disqualification options.
If behavioral models show a high-risk prosecutor (risk_score >= 51), front-load Brady and discovery motions to maximize disclosure pressure.`;

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 4000,
    system,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        case_state:        caseRow.state,
        filed_date:        caseRow.filed_date,
        days_since_filing: daysSince,
        speedy_limit:      SPEEDY_LIMITS[caseRow.state]?.days ?? null,
        case_status:       caseRow.status,
        missed_hearings:   missedHrgs,
        overdue_foia:      overdueFoia,
        behavioral_models: Object.keys(behavioralContext).length ? behavioralContext : null,
        ranked_theories:   ranked.map(t => ({
          theory_id:           t.theory_id,
          theory_type:         t.theory_type,
          title:               t.title,
          states_applicable:   t.states_applicable,
          viability:           t.viability,
          strength_score:      t.strength_score,
          supporting_facts:    t.supporting_facts,
          applicable_statutes: t.applicable_statutes,
          potential_remedies:  t.potential_remedies,
          weakness:            t.weakness,
          base_sequence:       t.base_sequence,
        })),
      }),
    }],
  });

  let data = { stack_plan: [] };
  try { data = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}
  return data.stack_plan ?? [];
}

// ── Stage 4: Research top theories ────────────────────────────────────────────

async function researchTopTheories(ranked, state) {
  const top = ranked.filter(t => t.viability !== 'low').slice(0, 3);
  const results = await Promise.all(
    top.map(t => {
      const query = [
        t.theory_type.replace(/_/g, ' '),
        ...(t.applicable_statutes ?? []).slice(0, 2),
        'criminal defense case law',
      ].join(' ');
      return lookupCaseLaw(query, state)
        .catch(e => ({ error: e.message, theory_id: t.theory_id }));
    })
  );
  return Object.fromEntries(top.map((t, i) => [t.theory_id, results[i]]));
}

// ── Stage 5: Verification ─────────────────────────────────────────────────────

async function verifyTopTheories(case_id, ranked) {
  if (!ranked.length) return null;
  const top3Summary = ranked.slice(0, 3).map(t =>
    `${t.title}: ${t.description ?? ''} Supporting: ${(t.supporting_facts ?? []).join('; ')}`
  ).join('\n\n');
  return verifyStrategyOutput({ case_id, strategy: top3Summary })
    .catch(e => ({ verdict: 'error', error: e.message }));
}

// ── Merge + note builder ──────────────────────────────────────────────────────

function mergeStack(ranked, stackPlan, research) {
  const planById = Object.fromEntries((stackPlan ?? []).map(p => [p.theory_id, p]));
  return ranked
    .map(t => ({
      ...t,
      ...(planById[t.theory_id] ?? { sequence_order: t.base_sequence }),
      research: research[t.theory_id] ?? null,
    }))
    .sort((a, b) => (a.sequence_order ?? 99) - (b.sequence_order ?? 99));
}

function buildStackNote(stacked, verification, caseRow, actorModels) {
  const date  = new Date().toLocaleDateString('en-US');
  const state = caseRow.state ?? 'Multi-state';
  const lines = [
    `# Defense Stack Plan — ${state} — ${date}`,
    `**Case:** ${caseRow.title ?? caseRow.id ?? 'Unknown'} | **Status:** ${caseRow.status ?? '?'}`,
    `**Total theories:** ${stacked.length}`,
    '',
  ];

  // Behavioral model summary block
  if (actorModels?.judge || actorModels?.prosecutor) {
    lines.push('## Behavioral Models');
    if (actorModels.judge) {
      const j = actorModels.judge;
      lines.push(
        `**Judge:** ${j.name ?? j.full_name ?? 'Unknown'} — Risk: ${j.risk_score ?? '?'}/100 (${j.risk_level ?? '?'})`,
      );
      if (j.risk_factors?.length) {
        j.risk_factors.slice(0, 4).forEach(f => lines.push(`  - ${f}`));
      }
      const cr = j.delay_patterns?.continuation_rate;
      if (cr != null) lines.push(`  - Continuation rate: ${(cr * 100).toFixed(0)}%`);
    }
    if (actorModels.prosecutor) {
      const p = actorModels.prosecutor;
      lines.push(
        `**Prosecutor:** ${p.name ?? p.full_name ?? 'Unknown'} — Risk: ${p.risk_score ?? '?'}/100 (${p.risk_level ?? '?'})`,
      );
      if (p.risk_factors?.length) {
        p.risk_factors.slice(0, 4).forEach(f => lines.push(`  - ${f}`));
      }
      const fo = p.filing_patterns?.foia_overdue;
      if (fo) lines.push(`  - Overdue FOIA requests: ${fo}`);
    }
    lines.push('');
  }

  for (const t of stacked) {
    const urgency = t.timing_window?.urgency?.toUpperCase() ?? '?';
    const seqStr  = t.sequence_order != null ? `[${t.sequence_order}]` : '[?]';
    lines.push(
      `## ${seqStr} ${t.title}`,
      `**Type:** \`${t.theory_type}\` | **Strength:** ${t.strength_score ?? '?'}/100 | **Viability:** ${t.viability ?? '?'} | **Timing:** ${urgency}`,
      `**Motion:** ${t.leverage_map?.motion_type ?? '?'} | **Dismissal:** ${t.leverage_map?.dismissal_potential ?? '?'} | **Plea leverage:** ${t.leverage_map?.plea_leverage ?? '?'}`,
      '',
      t.description ?? '',
      '',
    );

    if (t.supporting_facts?.length) {
      lines.push('**Supporting facts:**');
      t.supporting_facts.forEach(f => lines.push(`- ${f}`));
      lines.push('');
    }

    if (t.behavioral_basis) {
      lines.push(`**Behavioral basis:** ${t.behavioral_basis}`);
    }

    if (t.applicable_statutes?.length) {
      lines.push(`**Statutes:** ${t.applicable_statutes.join(', ')}`);
    }

    if (t.timing_window?.must_file_by_note) {
      lines.push(`**Timing:** ${t.timing_window.must_file_by_note} (${t.timing_window.deadline_basis ?? '?'})`);
    }

    if (t.stacking_synergies?.length) {
      lines.push(`**Synergies with:** ${t.stacking_synergies.join(', ')}`);
    }

    if (t.leverage_map?.discovery_triggers?.length) {
      lines.push('**Forces disclosure of:**');
      t.leverage_map.discovery_triggers.forEach(d => lines.push(`- ${d}`));
    }

    if (t.filing_sequence_note) {
      lines.push('', `> ${t.filing_sequence_note}`);
    }

    if (t.weakness) {
      lines.push(`**Weakness:** ${t.weakness}`);
    }

    lines.push('', '---', '');
  }

  if (verification) {
    lines.push(
      '## Verification',
      `**Overall:** ${verification.overall_verdict?.toUpperCase() ?? '?'} | **Issues:** ${verification.issues?.length ?? 0}`,
    );
    (verification.issues ?? []).slice(0, 6).forEach(i =>
      lines.push(`- [${(i.severity ?? 'info').toUpperCase()}] ${i.description ?? i.type ?? '?'}`)
    );
  }

  return lines.join('\n');
}

// ── Main pipeline: runDefenseStack ────────────────────────────────────────────

export async function runDefenseStack({ case_id }) {
  const ctx = await fetchStackContext(case_id);
  const { caseRow, flags, events, foia, people } = ctx;

  // Fetch behavioral models for judge and prosecutor in parallel with theory generation
  const [actorModels, theories] = await Promise.all([
    fetchActorModels(people),
    generateTheories(ctx, null), // first pass without models to avoid serial dependency
  ]);

  // Re-generate theories WITH behavioral models if models are available
  const finalTheories = (actorModels.judge || actorModels.prosecutor)
    ? await generateTheories(ctx, actorModels)
    : theories;

  if (!finalTheories.length) {
    return { error: 'No theories generated — insufficient case data or flags' };
  }

  // Stage 2: Rank (in-JS, no API call) — includes behavioral scoring
  const ranked = rankTheories(finalTheories, { flags, caseRow, actorModels });

  // Stage 3 + 4 + 5 parallel: stack plan + research top theories + verification
  const [stackPlan, research, verification] = await Promise.all([
    buildStackPlan(ranked, { caseRow, events, foia, actorModels }),
    researchTopTheories(ranked, caseRow.state ?? null),
    verifyTopTheories(case_id, ranked),
  ]);

  // Merge
  const stacked = mergeStack(ranked, stackPlan, research);

  // Summary stats
  const critical    = stacked.filter(t => t.timing_window?.urgency === 'critical');
  const high        = stacked.filter(t => t.timing_window?.urgency === 'high');
  const dismissHigh = stacked.filter(t => t.leverage_map?.dismissal_potential === 'high');

  await createNote({
    case_id,
    note_type: 'strategy',
    title:     `Defense Stack — ${stacked.length} theories [${caseRow.state ?? 'multi'}] — ${new Date().toLocaleDateString('en-US')}`,
    body:      buildStackNote(stacked, verification, caseRow, actorModels),
    author:    'defense_stack',
  });

  return {
    workflow:         'defense_stack',
    case_id,
    generated_at:     new Date().toISOString(),
    case_state:       caseRow.state,
    total_theories:   stacked.length,
    theories_by_type: Object.fromEntries(
      [...new Set(stacked.map(t => t.theory_type))].map(type => [
        type, stacked.filter(t => t.theory_type === type).length
      ])
    ),
    stacked_theories: stacked,
    actor_models:     actorModels,
    verification,
    summary: {
      top_filing:          stacked[0] ? `[${stacked[0].sequence_order}] ${stacked[0].title}` : null,
      critical_urgency:    critical.map(t => ({ title: t.title, note: t.timing_window?.must_file_by_note })),
      high_urgency_count:  high.length,
      dismissal_targets:   dismissHigh.map(t => t.title),
      total_synergies:     stacked.reduce((n, t) => n + (t.stacking_synergies?.length ?? 0), 0),
      theories_researched: Object.keys(research).length,
      judge_risk:          actorModels.judge  ? { name: actorModels.judge.name,  risk_score: actorModels.judge.risk_score,  risk_level: actorModels.judge.risk_level }  : null,
      prosecutor_risk:     actorModels.prosecutor ? { name: actorModels.prosecutor.name, risk_score: actorModels.prosecutor.risk_score, risk_level: actorModels.prosecutor.risk_level } : null,
    },
  };
}

// ── Multi-case (multi-state) defense stack ────────────────────────────────────

export async function runMultiCaseStack({ person_id, case_ids }) {
  const caseResults = await Promise.all(
    case_ids.map(id => runDefenseStack({ case_id: id }).catch(e => ({ case_id: id, error: e.message })))
  );

  // Unified priority: collect all stacked theories, flatten, re-sort by sequence_order + strength
  const allTheories = caseResults
    .filter(r => !r.error && r.stacked_theories?.length)
    .flatMap(r => r.stacked_theories.map(t => ({ ...t, source_case_id: r.case_id, source_state: r.case_state })));

  const unified = allTheories.sort((a, b) =>
    (a.sequence_order ?? 99) - (b.sequence_order ?? 99) ||
    b.strength_score - a.strength_score
  );

  const critical   = unified.filter(t => t.timing_window?.urgency === 'critical');
  const highLev    = unified.filter(t => t.leverage_map?.dismissal_potential === 'high');

  // Aggregate actor models from all cases (deduplicate by name)
  const actorModelsByCase = caseResults
    .filter(r => !r.error && r.actor_models)
    .map(r => ({ case_id: r.case_id, case_state: r.case_state, actor_models: r.actor_models }));

  return {
    workflow:        'multi_case_defense_stack',
    person_id,
    case_ids,
    generated_at:    new Date().toISOString(),
    per_case:        caseResults,
    unified_stack:   unified,
    actor_models_by_case: actorModelsByCase,
    summary: {
      total_theories:    unified.length,
      critical_urgency:  critical.length,
      dismissal_targets: highLev.length,
      states_covered:    [...new Set(unified.map(t => t.source_state).filter(Boolean))],
    },
  };
}

// ── Latest stack retrieval ────────────────────────────────────────────────────

export async function getLatestStack(case_id) {
  const { data } = await supabase
    .from('notes')
    .select('id, title, body, created_at')
    .eq('case_id', case_id)
    .eq('author', 'defense_stack')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}
