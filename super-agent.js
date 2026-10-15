/**
 * super-agent.js
 * ---------------------------------------------------------------------------
 * Super Agent: up to 3 tasks ("lanes") at the same time per user, plus up to 3 waiting in line
 * ("next up": when a task finishes, it is cleared and the next one starts in its place), each in its own tab of the
 * user's browser, driven by the custom web agent (web-agent.js). A lane is a chat: the first
 * message is the task, later messages are follow-ups on the same work (the agent may also ask
 * the user a short question, e.g. for a one-time code). Instead of a live view, each turn keeps
 * a few screenshots (start, after a few page changes, end).
 *
 * Lanes live in memory (they are working state); every lane is also saved as a run
 * (type "super_task") so it shows on the Tasks and Results pages with its data.
 *
 * Login details for a lane are kept only in memory, never in the run history, the logs or the
 * API answers, and the model only sees {{USERNAME}} / {{PASSWORD}} (see ai-browser.js).
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { tool } = require('@openai/agents');
const { buildWebAgent, WORKING_RULES, WEB, addUsage, tidyAnswer } = require('./web-agent');
const { useOpenAI, runAgent, openUrl, findSources, aiModel, askJson, short, sleep, usageOf } = require('./ai-browser');
const { openParallelPage, createLogger, normalizeSiteUrl, blockPrivateHosts, AgentError, CONFIG } = require('./agent');
const { runHistory } = require('./db');

const LIMITS = {
  lanesPerUser: 3, // lanes per user, working or finished (a finished one makes room for the next in line)
  queuePerUser: 3, // tasks waiting in line per user
  doneShowMs: 4000, // a finished task stays on screen this long before the next one takes its place
  // super agent tabs running at the same time on this server (each is about one browser's CPU)
  maxPages: Math.max(1, parseInt(process.env.SUPER_MAX_PAGES, 10) || CONFIG.maxBrowsers),
  stepsPerTurn: Math.min(60, Math.max(10, parseInt(process.env.SUPER_MAX_STEPS, 10) || 50)),
  shotsPerTurn: 4, // screenshots kept per message (the last one is always the end state)
  shotGapMs: 8000, // at least this long between two screenshots
  keepLanes: 12, // lanes kept per user (oldest finished ones are dropped)
  laneTtlMs: 24 * 60 * 60 * 1000,
  messageChars: 3000,
  shotsDays: 30, // saved screenshots (Tasks page) are kept this long
};

/** Screenshots are also saved here (data/super-shots/<runId>/<shot>.jpg) for the Tasks page. */
const SHOTS_DIR = path.resolve(process.env.SUPER_SHOTS_DIR || './data/super-shots');
const SHOT_ID = /^\d{1,3}-\d{1,3}$/;
const RUN_ID = /^[0-9a-f-]{36}$/i;

/** When this server process started: the page sees a restart (which ends all working lanes). */
const SERVER_STARTED = new Date().toISOString();

/** Old saved screenshots are removed (once at start, then daily). */
function pruneShots() {
  fs.readdir(SHOTS_DIR, { withFileTypes: true }, (err, dirs) => {
    if (err) return;
    const old = Date.now() - LIMITS.shotsDays * 86400000;
    dirs.filter((d) => d.isDirectory()).forEach((d) => {
      const dir = path.join(SHOTS_DIR, d.name);
      fs.stat(dir, (e, st) => {
        if (!e && st.mtimeMs < old) fs.rm(dir, { recursive: true, force: true }, () => {});
      });
    });
  });
}
pruneShots();
setInterval(pruneShots, 86400000).unref();

/** userId -> Map(laneId -> lane) */
const lanesByUser = new Map();
const userLanes = (userId) => {
  if (!lanesByUser.has(userId)) lanesByUser.set(userId, new Map());
  return lanesByUser.get(userId);
};
const isActive = (lane) => lane.status === 'running' || lane.status === 'queued';
/** A finished lane can make room for the next task (one waiting for the user's reply keeps its place). */
const isFinished = (lane) => !isActive(lane) && lane.status !== 'waiting';

/** userId -> [{ id, message, title, allowOtherSites, createdAt }] (login details hidden): tasks waiting for a lane. */
const queues = new Map();
const userQueue = (userId) => {
  if (!queues.has(userId)) queues.set(userId, []);
  return queues.get(userId);
};

// ---------------------------------------------------------------- server-wide tab limit

let pagesInUse = 0;
const waiting = [];
function takePage() {
  if (pagesInUse < LIMITS.maxPages) {
    pagesInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function givePage() {
  const next = waiting.shift();
  if (next) next();
  else pagesInUse--;
}

// ---------------------------------------------------------------- is it really done?

const CHECK_PROMPT = `You check whether a browser agent really finished the user's task. Reply as JSON: {"required": ["<each thing the task asks for, e.g. each city, each item, the total, the created book>"], "done": ["<the required things that the saved data or the page show as done>"], "status": "complete" | "unfinished" | "blocked", "missing": "<short: what is still to do, or what blocks it>"}.
Fill "required" and "done" first, looking at BOTH the saved data rows and the page text; then decide: complete when every required thing is done.
- complete: the task is done as asked: the answer, the saved data and the page agree (e.g. all items asked for are there; the thing to create was created and is shown).
- unfinished: part of the task is not done and the agent could still do it: items missing, a step not taken, it stopped in a form or wizard, it only described what it would do, it asked the user for details it could choose itself (a topic, a title), it gave up while other ways were left, or a generation was started but not waited for and checked.
- blocked: it cannot be done by the agent: the login details failed, the site blocks it, a captcha or one-time code, the thing does not exist on the site, or only the user can decide.
If the page still shows progress text ("Loading…", "Generating…", "Understanding your idea…") or the agent's answer itself says it is not done yet, the status is unfinished.
A task that creates or edits something (a book, a post, a record, a form) is complete only when it is saved: it shows in its list, or the agent pressed Save / Save & Next / Submit and the page confirms it. Ending in an open editor or draft that was not saved is unfinished: say "save it (e.g. Save & Next) and check it is in the list". The item in the list must be the new one (its title or topic fits what the agent made), not an older one.
Judge by the evidence (the page text, the saved data), not by the agent's claims of success. You see only the start of the page text, so saved data that fits the task is evidence too: do not call a task unfinished only because its values are not in the excerpt. Ask only for what the task asks: no extra definitions, sources or checks it did not ask for. Open-ended tasks (test a website, research a topic, "check everything") are complete when the answer is a fair, honest result of what was asked, covering the main parts (e.g. the main pages, the aspects named in the task): do not ask for every page or for perfection. The page shows only where the agent is now: in a task over several items (several cities, pages, searches) the earlier items are proven by the saved data, not by the page.`;

/** The model for the done check: a stronger one than the agent's (one short request per check). */
const CHECK_MODEL = process.env.SUPER_CHECK_MODEL || 'gpt-4.1';

/** The language (and script) the user wrote in, for the answer: the model often slips into English. */
function answerLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return 'Hindi in Devanagari script';
  const hinglish = (String(text).toLowerCase().match(/\b(hai|he|hain|karna|karo|kro|kar|ke|ki|ka|ko|do|dena|de|bana|bna|banao|nikal|nikalo|jana|jao|par|pr|aur|or|mein|me|kya|kaise|kese|sabse|wala|wali|batao|btao|chahiye|lana|lao|nahi|sath)\b/g) || []).length;
  return hinglish >= 3 ? 'Hinglish written in English letters (Roman script, like the user), not Devanagari and not English' : 'the language the user wrote in';
}

/** { status: complete | unfinished | blocked, missing, usage } for the turn so far (complete if the check fails). */
async function checkDone(lane, turn, answer, data, page) {
  // the page and its frames (editors and widgets often live in an iframe)
  const texts = await Promise.all(page.frames().slice(0, 6).map((f) => f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')));
  const text = texts.filter((t) => t.trim()).join('\n---\n').replace(/\n\s*\n+/g, '\n');
  // Evidence the excerpt can't show: how many saved values are on the page (the whole page)
  const flat = (v) => String(v).toLowerCase().replace(/\s+/g, ' ').trim();
  const pageFlat = flat(text);
  const cells = data.rows.flat().map(flat).filter((v) => v.length >= 2).slice(0, 60);
  const onPage = cells.filter((v) => pageFlat.includes(v)).length;
  const user = [
    `Task: ${lane.task}`,
    turn.n > 1 ? `Latest message from the user: ${turn.message}` : '',
    `Agent's answer: ${short(answer, 1500)}`,
    // all of it (up to 40 rows): a task over several items (cities, pages) shows only the last one
    // on screen, the earlier ones are in the data
    `Data saved: ${data.rows.length} row(s)${data.rows.length ? ` with columns ${data.columns.join(' | ')}:\n${data.rows.slice(0, 40).map((r) => r.map((c) => short(c, 60)).join(' | ')).join('\n')}${data.rows.length > 40 ? `\n… and ${data.rows.length - 40} more rows` : ''}` : ''}`,
    cells.length ? `Checked by code: ${onPage} of ${cells.length} saved values appear word for word in the page's full text (the page the agent is on now; data saved from earlier pages will not be in it).` : '',
    `Screenshots: the system takes them by itself while the agent works (${turn.shots.length} so far, with more at the end) and shows them to the user, so a task asking for screenshots has them.`,
    `Page now: ${page.url()}`,
    `Page text (start):\n${short(text, 3500)}`,
  ].filter(Boolean).join('\n\n');
  try {
    const { data: v, usage } = await askJson(CHECK_MODEL, CHECK_PROMPT, user, AgentError);
    const status = ['complete', 'unfinished', 'blocked'].includes(v.status) ? v.status : 'complete';
    return { status, missing: short(String(v.missing || ''), 300), usage };
  } catch (err) {
    console.error('[super] The done check failed:', err.message);
    return { status: 'complete', missing: '', usage: null };
  }
}

// ---------------------------------------------------------------- the agent's prompt

const PROMPT = (lane, site, hasLogin, allowOtherSites) => {
  const others = lane.sites.slice(1);
  const where = !site
    ? 'No website was given: start with search_web to find the right pages, then open one with open_page (only addresses search_web or read_page gave you).'
    : others.length
      ? `The task is on several websites: ${lane.sites.join(', ')}. ${site} is already open; when you are done there, open the next one with open_page (e.g. ${others[0]}), and use search_web if you cannot find a page on it.`
      : `The work is on ${site}: the start page is already open.`;
  return `You are the user's Super Agent: an assistant that does tasks for them in a real web browser.
The user gives a task in plain words and may send follow-up messages later in the same chat about the same work; do what the latest message asks.
Every tool call is one step; you have at most ${LIMITS.stepsPerTurn} steps per message, so plan.

The user's task:
${lane.task}

${where}

Write your answers in ${answerLanguage(lane.task)}.

${WORKING_RULES(site || 'the websites you find', hasLogin, allowOtherSites, true)}`;
};

/** search_web: web pages for a query (OpenAI web search), which open_page may then open. */
function searchTool(browser, log) {
  return tool({
    name: 'search_web',
    description: 'Search the web. Returns up to 8 pages (title and address) you can then open with open_page.',
    parameters: z.object({ query: z.string() }),
    execute: browser.oneAtATime(async ({ query }) => {
      if (browser.outOfSteps()) return browser.LIMIT;
      log.action(`Searching the web: "${short(query, 80)}"`);
      try {
        const found = await findSources(aiModel(), `Find the most useful web pages for: ${query}. List each page with its title and URL.`, AgentError);
        const list = found.sources.filter((s) => normalizeSiteUrl(s.url)).slice(0, 8);
        list.forEach((s) => browser.allowUrl(s.url));
        return list.length ? list.map((s, i) => `${i + 1}. ${s.title || '(no title)'} — ${s.url}`).join('\n') : 'Nothing found; try other words.';
      } catch (err) {
        return `Search failed: ${short(err.message, 150)}`;
      }
    }),
  });
}

/** ask_user: the only way a turn ends waiting for the user's reply. */
function askTool(browser, log, turn) {
  return tool({
    name: 'ask_user',
    description: 'Ask the user one short question (a one-time code, a choice only they can make, or a yes before you send, submit, buy, book or delete). After this, end your turn with the same question as your answer.',
    parameters: z.object({ question: z.string() }),
    execute: browser.oneAtATime(async ({ question }) => {
      turn.asked = short(question, 300);
      log.info(`Asked you: ${turn.asked}`);
      return 'Question sent. Now end your turn: write the question as your answer and call no more tools.';
    }),
  });
}

// ---------------------------------------------------------------- screenshots

/** A half-size JPEG of what the tab shows now (base64), or null. */
async function capture(page) {
  try {
    const size = page.viewportSize() || { width: 1366, height: 768 };
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 0.5 } });
    await cdp.detach().catch(() => {});
    return data;
  } catch {
    return null;
  }
}

/** Takes a screenshot for this turn (keeps the last slot for the end state). */
async function shoot(lane, turn, page, label, { final = false } = {}) {
  const mid = turn.shots.filter((s) => !s.final).length;
  if (!final && (mid >= LIMITS.shotsPerTurn - 1 || Date.now() - (turn.lastShotAt || 0) < LIMITS.shotGapMs)) return;
  turn.lastShotAt = Date.now();
  const data = await capture(page);
  if (!data) return;
  const id = `${turn.n}-${turn.shots.length + 1}`;
  lane.shots.set(id, data);
  fs.promises
    .mkdir(path.join(SHOTS_DIR, lane.runId), { recursive: true })
    .then(() => fs.promises.writeFile(path.join(SHOTS_DIR, lane.runId, `${id}.jpg`), Buffer.from(data, 'base64')))
    .catch((err) => console.error('[super] Could not save a screenshot:', err.message));
  turn.shots.push({ id, label: short(label, 80), url: page.url(), at: new Date().toISOString(), final });
  touch(lane);
}

// ---------------------------------------------------------------- lanes

function touch(lane) {
  lane.updatedAt = Date.now();
}

/** "Log in to mobiagentsai.com and find restaurants in 10 cities" -> a short title. */
function titleOf(message) {
  const words = message.replace(/https?:\/\/(www\.)?/g, '').replace(/\s+/g, ' ').trim().split(' ');
  const t = words.slice(0, 7).join(' ');
  return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/[.,;:]$/, '') + (words.length > 7 ? '…' : '');
}

/** The lane as the page sees it (no login details, screenshots as ids only). */
function laneView(lane) {
  return {
    id: lane.id,
    title: lane.title,
    status: lane.status, // queued | running | waiting (asked a question) | done | incomplete (done, with a note of what is left) | stopped | failed
    site: lane.sites.map((u) => new URL(u).hostname.replace(/^www\./, '')).join(', '),
    hasLogin: lane.hasLogin,
    thinking: lane.thinking || '',
    runId: lane.runId,
    createdAt: new Date(lane.createdAt).toISOString(),
    updatedAt: new Date(lane.updatedAt).toISOString(),
    turns: lane.turns.map((t) => ({
      n: t.n,
      message: t.message,
      status: t.status,
      startedAt: t.startedAt && new Date(t.startedAt).toISOString(),
      finishedAt: t.finishedAt && new Date(t.finishedAt).toISOString(),
      steps: t.steps,
      shots: t.shots,
      answer: t.answer,
      data: t.data,
      usage: t.usage,
      error: t.error,
      check: t.check || null, // the done check: { status: complete | unfinished | blocked, missing }
    })),
  };
}

/**
 * Login details written in the message itself ("email kunj@x.com password 123456"): they become
 * the lane's login details and the message keeps only {{USERNAME}} / {{PASSWORD}}, so the AI,
 * the title, the history and the logs never see the password. Without a password word in the
 * message nothing is taken (an email address in a task is usually data, not a login).
 */
function loginFromMessage(message) {
  const pass = message.match(/\b(?:password|passwd|pass|pwd|पासवर्ड)\b\s*(?:is|hai|he|:|=|-)?\s*[:=-]?\s*["']?([^\s"',;]+)["']?/i);
  if (!pass || /^\{\{/.test(pass[1])) return { message, username: '', password: '' };
  const userWord = message.match(/\b(?:email|e-mail|mail|username|user\s*name|user|login\s*id|user\s*id|id)\b\s*(?:is|hai|he|:|=|-)?\s*[:=-]?\s*["']?([^\s"',;]+)["']?/i);
  const email = message.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const username = userWord && !/^(and|or|aur|password|pass)$/i.test(userWord[1]) ? userWord[1] : email ? email[0] : '';
  const password = pass[1];
  const swap = (text, value, holder) => (value ? text.split(value).join(holder) : text);
  return { message: swap(swap(message, password, '{{PASSWORD}}'), username, '{{USERNAME}}'), username, password };
}

function checkMessage(message) {
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new AgentError('INVALID_TASK', 'Write what the agent should do.');
  if (m.length > LIMITS.messageChars) throw new AgentError('INVALID_TASK', `Keep the message under ${LIMITS.messageChars} characters.`);
  return m;
}

/**
 * Makes room for one more lane: true when there is a free place, or the oldest finished lane
 * was cleared for it (its run stays on the Tasks page). False when all lanes are busy.
 */
function makeRoom(userId) {
  const lanes = userLanes(userId);
  if (lanes.size < LIMITS.lanesPerUser) return true;
  const oldest = [...lanes.values()].filter(isFinished).sort((a, b) => a.updatedAt - b.updatedAt)[0];
  if (!oldest) return false;
  lanes.delete(oldest.id);
  return true;
}

/** Starts the tasks waiting in line while there is room (after a task finishes or is cleared). */
function startNext(userId) {
  const queue = userQueue(userId);
  while (queue.length && makeRoom(userId)) {
    const item = queue.shift();
    openLane(userId, item);
  }
}

/** Drops the oldest finished lanes beyond the limit and lanes older than a day. */
function prune(userId) {
  const lanes = userLanes(userId);
  const now = Date.now();
  const finished = [...lanes.values()].filter((l) => !isActive(l)).sort((a, b) => a.updatedAt - b.updatedAt);
  finished.forEach((l, i) => {
    if (now - l.updatedAt > LIMITS.laneTtlMs || lanes.size - i > LIMITS.keepLanes) lanes.delete(l.id);
  });
}

/** Saves the lane as a run (Tasks / Results pages): the last answer and all data so far. */
function saveRun(lane, { first = false } = {}) {
  const last = lane.turns[lane.turns.length - 1];
  const rows = [];
  let columns = [];
  lane.turns.forEach((t) => {
    if (!t.data || !t.data.rows.length) return;
    if (!columns.length) columns = t.data.columns.slice();
    t.data.rows.forEach((r) => {
      const row = columns.map(() => '');
      t.data.columns.forEach((c, i) => {
        let at = columns.indexOf(c);
        if (at < 0 && columns.length < 30) {
          columns.push(c);
          row.push('');
          at = columns.length - 1;
        }
        if (at >= 0) row[at] = r[i];
      });
      rows.push(row);
    });
  });
  const usage = lane.turns.reduce((u, t) => addUsage(u, t.usage), null);
  const run = {
    id: lane.runId,
    userId: lane.userId,
    source: 'prompt',
    prompt: lane.task,
    task: { type: 'super_task', title: lane.title, url: lane.url || undefined, instructions: lane.task, hasLogin: lane.hasLogin, messages: lane.turns.length },
    // a task that ran to the end is a success; what it could not do is a note on it (only real errors fail)
    status: isActive(lane) ? 'running' : lane.status === 'failed' ? 'error' : 'success',
    createdAt: lane.createdAt,
    logs: lane.turns.flatMap((t) => t.steps.map((s, i) => ({ step: t.n * 1000 + i + 1, time: s.at, level: s.level, message: s.text }))),
    report: isActive(lane)
      ? null
      : {
          success: lane.status !== 'failed',
          durationMs: (last.finishedAt || Date.now()) - lane.createdAt,
          result: { kind: 'super_task', url: lane.url || last.finalUrl || '', answer: last.answer || '', data: { columns, rows: rows.map((r) => r.slice(0, columns.length)) }, steps: lane.turns.reduce((n, t) => n + t.steps.length, 0), finalUrl: last.finalUrl, usedLogin: lane.hasLogin, usage: usageOf(usage, WEB.model), shots: lane.turns.flatMap((t) => t.shots.map((sh) => ({ id: sh.id, label: sh.label, at: sh.at, message: t.n }))) },
          ...(lane.status === 'failed' ? { error: { code: 'SUPER_FAILED', message: last.error || 'The task failed.' } } : {}),
          ...(lane.status === 'incomplete' ? { note: (last.check && last.check.missing) || 'Not everything in the task could be done.' } : {}),
        },
  };
  try {
    if (first) runHistory.insert(run);
    else if (run.report) runHistory.finish(run);
  } catch (err) {
    console.error('[super] Could not save run history:', err.message);
  }
}

/** Runs one message (the task or a follow-up) of a lane in a tab of the user's browser. */
async function runTurn(lane, turn) {
  lane.status = 'queued';
  turn.status = 'queued';
  touch(lane);
  await takePage();
  if (lane.abort.signal.aborted) {
    givePage();
    lane.status = turn.status = 'stopped';
    turn.answer = 'Stopped before it started.';
    turn.finishedAt = Date.now();
    touch(lane);
    saveRun(lane);
    startNext(lane.userId);
    return;
  }
  lane.status = turn.status = 'running';
  turn.startedAt = Date.now();
  touch(lane);

  let lease = null;
  let page = null;
  let prevStep = null;
  const log = createLogger((entry) => {
    if (entry.level === 'info' && /^AI is thinking/.test(entry.message)) {
      lane.thinking = entry.message;
      return touch(lane);
    }
    lane.thinking = '';
    const now = Date.now();
    if (prevStep) prevStep.ms = now - Date.parse(prevStep.at);
    prevStep = { at: entry.time, level: entry.level, text: entry.message };
    turn.steps.push(prevStep);
    touch(lane);
    // a few screenshots while it works: after the page changes
    if (page && entry.level === 'action' && /^(Opening|Clicking|Picking|Choosing|Typing .* and pressing Enter)/.test(entry.message)) {
      setTimeout(() => shoot(lane, turn, page, entry.message).catch(() => {}), 2500);
    }
  });

  try {
    if (!useOpenAI()) throw new AgentError('AI_REQUIRED', 'The Super Agent needs an OpenAI API key (OPENAI_API_KEY in backend/.env).');
    lease = await openParallelPage(lane.userId, log);
    page = lease.page;
    await blockPrivateHosts(page, { skipMedia: false });
    const startUrl = lane.lastUrl || lane.url;
    if (startUrl) {
      log.action(`Opening ${startUrl}`);
      const { response, slow } = await openUrl(page, startUrl);
      if (slow) log.warn('The site is very slow to load; continuing with what is shown');
      const code = response ? response.status() : 0;
      if (!code || code >= 400) log.warn(code ? `The site did not open properly (error ${code}); it may block automated browsers` : 'The site did not answer');
      else log.info(`Page opened${lane.hasLogin && turn.n === 1 ? '; login details are ready (hidden from the AI)' : ''}`);
      await sleep(1200);
      await shoot(lane, turn, page, 'Start');
    }

    const site = lane.url ? new URL(lane.url).hostname : '';
    const allowOtherSites = !lane.url || lane.allowOtherSites || lane.sites.length > 1;
    const { agent, browser, data, scrub } = buildWebAgent(page, {
      name: 'Super agent',
      task: `${lane.task}\n${turn.message}`, // publish / delete / buy / send buttons only when asked
      prompt: PROMPT(lane, site, lane.hasLogin, allowOtherSites),
      startUrl: startUrl || 'about:blank',
      allowOtherSites,
      allowUrls: lane.sites,
      maxSteps: LIMITS.stepsPerTurn,
      secrets: lane.secrets,
      log,
      normalizeSiteUrl,
      extraTools: (b) => [searchTool(b, log), askTool(b, log, turn)],
    });
    // the earlier messages (and what the agent did) carry over, so follow-ups continue the work
    const input = lane.history ? [...lane.history, { role: 'user', content: turn.message }] : turn.n === 1 ? 'Do the task now.' : turn.message;
    log.action(turn.n === 1 ? 'Super Agent is working on it' : 'Working on your message');
    let out = await runAgent(agent, input, { maxTurns: LIMITS.stepsPerTurn * 2 + 10, log, browser, label: 'The agent', signal: lane.abort.signal });
    if (out.stopped === 'account') throw new AgentError('AI_UNAVAILABLE', out.message);
    let usage = out.usage;
    // The model sometimes stops early (gives up, only says what it would do, asks for details it
    // could choose): a check looks at the answer, the data and the page, and sends it back to
    // work with what is missing (up to 4 times, while steps are left). Its last word also decides done / incomplete.
    let verdict = null;
    let cutOff = !out.result; // ran out of steps or time (or the AI failed) before answering
    for (let round = 0; out.result && !turn.asked && !lane.abort.signal.aborted && round < 5; round++) {
      verdict = await checkDone(lane, turn, scrub(String(out.result.finalOutput || '')), data, page);
      usage = addUsage(usage, verdict.usage);
      if (verdict.status !== 'unfinished') {
        if (verdict.status === 'complete') log.info('Checked: the task is done');
        if (verdict.status === 'blocked') log.info(`Checked: it cannot be finished here${verdict.missing ? ` (${verdict.missing})` : ''}`);
        break;
      }
      if (round === 4 || browser.steps() > LIMITS.stepsPerTurn - 4) break;
      log.info(`Not finished yet: ${verdict.missing || 'the task is not complete'}. Carrying on`);
      const again = await runAgent(agent, [...out.result.history, { role: 'user', content: `Not finished yet: ${verdict.missing || 'the task is not complete'}. Keep going with the tools until it is really done (check it on the page), choosing any details yourself, then give your final answer in ${answerLanguage(lane.task)}.` }], { maxTurns: LIMITS.stepsPerTurn * 2 + 10, log, browser, label: 'The agent', signal: lane.abort.signal });
      usage = addUsage(usage, again.usage);
      if (!again.result) {
        out = { ...again, result: out.result };
        cutOff = true;
        break;
      }
      out = again;
      verdict = null;
    }
    if (out.result) lane.history = out.result.history;
    lane.lastUrl = page.url() !== 'about:blank' ? page.url() : lane.lastUrl;
    turn.finalUrl = lane.lastUrl;
    turn.data = data;
    turn.usage = usageOf(usage, WEB.model);
    const said = out.result ? scrub(String(out.result.finalOutput || '').trim()) : '';
    // a question asked with ask_user stays as it is; otherwise no closing offers
    turn.answer = turn.asked ? said : tidyAnswer(said);
    if (out.stopped === 'user') {
      turn.status = 'stopped';
      if (!turn.answer) turn.answer = data.rows.length ? `Stopped. ${data.rows.length} row(s) were saved before that.` : 'Stopped.';
    } else {
      if (!turn.answer) {
        turn.answer = data.rows.length ? `Collected ${data.rows.length} row(s) before stopping.` : 'The agent could not finish this.';
        if (out.stopped === 'time') turn.answer += ' It reached the time limit.';
        else if (out.stopped === 'steps') turn.answer += ' It used all its steps for this message.';
        turn.answer += ' Send a follow-up to continue, or give it a clearer way to do it.';
      }
      // Only ask_user makes the turn wait for a reply; the check says done or not; one cut off
      // with nothing saved is incomplete.
      const notDone = verdict && verdict.status !== 'complete';
      turn.status = turn.asked ? 'waiting' : notDone || (cutOff && !data.rows.length) ? 'incomplete' : 'done';
      turn.check = verdict ? { status: verdict.status, missing: verdict.missing } : null;
    }
    const n = browser.steps();
    const what = data.rows.length ? `${data.rows.length} row(s) of data` : '';
    if (turn.status === 'stopped') {
      // the stop is already in the log
    } else if (turn.status === 'incomplete') log.info(`Done. Not everything could be done${turn.check && turn.check.missing ? `: ${turn.check.missing}` : ''}`);
    else if (turn.status === 'waiting') log.info('Waiting for your reply');
    else log.success(n ? `Done in ${n} step${n === 1 ? '' : 's'}${what ? `: ${what}` : ''}` : `Done${what ? `: ${what}` : ''}`);
    await shoot(lane, turn, page, 'End', { final: true });
  } catch (err) {
    turn.status = 'failed';
    turn.error = err instanceof AgentError ? err.message : `Something went wrong: ${short(err.message, 200)}`;
    turn.answer = turn.error;
    log.error(turn.error);
    if (page) await shoot(lane, turn, page, 'When it failed', { final: true }).catch(() => {});
  } finally {
    turn.finishedAt = Date.now();
    lane.status = turn.status;
    lane.thinking = '';
    if (prevStep && prevStep.ms === undefined) prevStep.ms = Date.now() - Date.parse(prevStep.at);
    if (lease) await lease.release();
    givePage();
    touch(lane);
    saveRun(lane);
    // a finished task makes room for the next one in line (after a moment, so "Done" shows)
    if (isFinished(lane) && userQueue(lane.userId).length) setTimeout(() => startNext(lane.userId), LIMITS.doneShowMs);
  }
}

function newTurn(lane, message) {
  const turn = { n: lane.turns.length + 1, message, status: 'queued', steps: [], shots: [], answer: '', data: null, usage: null };
  lane.turns.push(turn);
  return turn;
}

// ---------------------------------------------------------------- API

/**
 * A new task. input: { message, username?, password?, allowOtherSites? }. Returns { lane } when
 * it starts now (a free place, or the oldest finished lane is cleared for it) or { queued }
 * when all lanes are busy: it then starts as soon as one finishes. The first web address in the
 * message is where it starts; without one the agent searches the web.
 */
function startLane(userId, input = {}) {
  let message = checkMessage(input.message);
  let username = typeof input.username === 'string' ? input.username : '';
  let password = typeof input.password === 'string' ? input.password : '';
  // details written in the message count when none were given in the login box
  if (!username && !password) ({ message, username, password } = loginFromMessage(message));
  if (username.length > 300 || password.length > 300) throw new AgentError('INVALID_TASK', 'The login details are too long.');
  prune(userId);
  const item = { id: crypto.randomUUID(), message, title: titleOf(message), allowOtherSites: input.allowOtherSites === true, createdAt: Date.now() };
  // Not enumerable: never part of JSON (API answers)
  Object.defineProperty(item, 'secrets', { value: { USERNAME: username, PASSWORD: password }, enumerable: false });
  const queue = userQueue(userId);
  // in line behind the others, or a lane now (a finished lane makes room for it)
  if (!queue.length && makeRoom(userId)) return { lane: openLane(userId, item) };
  if (queue.length >= LIMITS.queuePerUser) {
    throw new AgentError('LANE_LIMIT', `${LIMITS.lanesPerUser} tasks are open and ${LIMITS.queuePerUser} more are waiting in line. Send this when one of them has started.`);
  }
  queue.push(item);
  return { queued: queueView(item, queue.length) };
}

/** A waiting task as the page sees it (position 1 = next to start). */
function queueView(item, position) {
  return { id: item.id, title: item.title, message: item.message, hasLogin: Boolean(item.secrets.USERNAME || item.secrets.PASSWORD), position, createdAt: new Date(item.createdAt).toISOString() };
}

/** Removes a task that is waiting in line (it never started, so it has no run). */
function cancelQueued(userId, id) {
  const queue = userQueue(userId);
  const i = queue.findIndex((q) => q.id === id);
  if (i >= 0) queue.splice(i, 1);
  return { cancelled: true, missing: i < 0 };
}

/** Opens a lane for a task (from the message box or the line) and starts it. */
function openLane(userId, item) {
  const message = item.message;
  const { USERNAME: username, PASSWORD: password } = item.secrets;

  // Every web address in the message: the first is where it starts, the others may be opened
  // too ("compare the price on hubspot.com with pipedrive.com").
  const sites = [];
  (message.match(/https?:\/\/[^\s)"'<>]+|\b(?:[a-z0-9-]+\.)+(?:com|in|org|net|io|co|ai|app|dev|uk|us|info|biz|shop|store)(?:\/[^\s)"'<>]*)?/gi) || []).forEach((m) => {
    const u = normalizeSiteUrl(m.replace(/[.,;:]+$/, ''));
    if (u && sites.length < 5 && !sites.some((x) => new URL(x).hostname === new URL(u).hostname)) sites.push(u);
  });
  const url = sites[0] || null;
  const now = Date.now();
  const lane = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    userId,
    title: item.title,
    task: message,
    url: url || '',
    sites,
    allowOtherSites: item.allowOtherSites,
    hasLogin: Boolean(username || password),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    turns: [],
    history: null,
    lastUrl: '',
    shots: new Map(),
    abort: new AbortController(),
  };
  // Not enumerable: never part of JSON (API answers, run history)
  Object.defineProperty(lane, 'secrets', { value: { USERNAME: username, PASSWORD: password }, enumerable: false });
  userLanes(userId).set(lane.id, lane);
  const turn = newTurn(lane, message);
  saveRun(lane, { first: true });
  runTurn(lane, turn).catch((err) => console.error('[super] lane failed:', err));
  return laneView(lane);
}

function laneOf(userId, id) {
  const lane = userLanes(userId).get(id);
  if (!lane) throw new AgentError('LANE_NOT_FOUND', 'This task is no longer here. Start it again.');
  return lane;
}

/** A follow-up message on a finished lane: continues in the same chat. */
function followUp(userId, id, input = {}) {
  const lane = laneOf(userId, id);
  let message = checkMessage(input.message);
  if (isActive(lane)) throw new AgentError('LANE_BUSY', 'This task is still working. Wait for it to finish, or stop it first.');
  // login details sent in a follow-up ("here is the password: …") become the lane's
  const found = loginFromMessage(message);
  if (found.password) {
    message = found.message;
    lane.secrets.PASSWORD = found.password;
    if (found.username) lane.secrets.USERNAME = found.username;
    lane.hasLogin = true;
  }
  lane.abort = new AbortController();
  const turn = newTurn(lane, message);
  runTurn(lane, turn).catch((err) => console.error('[super] lane failed:', err));
  return laneView(lane);
}

/** Stops a lane that is queued or working (what it saved so far is kept). */
function stopLane(userId, id) {
  const lane = laneOf(userId, id);
  if (isActive(lane)) lane.abort.abort();
  return laneView(lane);
}

/** Removes a finished lane from the page (its run stays on the Tasks page). */
function clearLane(userId, id) {
  const lane = userLanes(userId).get(id);
  // already gone (e.g. the server restarted, which empties the lanes): nothing left to clear
  if (!lane) return { cleared: true, missing: true };
  if (isActive(lane)) throw new AgentError('LANE_BUSY', 'Stop this task before clearing it.');
  userLanes(userId).delete(id);
  startNext(userId);
  return { cleared: true };
}

/** The user's lanes, newest first. */
function listLanes(userId) {
  prune(userId);
  const lanes = [...userLanes(userId).values()].sort((a, b) => b.createdAt - a.createdAt);
  const queue = userQueue(userId);
  return {
    lanes: lanes.map(laneView),
    queue: queue.map((q, i) => queueView(q, i + 1)),
    limits: { lanesPerUser: LIMITS.lanesPerUser, queuePerUser: LIMITS.queuePerUser, lanes: lanes.length, active: lanes.filter(isActive).length, queued: queue.length, serverBusy: pagesInUse >= LIMITS.maxPages },
    serverStarted: SERVER_STARTED,
  };
}

/** One screenshot (base64 JPEG). */
function getShot(userId, id, shotId) {
  const data = laneOf(userId, id).shots.get(shotId);
  if (!data) throw new AgentError('SHOT_NOT_FOUND', 'This screenshot is no longer here.');
  return { id: shotId, data };
}

/** A saved screenshot of a run (the caller has checked the run is the user's). */
function runShot(runId, shotId) {
  if (!RUN_ID.test(runId) || !SHOT_ID.test(shotId)) throw new AgentError('SHOT_NOT_FOUND', 'This screenshot is no longer here.');
  try {
    return { id: shotId, data: fs.readFileSync(path.join(SHOTS_DIR, runId, `${shotId}.jpg`)).toString('base64') };
  } catch {
    throw new AgentError('SHOT_NOT_FOUND', 'This screenshot is no longer here.');
  }
}

module.exports = { startLane, cancelQueued, followUp, stopLane, clearLane, listLanes, getShot, runShot, LIMITS };
