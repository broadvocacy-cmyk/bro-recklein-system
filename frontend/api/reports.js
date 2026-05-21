import {
  caseSummary,
  foiaSummary,
  upcomingDeadlines,
  missedDeadlines,
  criticalEvents,
  flagSummary,
  judgeStats,
  prosecutorStats,
  peopleByRole
} from '../../backend/reports.js';

const REPORTS = {
  case_summary:       ()  => caseSummary(),
  foia_summary:       ()  => foiaSummary(),
  upcoming_deadlines: (q) => upcomingDeadlines(q.days ? parseInt(q.days, 10) : undefined),
  missed_deadlines:   ()  => missedDeadlines(),
  critical_events:    ()  => criticalEvents(),
  flag_summary:       ()  => flagSummary(),
  judge_stats:        ()  => judgeStats(),
  prosecutor_stats:   ()  => prosecutorStats(),
  people_by_role:     ()  => peopleByRole()
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { report, ...query } = req.query;

  if (!report) {
    return res.status(400).json({
      error:     'report param is required',
      available: Object.keys(REPORTS)
    });
  }

  const fn = REPORTS[report];
  if (!fn) {
    return res.status(400).json({
      error:     `Unknown report "${report}"`,
      available: Object.keys(REPORTS)
    });
  }

  try {
    const result = await fn(query);
    if (result?.error) return res.status(500).json({ error: result.error });
    return res.status(200).json({ report, ...result });
  } catch (err) {
    console.error(`Report error [${report}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
