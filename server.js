/**
 * server.js
 * ---------------------------------------------------------------------------
 * Express API in front of the Playwright browser agent (multi-user).
 *
 *   GET  /health                    Liveness + server-wide status (no auth, no user data).
 *
 *   Every /api route needs the x-api-key header (sent by the Next.js proxy). Every route
 *   except /api/auth/login also needs "Authorization: Bearer <token>" for a signed-in user
 *   (a token from our own login, or with AUTH_MODE=php one signed by the PHP app);
 *   everything below only ever sees and changes that user's own data.
 *
 *   Auth
 *   POST /api/auth/login            { email, password } -> { token, user }  (not with AUTH_MODE=php)
 *   GET  /api/auth/me               The signed-in user.
 *
 *   Admin (role "admin")
 *   GET    /api/admin/users         All users, with Gmail status and today's usage.
 *   POST   /api/admin/users         { email, name, password, role?, dailyEmailLimit? }
 *   PATCH  /api/admin/users/:id     { name?, role?, disabled?, password?, dailyEmailLimit? }
 *   DELETE /api/admin/users/:id     Removes the user, their browser profile and schedules.
 *
 *   Agent (the signed-in user's own browser, Gmail, runs and schedules)
 *   POST /api/agent/plan            { prompt } -> AI plan: the task, with the email written for you.
 *   POST /api/agent/parse           Rule-based interpretation of a prompt (no browser).
 *   POST /api/agent/run             Run a command, respond once with all logs (JSON).
 *   POST /api/agent/stream          Run a command, stream logs live (SSE).
 *   GET  /api/agent/screencast      Live preview of the user's browser (SSE of JPEG frames).
 *   GET  /api/agent/screencast/frame ?after=<ms> -> newest frame (polling alternative).
 *   GET  /api/agent/session         Is the user's agent browser signed in to Google?
 *   GET  /api/agent/login           Is a Gmail sign-in in progress?
 *   POST /api/agent/login/start     Open Google's sign-in page (Connect Gmail).
 *   POST /api/agent/login/input     { type: click, x, y (0-1) } | { type: type, text } | { type: key, key } | { type: scroll, deltaY }
 *   POST /api/agent/login/cancel    Close the sign-in page.
 *   POST /api/agent/logout          Sign the user's agent browser out of Google.
 *   POST /api/agent/runs            Start a run from a reviewed { task, prompt? } or from { prompt }.
 *   GET  /api/agent/runs            The user's recent runs.
 *   GET  /api/agent/runs/:id        One run with its logs and report.
 *   GET  /api/agent/runs/:id/stream SSE: past logs, then live logs, then the result.
 *   GET  /api/agent/schedules       The user's schedules.
 *   POST /api/agent/schedules       { task, prompt?, frequency: once|daily|weekly, time: "HH:MM", date?, weekday? }
 *   DELETE /api/agent/schedules/:id Remove one of the user's schedules.
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
  startLogin,
  sendLoginInput,
  cancelLogin,
  loginStatus,
  logoutGmail,
  removeUserData,
  closeBrowser,
  getStatus,
  subscribeViewport,
  getViewportSnapshot,
  AgentError,
  CONFIG,
} = require('./agent');
const { planTask, createSummarizer, aiStatus } = require('./planner');
const { startScheduler, stopScheduler, createSchedule, listSchedules, deleteSchedule, deleteUserSchedules } = require('./scheduler');
const { users, usage, publicUser } = require('./db');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const API_KEY = process.env.AGENT_API_KEY || '';
const MAX_PROMPT_LENGTH = 2000;
// Who signs users in: "local" (this app's own login page), "php" (the PHP app gives each user a
// signed token; see auth.verifyPhpToken) or "both".
const AUTH_MODE = ['local', 'php', 'both'].includes(process.env.AUTH_MODE) ? process.env.AUTH_MODE : 'local';

const app = express();
app.set('trust proxy', 'loopback'); // the Next.js proxy / Caddy run on this machine

// ---------------------------------------------------------------------------
// CORS: allow the configured frontends
// ---------------------------------------------------------------------------

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** "https://*.example.com" in CORS_ORIGINS allows every subdomain of example.com (https only). */
function originAllowed(origin) {
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  return allowedOrigins.some((o) => {
    const m = o.match(/^(https?):\/\/\*\.(.+)$/);
    if (!m) return false;
    try {
      const u = new URL(origin);
      return u.protocol === m[1] + ':' && u.hostname.endsWith('.' + m[2]) && !u.port;
    } catch {
      return false;
    }
  });
}

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed;
      // they are still protected by the API key and the user token.
      if (!origin || originAllowed(origin)) {
        return callback(null, true);
      }
      return callback(null, false); // Browser will block the response.
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '32kb' }));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Maps error codes to HTTP status codes. */
function statusForError(code) {
  switch (code) {
    case 'INVALID_PROMPT':
    case 'INVALID_TASK':
    case 'INVALID_SCHEDULE':
    case 'INVALID_INPUT':
    case 'INVALID_USER':
    case 'NEEDS_INFO':
    case 'UNSUPPORTED_TASK':
      return 400;
    case 'UNAUTHENTICATED':
    case 'BAD_LOGIN':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
    case 'RUN_NOT_FOUND':
    case 'SCHEDULE_NOT_FOUND':
    case 'USER_NOT_FOUND':
      return 404;
    case 'ALREADY_LOGGED_IN':
    case 'NO_LOGIN':
    case 'EMAIL_TAKEN':
      return 409;
    case 'CONTACT_NOT_FOUND':
      return 422;
    case 'AI_RATE_LIMIT':
    case 'DAILY_LIMIT':
    case 'TOO_MANY_ATTEMPTS':
      return 429;
    case 'AI_AUTH':
    case 'AI_QUOTA':
    case 'AI_MODEL':
    case 'AI_UNREACHABLE':
    case 'AI_ERROR':
      return 502; // the upstream AI service failed, not this server
    case 'BROWSERS_BUSY':
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

const fail = (code, message) => {
  throw new AgentError(code, message);
};

const sendError = (res, err) => {
  const code = err instanceof AgentError ? err.code : 'UNKNOWN';
  if (code === 'UNKNOWN') console.error('[server] Error:', err);
  res.status(statusForError(code)).json({ success: false, error: { code, message: err.message } });
};

/** Wraps an async route so thrown errors become JSON error responses. */
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Middleware: API key (from the proxy) + signed-in user
// ---------------------------------------------------------------------------

/** Constant-time API key check. Disabled when AGENT_API_KEY is empty. */
// Called straight from the user's browser (PHP "AI Agent (Direct)" page: live picture and
// typing into Google's sign-in), so without the API key, which stays on the servers. They
// still need the user's token (requireUser), and only reach that user's own browser.
const BROWSER_DIRECT = new Set(['GET /api/agent/screencast', 'GET /api/agent/screencast/frame', 'GET /api/agent/login', 'POST /api/agent/login/input']);

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (BROWSER_DIRECT.has(`${req.method} ${req.baseUrl}${req.path}`)) return next();
  const provided = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return next();
  return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing x-api-key header.' } });
}

/** The signed-in user for a token: our own login (AUTH_MODE local/both) or the PHP app's (php/both). */
function userFromToken(token) {
  if (AUTH_MODE !== 'php') {
    const claims = auth.verifyToken(token);
    if (claims) return users.get(claims.uid);
  }
  if (AUTH_MODE !== 'local') {
    const claims = auth.verifyPhpToken(token);
    if (claims) {
      const limit = Number(claims.limit);
      return users.fromExternal({
        externalId: claims.sub,
        email: claims.email,
        name: claims.name,
        dailyEmailLimit: Number.isInteger(limit) ? limit : null,
      });
    }
  }
  return null;
}

/** Loads the signed-in user from "Authorization: Bearer <token>" into req.user. */
function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  // ?access_token= only for GET: EventSource (the live picture stream) can't send headers.
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.method === 'GET' ? String(req.query.access_token || '') : '';
  const user = token ? userFromToken(token) : null;
  if (!user || user.disabled) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only admins can do this.' } });
  }
  next();
}

/** Validates `req.body.prompt` and stores the trimmed value on `req.prompt`. */
function validatePrompt(req, res, next) {
  try {
    req.prompt = readPrompt(req.body && req.body.prompt, true);
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/** Checks an optional/required prompt string and returns it trimmed. */
function readPrompt(prompt, required) {
  if (prompt === undefined && !required) return undefined;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    fail('INVALID_PROMPT', `"prompt" must be 1-${MAX_PROMPT_LENGTH} characters.`);
  }
  return prompt.trim();
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), agent: getStatus(), ai: aiStatus() });
});

app.use('/api', requireApiKey);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/login',
  route(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (AUTH_MODE === 'php') fail('FORBIDDEN', 'Sign in through the main app.');
    const key = `${email}|${req.ip}`;
    if (auth.loginLimiter.blocked(key)) fail('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in 15 minutes.');
    const user = email && users.getByEmail(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      auth.loginLimiter.fail(key);
      fail('BAD_LOGIN', 'Wrong email or password.');
    }
    if (user.disabled) fail('BAD_LOGIN', 'This account is disabled. Ask your admin.');
    auth.loginLimiter.reset(key);
    users.touchLogin(user.id);
    res.json({ success: true, token: auth.signToken({ uid: user.id, role: user.role }), user: publicUser(user), expiresInHours: auth.SESSION_HOURS });
  })
);

app.use('/api', requireUser);

app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: publicUser(req.user), usage: usage.today(req.user.id) });
});

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readLimit(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null; // back to the default
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000) fail('INVALID_USER', 'Daily email limit must be a whole number from 0 to 10000.');
  return n;
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: users.list().map((u) => ({ ...publicUser(u), usageToday: usage.today(u.id) })) });
});

app.post(
  '/api/admin/users',
  requireAdmin,
  route(async (req, res) => {
    const { email, name, password, role = 'user', dailyEmailLimit } = req.body || {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) fail('INVALID_USER', 'Enter a valid email address.');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail('INVALID_USER', 'Enter a name (up to 100 characters).');
    const problem = auth.passwordProblem(password);
    if (problem) fail('INVALID_USER', problem);
    if (!['admin', 'user'].includes(role)) fail('INVALID_USER', 'Role must be admin or user.');
    if (users.getByEmail(email)) fail('EMAIL_TAKEN', 'A user with this email already exists.');
    const user = users.create({
      email: email.toLowerCase(),
      name,
      passwordHash: auth.hashPassword(password),
      role,
      dailyEmailLimit: readLimit(dailyEmailLimit) ?? null,
    });
    res.status(201).json({ success: true, user: publicUser(user) });
  })
);

app.patch(
  '/api/admin/users/:id',
  requireAdmin,
  route(async (req, res) => {
    const target = users.get(req.params.id);
    if (!target) fail('USER_NOT_FOUND', 'This user no longer exists.');
    const { name, role, disabled, password, dailyEmailLimit } = req.body || {};
    const patch = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 100) fail('INVALID_USER', 'Enter a name (up to 100 characters).');
      patch.name = name.trim();
    }
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) fail('INVALID_USER', 'Role must be admin or user.');
      if (target.id === req.user.id && role !== 'admin') fail('INVALID_USER', 'You cannot remove your own admin role.');
      patch.role = role;
    }
    if (disabled !== undefined) {
      if (target.id === req.user.id && disabled) fail('INVALID_USER', 'You cannot disable your own account.');
      patch.disabled = disabled ? 1 : 0;
    }
    if (password !== undefined) {
      const problem = auth.passwordProblem(password);
      if (problem) fail('INVALID_USER', problem);
      patch.password_hash = auth.hashPassword(password);
    }
    const limit = readLimit(dailyEmailLimit);
    if (limit !== undefined) patch.daily_email_limit = limit;
    const updated = users.update(target.id, patch);
    res.json({ success: true, user: { ...publicUser(updated), usageToday: usage.today(updated.id) } });
  })
);

app.delete(
  '/api/admin/users/:id',
  requireAdmin,
  route(async (req, res) => {
    const target = users.get(req.params.id);
    if (!target) fail('USER_NOT_FOUND', 'This user no longer exists.');
    if (target.id === req.user.id) fail('INVALID_USER', 'You cannot delete your own account.');
    await removeUserData(target.id); // closes their browser, deletes their Gmail profile
    deleteUserSchedules(target.id);
    for (const [id, run] of runs) if (run.userId === target.id) runs.delete(id);
    users.remove(target.id);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// Daily email limit
// ---------------------------------------------------------------------------

/** Throws DAILY_LIMIT if this user may not send another email today. */
function checkEmailLimit(user, task) {
  if (task.type !== 'send_email' || task.sendMode === 'draft') return;
  const limit = usage.limitFor(user);
  if (usage.today(user.id).emails >= limit) {
    fail('DAILY_LIMIT', `Daily limit reached: you can send ${limit} emails per day. Try again tomorrow or ask your admin.`);
  }
}

/** Counts a finished run (and a sent email) towards the user's usage. */
function recordUsage(userId, report) {
  const sent = report && report.success && report.result && report.result.sent ? 1 : 0;
  usage.add(userId, { runs: 1, emails: sent });
}

// ---------------------------------------------------------------------------
// One-shot runs (JSON / SSE), kept for API clients
// ---------------------------------------------------------------------------

app.post('/api/agent/parse', validatePrompt, (req, res) => {
  try {
    res.json({ success: true, task: parseCommand(req.prompt) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post(
  '/api/agent/run',
  validatePrompt,
  route(async (req, res) => {
    checkEmailLimit(req.user, parseCommand(req.prompt));
    const report = await runBrowserAgent(req.prompt, { userId: req.user.id, dryRun: req.body.dryRun === true });
    recordUsage(req.user.id, report);
    res.status(report.success ? 200 : statusForError(report.error.code)).json(report);
  })
);

app.post('/api/agent/stream', validatePrompt, async (req, res) => {
  try {
    checkEmailLimit(req.user, parseCommand(req.prompt));
  } catch (err) {
    return sendError(res, err);
  }
  const sse = openSse(res);
  try {
    // The task keeps running even if the client disconnects: stopping halfway through
    // composing an email would leave Gmail in an unknown state.
    const report = await runBrowserAgent(req.prompt, {
      userId: req.user.id,
      dryRun: req.body.dryRun === true,
      onLog: (entry) => sse.send('log', entry),
    });
    recordUsage(req.user.id, report);
    sse.send('result', report);
  } catch (err) {
    sse.send('result', { success: false, error: { code: 'UNKNOWN', message: err.message }, logs: [] });
  } finally {
    sse.end();
  }
});

// ---------------------------------------------------------------------------
// Live preview (only the user's own browser)
// ---------------------------------------------------------------------------

/**
 * Events: state -> { active, url } · frame -> { data, width, height, url, time } (base64 JPEG).
 * On connect the viewer gets the current state and last frame immediately. Frames are
 * rate-limited per viewer and only the newest is kept, so a slow connection sees fewer
 * frames instead of an ever-growing delay.
 */
app.get('/api/agent/screencast', (req, res) => {
  const userId = req.user.id;
  const sse = openSse(res);
  const minIntervalMs = 1000 / Math.max(1, CONFIG.screencast.maxFps);
  let closed = false;
  let blocked = false; // socket buffer full; wait for 'drain'
  let pending = null; // newest frame not yet sent
  let lastSentAt = 0;
  let timer = null;

  const sendPending = () => {
    timer = null;
    if (closed || blocked || !pending) return;
    const frame = pending;
    pending = null;
    lastSentAt = Date.now();
    if (!res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)) {
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
  const onState = (state) => sse.send('state', state);

  const { state, lastFrame } = getViewportSnapshot(userId);
  sse.send('state', state);
  if (lastFrame) onFrame(lastFrame);
  const unsubscribe = subscribeViewport(userId, onFrame, onState);
  sse.onClose(() => {
    closed = true;
    clearTimeout(timer);
    unsubscribe();
  });
});

/**
 * Polling alternative to the screencast stream (for pages that can't keep a stream open, e.g.
 * behind shared PHP hosting): { state, frame } where frame is the newest frame, or null when
 * there is none newer than ?after=<frame time in ms>.
 */
app.get('/api/agent/screencast/frame', (req, res) => {
  const { state, lastFrame } = getViewportSnapshot(req.user.id, { polled: true });
  const after = Number(req.query.after) || 0;
  res.set('Cache-Control', 'no-store');
  res.json({ state, frame: lastFrame && lastFrame.time > after ? lastFrame : null });
});

// ---------------------------------------------------------------------------
// Gmail connection of the user's agent browser
// ---------------------------------------------------------------------------

app.get(
  '/api/agent/session',
  route(async (req, res) => {
    res.json(await checkSession(req.user.id, { force: req.query.refresh === '1' }));
  })
);

app.get('/api/agent/login', (req, res) => res.json(loginStatus(req.user.id)));

app.post(
  '/api/agent/login/start',
  route(async (req, res) => {
    res.json({ success: true, login: await startLogin(req.user.id) });
  })
);

app.post(
  '/api/agent/login/input',
  route(async (req, res) => {
    await sendLoginInput(req.user.id, req.body);
    res.json({ success: true });
  })
);

app.post(
  '/api/agent/login/cancel',
  route(async (req, res) => {
    await cancelLogin(req.user.id);
    res.json({ success: true });
  })
);

app.post(
  '/api/agent/logout',
  route(async (req, res) => {
    res.json({ success: true, ...(await logoutGmail(req.user.id)) });
  })
);

// ---------------------------------------------------------------------------
// Runs: start a task on one page, watch it on another (refresh-safe)
// ---------------------------------------------------------------------------

const MAX_RUNS = 500; // all users together; kept in memory, lost when the server restarts
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

/**
 * Starts a run of an already validated task for a user, in the background, and returns it
 * immediately. Throws DAILY_LIMIT when the user may not send another email today.
 */
function startRun({ userId, task, prompt, dryRun, scheduled = false }) {
  const user = users.get(userId);
  if (!user || user.disabled) fail('UNAUTHENTICATED', 'Unknown or disabled user.');
  const effectiveTask = dryRun && task.type === 'send_email' ? { ...task, sendMode: 'draft' } : task;
  checkEmailLimit(user, effectiveTask);

  const run = {
    id: crypto.randomUUID(),
    userId,
    scheduled,
    source: prompt ? 'prompt' : 'form',
    prompt, // the user's original words, kept for display and for the AI summary
    task: effectiveTask,
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
    recordUsage(userId, report);
    run.events.emit('done', report);
  };

  runBrowserAgent(effectiveTask, {
    userId,
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

/**
 * Plan with AI: { prompt } -> { ai, model, task, summary }. Nothing runs yet. The email is
 * signed with this user's name. Without OPENAI_API_KEY the rule-based parser is used.
 */
app.post(
  '/api/agent/plan',
  route(async (req, res) => {
    const prompt = readPrompt(req.body && req.body.prompt, true);
    res.json({ success: true, ...(await planTask(prompt, req.user.id)) });
  })
);

/**
 * Start a run. Body (plus optional dryRun):
 *   { task: {...}, prompt?: "original words" }   run this exact (e.g. reviewed) task
 *   { prompt: "..." }                            plan with AI first, then run
 */
app.post(
  '/api/agent/runs',
  route(async (req, res) => {
    const { prompt: promptInput, task: taskInput, dryRun } = req.body || {};
    let task;
    let prompt;
    if (taskInput !== undefined) {
      task = validateTask(taskInput);
      prompt = readPrompt(promptInput, false);
    } else {
      prompt = readPrompt(promptInput, true);
      task = (await planTask(prompt, req.user.id)).task;
    }
    const run = startRun({ userId: req.user.id, task, prompt, dryRun: dryRun === true });
    res.status(202).json({ success: true, run: runSummary(run) });
  })
);

app.get('/api/agent/runs', (req, res) => {
  res.json({ runs: [...runs.values()].filter((r) => r.userId === req.user.id).reverse().map(runSummary) });
});

/** The run, if it exists and belongs to the signed-in user (otherwise a 404, never someone else's run). */
function findRun(req, res) {
  const run = runs.get(req.params.id);
  if (!run || run.userId !== req.user.id) {
    res.status(404).json({
      success: false,
      error: { code: 'RUN_NOT_FOUND', message: 'This run does not exist (runs are forgotten after a server restart or 1 hour).' },
    });
    return null;
  }
  return run;
}

/** ?since=<step>: only logs after that step (for pages that poll instead of streaming). */
app.get('/api/agent/runs/:id', (req, res) => {
  const run = findRun(req, res);
  if (!run) return;
  const since = parseInt(req.query.since, 10);
  const logs = Number.isInteger(since) ? run.logs.filter((l) => l.step > since) : run.logs;
  res.json({ run: { ...runSummary(run), logs, report: run.report } });
});

/** Events: run (summary), log (past ones replayed first, then live), result (final report). */
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

// ---------------------------------------------------------------------------
// Schedules (the user's own)
// ---------------------------------------------------------------------------

app.get('/api/agent/schedules', (req, res) => {
  res.json({ schedules: listSchedules(req.user.id) });
});

app.post(
  '/api/agent/schedules',
  route(async (req, res) => {
    res.status(201).json({ success: true, schedule: createSchedule(req.body, req.user.id) });
  })
);

app.delete('/api/agent/schedules/:id', (req, res) => {
  if (deleteSchedule(req.params.id, req.user.id)) return res.json({ success: true });
  res.status(404).json({ success: false, error: { code: 'SCHEDULE_NOT_FOUND', message: 'This schedule no longer exists.' } });
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

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
  console.log(`[server] Up to ${CONFIG.maxBrowsers} browsers at once; idle ones close after ${CONFIG.idleCloseMs / 60000} min`);
  if (!API_KEY) console.warn('[server] WARNING: AGENT_API_KEY is empty. Set it before exposing this server.');
  console.log(`[server] Sign-in: ${AUTH_MODE === 'php' ? 'through the PHP app (AUTH_MODE=php)' : AUTH_MODE === 'both' ? 'local accounts and the PHP app' : 'local accounts'}`);
  if (AUTH_MODE !== 'php' && users.count() === 0) console.warn('[server] No users yet. Create the first admin: npm run add-admin');
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
