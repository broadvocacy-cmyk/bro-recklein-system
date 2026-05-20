import { supabase } from '../supabase_client.js';
import { config } from '../config.js';

const TABLES = ['cases', 'flags', 'documents', 'notifications'];

export async function healthHandler(req, res) {
  const checks = {};
  let allOk = true;

  for (const table of TABLES) {
    try {
      const { error } = await supabase.from(table).select('id').limit(1);
      if (error) {
        checks[`supabase_${table}`] = { status: 'error', message: error.message };
        allOk = false;
      } else {
        checks[`supabase_${table}`] = { status: 'ok' };
      }
    } catch (e) {
      checks[`supabase_${table}`] = { status: 'error', message: e.message };
      allOk = false;
    }
  }

  checks.anthropic_key = process.env.ANTHROPIC_API_KEY
    ? { status: 'ok' }
    : { status: 'error', message: 'ANTHROPIC_API_KEY not set' };
  if (!process.env.ANTHROPIC_API_KEY) allOk = false;

  return res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    env:    config.nodeEnv,
    checks,
    ts:     new Date().toISOString(),
  });
}

export function statusHandler(req, res) {
  return res.status(200).json({
    service: 'Recklein Case Engine',
    version: '1.0.0',
    env:     config.nodeEnv,
    uptime:  Math.floor(process.uptime()),
    ts:      new Date().toISOString(),
  });
}
