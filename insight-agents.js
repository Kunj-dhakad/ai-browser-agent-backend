/**
 * insight-agents.js
 * ---------------------------------------------------------------------------
 * Four AI agents:
 *
 *   web_research         a question -> web sources (OpenAI web search; search engines show
 *                        automated browsers poor results) -> our browser reads each source
 *                        -> the AI answers from that text only, citing [1], [2]...
 *   competitor_research  competitor websites (given, or found with web search) -> our browser
 *                        reads their home, pricing, about and product pages -> the AI compares
 *   data_collection      any list page -> the AI turns each page into rows (fields the user
 *                        names, or its own) and follows "Next" up to N pages
 *   crm_task             the custom web agent working in the user's CRM: add, update or find
 *                        records (login details hidden from the AI, as in web-agent.js)
 *
 * The first three are code-driven: our code opens and reads the pages, the model only
 * answers in JSON. That keeps them quick, cheap and tied to what the pages really say.
 * ---------------------------------------------------------------------------
 */

const { runWebAgent, WORKING_RULES } = require('./web-agent');
const { useOpenAI, openUrl, sleep, short, askJson, addUsage, findSources, readUrl, aiModel } = require('./ai-browser');

const COLUMNS = {
  web_research: ['#', 'Title', 'Website', 'Key points', 'Link'],
  competitor_research: ['Competitor', 'Website', 'What they offer', 'Pricing', 'Target customers', 'Strengths', 'Weaknesses'],
};

const SOURCE_CHARS = 5000; // of each web source, for the AI (~1.2k tokens)
const SITE_PAGE_CHARS = 2500; // of each competitor page
const LIST_CHARS = 40000; // of a list page's outline, for data collection (~10k tokens)
const MAX_ROWS = 500;

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

function needAi(AgentError, what) {
  if (!useOpenAI()) throw new AgentError('AI_REQUIRED', `The ${what} needs an OpenAI API key (OPENAI_API_KEY in backend/.env).`);
}

/** The result shape the page shows (same as the custom web agent's). */
function result(task, url, answer, columns, rows, steps, page, usage, model) {
  return { kind: task.type, url, answer, data: { columns, rows }, steps, stoppedEarly: false, finalUrl: page.url(), usedLogin: false, usage: { model, ...usage } };
}

// ---------------------------------------------------------------- web research

async function webResearch(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  needAi(AgentError, 'web research agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  log.action(`Searching the web: "${short(task.question, 80)}"`);
  const found = await findSources(
    model,
    `Find the ${task.count + 3} most useful, trustworthy web pages to answer this question: "${task.question}".${task.focus ? ` Focus: ${task.focus}.` : ''} Prefer official, expert and recent sources; avoid forums and videos unless nothing else covers it. List each page with its title and URL.`,
    AgentError,
  );
  addUsage(usage, found.usage);
  // a few spare sources stand in for pages that can't be read
  const sources = found.sources.filter((s) => normalizeSiteUrl(s.url)).slice(0, task.count + 4);
  log.info(`Found ${sources.length} source(s)`);
  if (!sources.length) {
    return result(task, '', 'No web pages were found for this question. Try asking it another way.', COLUMNS.web_research, [], 0, page, usage, model);
  }

  await blockPrivateHosts(page, { skipMedia: true });
  let steps = 0;
  for (const s of sources) {
    if (sources.filter((x) => x.text).length >= task.count) break;
    steps++;
    log.action(`Reading ${domainOf(s.url)}`);
    s.text = await readUrl(page, s.url, SOURCE_CHARS);
    if (!s.title) s.title = short(await page.title().catch(() => ''), 150);
    if (s.text.length < 300) {
      s.text = '';
      log.warn(`Could not read ${domainOf(s.url)} (blocked or empty); trying another source`);
    }
  }
  const read = sources.filter((s) => s.text);
  if (!read.length) {
    return result(task, sources[0].url, 'None of the sources could be read (they blocked the browser or were empty). Try again or ask in other words.', COLUMNS.web_research, sources.map((s, i) => [String(i + 1), s.title, domainOf(s.url), '', s.url]), steps, page, usage, model);
  }

  log.action(`Writing the answer from ${read.length} source(s)`);
  const written = await askJson(
    model,
    'You are a careful researcher. Answer the question using ONLY the numbered sources given (never your own knowledge). ' +
      (task.detail === 'detailed' ? 'Write a thorough answer: a short direct answer first, then the details in short sections or bullet points. ' : 'Write a short, direct answer (one paragraph or a few bullet points). ') +
      'After each fact put the number of its source in brackets, e.g. [2]. Say where sources disagree or when they do not answer part of the question. ' +
      'Also give each source\'s 1-2 most useful points. Reply with JSON: {"answer": "...", "sources": [{"n": source number, "points": "..."}]}.',
    `Question: ${task.question}${task.focus ? `\nFocus: ${task.focus}` : ''}\n\n${read.map((s, i) => `### Source ${i + 1}: ${s.title} (${domainOf(s.url)})\n${s.text}`).join('\n\n')}`,
    AgentError,
  );
  addUsage(usage, written.usage);
  const points = new Map((Array.isArray(written.data.sources) ? written.data.sources : []).map((x) => [Number(x.n), String(x.points || '').trim()]));
  const rows = read.map((s, i) => [String(i + 1), s.title, domainOf(s.url), points.get(i + 1) || '', s.url]);
  log.success(`Answer written from ${read.length} source(s)`);
  return result(task, read[0].url, String(written.data.answer || '').trim() || 'The AI did not write an answer; the sources are below.', COLUMNS.web_research, rows, steps, page, usage, model);
}

// ---------------------------------------------------------------- competitor research

/** "{...}" out of a reply that may have text around it. */
function jsonIn(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : {};
  } catch {
    return {};
  }
}

/** A competitor's home page, plus its pricing / about / product pages when it links to them. */
async function readSite(page, url, log) {
  const home = await readUrl(page, url, SITE_PAGE_CHARS);
  const title = short(await page.title().catch(() => ''), 120);
  const host = domainOf(page.url() || url);
  const links = await page
    .evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().toLowerCase() })))
    .catch(() => []);
  const pick = (re) => links.find((l) => domainOf(l.href) === host && (re.test(l.text) || re.test(new URL(l.href).pathname)));
  const extra = [pick(/pricing|plans|price/), pick(/about|company|who we are/), pick(/features|product|services|solutions/)]
    .filter((l, i, a) => l && a.findIndex((x) => x && x.href === l.href) === i && l.href.split('#')[0] !== url.split('#')[0])
    .slice(0, 2);
  const pages = [`Home page:\n${home}`];
  for (const l of extra) {
    log.action(`Reading ${host}${new URL(l.href).pathname}`);
    const text = await readUrl(page, l.href, SITE_PAGE_CHARS);
    if (text) pages.push(`${new URL(l.href).pathname} page:\n${text}`);
  }
  return { title, text: home ? pages.join('\n\n') : '' };
}

async function competitorResearch(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  needAi(AgentError, 'competitor research agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const own = task.website ? domainOf(task.website) : '';

  let list = task.competitors.map((url) => ({ url, name: '' }));
  if (!list.length) {
    log.action('Finding competitors on the web');
    const found = await findSources(
      model,
      `Find the ${task.count} main competitors of this business${task.location ? ` (market: ${task.location})` : ''}: ${task.business}${task.website ? `. Its website: ${task.website}` : ''}. ` +
        'Give each competitor company\'s own official website (its home page), not review sites, directories, marketplaces or articles. ' +
        'Reply only with JSON: {"competitors": [{"name": "...", "website": "https://..."}]}',
      AgentError,
    );
    addUsage(usage, found.usage);
    const named = (jsonIn(found.text).competitors || []).map((c) => ({ url: normalizeSiteUrl(String(c.website || '')), name: String(c.name || '').trim() }));
    list = named.filter((c) => c.url && domainOf(c.url) !== own);
    if (!list.length) throw new AgentError('NOT_FOUND', 'No competitor websites were found. Add their website addresses yourself and run it again.');
    log.info(`Competitors: ${list.map((c) => c.name || domainOf(c.url)).join(', ')}`);
  }
  list = list.filter((c, i, a) => a.findIndex((x) => domainOf(x.url) === domainOf(c.url)) === i).slice(0, task.count);

  await blockPrivateHosts(page, { skipMedia: true });
  let steps = 0;
  let ownSite = null;
  if (task.website) {
    steps++;
    log.action(`Reading your website ${own}`);
    ownSite = await readSite(page, task.website, log);
  }
  for (const c of list) {
    steps++;
    log.action(`Reading ${c.name || domainOf(c.url)} (${domainOf(c.url)})`);
    const site = await readSite(page, c.url, log);
    c.text = site.text;
    if (!c.name) c.name = site.title.split(/[|\-–—:]/)[0].trim() || domainOf(c.url);
    if (!c.text) log.warn(`Could not read ${domainOf(c.url)}; it is listed without details`);
  }

  log.action(`Comparing ${list.length} competitor(s)`);
  const written = await askJson(
    model,
    'You are a market analyst. Using ONLY the website text given (never your own knowledge), describe each competitor and compare them with the user\'s business. ' +
      'For each competitor give: offer (what they sell, 1 sentence), pricing (plans and prices exactly as shown, or "Not shown"), audience (who it is for), strengths (2-3 short points), weaknesses (1-3 short points or gaps you can see; "Not clear" if none). ' +
      'Then a summary: 4-6 bullet points starting with "- ": how the competitors position themselves, price range, what they all do, and gaps or opportunities for the user\'s business' +
      (task.focus ? ', answering the user\'s focus' : '') +
      '. Reply with JSON: {"competitors": [{"n": number, "offer": "", "pricing": "", "audience": "", "strengths": "", "weaknesses": ""}], "summary": "..."}.',
    `The user's business: ${task.business}${task.location ? ` (market: ${task.location})` : ''}${task.focus ? `\nWhat the user wants to know: ${task.focus}` : ''}` +
      (ownSite && ownSite.text ? `\n\n### The user's own website (${own})\n${ownSite.text}` : '') +
      `\n\n${list.map((c, i) => `### Competitor ${i + 1}: ${c.name} (${domainOf(c.url)})\n${c.text || '(the website could not be read)'}`).join('\n\n')}`,
    AgentError,
  );
  addUsage(usage, written.usage);
  const by = new Map((Array.isArray(written.data.competitors) ? written.data.competitors : []).map((x) => [Number(x.n), x]));
  const cell = (v) => (Array.isArray(v) ? v.join('; ') : String(v || '').trim());
  const rows = list.map((c, i) => {
    const x = by.get(i + 1) || {};
    return [c.name, c.url, cell(x.offer), cell(x.pricing), cell(x.audience), cell(x.strengths), cell(x.weaknesses)];
  });
  log.success(`Compared ${rows.length} competitor(s)`);
  return result(task, list[0].url, String(written.data.summary || '').trim() || 'The AI did not write a summary; the comparison is below.', COLUMNS.competitor_research, rows, steps, page, usage, model);
}

// ---------------------------------------------------------------- data collection

async function dataCollection(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  needAi(AgentError, 'data collection agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const wanted = task.fields ? task.fields.split(/\s*[,;\n]\s*/).map((f) => f.trim()).filter(Boolean).slice(0, 20) : [];
  let columns = wanted;
  const rows = [];
  const seen = new Set();

  await blockPrivateHosts(page, { skipMedia: true });
  log.action(`Opening ${task.url}`);
  const { response, slow } = await openUrl(page, task.url);
  if (slow) log.warn('The site is slow to load; reading what is shown');
  {
    const code = response ? response.status() : 0;
    if (!code || code >= 400) log.warn(code ? `The site did not open properly (error ${code}); it may block automated browsers` : 'The site did not answer');
    else log.info('Page opened');
  }

  let pages = 0;
  for (; pages < task.maxPages; ) {
    pages++;
    await sleep(1500);
    const outline = await page.locator('body').ariaSnapshot({ timeout: 15000 }).catch(() => '');
    if (!outline) {
      log.warn('Could not read this page');
      break;
    }
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim(), rel: a.rel || '' }))).catch(() => []);
    log.action(`AI is reading page ${pages} (${page.url().replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)})`);
    const got = await askJson(
      model,
      'You turn a web page into a data table. The page is given as an outline: one element per line, links followed by their /url. ' +
        'Collect every item of the main list or table on the page (products, businesses, people, posts, rows...), not menus, ads or footers. ' +
        (columns.length ? `Use exactly these columns, in this order: ${JSON.stringify(columns)}. ` : 'Choose short, clear column names for the useful details of each item (at most 10 columns), with a link column when items have their own page. ') +
        'Copy values exactly as shown; leave a cell "" when an item doesn\'t show it; never invent or guess values. Things shown only as pictures (star ratings, icons, colours) are not in the outline: leave them "" and don\'t choose a column for them. For links use the item\'s /url. ' +
        'Also tell the link to the next page of the list (its /url, or "" when there is none). ' +
        'Reply with JSON: {"columns": [...], "rows": [[...], ...], "next": "..."}.',
      `${task.instructions ? `What the user wants: ${task.instructions}\n` : ''}Page: ${page.url()}\n\n${short(outline, LIST_CHARS)}`,
      AgentError,
    );
    addUsage(usage, got.usage);
    if (!columns.length) columns = (Array.isArray(got.data.columns) ? got.data.columns : []).map((c) => short(String(c), 60)).filter(Boolean).slice(0, 15);
    let added = 0;
    (Array.isArray(got.data.rows) ? got.data.rows : []).forEach((r) => {
      if (!Array.isArray(r) || rows.length >= MAX_ROWS) return;
      const row = columns.map((c, i) => {
        let v = short(String(r[i] == null ? '' : r[i]).trim(), 500);
        // a page's own link ("/x", "../x.html", "x.html") -> its full address
        if (v && !/^[a-z][\w+.-]*:/i.test(v) && (/^\.{0,2}\//.test(v) || (/link|url|href|website|page/i.test(c) && /^[\w./-]+$/.test(v)))) {
          try {
            v = new URL(v, page.url()).toString();
          } catch {
            // keep as shown
          }
        }
        return v;
      });
      const key = row.join('\u0001');
      if (row.some(Boolean) && !seen.has(key)) {
        seen.add(key);
        rows.push(row);
        added++;
      }
    });
    log.success(`Page ${pages}: ${added} row(s) (${rows.length} in total)`);
    if (pages >= task.maxPages || rows.length >= MAX_ROWS) break;

    // the next page: only a link that is really on this page (the model can't make one up)
    let next = String(got.data.next || '').trim();
    if (next && !/^https?:/i.test(next)) next = new URL(next, page.url()).toString();
    const onPage = links.find((l) => next && l.href.split('#')[0] === next.split('#')[0]) || links.find((l) => /\bnext\b/i.test(l.rel)) || links.find((l) => /^(next|next page|›|»|>)$/i.test(l.text));
    if (!onPage || !normalizeSiteUrl(onPage.href) || onPage.href.split('#')[0] === page.url().split('#')[0]) {
      log.info('No next page');
      break;
    }
    log.action(`Opening the next page`);
    await openUrl(page, onPage.href);
  }

  return result(
    task,
    task.url,
    rows.length ? `Collected ${rows.length} row(s) from ${pages} page(s) of ${domainOf(task.url)}.` : `No list data was found on ${domainOf(task.url)}. Check the address, or say in the instructions which part of the page to collect.`,
    columns.length ? columns : ['Value'],
    rows,
    pages,
    page,
    usage,
    model,
  );
}

// ---------------------------------------------------------------- CRM

const CRM_ACTION = {
  add: 'Add each record below as a new contact / lead (whichever the CRM uses; the user may say which).',
  update: 'Find each record below (search by email, then by name) and update it with the values given. Change only those fields.',
  find: 'Find each record below (or, with no records, the list the instructions describe) and collect its details.',
};

function crmPrompt(task, hasLogin) {
  const site = new URL(task.url).hostname;
  return `You are working for the user in their CRM at ${site}, in a real browser. Every tool call is one step; you have at most ${task.maxSteps} steps, so plan.

What to do: ${CRM_ACTION[task.action]}
${task.records ? `Records (one per line):\n${task.records}\n` : ''}${task.instructions ? `The user's instructions: ${task.instructions}\n` : ''}
How:
- First log in if the CRM asks for it.
- Go one record at a time. ${task.action === 'add' ? 'Before adding, search for the email or name; if the record already exists, don\'t add it again (Status "Already exists"). Open the create form, fill the fields that match the record, save, and check the record now shows.' : task.action === 'update' ? 'Open the record, change only the given fields, save, and check the new values show.' : 'Open the record or list and read its details.'}
- Right after each record, call save_data with one row: columns ${task.action === 'find' ? 'the record\'s details (e.g. Name, Email, Phone, Company, Status, Owner)' : '"Record", "Status" (Added / Updated / Already exists / Not found / Failed) and "Notes"'}.
- The user asked for exactly these ${task.action === 'find' ? 'look-ups' : 'changes'}, so ${task.action === 'add' ? 'creating these records is' : task.action === 'update' ? 'updating these records is' : 'reading these records is'} allowed. Never delete, merge, import or bulk-edit anything, never change other records, and never email or message contacts.

${WORKING_RULES(site, hasLogin, false)}`;
}

/** The CRM agent: the custom web agent with a CRM prompt. */
async function crmTask(page, task, log, helpers) {
  const webTask = { type: 'crm_task', url: task.url, instructions: '', maxSteps: task.maxSteps, allowOtherSites: task.allowOtherSites };
  Object.defineProperty(webTask, 'secrets', { value: task.secrets, enumerable: false });
  const hasLogin = Boolean(task.secrets && (task.secrets.USERNAME || task.secrets.PASSWORD));
  const out = await runWebAgent(page, webTask, log, helpers, { name: 'CRM agent', instructions: crmPrompt(task, hasLogin) });
  return { kind: task.type, ...out };
}

const HANDLERS = { web_research: webResearch, competitor_research: competitorResearch, data_collection: dataCollection, crm_task: crmTask };

/** Runs one of the agents above (by task.type). */
function runInsight(page, task, log, helpers) {
  return HANDLERS[task.type](page, task, log, helpers);
}

module.exports = { runInsight, COLUMNS };
