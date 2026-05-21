import { runWatchdog, getLatestAlerts, ALERT_TYPES } from '../../backend/watchdog_engine.js';

export default async function handler(req, res) {
  // ── GET: retrieve latest alert digest for a person ────────────────────────
  if (req.method === 'GET') {
    const { person_id } = req.query;

    if (!person_id) {
      return res.status(200).json({
        description: 'Alerts & Watchdog Engine',
        alert_types: ALERT_TYPES,
        endpoints: {
          'GET  /api/watchdog?person_id=<id>': 'Retrieve latest alert digest for a person',
          'POST /api/watchdog':                'Run watchdog engine across one or more cases',
        },
        post_body: {
          required: {
            person_id: '<uuid>',
            case_ids:  ['<uuid>', '<uuid>'],
          },
        },
        alert_types_detail: {
          speedy_trial_violation:  'Statutory limit exceeded — file immediately',
          speedy_trial_warning:    '≥ 75% of limit elapsed — prepare motion',
          speedy_trial_approaching:'≥ 50% elapsed — monitor and calendar',
          foia_brady_risk:         'Overdue FOIA with Brady material exposure',
          brady_risk:              'Open Brady flag or undisclosed Brady material',
          hearing_upcoming:        'Hearing within 7 days — confirm attendance',
          hearing_missed:          'Hearing marked missed with no follow-up',
          hearing_continuations:   '3+ continuations — systemic delay pattern',
          extradition_conflict:    '2+ active cases across states — custody conflict',
          extradition_violation:   'IADA / proper-process violation detected',
          service_failure:         'Service of process failed or undocumented',
          facility_delay:          'Transport or custody facility causing delay',
        },
        integrations: [
          'Module A: cases — speedy trial timers and jurisdiction',
          'Module C: flags — Brady and service failure signals',
          'Module D: events — hearing and transport tracking',
          'Module E: FOIA — overdue FOIA with Brady exposure',
          'Module G: notifications — dedup and alert delivery',
          'All alerts saved as note_type: "alert" against person_id',
        ],
      });
    }

    try {
      const result = await getLatestAlerts(person_id);
      if (!result) {
        return res.status(404).json({ error: `No alert digest found for person ${person_id}` });
      }
      return res.status(200).json(result);
    } catch (err) {
      console.error('[watchdog] GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: run watchdog engine ─────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};
  const { person_id, case_ids } = body;

  if (!person_id)        return res.status(400).json({ error: 'person_id is required' });
  if (!case_ids?.length) return res.status(400).json({ error: 'case_ids array is required' });

  try {
    const result = await runWatchdog({ person_id, case_ids });
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[watchdog] run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
