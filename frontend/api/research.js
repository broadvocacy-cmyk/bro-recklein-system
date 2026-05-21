import { runResearch, RESEARCH_TYPES } from '../../backend/research_agent.js';

const REQUIRED = {
  web_search:            ['query'],
  case_law:              ['query'],
  people_lookup:         ['query'],
  statutory_lookup:      ['query'],
  public_records_ingest: ['case_id'],
};

const NOTES = {
  case_law:              'opts.state (TX|IL|MO) restricts results to BRO jurisdictions via CourtListener',
  people_lookup:         'opts.state narrows CourtListener party + docket search',
  statutory_lookup:      'opts.statute + opts.state uses fast local DB for known BRO statutes (e.g. 32A.02, 103(b), 33.01)',
  public_records_ingest: 'opts.url (required), opts.doc_type (default: evidence), opts.title',
  web_search:            'Uses Claude\'s built-in web search tool; automatically focused on TX/IL/MO criminal defense',
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      available:       RESEARCH_TYPES,
      required_params: REQUIRED,
      notes:           NOTES,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { research_type, query, case_id, person_id, opts = {} } = body;

  if (!research_type) {
    return res.status(400).json({ error: 'research_type is required', available: RESEARCH_TYPES });
  }

  if (!RESEARCH_TYPES.includes(research_type)) {
    return res.status(400).json({ error: `Unknown research_type "${research_type}"`, available: RESEARCH_TYPES });
  }

  const reqFields = REQUIRED[research_type] ?? [];
  const missing   = reqFields.filter(k => !body[k]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  try {
    const result = await runResearch({ case_id, person_id, research_type, query, opts });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Research error [${research_type}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
