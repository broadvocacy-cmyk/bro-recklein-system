import {
  repeatedJudges,
  repeatedProsecutors,
  repeatedOfficers,
  repeatedFacilities,
  misconductPatterns,
  bradyViolationPatterns,
  flagTrend,
  eventTrend,
  foiaTrend,
  violationTrend
} from '../../backend/cross_case.js';

const ANALYSES = {
  repeated_judges:      () => repeatedJudges(),
  repeated_prosecutors: () => repeatedProsecutors(),
  repeated_officers:    () => repeatedOfficers(),
  repeated_facilities:  () => repeatedFacilities(),
  misconduct_patterns:  () => misconductPatterns(),
  brady_violations:     () => bradyViolationPatterns(),
  flag_trend:           (q) => flagTrend(q.interval || 'month'),
  event_trend:          (q) => eventTrend(q.interval || 'month'),
  foia_trend:           (q) => foiaTrend(q.interval || 'month'),
  violation_trend:      (q) => violationTrend(q.interval || 'month')
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { analysis, ...query } = req.query;

  if (!analysis) {
    return res.status(400).json({
      error:     'analysis param is required',
      available: Object.keys(ANALYSES)
    });
  }

  const fn = ANALYSES[analysis];
  if (!fn) {
    return res.status(400).json({
      error:     `Unknown analysis "${analysis}"`,
      available: Object.keys(ANALYSES)
    });
  }

  try {
    const result = await fn(query);
    return res.status(200).json({ analysis, ...result });
  } catch (err) {
    console.error(`Cross-case analysis error [${analysis}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
