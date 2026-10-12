/**
 * ai-browser.js
 * ---------------------------------------------------------------------------
 * What the AI agents (qa-agent.js, web-agent.js) share: the OpenAI client for the Agents SDK
 * and the browser tools the model can call. The model only picks a tool and its arguments;
 * Playwright does the action, one action at a time.
 *
 * Login details: the model sees only the placeholders {{USERNAME}} and {{PASSWORD}}; type_text
 * swaps in the real values when it types, so they never reach the model, the logs or the result.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const OpenAI = require('openai');
const { z } = require('zod');
const { tool, run, setDefaultOpenAIClient, setTracingDisabled } = require('@openai/agents');

const SNAPSHOT_CHARS = 24000; // ~6k tokens: what the model reads per page
const QUIET_MAX_MS = 25000; // after an action, wait this long at most for the site's background requests
// One AI request may take this long before it is retried (the OpenAI default is 10 minutes,
// so a stuck request left the task "running" with nothing happening).
const AI_REQUEST_TIMEOUT_MS = Math.max(15, Number(process.env.AI_REQUEST_TIMEOUT_SECONDS) || 60) * 1000;
// A whole AI task stops after this long and keeps what it has done so far.
const AI_TASK_LIMIT_MS = Math.max(1, Number(process.env.AI_TASK_MAX_MINUTES) || 10) * 60 * 1000;

let clientReady = false;
/** Sets up the Agents SDK with our OpenAI key. false when there is no key. */
function useOpenAI() {
  if (!process.env.OPENAI_API_KEY) return false;
  if (!clientReady) {
    setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 2 }));
    setTracingDisabled(!/^(1|true|yes|on)$/i.test(process.env.QA_TRACING || ''));
    clientReady = true;
  }
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

/**
 * Before each AI request: older read_page results are replaced by a one-line note, so only
 * the newest page outline is sent. Without this every step re-sends every page read so far
 * and the cost grows with each step (measured: 600k input tokens for 20 steps).
 */
function keepLatestPageOnly({ modelData }) {
  const input = modelData.input.slice();
  let newest = -1;
  input.forEach((item, i) => {
    if (item && item.type === 'function_call_result' && item.name === 'read_page') newest = i;
  });
  input.forEach((item, i) => {
    if (item && item.type === 'function_call_result' && item.name === 'read_page' && i !== newest) {
      const note = '(older page reading removed to save space; call read_page to see the page now)';
      input[i] = { ...item, output: typeof item.output === 'string' ? note : { type: 'text', text: note } };
    }
  });
  return { ...modelData, input };
}

/** "shop.example.com" and "www.example.com" count as the same site as "example.com". */
function sameSite(url, baseHost) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const base = baseHost.replace(/^www\./, '');
    return h === base || h.endsWith(`.${base}`) || base.endsWith(`.${h}`);
  } catch {
    return false;
  }
}

/** Waits for the page to settle after an action (navigation or script updates). */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
  await sleep(600);
}

/**
 * Opens `url` and waits for it to be usable. Slow sites (scripts that take 30+ s) are not a
 * failure: we wait up to 45 s for the page to finish parsing, then go on with what is there.
 * Returns the response (or null) and whether the page was slow.
 */
async function openUrl(page, url) {
  const response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  let slow = false;
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {
    slow = true;
  });
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  return { response, slow };
}

/** The model's run usage in the shape we store. */
function usageOf(usage, model) {
  return usage
    ? { model, requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    : { model };
}

/** A field that opens suggestions while you type (location, city, address search...). */
async function looksLikeAutocomplete(field) {
  return field
    .evaluate((el) => {
      const attrs = ['aria-autocomplete', 'list', 'aria-haspopup', 'aria-controls', 'aria-owns'].some((a) => el.hasAttribute(a));
      const words = [el.id, el.name, el.className, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')].join(' ');
      return attrs || /locat|city|address|place|autocomplete|suggest|where/i.test(words);
    }, null, { timeout: 3000 })
    .catch(() => false);
}

/** Types like a person (key events), so autocomplete lists open. */
async function typeKeyByKey(field, value) {
  await field.click({ timeout: 8000 });
  await field.fill('', { timeout: 5000 }).catch(() => {});
  await field.pressSequentially(value, { delay: 70, timeout: 20000 });
  await sleep(1500); // time for the suggestions to load
}

// The items of an autocomplete list on common sites (ARIA, Google Places, jQuery UI, others).
const SUGGESTIONS = '[role="option"], [role="listbox"] li, .pac-item, .ui-menu-item, .autocomplete-suggestion, [class*="suggestion"] li, [class*="autocomplete"] li, [class*="dropdown"] li';

/** The visible suggestions of an open autocomplete list (first 8). */
async function readSuggestions(page) {
  return page
    .evaluate((sel) => {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (r.width && r.height && t && !out.includes(t)) out.push(t.slice(0, 100));
        if (out.length >= 8) break;
      }
      return out;
    }, SUGGESTIONS)
    .catch(() => []);
}

/**
 * Runs an Agents SDK agent with a time limit, and while the model is thinking (no tool
 * running for a while) writes "AI is thinking…" to the log so the task doesn't look stuck.
 * Returns { result, usage, stopped }: stopped is null, 'steps', 'time' or the error message.
 */
async function runAgent(agent, input, { maxTurns, log, browser, label = 'The AI agent', signal }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), AI_TASK_LIMIT_MS);
  // signal: the user pressed Stop (super agent)
  const onStop = () => abort.abort();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', onStop, { once: true });
  }
  let lastNote = 0;
  const heartbeat = setInterval(() => {
    const idle = browser.idleMs();
    if (idle >= 15000 && Date.now() - lastNote >= 15000) {
      lastNote = Date.now();
      log.info(`AI is thinking… (${Math.round(idle / 1000)}s)`);
    }
  }, 5000);
  try {
    const result = await run(agent, input, { maxTurns, callModelInputFilter: keepLatestPageOnly, signal: abort.signal });
    return { result, usage: result.runContext && result.runContext.usage, stopped: null };
  } catch (err) {
    const usage = err && err.state && err.state.usage ? err.state.usage : null;
    let stopped;
    if (signal && signal.aborted) {
      stopped = 'user';
      log.warn(`${label} was stopped`);
    } else if (abort.signal.aborted) {
      stopped = 'time';
      log.warn(`${label} reached the time limit (${Math.round(AI_TASK_LIMIT_MS / 60000)} min) and stopped`);
    } else if (/max turns/i.test(err && err.message)) {
      stopped = 'steps';
      log.warn(`${label} used all its steps`);
    } else if (/no credits|insufficient_quota|quota|billing|incorrect api key|invalid api key|401/i.test(err && err.message)) {
      // the OpenAI account can't be used: nothing the agent can do about it
      const message = /401|api key/i.test(err.message)
        ? 'The OpenAI API key is not valid. Check OPENAI_API_KEY in backend/.env.'
        : 'The OpenAI account has no credits left. Add credits at platform.openai.com (Settings → Billing), then run the task again.';
      log.warn(message);
      return { result: null, usage, stopped: 'account', message };
    } else {
      stopped = short(err && err.message, 200);
      log.warn(`${label} stopped: ${stopped}`);
    }
    return { result: null, usage, stopped };
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (signal) signal.removeEventListener('abort', onStop);
  }
}

/**
 * The browser tools for an agent working on `page`.
 * opts: { startUrl, allowOtherSites, maxSteps, log, normalizeSiteUrl, secrets: { USERNAME, PASSWORD } | null, allowUrls: [] }
 * Returns { tools, oneAtATime, steps(), outOfSteps(), LIMIT }.
 */
function createBrowserTools(page, opts) {
  const { startUrl, allowOtherSites = false, maxSteps, log, normalizeSiteUrl } = opts;
  // Addresses open_page may open: the start page, addresses in the task (opts.allowUrls) and
  // every link read_page has shown. Models
  // make up addresses that look right ("/contacts", "index.php?module=...") and lose their
  // steps on error pages; they get to open only what is really on the pages.
  const known = new Set([startUrl, ...(opts.allowUrls || [])].map((u) => u.split('#')[0]));
  const remember = (snapshot) => {
    for (const m of String(snapshot).matchAll(/\/url: (\S+)/g)) {
      try {
        known.add(new URL(m[1], page.url()).toString().split('#')[0]);
      } catch {
        // not an address
      }
    }
  };
  const secrets = opts.secrets || {};
  const baseHost = new URL(startUrl).hostname;
  let steps = 0;
  let lastActivity = Date.now();
  let busy = false;
  const step = (label) => {
    steps++;
    log.action(label);
  };
  const LIMIT = 'STEP LIMIT REACHED: do not call more browser tools. Save or record what you have, then write your final answer now.';
  const outOfSteps = () => steps >= maxSteps;
  const allowed = (url) => Boolean(normalizeSiteUrl(url)) && (allowOtherSites || sameSite(url, baseHost));

  // The site's background requests (XHR / fetch) still waiting for an answer. Many sites load
  // search results this way, some slowly (measured: 13 s), and show "0 results" until then.
  // Requests to other sites (ads, analytics) are left out: on news sites they never stop.
  const pending = new Map();
  const track = (r) => {
    if (['xhr', 'fetch'].includes(r.resourceType())) pending.set(r, Date.now());
  };
  const untrack = (r) => pending.delete(r);
  page.on('request', track);
  page.on('requestfinished', untrack);
  page.on('requestfailed', untrack);

  /** Waits (up to maxMs) until the site has no background request open for a moment. false if it is still busy. */
  const waitForQuiet = async (maxMs = QUIET_MAX_MS) => {
    const until = Date.now() + maxMs;
    let quietSince = 0;
    while (Date.now() < until) {
      // a request open for over a minute is a long poll, not the page loading
      const host = new URL(page.url()).hostname;
      const open = [...pending].filter(([r, t]) => Date.now() - t < 60000 && sameSite(r.url(), host)).length;
      if (open) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince >= 700) return true;
      await sleep(200);
    }
    return false;
  };

  /** "Loading…", "Getting location…", "Please wait" still on the page: a note for the model, or ''. */
  const loadingNote = async () => {
    const seen = await page
      .evaluate(() => {
        const re = /\b(loading|getting|fetching|searching|please wait|processing)\b[^\n]{0,40}?(\.\.\.|…)|\bplease wait\b/i;
        const m = (document.body.innerText || '').match(re);
        return m ? m[0] : '';
      })
      .catch(() => '');
    return seen ? ` The page still shows "${short(seen, 60)}": it may still be loading results; use wait, then read_page again before you decide.` : '';
  };

  /** After an action: wait for the site to finish loading; back to the site if a click left it (unless other sites are allowed). */
  const after = async () => {
    await settle(page);
    if (!allowOtherSites && !sameSite(page.url(), baseHost)) {
      const left = page.url();
      await page.goBack({ timeout: 10000 }).catch(() => page.goto(startUrl).catch(() => {}));
      await settle(page);
      return `That opened another website (${short(left, 120)}), so the browser went back. Now on ${page.url()}.`;
    }
    const quiet = await waitForQuiet();
    return `Now on ${page.url()} — "${short(await page.title(), 120)}".${quiet ? '' : ' The site is still loading something.'}${await loadingNote()}`;
  };
  /**
   * An element by its accessible role and name, as read_page lists them. Visible matches come
   * first: menus often hold a hidden copy of the same link, which can't be clicked.
   */
  const element = async (role, name, index) => {
    const all = role === 'text' ? page.getByText(name, { exact: false }) : page.getByRole(role, { name, exact: false });
    const visible = all.filter({ visible: true });
    return (await visible.count()) > (index || 0) ? visible.nth(index || 0) : all.nth(index || 0);
  };
  const fail = (err) => `Failed: ${short(String(err && err.message ? err.message : err).split('\n')[0], 200)}`;

  // One browser, one action at a time: if the model asks for two actions at once (e.g. typing
  // two todos), they run one after the other instead of typing into the same box together.
  let queue = Promise.resolve();
  const oneAtATime = (fn) => (args) => {
    const next = queue.then(async () => {
      busy = true;
      try {
        return await fn(args);
      } finally {
        busy = false;
        lastActivity = Date.now();
      }
    });
    queue = next.catch(() => {});
    return next;
  };

  /** {{USERNAME}} / {{PASSWORD}} -> the real values (only here, right before typing). */
  const withSecrets = (text) =>
    String(text).replace(/\{\{\s*(USERNAME|PASSWORD)\s*\}\}/g, (m, key) => (secrets[key] !== undefined && secrets[key] !== '' ? secrets[key] : m));
  const usesSecret = (text) => /\{\{\s*(USERNAME|PASSWORD)\s*\}\}/.test(String(text));

  const tools = [
    tool({
      name: 'read_page',
      description: 'Read the current page: its address, title and an outline of its content and controls (role "name" per line).',
      parameters: z.object({}),
      execute: oneAtATime(async () => {
        if (outOfSteps()) return LIMIT;
        step('Reading the page');
        const snapshot = await page.locator('body').ariaSnapshot({ timeout: 15000 }).catch((e) => `(could not read the page: ${e.message})`);
        remember(snapshot);
        const note = await loadingNote();
        return `URL: ${page.url()}\nTitle: ${await page.title()}${note ? `\nNote:${note}` : ''}\n\n${short(snapshot, SNAPSHOT_CHARS)}`;
      }),
    }),
    tool({
      name: 'open_page',
      description: allowOtherSites ? 'Open a web address (a full URL, or a path like /orders on the current site).' : `Open an address on ${baseHost} (a full URL or a path like /orders).`,
      parameters: z.object({ address: z.string() }),
      execute: oneAtATime(async ({ address }) => {
        if (outOfSteps()) return LIMIT;
        let url;
        try {
          url = new URL(address, page.url()).toString();
        } catch {
          return 'Not a valid address.';
        }
        if (!allowed(url)) return allowOtherSites ? 'Not allowed: that address is not a public website.' : `Not allowed: only pages on ${baseHost} can be opened.`;
        if (!known.has(url.split('#')[0])) return 'Not allowed: open_page opens only addresses that read_page has shown (copy a /url exactly). Find the link or menu on the page instead.';
        step(`Opening ${short(url, 100)}`);
        try {
          const { response: r, slow } = await openUrl(page, url);
          return `${r ? `Answered ${r.status()}. ` : ''}${slow ? 'The page is slow and may still be loading. ' : ''}${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'click',
      description: 'Click an element. role is its role from read_page (button, link, checkbox, tab, menuitem, option...) or "text" to click visible text. index picks among several matches (0 = first).',
      parameters: z.object({ role: z.string(), name: z.string(), index: z.number().int().nullable() }),
      execute: oneAtATime(async ({ role, name, index }) => {
        if (outOfSteps()) return LIMIT;
        step(`Clicking ${role} "${short(name, 60)}"`);
        try {
          await (await element(role, name, index)).click({ timeout: 8000 });
          return `Clicked. ${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'type_text',
      description: 'Type into a field found by role (textbox, searchbox, combobox, spinbutton) and name. For login details write {{USERNAME}} or {{PASSWORD}} exactly; the real values are filled in for you. submit=true presses Enter afterwards. Location, city, address and other autocomplete fields are typed key by key and the reply lists the suggestions that open: pick one with pick_suggestion.',
      parameters: z.object({ role: z.string(), name: z.string(), text: z.string(), submit: z.boolean(), index: z.number().int().nullable() }),
      execute: oneAtATime(async ({ role, name, text, submit, index }) => {
        if (outOfSteps()) return LIMIT;
        const secret = usesSecret(text);
        // the log shows the placeholder, never the real value
        step(`Typing ${secret ? text : `"${short(text, 40)}"`} into ${role} "${short(name, 50)}"${submit ? ' and pressing Enter' : ''}`);
        try {
          const field = await element(role, name, index);
          const value = withSecrets(text);
          const keyByKey = !secret && (/combobox|searchbox/i.test(role) || (await looksLikeAutocomplete(field)));
          if (keyByKey) {
            await typeKeyByKey(field, value);
          } else {
            await field.fill(value, { timeout: 8000 });
            // some fields ignore fill(): type it like a person instead
            if ((await field.inputValue({ timeout: 2000 }).catch(() => value)) !== value) await typeKeyByKey(field, value);
          }
          const filled = (await field.inputValue({ timeout: 2000 }).catch(() => null)) === value;
          if (secret) log.info(`${filled ? 'Filled' : 'Could not fill'} the ${/PASSWORD/.test(text) ? 'password' : 'username'} field`);
          if (submit) {
            await field.press('Enter');
            return `Typed. ${await after()}`;
          }
          const suggestions = keyByKey ? await readSuggestions(page) : [];
          if (suggestions.length) {
            log.info(`${suggestions.length} suggestion(s) appeared`);
            return `Typed. Suggestions opened: ${suggestions.map((t) => JSON.stringify(t)).join(', ')}. Pick the right one with pick_suggestion so the site accepts the value.`;
          }
          return `Typed${filled ? '' : ' (but the field does not show the text: try another field or way)'}. ${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'pick_suggestion',
      description: 'Click a suggestion in the list that opened under a field after type_text (city, address, search suggestions). text = the suggestion as type_text listed it, or part of it.',
      parameters: z.object({ text: z.string() }),
      execute: oneAtATime(async ({ text }) => {
        if (outOfSteps()) return LIMIT;
        step(`Picking the suggestion "${short(text, 60)}"`);
        try {
          const items = page.locator(SUGGESTIONS).filter({ visible: true });
          const exact = items.filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
          const item = (await exact.count()) ? exact.first() : items.filter({ hasText: text }).first();
          await item.click({ timeout: 8000 });
          return `Picked. ${await after()}`;
        } catch (err) {
          const open = await readSuggestions(page);
          return `${fail(err)}${open.length ? ` Suggestions now: ${open.map((t) => JSON.stringify(t)).join(', ')}` : ' No suggestion list is open: type into the field again.'}`;
        }
      }),
    }),
    tool({
      name: 'choose_option',
      description: 'Pick an option in a drop-down (role combobox or listbox) by its label.',
      parameters: z.object({ name: z.string(), option: z.string() }),
      execute: oneAtATime(async ({ name, option }) => {
        if (outOfSteps()) return LIMIT;
        step(`Choosing "${short(option, 40)}" in "${short(name, 50)}"`);
        try {
          await page.getByRole('combobox', { name, exact: false }).first().selectOption({ label: option }, { timeout: 8000 });
          return `Chosen. ${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'press_key',
      description: 'Press a key on the page (Enter, Escape, Tab, ArrowDown...).',
      parameters: z.object({ key: z.string() }),
      execute: oneAtATime(async ({ key }) => {
        if (outOfSteps()) return LIMIT;
        step(`Pressing ${key}`);
        try {
          await page.keyboard.press(key);
          return `Pressed. ${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'wait',
      description: 'Wait for the page to finish loading (e.g. search results that show "Loading…" or "0 results" at first). text (optional) = a text that will show once it has loaded, or a loading text to wait to go away; seconds = the longest to wait, up to 30.',
      parameters: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
      execute: oneAtATime(async ({ text, seconds }) => {
        if (outOfSteps()) return LIMIT;
        const ms = Math.min(30, Math.max(2, Number(seconds) || 15)) * 1000;
        step(text ? `Waiting for "${short(text, 50)}"` : `Waiting up to ${ms / 1000}s for the page`);
        const started = Date.now();
        if (text && /loading|getting|fetching|searching|please wait|processing/i.test(text)) {
          // a loading text: wait for it to go away
          const gone = await page.getByText(text, { exact: false }).first().waitFor({ state: 'hidden', timeout: ms }).then(() => true, () => false);
          if (!gone) return `"${text}" is still shown after ${ms / 1000}s.`;
          await waitForQuiet(5000);
        } else if (text) {
          const shown = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
          if (!shown) return `"${text}" did not appear in ${ms / 1000}s.${await loadingNote()}`;
        } else {
          await sleep(2000);
          await waitForQuiet(ms - 2000);
        }
        return `Waited ${Math.round((Date.now() - started) / 1000)}s.${await loadingNote() || ' The page has finished loading.'} Call read_page to see it.`;
      }),
    }),
    tool({
      name: 'scroll',
      description: 'Scroll the page down or up by one screen.',
      parameters: z.object({ direction: z.enum(['down', 'up']) }),
      execute: oneAtATime(async ({ direction }) => {
        if (outOfSteps()) return LIMIT;
        step(`Scrolling ${direction}`);
        await page.mouse.wheel(0, direction === 'down' ? 700 : -700);
        await sleep(500);
        return 'Scrolled.';
      }),
    }),
    tool({
      name: 'check_text',
      description: 'Check exactly what the page shows: how many visible elements contain this text, and their full texts (first 8). Use it to confirm something.',
      parameters: z.object({ text: z.string() }),
      execute: oneAtATime(async ({ text }) => {
        if (outOfSteps()) return LIMIT;
        step(`Checking for "${short(text, 50)}"`);
        const found = await page.evaluate((needle) => {
          const lower = needle.toLowerCase();
          const out = [];
          // the smallest visible elements whose own text contains the needle
          for (const el of document.querySelectorAll('body *')) {
            if (!(el instanceof HTMLElement) || (!el.offsetParent && getComputedStyle(el).position !== 'fixed')) continue;
            const t = (el.innerText || '').trim();
            if (!t.toLowerCase().includes(lower)) continue;
            if ([...el.children].some((c) => (c.innerText || '').toLowerCase().includes(lower))) continue;
            out.push(t.replace(/\s+/g, ' ').slice(0, 160));
          }
          return out;
        }, text).catch(() => []);
        return found.length
          ? `Visible ${found.length} time(s): ${found.slice(0, 8).map((t) => JSON.stringify(t)).join(', ')}`
          : `"${text}" is not visible on the page.`;
      }),
    }),
    tool({
      name: 'read_tables',
      description: 'Read the data tables on the page exactly (header + rows, up to 5 tables and 80 rows each). Use it before saving tabular data.',
      parameters: z.object({}),
      execute: oneAtATime(async () => {
        if (outOfSteps()) return LIMIT;
        step('Reading the tables on the page');
        const tables = await page.evaluate(() => {
          const cellText = (c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          const visible = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
          const out = [];
          document.querySelectorAll('table, [role="table"], [role="grid"]').forEach((t) => {
            if (out.length >= 5 || !visible(t) || t.closest('table') !== t && t.tagName !== 'TABLE' && t.querySelector('table')) return;
            const rows = [...t.querySelectorAll(t.tagName === 'TABLE' ? 'tr' : '[role="row"]')]
              .map((r) => [...r.querySelectorAll(t.tagName === 'TABLE' ? 'th, td' : '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')].slice(0, 15).map(cellText))
              .filter((r) => r.some(Boolean));
            if (rows.length) out.push(rows.slice(0, 81));
          });
          return out;
        }).catch(() => []);
        if (!tables.length) return 'No data tables on this page; use read_page instead.';
        return tables.map((rows, i) => `Table ${i + 1} (${rows.length} rows):\n${rows.map((r) => r.join(' | ')).join('\n')}`).join('\n\n');
      }),
    }),
  ];

  const idleMs = () => (busy ? 0 : Date.now() - lastActivity);
  /** Lets open_page open this address too (e.g. a search result the agent found). */
  const allowUrl = (u) => known.add(String(u).split('#')[0]);
  return { tools, oneAtATime, steps: () => steps, outOfSteps, idleMs, allowUrl, LIMIT };
}


// ---------------------------------------------------------------- code-driven AI helpers
// The research agents that don't browse with the AI (news, web research, competitors, data
// collection, follow-ups): our code reads the pages, the model answers in JSON.

/** The model for the AI agents. */
const aiModel = () => process.env.WEB_AGENT_MODEL || process.env.QA_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';

let jsonClient = null;
function client() {
  if (!jsonClient) jsonClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 2 });
  return jsonClient;
}

/** An OpenAI error as an AgentError the user can act on. */
function aiFailure(err, AgentError) {
  const msg = String((err && err.message) || err);
  if (/no credits|insufficient_quota|quota|billing/i.test(msg)) return new AgentError('AI_UNAVAILABLE', 'The OpenAI account has no credits left. Add credits at platform.openai.com (Settings → Billing), then run the task again.');
  if (err && err.status === 401) return new AgentError('AI_UNAVAILABLE', 'The OpenAI API key is not valid. Check OPENAI_API_KEY in backend/.env.');
  return new AgentError('AI_ERROR', `The AI could not answer: ${short(msg, 200)}`);
}

/** The usage of one request in our shape. */
const oneRequest = (inputTokens, outputTokens) => ({ requests: 1, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 });

/** Adds b's usage into a ({ requests, inputTokens, outputTokens }). */
function addUsage(a, b) {
  ['requests', 'inputTokens', 'outputTokens'].forEach((k) => (a[k] = (a[k] || 0) + ((b && b[k]) || 0)));
  return a;
}

/** One JSON answer from the model. Returns { data, usage }. */
async function askJson(model, system, user, AgentError) {
  let completion;
  try {
    completion = await client().chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
  } catch (err) {
    throw aiFailure(err, AgentError);
  }
  let data = {};
  try {
    data = JSON.parse((completion.choices[0] && completion.choices[0].message.content) || '{}');
  } catch {
    // keep {}
  }
  const u = completion.usage || {};
  return { data, usage: oneRequest(u.prompt_tokens, u.completion_tokens) };
}

/**
 * Web pages about `request`, found with OpenAI's web search (search engines show automated
 * browsers poor results). Returns { sources: [{ title, url }], text, usage }.
 */
async function findSources(model, request, AgentError) {
  let r;
  try {
    r = await client().responses.create({ model, tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'], input: request });
  } catch (err) {
    throw aiFailure(err, AgentError);
  }
  const clean = (u) => String(u || '').replace(/[?&]utm_source=openai$/, '').replace(/\?$/, '');
  const sources = [];
  const add = (url, title) => {
    const u = clean(url);
    if (/^https?:\/\//i.test(u) && !sources.some((x) => x.url === u)) sources.push({ url: u, title: String(title || '').trim() });
  };
  const message = (r.output || []).find((o) => o.type === 'message');
  const parts = (message && message.content) || [];
  parts.forEach((c) => (c.annotations || []).forEach((x) => x.type === 'url_citation' && add(x.url, x.title)));
  (r.output || []).filter((o) => o.type === 'web_search_call').forEach((o) => ((o.action && o.action.sources) || []).forEach((x) => add(x.url, '')));
  const u = r.usage || {};
  return { sources, text: parts.map((c) => c.text || '').join('\n'), usage: oneRequest(u.input_tokens, u.output_tokens) };
}

/** The page's own text: paragraphs and list items in <article>, else <main>, else the page. */
async function readPageText(page) {
  return page
    .evaluate(() => {
      const parts = (sel) => [...document.querySelectorAll(sel)].map((p) => p.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 40);
      let ps = parts('article p, article li');
      if (ps.join(' ').length < 400) ps = parts('main p, main li, main h2, main h3');
      if (ps.join(' ').length < 400) ps = parts('p, li, h1, h2, h3');
      return [...new Set(ps)].join('\n');
    })
    .catch(() => '');
}

/** Opens `url` and returns its text ('' when it doesn't load in time). */
async function readUrl(page, url, maxChars = 4000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(1500);
      return (await readPageText(page)).slice(0, maxChars);
    } catch (err) {
      // After a failed page Chrome loads its own error page, which cuts off the next
      // navigation ("interrupted by another navigation"): give it a moment and try once more.
      await sleep(2000);
      if (!/interrupted|ERR_ABORTED/i.test(String(err && err.message))) return '';
    }
  }
  return '';
}

module.exports = {
  useOpenAI,
  runAgent,
  createBrowserTools,
  keepLatestPageOnly,
  sameSite,
  settle,
  short,
  sleep,
  usageOf,
  openUrl,
  aiModel,
  askJson,
  addUsage,
  findSources,
  readPageText,
  readUrl,
};
