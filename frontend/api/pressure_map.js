import {
  runPressureMap,
  runCrossCasePressureMap,
  getLatestPressureMap,
} from '../../backend/pressure_map.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest pressure map note for a case ─────────────────────
  if (req.method === 'GET') {
    const { case_id } = req.query;
    if (!case_id) {
      return res.status(200).json({
        description: 'Pressure Map Engine',
        endpoints: {
          'GET  /api/pressure_map?case_id=<id>': 'Retrieve latest pressure map note for a case',
          'POST /api/pressure_map':              'Run full pressure map analysis',
        },
        post_body_options: {
          single_case:  { case_id: '<uuid>' },
          cross_case:   { person_id: '<uuid>', case_ids: ['<uuid>', '<uuid>'] },
        },
        output_sections: [
          'leverage_points       — scored 0–100, sorted by pressure_score',
          'escalation_paths      — step-by-step escalation sequences per target',
          'systemic_vulnerabilities — structural weaknesses exploitable across filings',
          'actor_pressure_strategies — tailored approach per judge and prosecutor',
          'timing_synergies      — combined-action amplifiers sorted by amplification_score',
          'cross_case_patterns   — TX/IL/MO unified pressure patterns',
          'priority_actions      — ranked, deadline-anchored next steps',
        ],
        integrations: [
          'Verified facts     — verification_agent notes (last 3)',
          'Behavioral models  — judgeProfile + prosecutorProfile from actor_profiles',
          'Scenario outputs   — scenario_engine notes (last 3)',
          'Defense stack      — defense_stack notes (latest)',
        ],
      });
    }

    try {
      const note = await getLatestPressureMap(case_id);
      if (!note) return res.status(404).json({ error: `No pressure map found for case ${case_id}` });
      return res.status(200).json(note);
    } catch (err) {
      console.error('[pressure_map] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: run analysis ────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { case_id, person_id, case_ids } = body;

  // Cross-case path
  if (person_id && case_ids?.length) {
    try {
      const result = await runCrossCasePressureMap({ person_id, case_ids });
      return res.status(200).json(result);
    } catch (err) {
      console.error('[pressure_map] cross-case error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Single-case path
  if (!case_id) {
    return res.status(400).json({
      error: 'case_id is required (or provide person_id + case_ids for cross-case)',
    });
  }

  try {
    const result = await runPressureMap({ case_id });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[pressure_map] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
