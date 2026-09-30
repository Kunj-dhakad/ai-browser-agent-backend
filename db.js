/**
 * db.js
 * ---------------------------------------------------------------------------
 * Small SQLite database (Node's built-in `node:sqlite`, no extra package) for
 * multi-user mode: users, their Gmail connection and daily usage.
 *
 * File: data/app.db (DB_FILE). Runs stay in memory (see server.js); schedules
 * stay in data/schedules.json with a userId on each one.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = withoutSqliteWarning(() => require('node:sqlite'));

/**
 * Node 22-24 prints "ExperimentalWarning: SQLite is an experimental feature" on load. It is
 * harmless, but it lands in the middle of prompts (npm run add-user) and logs, so skip it.
 */
function withoutSqliteWarning(load) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite is an experimental feature/i.test(String(warning && warning.message ? warning.message : warning))) return;
    emitWarning.call(process, warning, ...rest);
  };
  try {
    return load();
  } finally {
    process.emitWarning = emitWarning;
  }
}

const DB_FILE = path.resolve(process.env.DB_FILE || './data/app.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name              TEXT NOT NULL,
    password_hash     TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
    disabled          INTEGER NOT NULL DEFAULT 0,
    daily_email_limit INTEGER,                           -- NULL = use DAILY_EMAIL_LIMIT
    gmail_status      TEXT NOT NULL DEFAULT 'unknown',   -- 'connected' | 'disconnected' | 'unknown'
    gmail_name        TEXT,
    gmail_email       TEXT,
    created_at        TEXT NOT NULL,
    last_login_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,                               -- YYYY-MM-DD, server local time
    emails  INTEGER NOT NULL DEFAULT 0,                  -- emails actually sent
    runs    INTEGER NOT NULL DEFAULT 0,                  -- runs started
    PRIMARY KEY (user_id, day)
  );
`);

// Users who come from the PHP app (AUTH_MODE=php) are linked by their PHP user id.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'external_id')) {
  db.exec('ALTER TABLE users ADD COLUMN external_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_external_id ON users(external_id)');

const DEFAULT_DAILY_EMAIL_LIMIT = parseInt(process.env.DAILY_EMAIL_LIMIT, 10) || 50;

/** Today's date as YYYY-MM-DD in the server's time zone. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The user as the API returns it: never the password hash. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: Boolean(u.disabled),
    dailyEmailLimit: u.daily_email_limit ?? DEFAULT_DAILY_EMAIL_LIMIT,
    gmail: { status: u.gmail_status, name: u.gmail_name || null, email: u.gmail_email || null },
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at || null,
    source: u.external_id ? 'php' : 'local', // php = signs in through the PHP app
  };
}

const stmt = {
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byExternal: db.prepare('SELECT * FROM users WHERE external_id = ?'),
  insertExternal: db.prepare(
    'INSERT INTO users (id, email, name, password_hash, role, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  linkExternal: db.prepare('UPDATE users SET external_id = ? WHERE id = ?'),
  updateExternalProfile: db.prepare('UPDATE users SET name = ?, email = ?, daily_email_limit = COALESCE(?, daily_email_limit) WHERE id = ?'),
  all: db.prepare('SELECT * FROM users ORDER BY created_at'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  firstAdmin: db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"),
  insert: db.prepare(
    'INSERT INTO users (id, email, name, password_hash, role, daily_email_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  remove: db.prepare('DELETE FROM users WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  gmailStatus: db.prepare('UPDATE users SET gmail_status = ? WHERE id = ?'),
  gmailAccount: db.prepare("UPDATE users SET gmail_status = 'connected', gmail_name = ?, gmail_email = ? WHERE id = ?"),
  gmailClear: db.prepare("UPDATE users SET gmail_status = 'disconnected', gmail_name = NULL, gmail_email = NULL WHERE id = ?"),
  usageGet: db.prepare('SELECT emails, runs FROM usage WHERE user_id = ? AND day = ?'),
  usageAdd: db.prepare(`
    INSERT INTO usage (user_id, day, emails, runs) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET emails = emails + excluded.emails, runs = runs + excluded.runs
  `),
};

const users = {
  get: (id) => stmt.byId.get(id) || null,
  getByEmail: (email) => stmt.byEmail.get(String(email || '').trim()) || null,
  list: () => stmt.all.all(),
  count: () => stmt.count.get().n,
  firstAdmin: () => stmt.firstAdmin.get() || null,

  /** Creates a user. `passwordHash` comes from auth.hashPassword(). */
  create({ email, name, passwordHash, role = 'user', dailyEmailLimit = null }) {
    const id = crypto.randomUUID();
    stmt.insert.run(id, email.trim(), name.trim(), passwordHash, role, dailyEmailLimit, new Date().toISOString());
    return users.get(id);
  },

  /** Updates the given fields only (name, role, disabled, password_hash, daily_email_limit). */
  update(id, patch) {
    const allowed = ['name', 'role', 'disabled', 'password_hash', 'daily_email_limit'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
    }
    return users.get(id);
  },

  /**
   * The local user for a PHP app user (created on first visit). Name, email and the daily limit
   * (when the PHP plan sends one) follow the PHP app. The password hash is a random, unusable
   * value: these users only ever sign in through the PHP app.
   */
  fromExternal({ externalId, email, name, dailyEmailLimit = null }) {
    const ext = String(externalId);
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(name || cleanEmail).trim().slice(0, 100) || cleanEmail;
    let user = stmt.byExternal.get(ext);
    if (!user) {
      const sameEmail = stmt.byEmail.get(cleanEmail);
      if (sameEmail && !sameEmail.external_id) {
        stmt.linkExternal.run(ext, sameEmail.id); // same person already had a local account
        user = users.get(sameEmail.id);
      } else {
        const id = crypto.randomUUID();
        const emailToUse = sameEmail ? `php-${ext}@users.local` : cleanEmail; // email taken by another PHP user
        stmt.insertExternal.run(id, emailToUse, cleanName, 'external', 'user', ext, new Date().toISOString());
        return users.get(id);
      }
    }
    const owner = stmt.byEmail.get(cleanEmail);
    const emailToUse = owner && owner.id !== user.id ? user.email : cleanEmail;
    const limit = Number.isInteger(dailyEmailLimit) && dailyEmailLimit >= 0 ? dailyEmailLimit : null;
    if (user.name !== cleanName || user.email !== emailToUse || (limit !== null && limit !== user.daily_email_limit)) {
      stmt.updateExternalProfile.run(cleanName, emailToUse, limit, user.id);
      user = users.get(user.id);
    }
    return user;
  },

  remove: (id) => stmt.remove.run(id),
  touchLogin: (id) => stmt.touchLogin.run(new Date().toISOString(), id),

  // Gmail connection of the user's agent browser
  setGmailStatus: (id, status) => stmt.gmailStatus.run(status, id),
  setGmailAccount: (id, name, email) => stmt.gmailAccount.run(name, email, id),
  clearGmail: (id) => stmt.gmailClear.run(id),
};

const usage = {
  /** { emails, runs } used today. */
  today: (userId) => stmt.usageGet.get(userId, today()) || { emails: 0, runs: 0 },
  add: (userId, { emails = 0, runs = 0 }) => stmt.usageAdd.run(userId, today(), emails, runs),
  /** How many emails this user may send per day. */
  limitFor: (user) => user.daily_email_limit ?? DEFAULT_DAILY_EMAIL_LIMIT,
};

// ---------------------------------------------------------------------------
// Run history: every task a user ran (task, status, logs, result), kept across restarts.
// Live progress still comes from memory (server.js); this is the record afterwards.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source      TEXT,
    prompt      TEXT,
    scheduled   INTEGER NOT NULL DEFAULT 0,
    task        TEXT NOT NULL,            -- JSON
    status      TEXT NOT NULL,            -- running | success | error
    created_at  TEXT NOT NULL,            -- ISO
    finished_at TEXT,
    duration_ms INTEGER,
    report      TEXT,                     -- JSON (result or error, without logs)
    logs        TEXT                      -- JSON array
  );
  CREATE INDEX IF NOT EXISTS runs_user_created ON runs(user_id, created_at DESC);
`);

const RUN_HISTORY_DAYS = parseInt(process.env.RUN_HISTORY_DAYS, 10) || 90;

const runStmt = {
  insert: db.prepare('INSERT INTO runs (id, user_id, source, prompt, scheduled, task, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  finish: db.prepare('UPDATE runs SET status = ?, task = ?, finished_at = ?, duration_ms = ?, report = ?, logs = ? WHERE id = ?'),
  list: db.prepare('SELECT id, user_id, source, prompt, scheduled, task, status, created_at, duration_ms, report FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
  get: db.prepare('SELECT * FROM runs WHERE id = ?'),
  stats: db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM runs WHERE user_id = ? AND created_at >= ?`),
  interrupt: db.prepare("UPDATE runs SET status = 'error', finished_at = ?, report = ? WHERE status = 'running'"),
  prune: db.prepare('DELETE FROM runs WHERE created_at < ?'),
};

const parse = (s, fallback = null) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

/** A stored run in the same shape the API uses for live runs. */
function runFromRow(r, { full = false } = {}) {
  if (!r) return null;
  const report = parse(r.report);
  return {
    id: r.id,
    userId: r.user_id,
    source: r.source,
    prompt: r.prompt || undefined,
    scheduled: Boolean(r.scheduled),
    task: parse(r.task, {}),
    status: r.status,
    createdAt: Date.parse(r.created_at),
    report: report ? { ...report, durationMs: r.duration_ms ?? report.durationMs } : null,
    logs: full ? parse(r.logs, []) : undefined,
  };
}

const runHistory = {
  insert: (run) =>
    runStmt.insert.run(run.id, run.userId, run.source || null, run.prompt || null, run.scheduled ? 1 : 0, JSON.stringify(run.task), run.status, new Date(run.createdAt).toISOString()),
  finish(run) {
    const { logs, ...report } = run.report || {};
    runStmt.finish.run(run.status, JSON.stringify(run.task), new Date().toISOString(), report.durationMs ?? null, JSON.stringify(report), JSON.stringify(run.logs || logs || []), run.id);
  },
  /** Newest first, without logs. */
  list: (userId, limit = 50) => runStmt.list.all(userId, limit).map((r) => runFromRow(r)),
  /** One run with its logs and report, or null. */
  get: (id) => runFromRow(runStmt.get.get(id), { full: true }),
  /** { total, success, failed, running } since the given Date. */
  stats(userId, since) {
    const s = runStmt.stats.get(userId, since.toISOString()) || {};
    return { total: s.total || 0, success: s.success || 0, failed: s.failed || 0, running: s.running || 0 };
  },
  /**
   * Call once when the server starts: tasks still "running" belonged to the previous process
   * and can't finish any more; old history is dropped (RUN_HISTORY_DAYS, default 90).
   */
  recoverAfterRestart() {
    runStmt.interrupt.run(new Date().toISOString(), JSON.stringify({ success: false, error: { code: 'INTERRUPTED', message: 'The agent server restarted while this task was running. Run it again.' } }));
    runStmt.prune.run(new Date(Date.now() - RUN_HISTORY_DAYS * 86400000).toISOString());
  },
};

module.exports = { db, users, usage, runHistory, publicUser, today, DB_FILE };
