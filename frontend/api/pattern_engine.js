import {
  runPatternAnalysis,
  getLatestPatternAnalysis,
} from '../../backend/pattern_engine.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest pattern analysis for a person ───────────────────
  if (req.method === 'GET') {
    const { person_id } = req.query;
    if (!person_id) {
      return res.status(200).json({
        description: 'Multi-Case Pattern Engine',
        endpoints: {
          'GET  /api/pattern_engine?person_id=<id>': 'Retrieve latest pattern analysis for a person',
          'POST /api/pattern_engine':                'Run multi-case pattern analysis',
        },
        post_body: {
          required: { person_id: '<uuid>', case_ids: ['<uuid>', '<uuid>'] },
        },
        output_sections: [
          'repeated_actors       — actors across 2+ cases, scored and sorted by pattern_score',
          'systemic_patterns     — recurring violation types with legal theory and recommended filing',
          'foia_patterns         — FOIA non-compliance by agency with Brady implication',
          'facility_patterns     — custody facility failures across cases',
          'prosecutorial_trends  — Brady/FOIA compliance trajectory for prosecutor',
          'judicial_trends       — delay/continuation pattern trajectory for judge',
          'cross_module_insights — convergences across Modules M–Q outputs',
          'priority_findings     — ranked, urgency-ordered actionable findings',
        ],
        integrations: [
          'Module M: research_agent notes (2 most recent per case)',
          'Module N: verification_agent notes (2 most recent per case)',
          'Module O: defense_stack notes (most recent per case)',
          'Module P: scenario_engine notes (2 most recent per case)',
          'Module Q: pressure_map notes (most recent per case)',
          'Module I: judgeProfile + prosecutorProfile for top repeated actors',
        ],
      });
    }

    try {
      const note = await getLatestPatternAnalysis(person_id);
      if (!note) return res.status(404).json({ error: `No pattern analysis found for person ${person_id}` });
      return res.status(200).json(note);
    } catch (err) {
      console.error('[pattern_engine] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: run analysis ────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { person_id, case_ids } = body;

  if (!person_id)          return res.status(400).json({ error: 'person_id is required' });
  if (!case_ids?.length)   return res.status(400).json({ error: 'case_ids array is required (minimum 1)' });

  try {
    const result = await runPatternAnalysis({ person_id, case_ids });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[pattern_engine] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
