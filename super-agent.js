/**
 * super-agent.js
 * ---------------------------------------------------------------------------
 * Super Agent: up to 3 tasks ("lanes") at the same time per user, each in its own tab of the
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
const { useOpenAI, runAgent, openUrl, findSources, aiModel, short, sleep, usageOf } = require('./ai-browser');
const { openParallelPage, createLogger, normalizeSiteUrl, blockPrivateHosts, AgentError, CONFIG } = require('./agent');
const { runHistory } = require('./db');

const LIMITS = {
  lanesPerUser: 3, // lanes per user, working or finished (a finished one is closed to make room)
  // super agent tabs running at the same time on this server (each is about one browser's CPU)
  maxPages: Math.max(1, parseInt(process.env.SUPER_MAX_PAGES, 10) || CONFIG.maxBrowsers),
  stepsPerTurn: Math.min(60, Math.max(10, parseInt(process.env.SUPER_MAX_STEPS, 10) || 40)),
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

/** Sent when the agent stopped after describing its next steps instead of doing them. */
const CARRY_ON = "Don't describe what you will do: do it now with the tools and finish the task (save the data with save_data), then give your final answer.";

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
    status: lane.status, // queued | running | waiting (asked a question) | done | incomplete (ran out of steps / time) | stopped | failed
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
    })),
  };
}

function checkMessage(message) {
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new AgentError('INVALID_TASK', 'Write what the agent should do.');
  if (m.length > LIMITS.messageChars) throw new AgentError('INVALID_TASK', `Keep the message under ${LIMITS.messageChars} characters.`);
  return m;
}

/** A user has at most 3 lanes, working or finished: a finished one is closed to make room. */
function checkRoom(userId) {
  const lanes = [...userLanes(userId).values()];
  if (lanes.length < LIMITS.lanesPerUser) return;
  throw new AgentError(
    'LANE_LIMIT',
    lanes.every(isActive)
      ? `All ${LIMITS.lanesPerUser} tasks are working. Wait for one to finish, close it (×), then send this.`
      : `You can have ${LIMITS.lanesPerUser} tasks at a time. Close a finished one (×) to start a new one.`,
  );
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
    status: isActive(lane) ? 'running' : lane.status === 'failed' || lane.status === 'incomplete' ? 'error' : 'success',
    createdAt: lane.createdAt,
    logs: lane.turns.flatMap((t) => t.steps.map((s, i) => ({ step: t.n * 1000 + i + 1, time: s.at, level: s.level, message: s.text }))),
    report: isActive(lane)
      ? null
      : {
          success: lane.status !== 'failed' && lane.status !== 'incomplete',
          durationMs: (last.finishedAt || Date.now()) - lane.createdAt,
          result: { kind: 'super_task', url: lane.url || last.finalUrl || '', answer: last.answer || '', data: { columns, rows: rows.map((r) => r.slice(0, columns.length)) }, steps: lane.turns.reduce((n, t) => n + t.steps.length, 0), finalUrl: last.finalUrl, usedLogin: lane.hasLogin, usage: usageOf(usage, WEB.model), shots: lane.turns.flatMap((t) => t.shots.map((sh) => ({ id: sh.id, label: sh.label, at: sh.at, message: t.n }))) },
          ...(lane.status === 'failed' ? { error: { code: 'SUPER_FAILED', message: last.error || 'The task failed.' } } : {}),
          ...(lane.status === 'incomplete' ? { error: { code: 'SUPER_INCOMPLETE', message: last.answer || 'The agent could not finish the task.' } } : {}),
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
    // The model sometimes stops after saying what it will do next ("Now I will sort them and
    // save the 10 cheapest…") without doing it: tell it to carry on (at most twice).
    for (let nudge = 0; nudge < 2 && out.result && !data.rows.length && !lane.abort.signal.aborted; nudge++) {
      const said = String(out.result.finalOutput || '');
      const promise = /\b(I will|I'll|I am going to|I'm going to|Let me (now )?(open|go|click|check|search|find|collect|save|read|sort|look)|Next,? I|Now,? I will|I need to)\b/i.test(said) && !/\?\s*$/.test(said);
      // "I could not open it: the site blocks automated browsers. I will need…" is an answer, not a promise
      const blocked = /\b(can'?not|can't|couldn'?t|could not|unable|not able|blocked|captcha|access denied|login details|not allowed|no (results|data))\b/i.test(said);
      if (!promise || blocked || turn.asked || browser.outOfSteps()) break;
      log.info('Continuing: the agent said what it would do next but stopped');
      const again = await runAgent(agent, [...out.result.history, { role: 'user', content: CARRY_ON }], { maxTurns: LIMITS.stepsPerTurn * 2 + 10, log, browser, label: 'The agent', signal: lane.abort.signal });
      usage = addUsage(usage, again.usage);
      if (!again.result) {
        out = { ...again, result: out.result };
        break;
      }
      out = again;
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
      const cutOff = !out.result; // ran out of steps or time (or the AI failed) before answering
      if (!turn.answer) {
        turn.answer = data.rows.length ? `Collected ${data.rows.length} row(s) before stopping.` : 'The agent could not finish this.';
        if (out.stopped === 'time') turn.answer += ' It reached the time limit.';
        else if (out.stopped === 'steps') turn.answer += ' It used all its steps for this message.';
        turn.answer += ' Send a follow-up to continue, or give it a clearer way to do it.';
      }
      // Only ask_user makes the turn wait for a reply; a finished task that offers more
      // ("Want me to …?") is done, and one cut off with nothing saved is incomplete.
      turn.status = turn.asked ? 'waiting' : cutOff && !data.rows.length ? 'incomplete' : 'done';
    }
    const n = browser.steps();
    const what = data.rows.length ? `${data.rows.length} row(s) of data` : '';
    if (turn.status === 'stopped') {
      // the stop is already in the log
    } else if (turn.status === 'incomplete') log.warn('Could not finish this');
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
  }
}

function newTurn(lane, message) {
  const turn = { n: lane.turns.length + 1, message, status: 'queued', steps: [], shots: [], answer: '', data: null, usage: null };
  lane.turns.push(turn);
  return turn;
}

// ---------------------------------------------------------------- API

/**
 * Starts a lane. input: { message, username?, password?, allowOtherSites? }. The first web
 * address in the message is where it starts; without one the agent searches the web.
 */
function startLane(userId, input = {}) {
  const message = checkMessage(input.message);
  const username = typeof input.username === 'string' ? input.username : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (username.length > 300 || password.length > 300) throw new AgentError('INVALID_TASK', 'The login details are too long.');
  prune(userId);
  checkRoom(userId);

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
    title: titleOf(message),
    task: message,
    url: url || '',
    sites,
    allowOtherSites: input.allowOtherSites === true,
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
  const message = checkMessage(input.message);
  if (isActive(lane)) throw new AgentError('LANE_BUSY', 'This task is still working. Wait for it to finish, or stop it first.');
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
  return { cleared: true };
}

/** The user's lanes, newest first. */
function listLanes(userId) {
  prune(userId);
  const lanes = [...userLanes(userId).values()].sort((a, b) => b.createdAt - a.createdAt);
  return {
    lanes: lanes.map(laneView),
    limits: { lanesPerUser: LIMITS.lanesPerUser, lanes: lanes.length, active: lanes.filter(isActive).length, serverBusy: pagesInUse >= LIMITS.maxPages },
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

module.exports = { startLane, followUp, stopLane, clearLane, listLanes, getShot, runShot, LIMITS };
