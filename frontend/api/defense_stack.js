import { runDefenseStack, runMultiCaseStack, getLatestStack } from '../../backend/defense_stack.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest stack note for a case ──────────────────────────────
  if (req.method === 'GET') {
    const { case_id } = req.query;
    if (!case_id) {
      return res.status(200).json({
        description: 'Advanced Defense Stacking Engine',
        endpoints: {
          'GET  /api/defense_stack?case_id=<id>': 'Retrieve latest stack note for a case',
          'POST /api/defense_stack':               'Run full defense stack analysis',
        },
        post_body_options: {
          single_case: { case_id: '<uuid>' },
          multi_case:  { person_id: '<uuid>', case_ids: ['<uuid>', '<uuid>'] },
        },
        stages: [
          '1. Theory generation — Claude Pro analyzes flags, events, docs, verified research + facts',
          '2. Ranking — JS scoring (evidence weight, viability, urgency, leverage)',
          '3. Stack plan — Claude Pro: sequencing, leverage map, timing windows',
          '4. Research — parallel CourtListener + Claude lookups for top theories',
          '5. Verification — citations, timeline, factual consistency on top theories',
        ],
      });
    }

    try {
      const note = await getLatestStack(case_id);
      if (!note) return res.status(404).json({ error: `No defense stack found for case ${case_id}` });
      return res.status(200).json(note);
    } catch (err) {
      console.error('[defense_stack] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: run analysis ──────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { case_id, person_id, case_ids } = body;

  // Multi-case path
  if (person_id && case_ids?.length) {
    try {
      const result = await runMultiCaseStack({ person_id, case_ids });
      return res.status(200).json(result);
    } catch (err) {
      console.error('[defense_stack] multi-case error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Single-case path
  if (!case_id) {
    return res.status(400).json({
      error: 'case_id is required (or provide person_id + case_ids for multi-state)',
    });
  }

  try {
    const result = await runDefenseStack({ case_id });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[defense_stack] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
