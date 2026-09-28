/**
 * scripts/add-user.js
 * ---------------------------------------------------------------------------
 * Creates a user from the command line (the first admin, or when the web admin
 * page isn't reachable). Other users are easier to add from Admin -> Users.
 *
 *   npm run add-user -- --admin --email you@example.com --name "Your Name"
 *   npm run add-user -- --email friend@example.com --name "Friend" --password "secret123"
 *
 * Without --password you are asked for one. The first admin also takes over the
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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))));
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

async function main() {
  const admin = process.argv.includes('--admin');
  const email = (arg('email') || (await ask('Email: '))).toLowerCase();
  const name = arg('name') || (await ask('Name: '));
  const password = arg('password') || (await ask('Password (min 8 characters): '));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (!name.trim()) throw new Error('Enter a name.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if (users.getByEmail(email)) throw new Error(`A user with email ${email} already exists.`);

  const isFirstAdmin = admin && !users.firstAdmin();
  const user = users.create({ email, name, passwordHash: hashPassword(password), role: admin ? 'admin' : 'user' });
  console.log(`Created ${user.role} ${user.name} <${user.email}>`);
  if (isFirstAdmin) migrateLegacy(user);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
