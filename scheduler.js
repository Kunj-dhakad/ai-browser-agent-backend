/**
 * scheduler.js
 * ---------------------------------------------------------------------------
 * Scheduled tasks: run a (planned) task once at a date/time, every day, or every
 * week. Schedules are saved to data/schedules.json so they survive restarts.
 *
 * The task (e.g. the AI-written email) is fixed when the schedule is created, so
 * exactly that email goes out at the scheduled time.
 *
 * Times are in the backend computer's local time zone.
 * If the backend was off at the scheduled time and more than MISSED_GRACE_MS
 * has passed, that occurrence is skipped (marked "missed") instead of sending
 * an old email late.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateTask, AgentError } = require('./agent');
const { users } = require('./db');

const FILE = path.resolve(process.env.SCHEDULES_FILE || './data/schedules.json');
const CHECK_EVERY_MS = 15_000;
const MISSED_GRACE_MS = 60 * 60 * 1000; // run up to 1 hour late (e.g. after a restart), otherwise skip
const MAX_SCHEDULES_PER_USER = 100;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let schedules = [];
let timer = null;
let startRunFn = null;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function load() {
  try {
    schedules = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // A run that was in progress when the server stopped never reported back.
    schedules.forEach((s) => {
      if (s.lastStatus === 'running') s.lastStatus = 'interrupted';
    });
    // Schedules from before multi-user mode have no owner: give them to the first admin.
    const orphans = schedules.filter((s) => !s.userId);
    const admin = orphans.length && users.firstAdmin();
    if (admin) {
      orphans.forEach((s) => (s.userId = admin.id));
      persist();
    }
  } catch {
    schedules = [];
  }
}

/** Writes to a temp file first, then renames, so a crash can't leave half a file. */
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---------------------------------------------------------------------------
// Time maths (local time)
// ---------------------------------------------------------------------------

/** Next time this schedule should run, strictly after `after`. */
function nextOccurrence(s, after = new Date()) {
  const [h, m] = s.time.split(':').map(Number);
  if (s.frequency === 'once') {
    const [y, mo, d] = s.date.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0);
  }
  const next = new Date(after);
  next.setHours(h, m, 0, 0);
  if (s.frequency === 'daily') {
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  next.setDate(next.getDate() + ((s.weekday - next.getDay() + 7) % 7));
  if (next <= after) next.setDate(next.getDate() + 7);
  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a schedule for a user.
 * input: { task, prompt?, frequency: 'once'|'daily'|'weekly', time: 'HH:MM', date?: 'YYYY-MM-DD', weekday?: 0-6 }
 */
function createSchedule(input, userId) {
  const fail = (message) => {
    throw new AgentError('INVALID_SCHEDULE', message);
  };
  const { task, prompt, frequency, time, date, weekday } = input || {};
  const cleanTask = validateTask(task);
  if (!['once', 'daily', 'weekly'].includes(frequency)) fail('Choose how often: once, daily or weekly.');
  if (!TIME_RE.test(time || '')) fail('Choose a time (HH:MM).');
  if (frequency === 'once' && !DATE_RE.test(date || '')) fail('Choose a date.');
  if (frequency === 'weekly' && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) fail('Choose a day of the week.');
  if (schedules.filter((s) => s.userId === userId).length >= MAX_SCHEDULES_PER_USER) {
    fail(`You can have at most ${MAX_SCHEDULES_PER_USER} scheduled tasks.`);
  }

  const schedule = {
    id: crypto.randomUUID(),
    userId,
    prompt: typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 2000) : undefined,
    task: cleanTask,
    frequency,
    time,
    date: frequency === 'once' ? date : undefined,
    weekday: frequency === 'weekly' ? weekday : undefined,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null, // running | success | error | missed | interrupted | skipped
    lastError: null,
  };
  const next = nextOccurrence(schedule);
  if (frequency === 'once' && next.getTime() <= Date.now()) fail('That date and time has already passed.');
  schedule.nextRunAt = next.toISOString();

  schedules.push(schedule);
  persist();
  return schedule;
}

/** The user's schedules: active first (soonest next run), then finished ones (newest first). */
function listSchedules(userId) {
  return schedules.filter((s) => s.userId === userId).sort((a, b) => {
    if (a.nextRunAt && b.nextRunAt) return a.nextRunAt.localeCompare(b.nextRunAt);
    if (a.nextRunAt) return -1;
    if (b.nextRunAt) return 1;
    return (b.lastRunAt || b.createdAt).localeCompare(a.lastRunAt || a.createdAt);
  });
}

/** Deletes one of the user's schedules. False if it doesn't exist or isn't theirs. */
function deleteSchedule(id, userId) {
  const i = schedules.findIndex((s) => s.id === id && s.userId === userId);
  if (i === -1) return false;
  schedules.splice(i, 1);
  persist();
  return true;
}

/** Deletes all schedules of a user (when the user is removed). */
function deleteUserSchedules(userId) {
  const before = schedules.length;
  for (let i = schedules.length - 1; i >= 0; i--) if (schedules[i].userId === userId) schedules.splice(i, 1);
  if (schedules.length !== before) persist();
}

/** Starts every schedule that is due. */
function tick() {
  const now = Date.now();
  let changed = false;

  for (const s of schedules) {
    if (!s.enabled || !s.nextRunAt) continue;
    const due = Date.parse(s.nextRunAt);
    if (due > now) continue;
    changed = true;

    if (now - due > MISSED_GRACE_MS) {
      s.lastStatus = 'missed';
      s.lastRunAt = new Date(due).toISOString();
      console.warn(`[scheduler] Skipped a missed run of ${s.id} (was due ${s.nextRunAt})`);
    } else {
      const owner = s.userId && users.get(s.userId);
      s.lastRunAt = new Date().toISOString();
      if (!owner || owner.disabled) {
        s.lastStatus = 'skipped';
        s.lastRunId = null;
        s.lastError = 'The account that owns this schedule is missing or disabled.';
      } else {
        try {
          const run = startRunFn({ userId: s.userId, task: s.task, prompt: s.prompt, dryRun: false, scheduled: true });
          s.lastRunId = run.id;
          s.lastStatus = 'running';
          s.lastError = null;
          run.events.once('done', (report) => {
            s.lastStatus = report.success ? 'success' : 'error';
            s.lastError = report.success ? null : report.error && report.error.message;
            persist();
          });
          console.log(`[scheduler] Started scheduled run ${run.id} for schedule ${s.id}`);
        } catch (err) {
          // e.g. the daily email limit was reached
          s.lastStatus = 'skipped';
          s.lastRunId = null;
          s.lastError = err.message;
        }
      }
    }

    if (s.frequency === 'once') {
      s.enabled = false;
      s.nextRunAt = null;
    } else {
      s.nextRunAt = nextOccurrence(s, new Date(Math.max(now, due))).toISOString();
    }
  }
  if (changed) persist();
}

/** Loads saved schedules and checks for due ones every 15 seconds. `startRun` comes from server.js. */
function startScheduler(startRun) {
  startRunFn = startRun;
  load();
  tick();
  timer = setInterval(tick, CHECK_EVERY_MS);
}

function stopScheduler() {
  clearInterval(timer);
}

module.exports = { startScheduler, stopScheduler, createSchedule, listSchedules, deleteSchedule, deleteUserSchedules };
