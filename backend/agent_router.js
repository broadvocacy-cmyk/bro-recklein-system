import { writeFlag } from './flags.js';
import { storeDocument } from './documents.js';

export async function routeToAgent(agentName, payload) {
  switch (agentName) {
    case 'preprocessor':
      return { normalized_text: payload.text };
    case 'flagging_agent':
      return await writeFlag(payload);
    case 'defense_strategist':
    case 'morning_brief':
    case 'thought_partner_bridge':
    case 'brady_monitor':
    case 'judge_pattern':
    case 'case_researcher':
    // Module M–U agents — dedicated endpoints handle full pipelines;
    // falling through to generic Claude call with system prompt for direct queries
    case 'research_agent':
    case 'verification_agent':
    case 'defense_stack_agent':
    case 'scenario_agent':
    case 'pressure_map_agent':
    case 'pattern_engine_agent':
    case 'oversight_agent':
    case 'watchdog_agent':
    case 'dashboard_agent':
      return null;
    default:
      throw new Error(`Unknown agent: ${agentName}`);
  }
}
