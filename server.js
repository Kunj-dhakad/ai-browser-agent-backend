/**
 * server.js
 * ---------------------------------------------------------------------------
 * Express API in front of the Playwright browser agent.
 *
 *   GET  /health               Liveness + agent status (no auth).
 *   POST /api/agent/parse      Preview how a prompt is interpreted (no browser).
 *   POST /api/agent/run        Run a command, respond once with all logs (JSON).
 *   POST /api/agent/stream     Run a command, stream logs live (Server-Sent Events).
 *   GET  /api/agent/screencast Live browser preview: JPEG frames as SSE (base64).
 *   GET  /api/agent/session    Is the browser profile signed in to Google?
 *   POST /api/agent/plan       { prompt } -> AI plan (OpenAI): the task, with the email written for you.
 *
 *   Runs (used by the dashboard; a run keeps going and can be re-watched after a page refresh):
 *   POST /api/agent/runs              Start a run from a (reviewed) { task, prompt? }, or from { prompt }
 *                                     alone (planned with AI first). Returns its id.
 *   GET  /api/agent/runs              Recent runs (newest first).
 *   GET  /api/agent/runs/:id          One run with its logs and report.
 *   GET  /api/agent/runs/:id/stream   SSE: replays past logs, then live logs, then the result.
 *
 *   Schedules (saved in data/schedules.json; see scheduler.js):
 *   GET    /api/agent/schedules        All schedules.
 *   POST   /api/agent/schedules        { task, prompt?, frequency: once|daily|weekly, time: "HH:MM", date?, weekday? }
 *   DELETE /api/agent/schedules/:id    Remove a schedule.
 *
 * Request body for parse/run/stream: { "prompt": "Send an email to ...", "dryRun"?: boolean }
 * Auth: send the `x-api-key` header when AGENT_API_KEY is set.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const cors = require('cors');
const {
  runBrowserAgent,
  parseCommand,
  validateTask,
  checkSession,
  closeBrowser,
  getStatus,
  subscribeViewport,
  getViewportSnapshot,
  AgentError,
  CONFIG,
} = require('./agent');
const { planTask, createSummarizer, aiStatus } = require('./planner');
const { startScheduler, stopScheduler, createSchedule, listSchedules, deleteSchedule } = require('./scheduler');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const API_KEY = process.env.AGENT_API_KEY || '';
const MAX_PROMPT_LENGTH = 2000;

const app = express();

// ---------------------------------------------------------------------------
// CORS: allow the configured frontends (Next.js on Vercel / Amplify / localhost)
// ---------------------------------------------------------------------------

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // they are still protected by the API key.
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false); // Browser will block the response.
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '32kb' }));

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Constant-time API key check. Disabled when AGENT_API_KEY is empty. */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    return next();
  }
  return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing x-api-key header.' } });
}

/** Validates `req.body.prompt` and stores the trimmed value on `req.prompt`. */
function validatePrompt(req, res, next) {
  const prompt = req.body && req.body.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_PROMPT', message: 'Body must include a non-empty "prompt" string.' } });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res
      .status(400)
      .json({ success: false, error: { code: 'INVALID_PROMPT', message: `Prompt must be at most ${MAX_PROMPT_LENGTH} characters.` } });
  }
  req.prompt = prompt.trim();
  next();
}

/** Maps agent error codes to HTTP status codes. */
function statusForError(code) {
  switch (code) {
    case 'INVALID_PROMPT':
    case 'INVALID_TASK':
    case 'INVALID_SCHEDULE':
    case 'NEEDS_INFO':
    case 'UNSUPPORTED_TASK':
      return 400;
    case 'AI_RATE_LIMIT':
      return 429;
    case 'AI_AUTH':
    case 'AI_QUOTA':
    case 'AI_MODEL':
    case 'AI_UNREACHABLE':
    case 'AI_ERROR':
      return 502; // the upstream AI service failed, not this server
    case 'CONTACT_NOT_FOUND':
      return 422;
    case 'LOGIN_REQUIRED':
    case 'PROFILE_IN_USE':
    case 'BROWSER_NOT_INSTALLED':
      return 503;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), agent: getStatus(), ai: aiStatus() });
});

app.use('/api', requireApiKey);

/** Dry interpretation of a prompt: useful for showing the user what will happen before running it. */
app.post('/api/agent/parse', validatePrompt, (req, res) => {
  try {
    res.json({ success: true, task: parseCommand(req.prompt) });
  } catch (err) {
    const code = err instanceof AgentError ? err.code : 'UNKNOWN';
    res.status(statusForError(code)).json({ success: false, error: { code, message: err.message } });
  }
});

/** Runs the agent and returns the full report (task, result, step logs) in one JSON response. */
app.post('/api/agent/run', validatePrompt, async (req, res, next) => {
  try {
    const report = await runBrowserAgent(req.prompt, { dryRun: req.body.dryRun === true });
    res.status(report.success ? 200 : statusForError(report.error.code)).json(report);
  } catch (err) {
    next(err);
  }
});

/**
 * Runs the agent and streams each log entry as it happens using Server-Sent Events.
 * Events:  log -> { step, time, level, message, data? }
 *          result -> final report (same shape as /api/agent/run)
 * POST is used (instead of EventSource/GET) so the prompt and API key stay out of URLs;
 * read it from the frontend with fetch() + response.body.getReader().
 */
app.post('/api/agent/stream', validatePrompt, async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable proxy buffering (nginx / some PaaS).
  });
  res.flushHeaders();

  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

  const send = (event, payload) => {
    if (clientGone) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // Comment lines keep idle connections alive through load balancers during long typing steps.
  const heartbeat = setInterval(() => {
    if (!clientGone) res.write(': ping\n\n');
  }, 15000);

  try {
    // The task keeps running even if the client disconnects: stopping halfway
    // through composing an email would leave Gmail in an unknown state.
    const report = await runBrowserAgent(req.prompt, {
      dryRun: req.body.dryRun === true,
      onLog: (entry) => send('log', entry),
    });
    send('result', report);
  } catch (err) {
    send('result', { success: false, error: { code: 'UNKNOWN', message: err.message }, logs: [] });
  } finally {
    clearInterval(heartbeat);
    if (!clientGone) res.end();
  }
});

/**
 * Live browser preview. Stays open; any number of dashboards can watch.
 * Events:  state -> { active, url }        (a task started/stopped or navigated)
 *          frame -> { data, width, height, url, time }   (data = base64 JPEG)
 * On connect the viewer gets the current state and the last frame immediately.
 * Frames are rate-limited per viewer and only the newest is kept, so a slow
 * connection sees fewer frames instead of an ever-growing delay.
 */
app.get('/api/agent/screencast', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const minIntervalMs = 1000 / Math.max(1, CONFIG.screencast.maxFps);
  let closed = false;
  let blocked = false; // socket buffer full; wait for 'drain'
  let pending = null; // newest frame not yet sent
  let lastSentAt = 0;
  let timer = null;

  const write = (event, payload) => (closed ? true : res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));

  const sendPending = () => {
    timer = null;
    if (closed || blocked || !pending) return;
    const frame = pending;
    pending = null;
    lastSentAt = Date.now();
    if (!write('frame', frame)) {
      blocked = true;
      res.once('drain', () => {
        blocked = false;
        schedule();
      });
    }
  };

  function schedule() {
    if (timer || blocked || !pending) return;
    timer = setTimeout(sendPending, Math.max(0, lastSentAt + minIntervalMs - Date.now()));
  }

  const onFrame = (frame) => {
    pending = frame; // older unsent frames are simply replaced
    schedule();
  };
  const onState = (state) => write('state', state);

  const { state, lastFrame } = getViewportSnapshot();
  write('state', state);
  if (lastFrame) onFrame(lastFrame);
  const unsubscribe = subscribeViewport(onFrame, onState);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  res.on('close', () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** Is the saved browser profile signed in to Google? `?refresh=1` skips the 1-minute cache. */
app.get('/api/agent/session', async (req, res, next) => {
  try {
    res.json(await checkSession({ force: req.query.refresh === '1' }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Runs: start a task on one page, watch it on another (refresh-safe)
// ---------------------------------------------------------------------------

const MAX_RUNS = 50; // kept in memory; lost when the server restarts
const RUN_TTL_MS = 60 * 60 * 1000;
const runs = new Map(); // id -> run (Map keeps insertion order: oldest first)

const isFinished = (run) => run.status === 'success' || run.status === 'error';

function runSummary(run) {
  return {
    id: run.id,
    source: run.source, // "form" | "prompt"
    prompt: run.prompt,
    scheduled: run.scheduled || undefined, // started by the scheduler
    task: run.task,
    status: run.status, // "running" | "success" | "error"
    createdAt: new Date(run.createdAt).toISOString(),
    durationMs: run.report ? run.report.durationMs : undefined,
    error: run.report && run.report.error ? run.report.error : undefined,
  };
}

function pruneRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (runs.size <= MAX_RUNS && now - run.createdAt < RUN_TTL_MS) break;
    if (isFinished(run)) runs.delete(id);
  }
}

/** Starts a run of an already validated task in the background and returns it immediately. */
function startRun({ task, prompt, dryRun, scheduled = false }) {
  const run = {
    id: crypto.randomUUID(),
    scheduled,
    source: prompt ? 'prompt' : 'form',
    prompt, // the user's original words, kept for display and for the AI summary
    task: dryRun && task.type === 'send_email' ? { ...task, sendMode: 'draft' } : task,
    status: 'running',
    logs: [],
    report: null,
    createdAt: Date.now(),
    events: new EventEmitter(),
  };
  run.events.setMaxListeners(50);
  runs.set(run.id, run);
  pruneRuns();

  const finish = (report) => {
    run.report = report;
    if (report.task) run.task = report.task;
    run.status = report.success ? 'success' : 'error';
    run.events.emit('done', report);
  };

  runBrowserAgent(task, {
    dryRun,
    postProcess: createSummarizer(prompt), // AI summary of search/inbox results (no-op when AI is off)
    onLog: (entry) => {
      run.logs.push(entry);
      run.events.emit('log', entry);
    },
  })
    .then(finish)
    .catch((err) => finish({ success: false, error: { code: 'UNKNOWN', message: err.message }, logs: run.logs }));

  return run;
}

/** Opens a Server-Sent Events response with a heartbeat. */
function openSse(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  const onCloseHandlers = [];
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    onCloseHandlers.forEach((fn) => fn());
  });
  return {
    send: (event, payload) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end: () => {
      if (!closed) res.end();
    },
    onClose: (fn) => onCloseHandlers.push(fn),
  };
}

const sendError = (res, err) => {
  const code = err instanceof AgentError ? err.code : 'UNKNOWN';
  res.status(statusForError(code)).json({ success: false, error: { code, message: err.message } });
};

/** Checks an optional/required prompt string and returns it trimmed. */
function readPrompt(prompt, required) {
  if (prompt === undefined && !required) return undefined;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw new AgentError('INVALID_PROMPT', `"prompt" must be 1-${MAX_PROMPT_LENGTH} characters.`);
  }
  return prompt.trim();
}

/**
 * Plan with AI: { prompt } -> { ai, model, task, summary }. Nothing runs yet, so the
 * dashboard can show the AI-written email for the user to check and edit first.
 * Without OPENAI_API_KEY this uses the rule-based parser (ai: false).
 */
app.post('/api/agent/plan', async (req, res) => {
  try {
    const prompt = readPrompt(req.body && req.body.prompt, true);
    res.json({ success: true, ...(await planTask(prompt)) });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Start a run. Body (plus optional dryRun):
 *   { task: {...}, prompt?: "original words" }   run this exact (e.g. reviewed) task
 *   { prompt: "..." }                            plan with AI first, then run
 * Input is checked here, so mistakes come back as 4xx before any browser work.
 */
app.post('/api/agent/runs', async (req, res) => {
  const { prompt: promptInput, task: taskInput, dryRun } = req.body || {};
  try {
    let task;
    let prompt;
    if (taskInput !== undefined) {
      task = validateTask(taskInput);
      prompt = readPrompt(promptInput, false);
    } else {
      prompt = readPrompt(promptInput, true);
      task = (await planTask(prompt)).task;
    }
    const run = startRun({ task, prompt, dryRun: dryRun === true });
    res.status(202).json({ success: true, run: runSummary(run) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

app.get('/api/agent/schedules', (req, res) => {
  res.json({ schedules: listSchedules() });
});

app.post('/api/agent/schedules', (req, res) => {
  try {
    res.status(201).json({ success: true, schedule: createSchedule(req.body) });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/agent/schedules/:id', (req, res) => {
  if (deleteSchedule(req.params.id)) return res.json({ success: true });
  res.status(404).json({ success: false, error: { code: 'SCHEDULE_NOT_FOUND', message: 'This schedule no longer exists.' } });
});

app.get('/api/agent/runs', (req, res) => {
  res.json({ runs: [...runs.values()].reverse().map(runSummary) });
});

function findRun(req, res) {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({
      success: false,
      error: { code: 'RUN_NOT_FOUND', message: 'This run does not exist (runs are forgotten after a server restart or 1 hour).' },
    });
  }
  return run;
}

app.get('/api/agent/runs/:id', (req, res) => {
  const run = findRun(req, res);
  if (run) res.json({ run: { ...runSummary(run), logs: run.logs, report: run.report } });
});

/**
 * Watch a run. Events: run (summary), log (each step; past ones replayed first), result (final report).
 * The stream ends after "result", so a page refresh simply replays everything.
 */
app.get('/api/agent/runs/:id/stream', (req, res) => {
  const run = findRun(req, res);
  if (!run) return;
  const sse = openSse(res);
  sse.send('run', runSummary(run));
  run.logs.forEach((entry) => sse.send('log', entry));
  if (run.report) {
    sse.send('result', run.report);
    return sse.end();
  }
  const onLog = (entry) => sse.send('log', entry);
  const onDone = (report) => {
    sse.send('run', runSummary(run));
    sse.send('result', report);
    sse.end();
  };
  run.events.on('log', onLog);
  run.events.once('done', onDone);
  sse.onClose(() => {
    run.events.off('log', onLog);
    run.events.off('done', onDone);
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// Central error handler (malformed JSON, unexpected exceptions).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
});

// ---------------------------------------------------------------------------
// Startup / graceful shutdown
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[server] AI Browser Agent listening on http://localhost:${PORT}`);
  console.log(`[server] Allowed origins: ${allowedOrigins.join(', ')}`);
  if (!API_KEY) console.warn('[server] WARNING: AGENT_API_KEY is empty, so the API is unauthenticated. Set it before exposing this server.');
  startScheduler(startRun); // runs scheduled tasks when they're due
});

// SSE responses can legitimately stay open for minutes.
server.requestTimeout = 0;
server.headersTimeout = 65000;

async function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  stopScheduler();
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[server] Unhandled rejection:', reason));
