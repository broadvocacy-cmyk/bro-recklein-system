import {
  runIntake,
  runFlagEscalation,
  runAdvocateWorkflow,
  runMultiStateAnalysis,
  runStrategyGeneration
} from '../../backend/workflows.js';

const WORKFLOWS = {
  intake:              (body) => runIntake(body),
  flag_escalation:     (body) => runFlagEscalation(body),
  advocate:            (body) => runAdvocateWorkflow(body),
  multi_state:         (body) => runMultiStateAnalysis(body),
  strategy_generation: (body) => runStrategyGeneration(body)
};

const REQUIRED = {
  intake:              ['case_id', 'person_id'],
  flag_escalation:     ['case_id'],
  advocate:            ['person_id', 'case_ids'],
  multi_state:         ['person_id', 'case_ids'],
  strategy_generation: ['case_id']
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      available: Object.keys(WORKFLOWS),
      required_params: REQUIRED
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workflow } = req.query;

  if (!workflow) {
    return res.status(400).json({
      error:     'workflow query param is required',
      available: Object.keys(WORKFLOWS)
    });
  }

  const fn = WORKFLOWS[workflow];
  if (!fn) {
    return res.status(400).json({
      error:     `Unknown workflow "${workflow}"`,
      available: Object.keys(WORKFLOWS)
    });
  }

  const body     = req.body ?? {};
  const required = REQUIRED[workflow] ?? [];
  const missing  = required.filter(k => !body[k]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  try {
    const result = await fn(body);
    if (result?.error) return res.status(400).json({ error: result.error });
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Workflow error [${workflow}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
