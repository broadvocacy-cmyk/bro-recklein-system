import express from 'express';
import documentsHandler from '../frontend/api/documents.js';
import eventsHandler from '../frontend/api/events.js';
import flagsHandler from '../frontend/api/flags.js';
import ingestHandler from '../frontend/api/ingest.js';
import morningBriefHandler from '../frontend/api/morning_brief.js';
import notesHandler from '../frontend/api/notes.js';
import foiaRequestsHandler from '../frontend/api/foia_requests.js';
import peopleHandler from '../frontend/api/people.js';
import courtsHandler from '../frontend/api/courts.js';
import searchHandler from '../frontend/api/search.js';
import reportsHandler from '../frontend/api/reports.js';
import { executeAgent } from './agent_executor.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/documents',     documentsHandler);
app.get('/api/events',        eventsHandler);
app.get('/api/flags',         flagsHandler);
app.post('/api/ingest',       ingestHandler);
app.get('/api/morning_brief', morningBriefHandler);
app.get('/api/notes',            notesHandler);
app.post('/api/notes',           notesHandler);
app.get('/api/foia_requests',    foiaRequestsHandler);
app.post('/api/foia_requests',   foiaRequestsHandler);
app.patch('/api/foia_requests',  foiaRequestsHandler);
app.get('/api/people',           peopleHandler);
app.post('/api/people',          peopleHandler);
app.patch('/api/people',         peopleHandler);
app.delete('/api/people',        peopleHandler);
app.get('/api/courts',           courtsHandler);
app.post('/api/courts',          courtsHandler);
app.patch('/api/courts',         courtsHandler);
app.delete('/api/courts',        courtsHandler);
app.get('/api/search',           searchHandler);
app.get('/api/reports',          reportsHandler);

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
