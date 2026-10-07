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
const { tool, setDefaultOpenAIClient, setTracingDisabled } = require('@openai/agents');

const SNAPSHOT_CHARS = 24000; // ~6k tokens: what the model reads per page

let clientReady = false;
/** Sets up the Agents SDK with our OpenAI key. false when there is no key. */
function useOpenAI() {
  if (!process.env.OPENAI_API_KEY) return false;
  if (!clientReady) {
    setDefaultOpenAIClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined }));
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

/**
 * The browser tools for an agent working on `page`.
 * opts: { startUrl, allowOtherSites, maxSteps, log, normalizeSiteUrl, secrets: { USERNAME, PASSWORD } | null }
 * Returns { tools, oneAtATime, steps(), outOfSteps(), LIMIT }.
 */
function createBrowserTools(page, opts) {
  const { startUrl, allowOtherSites = false, maxSteps, log, normalizeSiteUrl } = opts;
  const secrets = opts.secrets || {};
  const baseHost = new URL(startUrl).hostname;
  let steps = 0;
  const step = (label) => {
    steps++;
    log.action(label);
  };
  const LIMIT = 'STEP LIMIT REACHED: do not call more browser tools. Save or record what you have, then write your final answer now.';
  const outOfSteps = () => steps >= maxSteps;
  const allowed = (url) => Boolean(normalizeSiteUrl(url)) && (allowOtherSites || sameSite(url, baseHost));

  /** After an action: back to the site if a click left it (unless other sites are allowed). */
  const after = async () => {
    await settle(page);
    if (!allowOtherSites && !sameSite(page.url(), baseHost)) {
      const left = page.url();
      await page.goBack({ timeout: 10000 }).catch(() => page.goto(startUrl).catch(() => {}));
      await settle(page);
      return `That opened another website (${short(left, 120)}), so the browser went back. Now on ${page.url()}.`;
    }
    return `Now on ${page.url()} — "${short(await page.title(), 120)}".`;
  };
  /** An element by its accessible role and name, as read_page lists them. */
  const element = (role, name, index) => {
    const loc = role === 'text' ? page.getByText(name, { exact: false }) : page.getByRole(role, { name, exact: false });
    return loc.nth(index || 0);
  };
  const fail = (err) => `Failed: ${short(String(err && err.message ? err.message : err).split('\n')[0], 200)}`;

  // One browser, one action at a time: if the model asks for two actions at once (e.g. typing
  // two todos), they run one after the other instead of typing into the same box together.
  let queue = Promise.resolve();
  const oneAtATime = (fn) => (args) => {
    const next = queue.then(() => fn(args));
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
        return `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${short(snapshot, SNAPSHOT_CHARS)}`;
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
          await element(role, name, index).click({ timeout: 8000 });
          return `Clicked. ${await after()}`;
        } catch (err) {
          return fail(err);
        }
      }),
    }),
    tool({
      name: 'type_text',
      description: 'Type into a field found by role (textbox, searchbox, combobox, spinbutton) and name. For login details write {{USERNAME}} or {{PASSWORD}} exactly; the real values are filled in for you. submit=true presses Enter afterwards.',
      parameters: z.object({ role: z.string(), name: z.string(), text: z.string(), submit: z.boolean(), index: z.number().int().nullable() }),
      execute: oneAtATime(async ({ role, name, text, submit, index }) => {
        if (outOfSteps()) return LIMIT;
        // the log shows the placeholder, never the real value
        step(`Typing ${usesSecret(text) ? text : `"${short(text, 40)}"`} into ${role} "${short(name, 50)}"${submit ? ' and pressing Enter' : ''}`);
        try {
          const field = element(role, name, index);
          await field.fill(withSecrets(text), { timeout: 8000 });
          if (submit) await field.press('Enter');
          return `Typed. ${await after()}`;
        } catch (err) {
          return fail(err);
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

  return { tools, oneAtATime, steps: () => steps, outOfSteps, LIMIT };
}

module.exports = { useOpenAI, createBrowserTools, keepLatestPageOnly, sameSite, settle, short, sleep, usageOf, openUrl };
