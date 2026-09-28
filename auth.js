/**
 * auth.js
 * ---------------------------------------------------------------------------
 * Passwords and login tokens for multi-user mode (no extra packages).
 *
 *   hashPassword / verifyPassword   scrypt, salted, constant-time compare.
 *   signToken / verifyToken         "<payload>.<signature>", HMAC-SHA256 with AUTH_SECRET.
 *                                   Payload: { uid, role, exp }. Anyone changing it breaks
 *                                   the signature; it expires after SESSION_HOURS.
 *   loginLimiter                    Slows down password guessing (per email + IP).
 *
 * Later, a token issued by the PHP app can be accepted here instead (same shape of
 * "who is this user"), without changing the rest of the backend.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const crypto = require('crypto');

let SECRET = process.env.AUTH_SECRET || '';
if (SECRET.length < 32) {
  // Works, but everyone is logged out on each restart. Set AUTH_SECRET in .env.
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] AUTH_SECRET is missing or short. Using a random one: all users will be logged out when the server restarts.');
}

const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS) || 12;
const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Returns an error message, or null when the password is acceptable. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password is too long.';
  return null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function signToken({ uid, role }) {
  const payload = b64url(JSON.stringify({ uid, role, exp: Math.floor(Date.now() / 1000) + Math.round(SESSION_HOURS * 3600) }));
  return `${payload}.${sign(payload)}`;
}

/** Returns { uid, role, exp } for a valid, unexpired token; otherwise null. */
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || typeof data.exp !== 'number' || data.exp * 1000 < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Login attempt limiter (in memory)
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // key -> { count, first }

const loginLimiter = {
  /** True when this email+IP has failed too often recently. */
  blocked(key) {
    const f = failures.get(key);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) {
      failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  },
  fail(key) {
    const f = failures.get(key);
    if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
    else f.count++;
  },
  reset: (key) => failures.delete(key),
};

module.exports = { hashPassword, verifyPassword, passwordProblem, signToken, verifyToken, loginLimiter, SESSION_HOURS };
