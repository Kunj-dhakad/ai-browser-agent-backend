/**
 * followup-agent.js
 * ---------------------------------------------------------------------------
 * Email follow-up (email_followup), in the user's Gmail:
 *   1. search Sent mail from the chosen period (older than N days, newer than M days)
 *   2. open each conversation; skip it when someone else wrote last (they replied)
 *   3. the AI writes a short follow-up from the conversation and the user's notes
 *   4. reply in the same conversation: saved as a draft (default) or sent
 *
 * Gmail is opened and checked by agent.js before this runs (it is a Gmail task).
 * ---------------------------------------------------------------------------
 */

const { askJson, addUsage, aiModel, useOpenAI, sleep, short } = require('./ai-browser');

const COLUMNS = ['To', 'Subject', 'Last sent', 'Follow-up', 'Status'];
const AUTOMATED = /no-?reply|do-?not-?reply|mailer-daemon|notifications?@|bounce/i;

/** The messages of the open conversation (the expanded ones; Gmail always expands the last). */
async function readThread(page) {
  return page.evaluate(() => {
    const subject = (document.querySelector('h2.hP') || {}).innerText || '';
    const messages = [...document.querySelectorAll('div.adn')].map((m) => {
      const from = m.querySelector('span.gD');
      const date = m.querySelector('span.g3');
      return {
        fromEmail: (from && from.getAttribute('email')) || '',
        fromName: (from && (from.getAttribute('name') || from.innerText)) || '',
        to: [...m.querySelectorAll('span.g2[email]')].map((t) => t.getAttribute('email')),
        date: (date && (date.getAttribute('title') || date.innerText)) || '',
        text: ((m.querySelector('div.a3s') || {}).innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
      };
    });
    return { subject: subject.trim(), messages };
  });
}

/**
 * helpers: { SELECTORS, readMailRows, AgentError, dryRun, account: { name, email } | null }
 */
async function runFollowup(page, task, log, helpers) {
  const { SELECTORS, readMailRows, AgentError } = helpers;
  if (!useOpenAI()) throw new AgentError('AI_REQUIRED', 'The follow-up agent needs an OpenAI API key (OPENAI_API_KEY in backend/.env).');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const send = task.mode === 'send' && !helpers.dryRun;
  if (task.mode === 'send' && helpers.dryRun) log.warn('DRY_RUN is on: follow-ups are saved as drafts, not sent');
  const me = ((helpers.account && helpers.account.email) || '').toLowerCase();
  const myName = (helpers.account && helpers.account.name) || '';

  const query = `in:sent older_than:${task.olderThanDays}d newer_than:${task.lookbackDays}d${task.onlyTo ? ` to:(${task.onlyTo})` : ''}`;
  log.action(`Searching Sent mail: ${query}`);
  const search = page.locator(SELECTORS.searchInput).first();
  await search.fill(query);
  await page.keyboard.press('Enter');
  await page.waitForURL(/#search\//, { timeout: 15000 }).catch(() => {});
  await sleep(2000);
  const listUrl = page.url();
  const listed = await readMailRows(page, 50);
  log.info(`${listed.length} sent conversation(s) in that period`);

  const rows = [];
  let done = 0;
  for (let i = 0; i < listed.length && done < task.max; i++) {
    if (page.url() !== listUrl) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
      await page.locator(SELECTORS.mailRow).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await sleep(1000);
    }
    const row = page.locator(SELECTORS.mailRow).nth(i);
    if (!(await row.count())) break;
    await row.click();
    await page.locator('h2.hP').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const thread = await readThread(page).catch(() => ({ subject: '', messages: [] }));
    const last = thread.messages[thread.messages.length - 1];
    if (!last) continue;
    const mine = me ? last.fromEmail.toLowerCase() === me : /^me$/i.test(last.fromName);
    const to = last.to.filter((e) => e && e.toLowerCase() !== me);
    if (!mine) {
      log.info(`Skipped "${short(thread.subject, 60)}": they replied`);
      continue;
    }
    if (!to.length || to.every((e) => AUTOMATED.test(e))) {
      log.info(`Skipped "${short(thread.subject, 60)}": no person to follow up with`);
      continue;
    }

    log.action(`Writing a follow-up to ${to.join(', ')}: "${short(thread.subject, 60)}"`);
    const written = await askJson(
      model,
      'You write short, polite follow-up emails. The user sent the last message in this conversation and got no reply. ' +
        'Write the body of a follow-up reply: 2-4 short sentences, friendly and specific to the conversation (mention what it was about), one clear ask, no pressure, no subject line, no placeholders like [Name]. ' +
        'Greet the person by first name when the conversation shows it. ' +
        (myName ? `End with a closing line and the sender's name: ${myName}. ` : 'End with a closing line. ') +
        'Write in the language of the conversation. Reply with JSON: {"body": "..."}.',
      `Subject: ${thread.subject}\nSent to: ${to.join(', ')}\n${task.notes ? `The user's notes for the follow-up: ${task.notes}\n` : ''}\nConversation (oldest first, may be shortened):\n${thread.messages
        .slice(-3)
        .map((m) => `--- ${m.fromName || m.fromEmail} (${m.date}):\n${short(m.text, 1500)}`)
        .join('\n')}`,
      AgentError,
    );
    addUsage(usage, written.usage);
    const body = String(written.data.body || '').trim();
    if (!body) {
      rows.push([to.join(', '), thread.subject, last.date, '', 'Failed: the AI wrote nothing']);
      continue;
    }

    // Reply in the conversation
    let status;
    try {
      const reply = page.locator('div[role="button"][data-tooltip="Reply"], div[role="button"][aria-label="Reply"], span[role="link"]:text-is("Reply")').last();
      await reply.click({ timeout: 8000 });
      const editor = page.locator(SELECTORS.bodyEditor).last();
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.click();
      await page.keyboard.insertText(body);
      await sleep(800);
      if (send) {
        log.action('Sending the follow-up');
        await page.locator(SELECTORS.sendButton).last().click({ timeout: 8000 });
        await editor.waitFor({ state: 'detached', timeout: 15000 });
        status = 'Sent';
      } else {
        await sleep(2500); // Gmail saves the reply as a draft by itself
        status = 'Draft saved';
      }
      done++;
      log.success(`${status}: "${short(thread.subject, 60)}"`);
    } catch (err) {
      status = `Failed: ${short(String(err.message).split('\n')[0], 120)}`;
      log.warn(`Could not reply to "${short(thread.subject, 60)}"`);
    }
    rows.push([to.join(', '), thread.subject, last.date, body, status]);
  }

  const answer = !listed.length
    ? `No sent emails between ${task.olderThanDays} and ${task.lookbackDays} days old${task.onlyTo ? ` to ${task.onlyTo}` : ''}.`
    : done
      ? `${done} follow-up(s) ${send ? 'sent' : 'saved as drafts in Gmail (open Drafts to check and send them)'}; ${listed.length} sent conversation(s) checked.`
      : `Checked ${Math.min(listed.length, 50)} sent conversation(s): none needed a follow-up (they were replied to or had no person to write to).`;
  log.success(answer);
  return { kind: task.type, url: listUrl, answer, data: { columns: COLUMNS, rows }, steps: done, stoppedEarly: false, finalUrl: page.url(), usedLogin: false, usage: { model, ...usage } };
}

module.exports = { runFollowup };
