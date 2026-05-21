import { anthropic } from './anthropic_client.js';
import { supabase } from './supabase_client.js';
import { createNote } from './notes.js';
import { ingest } from './ingestion/router.js';

const MODEL_PRO  = 'claude-sonnet-4-6';
const FETCH_OPTS = {
  headers: { 'User-Agent': 'BRO-Advocacy-Research/1.0', Accept: 'application/json' },
  signal:  AbortSignal.timeout(15_000),
};

const CL_SEARCH  = 'https://www.courtlistener.com/api/rest/v4/search/';
const CL_PARTIES = 'https://www.courtlistener.com/api/rest/v4/parties/';

// CourtListener court slugs for BRO jurisdictions
const STATE_COURTS = {
  TX: 'texcrimapp,texsupct,texapp',
  IL: 'ilsupct,illappct1,illappct4,illappct5',
  MO: 'mosupct,moctapp',
};

// Fast-path statute text for BRO-specific statutes
const KNOWN_STATUTES = {
  'TX:32A.02':   'Tex. Code Crim. Proc. Art. 32A.02 — Speedy Trial Act. The state must be ready for trial within 180 days from the commencement of a criminal action for a felony.',
  'TX:39.14':    'Tex. Code Crim. Proc. Art. 39.14 (Michael Morton Act) — Discovery. The state must produce all evidence material to guilt or punishment, including exculpatory Brady material.',
  'IL:103(b)':   'Ill. Sup. Ct. R. 103(b) — Speedy Trial. A defendant in custody must be tried within 120 days of arrest; on bail or own recognizance within 160 days.',
  'IL:Brady':    'Brady v. Maryland (1963); Illinois: People v. Steidl — Prosecution must disclose all materially favorable evidence. Failure is reversible constitutional error.',
  'MO:33.01':    'Mo. R. Crim. P. 33.01 — Speedy Trial. Trial must commence within 180 days of filing of the indictment or information.',
  'MO:Brady':    'Brady v. Maryland (1963); Missouri: State v. Nunley — Suppression of evidence favorable to the accused violates due process when the evidence is material.',
  'TX:FTA':      'Tex. Code Crim. Proc. Arts. 22.01–22.14 — Failure to Appear / Bond Forfeiture. A bench warrant may issue and bond declared forfeited if defendant fails to appear.',
  'IL:FTA':      '725 ILCS 5/110-3 — Conditions of Release / Failure to Appear. Court may issue warrant; failure to appear is a separate Class 4 felony if on Class X bail.',
  'MO:FTA':      'Mo. Rev. Stat. § 544.665 — Failure to Appear. Separate Class E or Class D felony depending on underlying charge class.',
  'FED:Brady':   'Brady v. Maryland, 373 U.S. 83 (1963). The government must disclose material evidence favorable to the defendant. Suppression violates due process.',
  'FED:Giglio':  'Giglio v. United States, 405 U.S. 150 (1972). Brady extends to impeachment evidence, including deals, promises, or benefits given to prosecution witnesses.',
};

export const RESEARCH_TYPES = [
  'web_search',
  'case_law',
  'people_lookup',
  'statutory_lookup',
  'public_records_ingest',
];

// ── Web search via Claude's built-in web_search tool ─────────────────────────

async function webSearch(query) {
  try {
    const response = await anthropic.messages.create({
      model:      MODEL_PRO,
      max_tokens: 2048,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{
        role:    'user',
        content: `Legal research for B.R.O. Advocacy — John Recklein multi-state criminal defense (TX Palo Pinto, IL St. Clair/Madison, MO St. Charles). Search for: ${query}`
      }],
    });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
    return text || 'No web results returned.';
  } catch {
    // Fallback: Claude general knowledge if web search tool is unavailable
    const fb = await anthropic.messages.create({
      model:      MODEL_PRO,
      max_tokens: 1024,
      messages:   [{
        role:    'user',
        content: `Provide what you know about the following legal topic, focusing on TX, IL, and MO criminal law: ${query}`
      }],
    });
    return fb.content[0]?.text ?? 'Web search unavailable.';
  }
}

// ── CourtListener: case-law opinions ─────────────────────────────────────────

async function caseLawLookup({ query, state, case_type = 'o' }) {
  const params = new URLSearchParams({ q: query, type: case_type, order_by: 'score desc' });
  if (state && STATE_COURTS[state]) params.set('court', STATE_COURTS[state]);

  const res = await fetch(`${CL_SEARCH}?${params}`, FETCH_OPTS);
  if (!res.ok) throw new Error(`CourtListener opinions: HTTP ${res.status}`);
  const data = await res.json();

  return (data.results ?? []).slice(0, 8).map(r => ({
    id:       r.id,
    title:    r.caseName   ?? r.case_name   ?? '—',
    court:    r.court_id   ?? r.court        ?? '—',
    date:     r.dateFiled  ?? r.date_filed   ?? null,
    citation: r.citation   ?? null,
    snippet:  r.snippet    ?? '',
    url:      r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
  }));
}

// ── CourtListener: party + docket search ─────────────────────────────────────

async function peopleLookup({ name, state }) {
  const partyParams  = new URLSearchParams({ name });
  const docketParams = new URLSearchParams({ q: name, type: 'd', order_by: 'score desc' });
  if (state && STATE_COURTS[state]) docketParams.set('court', STATE_COURTS[state]);

  const [partyRes, docketRes] = await Promise.all([
    fetch(`${CL_PARTIES}?${partyParams}`, FETCH_OPTS),
    fetch(`${CL_SEARCH}?${docketParams}`, FETCH_OPTS),
  ]);

  const parties = partyRes.ok
    ? ((await partyRes.json()).results ?? []).slice(0, 10).map(r => ({
        name:       r.name,
        party_type: r.party_type,
        docket:     r.docket,
        url:        r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
      }))
    : [];

  const dockets = docketRes.ok
    ? ((await docketRes.json()).results ?? []).slice(0, 6).map(r => ({
        title:  r.caseName ?? r.case_name ?? '—',
        court:  r.court_id ?? '—',
        date:   r.dateFiled ?? r.date_filed ?? null,
        url:    r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
      }))
    : [];

  return { parties, dockets };
}

// ── Statutory lookup ──────────────────────────────────────────────────────────

async function statutoryLookup({ statute, state, query }) {
  const key = state && statute ? `${state}:${statute}` : null;
  if (key && KNOWN_STATUTES[key]) {
    return { source: 'local_db', statute: key, text: KNOWN_STATUTES[key] };
  }
  // Web search fallback for unlisted statutes
  const searchQuery = query ?? `${state ?? ''} ${statute ?? ''} criminal statute full text`.trim();
  const text = await webSearch(searchQuery);
  return { source: 'web', statute: statute ?? null, query: searchQuery, text };
}

// ── Public records ingest ─────────────────────────────────────────────────────

async function publicRecordsIngest({ url, case_id, person_id, doc_type = 'evidence', title }) {
  const pageRes = await fetch(url, {
    headers: { 'User-Agent': 'BRO-Advocacy-Research/1.0', Accept: 'text/html,text/plain,application/pdf' },
    signal:  AbortSignal.timeout(20_000),
  });
  if (!pageRes.ok) throw new Error(`Fetch failed: HTTP ${pageRes.status} — ${url}`);

  const contentType = pageRes.headers.get('content-type') ?? '';
  const raw_text    = (await pageRes.text()).slice(0, 50_000);
  const ingestType  = contentType.includes('pdf') ? 'pdf' : 'email';

  const result = await ingest(ingestType, {
    case_id,
    person_id,
    file_path: url,
    raw_text,
    title:     title ?? `Public record: ${new URL(url).hostname}`,
    doc_type,
  });

  return { ingested: true, url, document_id: result?.document?.data?.id ?? null };
}

// ── Claude synthesis ──────────────────────────────────────────────────────────

async function synthesize(research_type, query, rawResults) {
  const system = [
    'You are the External Research Agent for B.R.O. Advocacy — John Recklein multi-state',
    'criminal defense (TX Palo Pinto, IL St. Clair/Madison, MO St. Charles).',
    'Synthesize the research data into actionable legal intelligence.',
    'Output ONLY valid JSON with this exact structure:',
    '{',
    '  "findings": [{ "source": "...", "title": "...", "excerpt": "...", "relevance": "high|medium|low" }],',
    '  "synthesis": "2-4 paragraph narrative",',
    '  "action_items": ["..."],',
    '  "confidence": "high|medium|low",',
    '  "jurisdictions_cited": ["TX"|"IL"|"MO"|"FED"]',
    '}',
  ].join('\n');

  const resp = await anthropic.messages.create({
    model:      MODEL_PRO,
    max_tokens: 2000,
    system,
    messages:   [{ role: 'user', content: JSON.stringify({ research_type, query, raw_results: rawResults }) }],
  });

  const text = resp.content[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { synthesis: text, findings: [], action_items: [], confidence: 'low', jurisdictions_cited: [] };
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runResearch({ case_id, person_id, research_type, query, opts = {} }) {
  if (!RESEARCH_TYPES.includes(research_type)) {
    return { error: `Unknown research_type "${research_type}". Available: ${RESEARCH_TYPES.join(', ')}` };
  }

  let rawResults;

  switch (research_type) {
    case 'web_search':
      rawResults = await webSearch(query);
      break;

    case 'case_law':
      rawResults = await caseLawLookup({ query, state: opts.state, case_type: opts.case_type });
      break;

    case 'people_lookup':
      rawResults = await peopleLookup({ name: query, state: opts.state });
      break;

    case 'statutory_lookup':
      rawResults = await statutoryLookup({ statute: opts.statute, state: opts.state, query });
      break;

    case 'public_records_ingest':
      if (!opts.url) return { error: 'opts.url is required for public_records_ingest' };
      rawResults = await publicRecordsIngest({ url: opts.url, case_id, person_id, doc_type: opts.doc_type, title: opts.title });
      break;
  }

  const synthesis = research_type === 'public_records_ingest'
    ? rawResults
    : await synthesize(research_type, query, rawResults);

  if (case_id && research_type !== 'public_records_ingest') {
    await createNote({
      case_id,
      note_type: 'research',
      title:     `Research [${research_type}]: ${query.slice(0, 80)}`,
      body:      typeof synthesis?.synthesis === 'string'
                   ? synthesis.synthesis
                   : JSON.stringify(synthesis, null, 2),
      author:    'research_agent',
    });
  }

  return {
    research_type,
    query,
    results:          rawResults,
    synthesis,
    stored_as_note:   !!(case_id && research_type !== 'public_records_ingest'),
  };
}

// ── Convenience helpers (used by workflows) ───────────────────────────────────
// Pass case_id to store results as a note; omit to get results only.

export async function researchCaseLaw(query, state, case_id) {
  return runResearch({ case_id, research_type: 'case_law', query, opts: { state } });
}

export async function researchStatute(statute, state, case_id) {
  return runResearch({ case_id, research_type: 'statutory_lookup', query: `${state ?? ''} ${statute}`.trim(), opts: { statute, state } });
}

export async function researchPerson(name, state, case_id) {
  return runResearch({ case_id, research_type: 'people_lookup', query: name, opts: { state } });
}

export async function webSearchResearch(query, case_id) {
  return runResearch({ case_id, research_type: 'web_search', query });
}

// No-note variant for use inside aggregate workflows
export async function lookupCaseLaw(query, state) {
  const results = await caseLawLookup({ query, state });
  const synthesis = await synthesize('case_law', query, results);
  return { results, synthesis };
}

export async function lookupStatute(statute, state) {
  return statutoryLookup({ statute, state, query: null });
}
