import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { lookupCaseLaw, lookupStatute } from './research_agent.js';

const MODEL_PRO   = 'claude-sonnet-4-6';
const MODEL_LIGHT = 'claude-haiku-4-5-20251001';

const CL_SEARCH  = 'https://www.courtlistener.com/api/rest/v4/search/';
const CL_PARTIES = 'https://www.courtlistener.com/api/rest/v4/parties/';
const FETCH_OPTS = {
  headers: { 'User-Agent': 'BRO-Advocacy-Research/1.0', Accept: 'application/json' },
  signal:  AbortSignal.timeout(12_000),
};

const SPEEDY_TRIAL = {
  TX: { days: 180, statute: 'Tex. Code Crim. Proc. Art. 32A.02' },
  IL: { days: 120, statute: 'Ill. Sup. Ct. R. 103(b)' },
  MO: { days: 180, statute: 'Mo. R. Crim. P. 33.01' },
};

export const VERIFICATION_TYPES = [
  'citation',
  'statute',
  'case_law',
  'timeline',
  'actor_identity',
  'factual_consistency',
  'document',
  'strategy_output',
];

// ── Citation extraction (lightweight) ────────────────────────────────────────

async function extractCitations(text) {
  if (!text || text.length < 30) return [];
  const resp = await anthropic.messages.create({
    model:   MODEL_LIGHT,
    max_tokens: 512,
    system:  'Extract all legal citations from the provided text. Return ONLY a JSON array of citation strings (e.g. ["Brady v. Maryland, 373 U.S. 83 (1963)", "Tex. Code Crim. Proc. Art. 32A.02"]). Return [] if none.',
    messages: [{ role: 'user', content: text.slice(0, 8000) }],
  });
  try { return JSON.parse(resp.content[0]?.text ?? '[]'); }
  catch { return []; }
}

// ── 1. Citation verification ──────────────────────────────────────────────────

async function verifyCitation({ citation }) {
  const params = new URLSearchParams({ q: citation, type: 'o', order_by: 'score desc' });
  let clMatches = null;
  try {
    const res = await fetch(`${CL_SEARCH}?${params}`, FETCH_OPTS);
    if (res.ok) {
      const data = await res.json();
      clMatches = (data.results ?? []).slice(0, 3).map(r => ({
        title: r.caseName ?? r.case_name,
        date:  r.dateFiled ?? r.date_filed,
        url:   r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
      }));
    }
  } catch { /* CourtListener unreachable — proceed with Claude-only assessment */ }

  const resp = await anthropic.messages.create({
    model:   MODEL_LIGHT,
    max_tokens: 350,
    system:  'You are a legal citation verifier. Assess whether the given citation is valid (correctly formatted and plausibly real). Output JSON only: {"valid": true|false|null, "confidence": "high|medium|low", "note": "..."}',
    messages: [{ role: 'user', content: JSON.stringify({ citation, courtlistener_matches: clMatches }) }],
  });

  let assessment = { valid: null, confidence: 'low', note: '' };
  try { assessment = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}

  return {
    citation,
    courtlistener_matches: clMatches,
    assessment,
    verdict: assessment.valid === true  ? 'verified'
           : assessment.valid === false ? 'conflict'
           : 'unverified',
  };
}

// ── 2. Statute verification ───────────────────────────────────────────────────

async function verifyStatute({ statute, state, claimed_text }) {
  const lookup = await lookupStatute(statute, state).catch(e => ({ error: e.message }));
  if (!lookup || lookup.error) {
    return { verdict: 'error', statute, state, error: lookup?.error ?? 'lookup failed' };
  }
  if (!claimed_text) {
    return { verdict: 'verified', statute, state, actual_text: lookup.text, source: lookup.source };
  }

  const resp = await anthropic.messages.create({
    model:   MODEL_LIGHT,
    max_tokens: 300,
    system:  'Compare the claimed statute text against the actual statute text. Output JSON only: {"match": "exact|substantial|partial|none", "confidence": "high|medium|low", "key_differences": "..."}',
    messages: [{ role: 'user', content: JSON.stringify({ claimed: claimed_text, actual: lookup.text }) }],
  });
  let comparison = { match: 'unknown', confidence: 'low', key_differences: '' };
  try { comparison = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}

  return {
    verdict:     ['exact', 'substantial'].includes(comparison.match) ? 'verified' : 'conflict',
    statute,
    state,
    actual_text: lookup.text,
    source:      lookup.source,
    comparison,
  };
}

// ── 3. Case law holding verification ─────────────────────────────────────────

async function verifyCaseLaw({ citation, claimed_holding }) {
  const research = await lookupCaseLaw(citation, null).catch(e => ({ error: e.message }));
  if (research?.error || !claimed_holding) {
    return { verdict: research?.error ? 'error' : 'unverified', citation, research };
  }

  const resp = await anthropic.messages.create({
    model:   MODEL_PRO,
    max_tokens: 600,
    system:  'You are a legal accuracy verifier. Given a claimed case holding and research results, assess whether the claimed holding is accurate. Output JSON only: {"accurate": true|false|null, "confidence": "high|medium|low", "actual_holding": "...", "discrepancy": "..."}',
    messages: [{ role: 'user', content: JSON.stringify({ citation, claimed_holding, research_results: research }) }],
  });
  let assessment = { accurate: null, confidence: 'low', actual_holding: '', discrepancy: '' };
  try { assessment = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}

  return {
    verdict:         assessment.accurate === true  ? 'verified'
                   : assessment.accurate === false ? 'conflict'
                   : 'unverified',
    citation,
    claimed_holding,
    assessment,
    research,
  };
}

// ── 4. Timeline verification ──────────────────────────────────────────────────

async function verifyTimeline({ case_id }) {
  const [{ data: caseRow }, { data: events }] = await Promise.all([
    supabase.from('cases').select('id, state, status, filed_date, closed_date').eq('id', case_id).single(),
    supabase.from('events').select('*').eq('case_id', case_id).order('event_date'),
  ]);

  const issues  = [];
  const state   = caseRow?.state;
  const rule    = SPEEDY_TRIAL[state];
  const now     = Date.now();

  // Speedy trial
  if (rule && caseRow?.filed_date && caseRow?.status === 'active') {
    const daysSince = Math.floor((now - new Date(caseRow.filed_date).getTime()) / 86_400_000);
    if (daysSince > rule.days) {
      issues.push({
        type:          'speedy_trial_exceeded',
        severity:      'critical',
        description:   `${state} speedy trial limit exceeded: ${daysSince} days since filing (limit ${rule.days}d, ${rule.statute}).`,
        days_elapsed:  daysSince,
        limit_days:    rule.days,
        days_over:     daysSince - rule.days,
      });
    } else if (daysSince > rule.days * 0.75) {
      issues.push({
        type:           'speedy_trial_approaching',
        severity:       'high',
        description:    `${state} speedy trial deadline approaching: ${daysSince} of ${rule.days} days elapsed (${rule.statute}). ${rule.days - daysSince} days remain.`,
        days_elapsed:   daysSince,
        days_remaining: rule.days - daysSince,
      });
    }
  }

  const dated = (events ?? []).filter(e => e.event_date).sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

  // Long gaps in active case
  if (caseRow?.status === 'active') {
    for (let i = 1; i < dated.length; i++) {
      const gap = Math.floor((new Date(dated[i].event_date) - new Date(dated[i - 1].event_date)) / 86_400_000);
      if (gap > 90) {
        issues.push({
          type:        'timeline_gap',
          severity:    'medium',
          description: `${gap}-day gap between "${dated[i - 1].title}" and "${dated[i].title}" — possible missing events or continuances.`,
          gap_days:    gap,
          from_date:   dated[i - 1].event_date,
          to_date:     dated[i].event_date,
        });
      }
    }
  }

  // Missed hearings
  const missed = (events ?? []).filter(e => e.status === 'missed');
  if (missed.length > 0) {
    issues.push({
      type:        'missed_hearings',
      severity:    missed.length > 2 ? 'high' : 'medium',
      description: `${missed.length} missed event${missed.length !== 1 ? 's' : ''}: ${missed.map(e => e.title).slice(0, 4).join(', ')}.`,
      count:       missed.length,
      event_ids:   missed.map(e => e.id),
    });
  }

  // Deadline-before-event anomalies
  for (const e of (events ?? [])) {
    if (e.event_date && e.deadline_date && new Date(e.deadline_date) < new Date(e.event_date)) {
      issues.push({
        type:        'deadline_before_event',
        severity:    'high',
        description: `"${e.title}": deadline (${e.deadline_date?.split('T')[0]}) precedes event date (${e.event_date?.split('T')[0]}).`,
        event_id:    e.id,
      });
    }
  }

  // Persist critical issues as flags
  const criticals = issues.filter(i => i.severity === 'critical');
  for (const issue of criticals) {
    await supabase.from('flags').insert({
      case_id,
      flag_type:      'deadline',
      violation_type: 'constitutional',
      severity:       'critical',
      title:          issue.description.slice(0, 120),
      description:    issue.description,
      raised_by:      'verification_agent',
      status:         'open',
    });
  }

  return {
    case_id,
    state,
    verdict:         issues.some(i => ['critical', 'high'].includes(i.severity)) ? 'conflict'
                   : issues.length > 0 ? 'unverified' : 'verified',
    issues,
    events_checked:  (events ?? []).length,
    filed_date:      caseRow?.filed_date ?? null,
    case_status:     caseRow?.status ?? null,
  };
}

// ── 5. Actor identity verification ────────────────────────────────────────────

async function verifyActorIdentity({ name, role, case_id }) {
  const { data: people } = await supabase
    .from('people')
    .select('id, full_name, role, organization, case_id')
    .ilike('full_name', `%${name}%`)
    .limit(10);

  let relatedFlags = [];
  if (case_id) {
    const { data: flags } = await supabase
      .from('flags')
      .select('id, title, severity, flag_type')
      .eq('case_id', case_id)
      .or(`title.ilike.%${name}%,description.ilike.%${name}%`)
      .limit(5);
    relatedFlags = flags ?? [];
  }

  let clParties = [];
  try {
    const res = await fetch(`${CL_PARTIES}?${new URLSearchParams({ name })}`, FETCH_OPTS);
    if (res.ok) {
      const data = await res.json();
      clParties = (data.results ?? []).slice(0, 5).map(r => ({ name: r.name, party_type: r.party_type }));
    }
  } catch {}

  const exact    = (people ?? []).find(p => p.full_name?.toLowerCase() === name.toLowerCase());
  const roleOk   = exact ? (role ? exact.role === role : true) : null;

  const issues = [
    ...(role && exact && !roleOk ? [{
      type: 'role_mismatch', severity: 'medium',
      description: `"${name}" in DB has role "${exact.role}", expected "${role}".`,
    }] : []),
    ...(!exact && !clParties.length ? [{
      type: 'actor_not_found', severity: 'high',
      description: `"${name}" not found in case records or CourtListener.`,
    }] : []),
  ];

  return {
    name,
    role,
    verdict:       exact ? 'verified' : clParties.length ? 'unverified' : 'unverified',
    db_record:     exact ?? null,
    role_match:    roleOk,
    db_similar:    (people ?? []).filter(p => p.id !== exact?.id).map(p => ({ id: p.id, name: p.full_name, role: p.role })),
    courtlistener: clParties,
    related_flags: relatedFlags,
    issues,
  };
}

// ── 6. Factual consistency check ──────────────────────────────────────────────

async function verifyFactualConsistency({ case_id, text }) {
  const [{ data: events }, { data: flags }, { data: people }] = await Promise.all([
    supabase.from('events').select('title, event_type, event_date, status').eq('case_id', case_id).order('event_date').limit(20),
    supabase.from('flags').select('title, flag_type, severity, status').eq('case_id', case_id).in('status', ['open', 'escalated']).limit(20),
    supabase.from('people').select('full_name, role, organization').eq('case_id', case_id).limit(20),
  ]);

  const resp = await anthropic.messages.create({
    model:   MODEL_PRO,
    max_tokens: 900,
    system:  [
      'You are a fact-checker for legal documents. Compare the provided text against the case database facts.',
      'Identify contradictions, unverifiable claims, or factual errors.',
      'Output ONLY valid JSON: {"consistent": true|false|null, "confidence": "high|medium|low", "contradictions": [{"claim": "...", "actual": "...", "severity": "critical|high|medium|low"}], "unverifiable": ["..."], "notes": "..."}',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        text_to_verify: text.slice(0, 6000),
        known_events:   events ?? [],
        open_flags:     flags  ?? [],
        known_actors:   people ?? [],
      }),
    }],
  });

  let result = { consistent: null, confidence: 'low', contradictions: [], unverifiable: [], notes: '' };
  try { result = JSON.parse(resp.content[0]?.text ?? '{}'); } catch {}

  return {
    verdict:       result.consistent === true ? 'verified' : result.consistent === false ? 'conflict' : 'unverified',
    consistency:   result,
    facts_checked: { events: (events ?? []).length, flags: (flags ?? []).length, actors: (people ?? []).length },
  };
}

// ── 7. Post-ingest document verification (called async after ingest) ──────────

export async function verifyIngestedDocument({ case_id, document_id }) {
  const { data: doc } = await supabase
    .from('documents')
    .select('id, title, doc_type, summary, filed_date, source_system')
    .eq('id', document_id)
    .single();

  if (!doc?.summary) return { skipped: true, reason: 'no summary available' };

  const [citations, timelineResult] = await Promise.all([
    extractCitations(doc.summary),
    verifyTimeline({ case_id }),
  ]);

  const citationResults = await Promise.all(
    citations.slice(0, 4).map(c =>
      verifyCitation({ citation: c }).catch(e => ({ citation: c, verdict: 'error', error: e.message }))
    )
  );

  const issues = [
    ...citationResults.filter(r => r.verdict === 'conflict'),
    ...timelineResult.issues.filter(i => ['critical', 'high'].includes(i.severity)),
  ];

  await createNote({
    case_id,
    document_id,
    note_type: 'observation',
    title:     `Verification: ${doc.title ?? document_id} (${doc.doc_type ?? 'unknown'})`,
    body: [
      `**Document:** ${doc.title ?? document_id}`,
      `**Type:** ${doc.doc_type} | **Source:** ${doc.source_system}`,
      '',
      `**Citations checked (${citationResults.length}):**`,
      ...citationResults.map(r => `- ${r.citation}: ${r.verdict.toUpperCase()} (confidence: ${r.assessment?.confidence ?? '?'})`),
      ...(citationResults.length === 0 ? ['- None found'] : []),
      '',
      `**Timeline issues (${timelineResult.issues.length}):**`,
      ...timelineResult.issues.map(i => `- [${i.severity.toUpperCase()}] ${i.description}`),
      ...(timelineResult.issues.length === 0 ? ['- None detected'] : []),
    ].join('\n'),
    author: 'verification_agent',
  });

  return {
    document_id,
    doc_type:          doc.doc_type,
    citations_checked: citationResults.length,
    citation_verdicts: citationResults,
    timeline:          timelineResult,
    issues,
    overall_verdict:   issues.some(i => i.verdict === 'conflict' || i.severity === 'critical') ? 'conflict' : 'verified',
  };
}

// ── 8. Strategy output verification ──────────────────────────────────────────

export async function verifyStrategyOutput({ case_id, strategy }) {
  const strategyText = typeof strategy === 'string' ? strategy : JSON.stringify(strategy);

  const [citations, timelineResult, consistencyResult] = await Promise.all([
    extractCitations(strategyText),
    verifyTimeline({ case_id }),
    verifyFactualConsistency({ case_id, text: strategyText }),
  ]);

  const citationResults = await Promise.all(
    citations.slice(0, 6).map(c =>
      verifyCitation({ citation: c }).catch(e => ({ citation: c, verdict: 'error', error: e.message }))
    )
  );

  const issues = [
    ...citationResults.filter(r => r.verdict === 'conflict').map(r => ({
      type: 'citation_conflict', severity: 'high', citation: r.citation, note: r.assessment?.note,
    })),
    ...timelineResult.issues.filter(i => ['critical', 'high'].includes(i.severity)),
    ...(consistencyResult.consistency?.contradictions ?? []).filter(c => ['critical', 'high'].includes(c.severity)),
  ];

  await createNote({
    case_id,
    note_type: 'observation',
    title:     `Strategy Verification — ${new Date().toLocaleDateString('en-US')}`,
    body: [
      `## Strategy Verification Report`,
      `**Generated:** ${new Date().toISOString()}`,
      '',
      `### Citations (${citationResults.length} checked)`,
      ...citationResults.map(r => `- \`${r.citation}\`: **${r.verdict.toUpperCase()}** (${r.assessment?.confidence ?? '?'})`),
      ...(citationResults.length === 0 ? ['- No citations found in strategy output'] : []),
      '',
      `### Timeline`,
      `Verdict: **${timelineResult.verdict.toUpperCase()}** — ${timelineResult.issues.length} issue(s)`,
      ...timelineResult.issues.map(i => `- [${i.severity.toUpperCase()}] ${i.description}`),
      '',
      `### Factual Consistency`,
      `Verdict: **${consistencyResult.verdict.toUpperCase()}** (confidence: ${consistencyResult.consistency?.confidence ?? '?'})`,
      ...(consistencyResult.consistency?.contradictions ?? []).map(c =>
        `- [${(c.severity ?? 'low').toUpperCase()}] Claim: "${c.claim}" → Actual: "${c.actual}"`
      ),
      '',
      `### Issue Summary`,
      `Total: **${issues.length}** issue(s) — ${issues.filter(i => i.severity === 'critical').length} critical, ${issues.filter(i => i.severity === 'high').length} high`,
    ].join('\n'),
    author: 'verification_agent',
  });

  return {
    case_id,
    citations_checked:   citationResults.length,
    citation_results:    citationResults,
    timeline:            timelineResult,
    factual_consistency: consistencyResult,
    issues,
    overall_verdict:     issues.some(i => i.severity === 'critical') ? 'conflict'
                       : issues.length > 0                            ? 'conflict'
                       : 'verified',
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runVerification({
  verification_type,
  case_id, document_id, strategy,
  name, role,
  citation, claimed_holding,
  statute, state, claimed_text,
  text,
}) {
  if (!VERIFICATION_TYPES.includes(verification_type)) {
    return { error: `Unknown verification_type "${verification_type}". Available: ${VERIFICATION_TYPES.join(', ')}` };
  }
  try {
    switch (verification_type) {
      case 'citation':
        return verifyCitation({ citation });
      case 'statute':
        return verifyStatute({ statute, state, claimed_text });
      case 'case_law':
        return verifyCaseLaw({ citation, claimed_holding });
      case 'timeline':
        if (!case_id) return { error: 'case_id required' };
        return verifyTimeline({ case_id });
      case 'actor_identity':
        if (!name) return { error: 'name required' };
        return verifyActorIdentity({ name, role, case_id });
      case 'factual_consistency':
        if (!case_id || !text) return { error: 'case_id and text required' };
        return verifyFactualConsistency({ case_id, text });
      case 'document':
        if (!case_id || !document_id) return { error: 'case_id and document_id required' };
        return verifyIngestedDocument({ case_id, document_id });
      case 'strategy_output':
        if (!case_id || !strategy) return { error: 'case_id and strategy required' };
        return verifyStrategyOutput({ case_id, strategy });
    }
  } catch (err) {
    return { verification_type, verdict: 'error', error: err.message };
  }
}
