import express from 'express';
import documentsHandler from '../frontend/api/documents.js';
import eventsHandler from '../frontend/api/events.js';
import flagsHandler from '../frontend/api/flags.js';
import ingestHandler from '../frontend/api/ingest.js';
import morningBriefHandler from '../frontend/api/morning_brief.js';
import notesHandler from '../frontend/api/notes.js';
import { executeAgent } from './agent_executor.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/documents',     documentsHandler);
app.get('/api/events',        eventsHandler);
app.get('/api/flags',         flagsHandler);
app.post('/api/ingest',       ingestHandler);
app.get('/api/morning_brief', morningBriefHandler);
app.get('/api/notes',         notesHandler);
app.post('/api/notes',        notesHandler);

app.post('/api/agent/:agentName', async (req, res) => {
  const { agentName } = req.params;
  try {
    const result = await executeAgent(agentName, req.body);
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Agent error [${agentName}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recklein Case Engine running on port ${PORT}`);
});
