import {
  runScenario,
  getLatestSimulation,
  SCENARIO_TYPES,
} from '../../backend/scenario_engine.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest simulation for a case ────────────────────────────
  if (req.method === 'GET') {
    const { case_id } = req.query;
    if (!case_id) {
      return res.status(200).json({
        description: 'Scenario Simulation Engine',
        scenario_types: SCENARIO_TYPES,
        endpoints: {
          'GET  /api/scenario?case_id=<id>': 'Retrieve latest simulation note for a case',
          'POST /api/scenario':              'Run a scenario simulation',
        },
        post_body: {
          required: { case_id: '<uuid>', scenario_type: SCENARIO_TYPES.join('|') },
          optional: {
            what_if_question: 'Free-form question (required for what_if type)',
            parameters: {
              motion_type: 'For motion_outcome / motion_timing',
              theory_id:   'Theory ID from defense stack (for motion_timing)',
              action_type: 'Action being modeled (for actor_response)',
              actor_type:  'judge | prosecutor (for actor_response)',
            },
          },
        },
        examples: [
          { scenario_type: 'what_if',      what_if_question: 'What if we file the speedy trial motion today?', case_id: '<uuid>' },
          { scenario_type: 'motion_timing', parameters: { motion_type: 'motion_to_dismiss', theory_id: 'speedy_trial_tx' }, case_id: '<uuid>' },
          { scenario_type: 'actor_response', parameters: { action_type: 'brady_demand_letter', actor_type: 'prosecutor' }, case_id: '<uuid>' },
          { scenario_type: 'plea_leverage', case_id: '<uuid>' },
          { scenario_type: 'multi_state_conflict', case_id: '<uuid>' },
        ],
      });
    }

    try {
      const note = await getLatestSimulation(case_id);
      if (!note) return res.status(404).json({ error: `No simulation found for case ${case_id}` });
      return res.status(200).json(note);
    } catch (err) {
      console.error('[scenario] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: run simulation ──────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { case_id, scenario_type, parameters, what_if_question } = body;

  if (!case_id)       return res.status(400).json({ error: 'case_id is required' });
  if (!scenario_type) return res.status(400).json({ error: 'scenario_type is required' });

  if (scenario_type === 'what_if' && !what_if_question) {
    return res.status(400).json({ error: 'what_if_question is required for scenario_type "what_if"' });
  }

  try {
    const result = await runScenario({ case_id, scenario_type, parameters, what_if_question });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[scenario] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
