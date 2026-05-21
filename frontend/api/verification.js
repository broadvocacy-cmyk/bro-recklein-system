import { runVerification, VERIFICATION_TYPES } from '../../backend/verification_agent.js';

const REQUIRED = {
  citation:            ['citation'],
  statute:             ['statute', 'state'],
  case_law:            ['citation', 'claimed_holding'],
  timeline:            ['case_id'],
  actor_identity:      ['name'],
  factual_consistency: ['case_id', 'text'],
  document:            ['case_id', 'document_id'],
  strategy_output:     ['case_id', 'strategy'],
};

const NOTES = {
  citation:            'Validates a legal citation against CourtListener + Claude',
  statute:             'claimed_text optional — if provided, compares to actual statutory text',
  case_law:            'Verifies that cited case actually supports the claimed_holding',
  timeline:            'Checks speedy trial, event order, gaps, and missed hearings; creates flags for critical violations',
  actor_identity:      'role optional; case_id optional but enables flag cross-reference',
  factual_consistency: 'Compares text against DB events, flags, and people for the case',
  document:            'Post-ingest citation + timeline check on a stored document summary',
  strategy_output:     'Composite: citations + timeline + factual consistency on strategy JSON/text',
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ available: VERIFICATION_TYPES, required_params: REQUIRED, notes: NOTES });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { verification_type } = body;

  if (!verification_type) {
    return res.status(400).json({ error: 'verification_type is required', available: VERIFICATION_TYPES });
  }
  if (!VERIFICATION_TYPES.includes(verification_type)) {
    return res.status(400).json({ error: `Unknown verification_type "${verification_type}"`, available: VERIFICATION_TYPES });
  }

  const missing = (REQUIRED[verification_type] ?? []).filter(k => !body[k]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  try {
    const result = await runVerification(body);
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Verification error [${verification_type}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
