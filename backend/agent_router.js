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
      return null;
    default:
      throw new Error(`Unknown agent: ${agentName}`);
  }
}
