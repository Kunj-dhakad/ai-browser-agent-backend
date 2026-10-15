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

// An open popup: Bootstrap / ARIA modals, <dialog>, and the like.
const DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .modal.show, .modal.in, .swal2-popup';

/**
 * The page outline for the model, shorter: images without a name and empty links are left
 * out (on card lists they are most of the text), and repeated blank lines go.
 */
function tidySnapshot(snapshot) {
  return String(snapshot)
    .split('\n')
    .filter((l) => !/^\s*- img\s*$/.test(l) && !/^\s*- \/url: "?javascript:void\(0\);?"?\s*$/.test(l))
    .join('\n');
}

/**
 * Marks the clickable things on screen with numbers (1, 2, 3…) drawn on the page, for a
 * screenshot: [{ n, x, y, label }] (x, y = the middle, in page pixels of the viewport).
 */
async function markClickables(page) {
  // the page itself, then its frames (editors and widgets often live in an iframe), numbered on
  const list = [];
  for (const frame of page.frames().slice(0, 8)) {
    let offset = { x: 0, y: 0 };
    if (frame !== page.mainFrame()) {
      const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
      if (!box || box.width < 50 || box.height < 50) continue;
      offset = { x: box.x, y: box.y };
    }
    const found = await markFrame(frame, list.length, 80 - list.length);
    found.forEach((m) => list.push({ ...m, x: Math.round(m.x + offset.x), y: Math.round(m.y + offset.y) }));
    if (list.length >= 80) break;
  }
  return list;
}

/** Marks the clickable things of one frame, numbered from start + 1 (x, y within the frame). */
async function markFrame(frame, start, limit) {
  return frame
    .evaluate(({ start, limit }) => {
      document.querySelectorAll('[data-ba-mark]').forEach((e) => e.remove());
      const sel = 'a, button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [onclick], [data-bs-toggle], [data-toggle], [tabindex]:not([tabindex="-1"])';
      const picked = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
        const x = Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2));
        const y = Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2));
        const top = document.elementFromPoint(x, y);
        if (!top || !(el === top || el.contains(top) || top.contains(el))) continue; // covered (e.g. by a popup)
        if (picked.some((p) => p.el.contains(el))) continue; // one mark per clickable thing
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || (el.querySelector('img') && el.querySelector('img').alt) || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        picked.push({ el, x: Math.round(x), y: Math.round(y), label, tag: (el.getAttribute('role') || el.tagName).toLowerCase() });
        if (picked.length >= limit) break;
      }
      picked.forEach((m, i) => {
        const d = document.createElement('div');
        d.setAttribute('data-ba-mark', '');
        d.textContent = String(start + i + 1);
        d.style.cssText = `position:fixed;left:${Math.max(0, m.x - 9)}px;top:${Math.max(0, m.y - 9)}px;z-index:2147483647;background:#e11d48;color:#fff;font:bold 11px/14px Arial,sans-serif;padding:1px 4px;border-radius:4px;border:1px solid #fff;pointer-events:none`;
        document.body.appendChild(d);
      });
      return picked.map((m, i) => ({ n: start + i + 1, x: m.x, y: m.y, label: m.label, tag: m.tag }));
    }, { start, limit })
    .catch(() => []);
}

/** The frames shown inside the page (iframes big enough to matter), without the page itself. */
async function shownFrames(page) {
  const out = [];
  for (const frame of page.frames().slice(1, 8)) {
    const box = await frame.frameElement().then((el) => el.boundingBox()).catch(() => null);
    if (box && box.width >= 50 && box.height >= 50) out.push(frame);
  }
  return out;
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
  await sleep(300);
}

// The items of an autocomplete list on common sites (ARIA, Google Places, jQuery UI, others);
// data-ba-sugg marks the items found under the field by suggestionsNear().
const SUGGESTIONS = '[data-ba-sugg], [role="option"], [role="listbox"] li, .pac-item, .ui-menu-item, .autocomplete-suggestion, [class*="suggestion"] li, [class*="autocomplete"] li, [class*="dropdown"] li';

/**
 * Texts shown just under a field (where a suggestion list opens). With `typed` and `before`
 * (the texts there before typing), the new ones that contain what was typed are marked
 * data-ba-sugg and returned: suggestion lists built without ARIA roles or list items.
 */
async function suggestionsNear(field, typed = null, before = []) {
  return field
    .evaluate(
      (input, { typed, before }) => {
        const fr = input.getBoundingClientRect();
        const word = typed ? typed.trim().toLowerCase().split(/\s+/)[0] : '';
        document.querySelectorAll('[data-ba-sugg]').forEach((e) => e.removeAttribute('data-ba-sugg'));
        const out = [];
        for (const el of document.body.querySelectorAll('li, div, a, button, span, p, td')) {
          if (el === input || el.contains(input)) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.height > 90 || r.top < fr.bottom - 4 || r.top > fr.bottom + 420 || r.right < fr.left - 40 || r.left > fr.right + 40) continue;
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 120) continue;
          if (!typed) {
            out.push({ t });
            continue;
          }
          if (!t.toLowerCase().includes(word) || before.includes(t)) continue;
          // the innermost element with this text, once
          if ([...el.children].some((c) => (c.innerText || '').replace(/\s+/g, ' ').trim() === t)) continue;
          out.push({ el, t });
          if (out.length >= 60) break;
        }
        if (!typed) return out.map((o) => o.t).slice(0, 300);
        // the items, not the box around them: keep only elements that hold no other match
        const items = out.filter((o) => !out.some((x) => x !== o && o.el.contains(x.el))).slice(0, 8);
        items.forEach((o) => o.el.setAttribute('data-ba-sugg', '1'));
        return items.map((o) => o.t.slice(0, 100));
      },
      { typed, before },
      { timeout: 3000 },
    )
    .catch(() => []);
}

/** Waits (up to `ms`) for the suggestion list of a field to open; its items, or []. */
async function waitForSuggestions(page, field, typed, before, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    let found = await readSuggestions(page);
    if (!found.length) found = await suggestionsNear(field, typed, before);
    if (found.length || Date.now() > end) return found;
    await sleep(400);
  }
}

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
  let requestsSent = 0; // all requests so far: did an action start anything?
  const track = (r) => {
    requestsSent++;
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
        // "Loading…", "Searching…", and the progress lines of AI generators ("Understanding your idea…").
        // Words like "Building…" also start cut-off titles ("Building a smart school busine…"),
        // so they count only when the page shows two or more such lines (a progress list).
        const sure = /^\s*(loading|getting|fetching|searching|processing|generating|understanding|analy[sz]ing|uploading|rendering)\b.{0,40}?(\.\.\.?|…)\s*$|\bplease wait\b/i;
        const maybe = /^\s*(creating|planning|building|crafting|writing|preparing|thinking)\b.{0,45}?(\.\.\.?|…)\s*$/i;
        const lines = (document.body.innerText || '').split('\n');
        const hit = lines.find((l) => sure.test(l));
        if (hit) return hit.trim();
        const some = lines.filter((l) => maybe.test(l));
        return some.length >= 2 ? some[0].trim() : '';
      })
      .catch(() => '');
    return seen ? ` The page still shows "${short(seen, 60)}": it may still be loading results; use wait, then read_page again before you decide.` : '';
  };

  const pageTextSize = () => page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);

  /** After an action: wait for the site to finish loading; back to the site if a click left it (unless other sites are allowed). */
  const after = async () => {
    await settle(page);
    known.add(page.url().split('#')[0]); // the page it is on can always be opened again (a reload)
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
    // the page first, then the frames inside it (editors and widgets often live in an iframe)
    for (const scope of [page, ...(await shownFrames(page))]) {
      const find = (exact) => (role === 'text' ? scope.getByText(name, { exact }) : scope.getByRole(role, { name, exact }));
      // The exact name first: a partial match for "Cart" also finds every "Add to cart" button.
      for (const exact of [true, false]) {
        const all = find(exact);
        const visible = all.filter({ visible: true });
        if ((await visible.count()) > (index || 0)) return visible.nth(index || 0);
        if (scope === page && (await all.count()) > (index || 0)) return all.nth(index || 0);
      }
    }
    return null;
  };
  // The numbered marks of the last look (click_mark uses them).
  let marks = null;
  // The page open_page was last warned about (it was still working when the model wanted to leave).
  let leaveWarned = '';
  // After the password was typed and the form sent: the login form still there = it failed.
  let passwordTyped = false;
  const loginStillShown = async () => {
    if (!passwordTyped) return '';
    const still = await page.locator('input[type="password"]').filter({ visible: true }).count().catch(() => 0);
    return still
      ? ' NOTE: the login form is still shown, so the login probably failed. Read the page for an error (e.g. "invalid email or password"). Try logging in at most once more; if it fails again, stop and tell the user the login details did not work.'
      : '';
  };
  const NOTHING_CHANGED =
    ' NOTE: the click changed nothing (no new page, no request, same text). Do not click it again the same way: reload the page with open_page on the current address and try once more, or use look and click_mark, or another way (a menu, a link).';
  const NOT_FOUND = (role, name) =>
    `Not found: there is no ${role} "${short(name, 60)}" on the page now (names change, e.g. "Cart, 1 item"). Call read_page and use a name exactly as it lists it.`;
  const fail = (err) => `Failed: ${short(String(err && err.message ? err.message : err).split('\n')[0], 200)}`;

  // The same action failing again and again (or repeated with no effect) eats every step:
  // after 2 failures or 3 repeats in a row on an unchanged page the model is told to stop and
  // try another way. ("Next" clicked page after page is not a repeat: the page changes.)
  const failures = new Map();
  let lastAction = '';
  let repeats = 0;
  const guard = async (action) => {
    const shown = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    const key = `${action}|${page.url()}|${shown}`;
    repeats = key === lastAction ? repeats + 1 : 1;
    lastAction = key;
    if ((failures.get(`${action}|${page.url()}`) || 0) >= 2) return 'Stop: this already failed twice. Do not try it again; use another way (another element, open its /url with open_page) or finish and say what blocked you.';
    if (repeats > 3) return 'Stop: you did exactly this 3 times in a row and it is not getting you anywhere. Call read_page, then try another way or finish and say what blocked you.';
    return null;
  };
  const failed = (action, message) => {
    const key = `${action}|${page.url()}`;
    failures.set(key, (failures.get(key) || 0) + 1);
    return message;
  };

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
      description: 'Read the current page: its address, title and an outline of its content and controls (role "name" per line). An open popup (dialog) is shown first. A long page comes in parts: part = 2, 3… reads further.',
      parameters: z.object({ part: z.number().int().nullable() }),
      execute: oneAtATime(async ({ part }) => {
        if (outOfSteps()) return LIMIT;
        const n = Math.max(1, Number(part) || 1);
        step(n > 1 ? `Reading the page (part ${n})` : 'Reading the page');
        let snapshot = tidySnapshot(await page.locator('body').ariaSnapshot({ timeout: 15000 }).catch((e) => `(could not read the page: ${e.message})`));
        remember(snapshot);
        // an open popup sits at the end of the page, where a long page gets cut: show it first
        let popup = '';
        const dialog = page.locator(DIALOGS).filter({ visible: true }).last();
        if (n === 1 && (await dialog.count().catch(() => 0))) {
          popup = tidySnapshot(await dialog.ariaSnapshot({ timeout: 8000 }).catch(() => ''));
          remember(popup);
        }
        // what the iframes show (an editor, a form, a widget): their outline goes after the page's
        let framed = '';
        for (const frame of await shownFrames(page)) {
          const inner = tidySnapshot(await frame.locator('body').ariaSnapshot({ timeout: 8000 }).catch(() => ''));
          if (inner.trim()) {
            remember(inner);
            framed += `\n\nINSIDE AN IFRAME (${short(frame.url(), 80)}); click and type_text work here too:\n${inner}`;
          }
        }
        if (framed) snapshot = snapshot + framed;
        const parts = Math.max(1, Math.ceil(snapshot.length / SNAPSHOT_CHARS));
        const body = snapshot.slice((n - 1) * SNAPSHOT_CHARS, n * SNAPSHOT_CHARS);
        const note = await loadingNote();
        return `URL: ${page.url()}\nTitle: ${await page.title()}${note ? `\nNote:${note}` : ''}` +
          (popup ? `\n\nA POPUP IS OPEN over the page. Act on it first (or close it):\n${short(popup, 8000)}\n\nThe page behind it:` : '') +
          `\n\n${body || '(no more content)'}` +
          (parts > n ? `\n\n(Part ${n} of ${parts}: the page goes on. Call read_page with part=${n + 1} to read further, or use look to see the screen.)` : '');
      }),
    }),
    tool({
      name: 'look',
      description: 'See the screen: a screenshot of what the page shows now, with a red number on every clickable thing, plus the list of those numbers. Use it when read_page is not enough: icons or cards without names, popups, editors, layouts, or to check what really happened after an action. Then click one with click_mark.',
      parameters: z.object({}),
      execute: oneAtATime(async () => {
        if (outOfSteps()) return LIMIT;
        step('Looking at the screen');
        const list = await markClickables(page);
        let data = null;
        try {
          const size = page.viewportSize() || { width: 1366, height: 768 };
          const cdp = await page.context().newCDPSession(page);
          ({ data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 0.8 } }));
          await cdp.detach().catch(() => {});
        } catch {
          data = null;
        }
        for (const frame of page.frames()) await frame.evaluate(() => document.querySelectorAll('[data-ba-mark]').forEach((e) => e.remove())).catch(() => {});
        marks = { url: page.url(), list };
        const text = `URL: ${page.url()}\nClickable things on screen (number: kind "label"):\n${list.map((m) => `${m.n}: ${m.tag} "${m.label}"`).join('\n') || '(none found)'}\nClick one with click_mark (number). Scroll and look again for more.`;
        return data ? [{ type: 'text', text }, { type: 'image', image: `data:image/jpeg;base64,${data}`, detail: 'auto' }] : text;
      }),
    }),
    tool({
      name: 'click_mark',
      description: 'Click the thing with this red number from your last look (only right after look, on the same page).',
      parameters: z.object({ number: z.number().int() }),
      execute: oneAtATime(async ({ number }) => {
        if (outOfSteps()) return LIMIT;
        const m = marks && marks.list.find((x) => x.n === number);
        if (!m) return 'No such number: call look first, then use a number from it.';
        if (marks.url !== page.url()) return 'The page changed since your last look: call look again.';
        step(`Clicking ${m.tag} "${short(m.label || '#' + number, 60)}"`);
        try {
          await page.mouse.click(m.x, m.y);
          marks = null;
          return `Clicked. ${await after()}${await loginStillShown()}`;
        } catch (err) {
          return fail(err);
        }
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
        // Leaving a page that is still working (an AI generation, an upload) cancels it: the first
        // time, say so; a second open_page right after goes ahead.
        const busy = leaveWarned === page.url() ? '' : await loadingNote();
        if (busy) {
          leaveWarned = page.url();
          return `Not opened yet: this page is still working.${busy} Leaving now may cancel it (e.g. a generation). Wait for it first (wait, up to 180 s). If you are sure, call open_page again.`;
        }
        leaveWarned = '';
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
        const key = `click|${role}|${name}|${index || 0}`;
        const stop = await guard(key);
        if (stop) return stop;
        // Several elements with this exact name (e.g. an "Add to cart" under every product):
        // clicking the first one may act on the wrong item, so the model must say which one.
        if (index == null && role !== 'text') {
          const same = page.getByRole(role, { name, exact: true }).filter({ visible: true });
          const count = await same.count().catch(() => 0);
          if (count > 1) {
            const hrefs = role === 'link' ? await same.evaluateAll((els) => els.map((e) => e.getAttribute('href'))).catch(() => []) : [];
            if (!hrefs.length || new Set(hrefs).size > 1) {
              return `There are ${count} ${role}s named "${short(name, 60)}" on the page. Call click again with index = which one you mean, counting from 0 in the order read_page lists them (e.g. the one in the item you want).`;
            }
          }
        }
        step(`Clicking ${role} "${short(name, 60)}"`);
        try {
          const target = await element(role, name, index);
          if (!target) return failed(key, NOT_FOUND(role, name));
          const was = { url: page.url(), sent: requestsSent, text: await pageTextSize() };
          await target.click({ timeout: 8000 });
          const now = await after();
          // a click that changed nothing: say so, or the model clicks it again and again
          const nothing = page.url() === was.url && requestsSent === was.sent && (await pageTextSize()) === was.text;
          return `Clicked. ${now}${nothing ? NOTHING_CHANGED : ''}${await loginStillShown()}`;
        } catch (err) {
          return failed(key, fail(err));
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
        const key = `type|${role}|${name}|${index || 0}|${text}`;
        const stop = await guard(key);
        if (stop) return stop;
        try {
          const field = await element(role, name, index);
          if (!field) {
            step(`Typing into ${role} "${short(name, 50)}"`);
            return failed(key, NOT_FOUND(role, name));
          }
          // A field in a tab, section or step that is not open: typing there does not count
          if (!(await field.isVisible().catch(() => true))) {
            step(`Typing into ${role} "${short(name, 50)}"`);
            return failed(key, `That ${role} is hidden right now: it sits in a tab, section or step that is not open. Select its tab (or open its section) first, then type into it. Use look to see the form.`);
          }
          // A password nobody gave (e.g. a demo one printed on the page) is never typed: the user
          // decides which account the agent uses, through the login details.
          // A password field only ever gets {{PASSWORD}}: never another value (a guess, or the
          // demo one a login page shows after the user's details failed).
          if ((await field.getAttribute('type', { timeout: 2000 }).catch(() => '')) === 'password') {
            if (!secrets.PASSWORD) {
              step('Stopped at the password field: no login details were given');
              return 'Not allowed: no login details were given for this task, so do not type any password (not even one shown on the page). Stop and tell the user to add login details and send the task again.';
            }
            if (!/^\s*\{\{\s*PASSWORD\s*\}\}\s*$/.test(text)) {
              step('Stopped: only the given password may go into the password field');
              return 'Not allowed: the password field only takes {{PASSWORD}} (the user\'s own login). Never type any other password, not even one shown on the page. If the login failed, stop and tell the user their login details did not work.';
            }
          }
          // On a login form (a password field is on screen) with login details given, the
          // username / email field also only gets {{USERNAME}}, never a name shown on the page.
          if (secrets.USERNAME && !secret && (await page.locator('input[type="password"]').filter({ visible: true }).count().catch(() => 0))) {
            const what = await field.evaluate((el) => [el.type, el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ')).catch(() => '');
            if (/user|email|e-mail|login|account|phone|mobile/i.test(`${what} ${name}`)) {
              step('Stopped: only the given username may go into the login form');
              return 'Not allowed: on this login form the username / email field only takes {{USERNAME}} (the user\'s own login). Type {{USERNAME}} exactly like that.';
            }
          }
          // the log shows the placeholder, never the real value
          step(`Typing ${secret ? text : `"${short(text, 40)}"`} into ${role} "${short(name, 50)}"${submit ? ' and pressing Enter' : ''}`);
          const value = withSecrets(text);
          const keyByKey = !secret && (/combobox|searchbox/i.test(role) || (await looksLikeAutocomplete(field)));
          const before = keyByKey ? await suggestionsNear(field) : [];
          if (keyByKey) {
            await typeKeyByKey(field, value);
          } else {
            await field.fill(value, { timeout: 8000 });
            // some fields ignore fill(): type it like a person instead
            if ((await field.inputValue({ timeout: 2000 }).catch(() => value)) !== value) await typeKeyByKey(field, value);
          }
          const filled = (await field.inputValue({ timeout: 2000 }).catch(() => null)) === value;
          if (secret) log.info(`${filled ? 'Filled' : 'Could not fill'} the ${/PASSWORD/.test(text) ? 'password' : 'username'} field`);
          if (/PASSWORD/.test(text)) passwordTyped = true;
          // suggestion lists often take a few seconds (they ask the site's server)
          const suggestions = keyByKey ? await waitForSuggestions(page, field, value, before, submit ? 4000 : 6000) : [];
          if (suggestions.length) {
            log.info(`${suggestions.length} suggestion(s) appeared`);
            // Enter on an open list usually leaves the value unaccepted: pick one first
            return `Typed${submit ? ' (Enter was NOT pressed)' : ''}. Suggestions opened: ${suggestions.map((t) => JSON.stringify(t)).join(', ')}. Pick the right one with pick_suggestion so the site accepts the value${submit ? ', then search' : ''}.`;
          }
          if (submit) {
            const was = { url: page.url(), sent: requestsSent, text: await pageTextSize() };
            await field.press('Enter');
            const now = await after();
            // Enter often does nothing outside a <form>: say so, or the model reads the old page as the result
            const nothing = page.url() === was.url && requestsSent === was.sent && (await pageTextSize()) === was.text;
            return `Typed. ${now}${nothing ? ' Pressing Enter did NOTHING here (no search or page change started): click the Search / Submit button of the form instead. What the page shows now is NOT a result.' : ''}${await loginStillShown()}`;
          }
          return `Typed${filled ? '' : ' (but the field does not show the text: try another field or way)'}. ${await after()}`;
        } catch (err) {
          return failed(key, fail(err));
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
      description: 'Wait for the page to finish loading or for slow work to finish (search results that show "Loading…" or "0 results" at first; AI generation like "Generating…" / "Creating your book…" which can take minutes). text (optional) = a text that will show once it is done, or a loading text to wait to go away; seconds = the longest to wait, up to 180.',
      parameters: z.object({ text: z.string().nullable(), seconds: z.number().nullable() }),
      execute: oneAtATime(async ({ text, seconds }) => {
        if (outOfSteps()) return LIMIT;
        const ms = Math.min(180, Math.max(2, Number(seconds) || 15)) * 1000;
        step(text ? `Waiting for "${short(text, 50)}"` : `Waiting up to ${ms / 1000}s for the page`);
        const started = Date.now();
        if (text && /loading|getting|fetching|searching|please wait|processing|generating|creating|writing|understanding|preparing|building|planning|crafting/i.test(text)) {
          // a loading text: wait for it to go away, and for any other progress text too
          const gone = await page.getByText(text, { exact: false }).first().waitFor({ state: 'hidden', timeout: ms }).then(() => true, () => false);
          if (!gone) return `"${text}" is still shown after ${ms / 1000}s: it is still working. Wait again.`;
          while (Date.now() - started < ms && (await loadingNote())) await sleep(2000);
          await waitForQuiet(5000);
        } else if (text) {
          const shown = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
          if (!shown) return `"${text}" did not appear in ${ms / 1000}s.${await loadingNote()}`;
          // the text can be part of a progress list ("Your book is ready!" as the last step): wait for the progress to end too
          while (Date.now() - started < ms && (await loadingNote())) await sleep(2000);
        } else {
          await sleep(2000);
          await waitForQuiet(ms - 2000);
          while (Date.now() - started < ms && (await loadingNote())) await sleep(2000);
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
