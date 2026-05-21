import { config } from './config.js';
import express from 'express';
import { requestLogger } from './middleware/logger.js';
import { healthHandler, statusHandler } from './routes/health.js';
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
import notificationsHandler from '../frontend/api/notifications.js';
import crossCaseHandler from '../frontend/api/cross_case.js';
import actorProfilesHandler from '../frontend/api/actor_profiles.js';
import exportsHandler from '../frontend/api/exports.js';
import workflowsHandler from '../frontend/api/workflows.js';
import researchHandler from '../frontend/api/research.js';
import verificationHandler from '../frontend/api/verification.js';
import { executeAgent } from './agent_executor.js';

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  const origin  = req.headers.origin;
  const allowed = config.corsOrigin;
  if (allowed === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health / Status ─────────────────────────────────────────────────────────

app.get('/api/health', healthHandler);
app.get('/api/status', statusHandler);

// ── Ingestion ───────────────────────────────────────────────────────────────

app.post('/api/ingest', ingestHandler);

// ── Core domain ─────────────────────────────────────────────────────────────

app.get('/api/documents',        documentsHandler);
app.get('/api/events',           eventsHandler);
app.get('/api/flags',            flagsHandler);
app.get('/api/morning_brief',    morningBriefHandler);

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

// ── Search, reports, notifications ─────────────────────────────────────────

app.get('/api/search',           searchHandler);
app.get('/api/reports',          reportsHandler);

app.get('/api/notifications',    notificationsHandler);
app.post('/api/notifications',   notificationsHandler);
app.patch('/api/notifications',  notificationsHandler);

// ── Analysis & exports ──────────────────────────────────────────────────────

app.get('/api/cross_case',       crossCaseHandler);
app.get('/api/actor_profiles',   actorProfilesHandler);
app.get('/api/exports',          exportsHandler);

// ── BRO workflows ───────────────────────────────────────────────────────────

app.get('/api/workflows',        workflowsHandler);
app.post('/api/workflows',       workflowsHandler);

// ── External research ────────────────────────────────────────────────────────

app.get('/api/research',         researchHandler);
app.post('/api/research',        researchHandler);

// ── Verification ─────────────────────────────────────────────────────────────

app.get('/api/verification',     verificationHandler);
app.post('/api/verification',    verificationHandler);

// ── Agent direct-call ───────────────────────────────────────────────────────

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

// ── 404 catch-all ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// ── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  console.log(`[${new Date().toISOString()}] Recklein Case Engine on port ${config.port} [${config.nodeEnv}]`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received — draining connections…`);
  server.close(() => {
    console.log('[shutdown] HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] Forced exit after 10s timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
