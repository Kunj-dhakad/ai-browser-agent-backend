/**
 * scripts/add-user.js
 * ---------------------------------------------------------------------------
 * Creates a user from the command line (the first admin, or when the web admin
 * page isn't reachable). Other users are easier to add from Admin -> Users.
 *
 *   npm run add-admin              asks for email, name and password; creates an admin
 *   npm run add-user               asks for everything (including "admin? y/N")
 *   npm run add-user -- --email friend@example.com --name "Friend" --password "secret123"
 *   (PowerShell drops a bare "--": use npm run add-user '--' --email ... or node scripts/add-user.js ...)
 *
 * Without --password you are asked for one. An admin created here also takes over the
 * Gmail login of the old single-user version (.browser-profile), if there is one,
 * so you don't have to connect Gmail again.
 * ---------------------------------------------------------------------------
 */

const path = require('path');
process.chdir(path.join(__dirname, '..')); // same relative paths (.env, ./data) as the server

require('dotenv').config();

const fs = require('fs');
const readline = require('readline');
const { users, DB_FILE } = require('../db');
const { hashPassword, passwordProblem } = require('../auth');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// One reader for all questions, so pasted / piped answers aren't lost between them.
let rl = null;
let inputClosed = false;
const lines = [];
const waiting = [];

function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => (waiting.length ? waiting.shift()(line.trim()) : lines.push(line.trim())));
    rl.on('close', () => {
      inputClosed = true;
      waiting.splice(0).forEach((resolve) => resolve(''));
    });
  }
  process.stdout.write(question);
  if (lines.length) return Promise.resolve(lines.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => waiting.push(resolve));
}

/** Moves the old single-user browser profile + account name to this admin. */
function migrateLegacy(user) {
  const legacyDir = path.resolve(process.env.USER_DATA_DIR || './.browser-profile');
  const profileDir = path.join(path.resolve(process.env.PROFILES_DIR || './data/profiles'), user.id);
  if (fs.existsSync(legacyDir) && !fs.existsSync(profileDir)) {
    fs.mkdirSync(path.dirname(profileDir), { recursive: true });
    fs.renameSync(legacyDir, profileDir);
    users.setGmailStatus(user.id, 'unknown'); // checked on first use
    console.log(`Moved the existing Gmail login (${path.basename(legacyDir)}) to this admin.`);
  }
  const accountFile = path.join(path.dirname(DB_FILE), 'account.json'); // single-user version's data folder
  if (fs.existsSync(accountFile)) {
    try {
      const { name, email } = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
      if (email) users.setGmailAccount(user.id, name || null, email);
      users.setGmailStatus(user.id, 'unknown'); // checked on first use
      fs.renameSync(accountFile, `${accountFile}.migrated`);
      console.log(`Gmail account: ${name || ''} <${email}>`);
    } catch (err) {
      console.warn(`Could not read ${accountFile}: ${err.message}`);
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Asks until `check` returns no problem (only when typed in; flags are checked once below). */
async function askUntilValid(question, check) {
  for (;;) {
    if (inputClosed && !lines.length) throw new Error('No input.');
    const answer = await ask(question);
    const problem = check(answer);
    if (!problem) return answer;
    console.log(`  ${problem}`);
  }
}

async function main() {
  // "--admin" or just "admin": PowerShell drops the "--" in `npm run add-user -- --admin`.
  let admin = process.argv.includes('--admin') || process.argv.includes('admin');
  const interactive = !arg('email');

  const emailProblem = (e) => (EMAIL_RE.test(e) ? (users.getByEmail(e) ? `A user with email ${e} already exists.` : null) : 'Enter a valid email address, e.g. admin@example.com');
  const nameProblem = (n) => (n.trim() ? null : 'Enter a name.');

  const email = (arg('email') || (await askUntilValid('Email (used to sign in): ', (e) => emailProblem(e.toLowerCase())))).trim().toLowerCase();
  const name = arg('name') || (await askUntilValid('Name: ', nameProblem));
  const password = arg('password') || (await askUntilValid('Password (min 8 characters): ', passwordProblem));
  if (interactive && !admin) admin = /^y(es)?$/i.test(await ask('Make this user an admin? (y/N): '));

  const problem = emailProblem(email) || nameProblem(name) || passwordProblem(password);
  if (problem) throw new Error(problem);

  const takesLegacy = admin; // the old single-user Gmail login goes to the first admin created here (moved only once)
  const user = users.create({ email, name, passwordHash: hashPassword(password), role: admin ? 'admin' : 'user' });
  console.log(`Created ${user.role} ${user.name} <${user.email}>`);
  if (takesLegacy) migrateLegacy(user);
}

main()
  .then(() => rl && rl.close())
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
