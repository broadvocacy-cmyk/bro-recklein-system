import {
  runDashboard,
  getCaseDashboard,
  getLatestDashboard,
} from '../../backend/dashboard_engine.js';

export default async function handler(req, res) {
  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { person_id, case_id } = req.query;

    if (!person_id && !case_id) {
      return res.status(200).json({
        description: 'Dashboard & Intelligence Hub — Module U',
        endpoints: {
          'GET  /api/dashboard':                                      'API documentation',
          'GET  /api/dashboard?person_id=<id>':                      'Latest cached intelligence hub for a person',
          'GET  /api/dashboard?case_id=<id>':                        'Single-case live dashboard (no synthesis)',
          'POST /api/dashboard':                                      'Regenerate intelligence hub with fresh Claude synthesis',
        },
        post_body: {
          required: {
            person_id: '<uuid>',
            case_ids:  ['<uuid>', '<uuid>'],
          },
        },
        response_sections: {
          threat_level:      'critical|high|medium|low — derived from open flags and notifications',
          intelligence_hub:  'priority_brief, immediate_actions[5], case_risk_summary, key_gaps',
          cases:             'Per-case cards with flag counts, hearing summary, module coverage',
          flags:             'summary counts + full open flag list',
          actor_intelligence:'judges and prosecutors deduped across cases',
          upcoming_hearings: 'Hearings within 7 days',
          timeline:          'Events from 60 days ago to 30 days ahead',
          overdue_foia:      'FOIA requests with status = overdue',
          notifications:     'All undismissed notifications',
          recent_documents:  'Last 20 documents filed',
          module_outputs:    'Metadata + excerpts for Modules O–T outputs',
        },
        integrations: [
          'Module O: defense_stack — per-case theory and timing',
          'Module P: scenario_engine — per-case outcome simulations',
          'Module Q: pressure_map — per-case leverage and escalation',
          'Module R: pattern_engine — cross-case actor and systemic patterns',
          'Module S: oversight_engine — 6 formal oversight reports',
          'Module T: watchdog_engine — real-time alert digest',
        ],
      });
    }

    // Single-case live dashboard
    if (case_id) {
      try {
        const result = await getCaseDashboard(case_id);
        return res.status(200).json(result);
      } catch (err) {
        console.error('[dashboard] case GET error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // Multi-case: return latest cached hub note
    if (person_id) {
      try {
        const result = await getLatestDashboard(person_id);
        if (!result) {
          return res.status(404).json({
            error: `No intelligence hub found for person ${person_id}. POST to generate.`,
          });
        }
        return res.status(200).json(result);
      } catch (err) {
        console.error('[dashboard] person GET error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }
  }

  // ── POST: generate / regenerate full intelligence hub ────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { person_id, case_ids } = body;

  if (!person_id)        return res.status(400).json({ error: 'person_id is required' });
  if (!case_ids?.length) return res.status(400).json({ error: 'case_ids array is required' });

  try {
    const result = await runDashboard({ person_id, case_ids });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[dashboard] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
