import { anthropic } from './anthropic_client.js';
import { routeToAgent } from './agent_router.js';
import fs from 'fs';
import path from 'path';

const MODEL = 'claude-sonnet-4-6';

function loadAgentPrompt(agentName) {
  const agentPath = path.resolve(`./agents/${agentName}.md`);
  if (fs.existsSync(agentPath)) {
    return fs.readFileSync(agentPath, 'utf-8');
  }
  return `You are the ${agentName} agent for the Recklein Case Engine.`;
}

export async function executeAgent(agentName, payload) {
  const routerResult = await routeToAgent(agentName, payload);
  if (routerResult !== null) {
    return routerResult;
  }

  const systemPrompt = loadAgentPrompt(agentName);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: JSON.stringify(payload)
      }
    ]
  });

  const raw = response.content[0].text;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw_output: raw };
  }
}
