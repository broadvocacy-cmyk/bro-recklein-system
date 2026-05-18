import { writeFlag } from './flags.js';
import { storeDocument } from './documents.js';

export async function routeToAgent(agentName, payload) {
  switch (agentName) {
    case 'preprocessor':
      return { normalized_text: payload.text };
    case 'flagging_agent':
      return await writeFlag(payload);
    case 'defense_strategist':
      return { strategy: "Generated strategy", recommended_actions: [] };
    case 'morning_brief':
      return { summary: "Generated morning brief" };
    default:
      throw new Error(`Unknown agent: ${agentName}`);
  }
}
