import {
  runReport,
  runAllReports,
  getLatestReport,
  REPORT_TYPES,
} from '../../backend/oversight_engine.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest report(s) for a person ───────────────────────────
  if (req.method === 'GET') {
    const { person_id, report_type } = req.query;
    if (!person_id) {
      return res.status(200).json({
        description: 'Oversight & Reporting Engine',
        report_types: REPORT_TYPES,
        endpoints: {
          'GET  /api/oversight?person_id=<id>':                        'Retrieve latest report of each type for a person',
          'GET  /api/oversight?person_id=<id>&report_type=<type>':     'Retrieve latest report of a specific type',
          'POST /api/oversight':                                        'Generate one or all oversight reports',
        },
        post_body: {
          required: { person_id: '<uuid>', case_ids: ['<uuid>', '<uuid>'] },
          optional: { report_type: REPORT_TYPES.join('|') + ' — omit to generate all 6' },
        },
        report_types_detail: {
          misconduct_report:          'Formal misconduct complaint — Bar Association / Judicial Conduct Commission',
          foia_compliance_summary:    'FOIA compliance analysis with Brady implications — court filing / agency complaint',
          judicial_behavior_report:   'Judge delay and bias analysis — recusal motion / appellate brief',
          prosecutor_behavior_report: 'Brady and FOIA compliance analysis — sanctions motion / bar referral',
          facility_report:            '8th Amendment conditions complaint — jail administration / civil rights division',
          systemic_summary:           'Executive summary — advocacy / media / legislative referral',
        },
        integrations: [
          'Module M: research_agent — statutes and case law for supporting_citations',
          'Module N: verification_agent — confirmed facts for status: "confirmed" findings',
          'Module O: defense_stack — theory framing for misconduct findings',
          'Module P: scenario_engine — probability estimates in finding context',
          'Module Q: pressure_map — leverage points and escalation paths for recommendations',
          'Module R: pattern_engine — primary source for repeated actors and systemic patterns',
          'Module I: actor profiles — judge and prosecutor behavioral metrics',
        ],
      });
    }

    if (report_type && !REPORT_TYPES.includes(report_type)) {
      return res.status(400).json({ error: `Invalid report_type. Valid: ${REPORT_TYPES.join(', ')}` });
    }

    try {
      const result = await getLatestReport(person_id, report_type ?? null);
      if (!result || (Array.isArray(result) && !result.length)) {
        return res.status(404).json({ error: `No reports found for person ${person_id}` });
      }
      return res.status(200).json(result);
    } catch (err) {
      console.error('[oversight] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: generate report(s) ──────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { person_id, case_ids, report_type } = body;

  if (!person_id)        return res.status(400).json({ error: 'person_id is required' });
  if (!case_ids?.length) return res.status(400).json({ error: 'case_ids array is required' });

  if (report_type && !REPORT_TYPES.includes(report_type)) {
    return res.status(400).json({ error: `Invalid report_type. Valid: ${REPORT_TYPES.join(', ')}` });
  }

  try {
    const result = report_type
      ? await runReport({ person_id, case_ids, report_type })
      : await runAllReports({ person_id, case_ids });

    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[oversight] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
