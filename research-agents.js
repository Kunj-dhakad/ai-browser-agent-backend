/**
 * research-agents.js
 * ---------------------------------------------------------------------------
 * Three ready-made AI research agents built on the custom web agent (web-agent.js):
 *
 *   travel_research  flights and/or hotels on Google Flights / Google Hotels
 *   job_search       job listings on LinkedIn Jobs (public pages, no login)
 *   news_research    news on Bing News, with a short summary per article (our code reads
 *                    the pages; the AI picks the articles and writes the summaries)
 *
 * Our code opens the search page with the user's choices already in the address (dates,
 * filters), so the AI starts on the results. The AI reads them, opens details where useful,
 * saves rows with fixed columns, and ends with a short recommendation or briefing.
 * Indeed, Naukri and Google News block automated browsers, so they are not used.
 * ---------------------------------------------------------------------------
 */

const { runWebAgent, WORKING_RULES } = require('./web-agent');
const { useOpenAI, openUrl, sleep, askJson, addUsage, readPageText, aiModel } = require('./ai-browser');

const enc = encodeURIComponent;

const COLUMNS = {
  travel_research: ['Type', 'Name', 'Price', 'Details', 'Rating', 'Link'],
  job_search: ['Title', 'Company', 'Location', 'Posted', 'Salary', 'Work type', 'Notes', 'Link'],
  news_research: ['Headline', 'Source', 'Published', 'Summary', 'Link'],
};

const SAFE = `- This is research only: never sign in, sign up, book, buy, pay, apply or submit anything.
- Copy values exactly as the page shows them (prices with their currency). Never invent a value; leave a cell empty when the page doesn't show it.
- Every fact you write (in the rows and in your answer) must come from the pages you read in this task, never from your own memory.
- For Link, use the address of the item's own page when read_page shows it (the /url under a link); otherwise leave it empty.`;

/** "Nov 12, 2026" for the prompt. */
const niceDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- travel

const CURRENCY_NAME = { USD: 'US Dollar', INR: 'Indian Rupee', EUR: 'Euro', GBP: 'British Pound', AED: 'Emirati Dirham|UAE Dirham|United Arab Emirates Dirham' };

/**
 * Picks the trip's currency in Google Travel's currency setting (it is remembered for flights
 * and hotels). Google Hotels ignores the address's curr= and uses the visitor's country.
 */
async function setGoogleCurrency(page, log, currency) {
  try {
    const button = page.getByRole('button', { name: /currency/i }).first();
    const now = (await button.getAttribute('aria-label', { timeout: 8000 }).catch(() => '')) || (await button.innerText({ timeout: 3000 }).catch(() => ''));
    if (new RegExp(`\\b${currency}\\b`).test(now)) {
      log.info(`Prices are in ${currency}`);
      return;
    }
    await button.click({ timeout: 8000 });
    await page.getByRole('radio', { name: new RegExp(`^(${CURRENCY_NAME[currency]})\\b`, 'i') }).first().click({ timeout: 5000 });
    const ok = page.getByRole('button', { name: /^(ok|done)$/i }).first();
    if (await ok.count()) await ok.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    log.info(`Prices set to ${currency}`);
  } catch {
    log.warn(`Could not set the currency to ${currency}; prices show in the currency Google picks`);
  }
}

function travelPlan(task) {
  const people = `${task.adults} adult${task.adults === 1 ? '' : 's'}`;
  const flightsUrl = `https://www.google.com/travel/flights?q=${enc(
    `Flights from ${task.from} to ${task.to} on ${task.departDate}${task.returnDate ? ` returning ${task.returnDate}` : ' one way'} for ${people}`,
  )}&hl=en&curr=${task.currency}`;
  // hotels: the nights of the trip (one night when there is no return date)
  const checkout = task.returnDate || new Date(Date.parse(`${task.departDate}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const hotelsUrl = `https://www.google.com/travel/search?q=${enc(`hotels in ${task.to} from ${task.departDate} to ${checkout} for ${people}`)}&hl=en&curr=${task.currency}`;
  const flights = task.search !== 'hotels';
  const hotels = task.search !== 'flights';
  const n = task.count;
  const trip = `${task.from ? `from ${task.from} ` : ''}to ${task.to}, ${niceDate(task.departDate)}${task.returnDate ? ` to ${niceDate(task.returnDate)}` : ''}, ${people}`;

  const steps = [];
  if (flights) {
    steps.push(`Flights (Google Flights is already open with the search done${task.returnDate ? ': round trip, the prices are for the whole trip' : ''}): read the results and save the ${n} best flight options (cheapest and best-ranked; mix in the fastest). One row each: Type "Flight", Name = airline(s), Price, Details = "depart–arrive times · duration · stops (and where)", Rating empty, Link empty.`);
  }
  if (hotels) {
    steps.push(`${flights ? `Then hotels: open_page ${hotelsUrl}` : 'Hotels (Google Hotels is already open with the dates set)'}: read the results and save the ${n} best hotels (good rating for the price). One row each: Type "Hotel", Name, Price (as shown, usually per night), Details = "hotel class · area · key amenities", Rating (e.g. "4.5 (2.1K)"), Link = the hotel's own /url from read_page. Skip "Sponsored" hotels and ads.`);
  }

  return {
    startUrl: flights ? flightsUrl : hotelsUrl,
    prepare: (page, log) => setGoogleCurrency(page, log, task.currency),
    maxSteps: (flights ? 14 : 0) + (hotels ? 14 : 0) + 6,
    instructions: `You are a travel research assistant working in a real browser on Google Travel.
Every tool call is one step; you have at most ${(flights ? 14 : 0) + (hotels ? 14 : 0) + 6} steps.

The trip: ${trip}. Prices in ${task.currency}.
${task.preferences ? `The traveller's wishes (use them to choose and rank): ${task.preferences}\n` : ''}
What to do:
${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}
${steps.length + 1}. Answer with a short recommendation: the best value option${flights && hotels ? 's (flight and hotel), the cheapest total for the trip' : ''}, and anything to know (prices change, baggage, area). Plain words, no questions.

- Results can take a few seconds to appear ("Loading results", "Fetching results"): use wait, then read again.
- Don't open each option one by one; the results list has what you need.
${SAFE}

${WORKING_RULES('Google Travel', false, false)}`,
  };
}

// ---------------------------------------------------------------- jobs

const POSTED = { day: 'r86400', week: 'r604800', month: 'r2592000' };
const LEVEL = { entry: '1%2C2', mid: '3%2C4', senior: '4%2C5%2C6' };

function jobsPlan(task) {
  const location = task.location || (task.remote ? 'Worldwide' : 'United States');
  let url = `https://www.linkedin.com/jobs/search?keywords=${enc(task.remote ? `${task.role} remote` : task.role)}&location=${enc(location)}`;
  if (POSTED[task.posted]) url += `&f_TPR=${POSTED[task.posted]}`;
  if (LEVEL[task.experience]) url += `&f_E=${LEVEL[task.experience]}`;
  // LinkedIn's public pages ignore the remote filter: remote jobs come from RemoteOK first
  const remoteOk = `https://remoteok.com/?search=${enc(task.role)}`;
  const n = task.count;
  return {
    startUrl: task.remote ? remoteOk : url,
    allowOtherSites: task.remote, // RemoteOK, then LinkedIn
    maxSteps: Math.min(60, 12 + Math.ceil(n / 4) * 2 + (task.preferences ? 8 : 4) + (task.remote ? 6 : 0)),
    instructions: `You are a job search assistant working in a real browser on ${task.remote ? 'RemoteOK and LinkedIn Jobs' : 'LinkedIn Jobs'} (public job pages, no login).

The search: "${task.role}"${task.remote ? `, remote jobs${task.location ? ` open to people in ${task.location}` : ''}` : ` in ${location}`}${task.experience !== 'any' ? `, ${task.experience}-level` : ''}${task.posted !== 'any' ? `, posted in the last ${task.posted}` : ''}.
${task.preferences ? `The job seeker's wishes (use them to choose, and say in Notes how a job fits): ${task.preferences}\n` : ''}
What to do:
${task.remote ? `0. RemoteOK is open with this search (every job there is remote; the list shows salary and where applicants may live). Save the matching jobs from it first (Work type "Remote", Location = where applicants may live, e.g. "Worldwide" or "US only")${task.posted !== 'any' ? `, skipping jobs older than the last ${task.posted} (RemoteOK shows the age, e.g. "3d", "2mo")` : ''}. If you have fewer than ${n}, open_page ${url} and add LinkedIn jobs that say Remote in their title or location.
` : ''}1. ${task.remote ? 'On LinkedIn' : 'LinkedIn is already open with this search.'} Read the list and save up to ${n} jobs that match the search${task.preferences ? ' and the wishes' : ''}. One row each: Title, Company, Location, Posted (e.g. "2 days ago"), Salary (only if shown), Work type (Remote / Hybrid / On-site, if shown), Notes (short: why it fits, or "Easy Apply", "Actively hiring"), Link = the job's /url from read_page.
2. Need more jobs? scroll down, then read_page again (the list grows); or click the "See more jobs" button. Don't save the same job twice.
3. ${task.preferences ? 'For the best few matches you may open the job page to check salary or requirements, then come back with open_page to the search.' : 'Don\'t open each job; the list has what you need.'}
4. Answer: how many jobs you found, the companies hiring most, any salary range seen, and the 3 best matches. Plain words, no questions.

- If LinkedIn shows a sign-in wall, close it (Escape or the dismiss button) or go on with the jobs that are shown.
${SAFE}

${WORKING_RULES('LinkedIn Jobs', false, false)}`,
  };
}

// ---------------------------------------------------------------- news
//
// Not a browsing AI: on news sites the model wandered off to related links and made up
// article addresses. Our code reads Bing's list and the articles; the AI only picks the
// articles (one request) and writes the summaries and the briefing (one request).

const PERIOD = { day: '7', week: '8', month: '9' }; // Bing: past 24 hours / 7 days / 30 days
const MARKET = { us: 'en-US', in: 'en-IN', gb: 'en-GB', au: 'en-AU', ca: 'en-CA' };
const NEWS_TEXT_CHARS = 4000; // of each article, for the AI (~1k tokens)

function newsUrl(task) {
  let url = `https://www.bing.com/news/search?q=${enc(task.topic)}`;
  if (PERIOD[task.period]) url += `&qft=interval%3d%22${PERIOD[task.period]}%22`;
  return `${url}&setmkt=${MARKET[task.region] || 'en-US'}&setlang=en`;
}

/** The news cards on a Bing News results page. */
async function readBingNews(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.news-card[data-url]')].map((c) => {
      const time = [...c.querySelectorAll('span[aria-label]')].map((s) => s.getAttribute('aria-label')).find((t) => /ago$|^\w{3} \d/.test(t || ''));
      const snippet = c.querySelector('.snippet');
      return {
        title: (c.getAttribute('data-title') || '').trim(),
        source: (c.getAttribute('data-author') || '').trim(),
        url: c.getAttribute('data-url') || '',
        published: time || '',
        snippet: (snippet ? snippet.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 400),
      };
    }),
  );
}

async function newsResearch(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  if (!useOpenAI()) throw new AgentError('AI_REQUIRED', 'The news agent needs an OpenAI API key (OPENAI_API_KEY in backend/.env).');
  const model = aiModel();
  const url = newsUrl(task);
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const focus = task.focus ? `\nWhat the reader wants to know: ${task.focus}` : '';

  await blockPrivateHosts(page, { skipMedia: true });
  log.action(`Searching Bing News for "${task.topic}"`);
  await openUrl(page, url);
  let cards = await readBingNews(page);
  // more results load as you scroll
  for (let i = 0; cards.length < task.count * 2 && i < 3; i++) {
    await page.mouse.wheel(0, 5000);
    await sleep(1500);
    cards = await readBingNews(page);
  }
  cards = cards.filter((c, i) => c.title && normalizeSiteUrl(c.url) && cards.findIndex((x) => x.url === c.url) === i).slice(0, 40);
  log.info(`Bing News listed ${cards.length} article(s)`);
  if (!cards.length) {
    return { kind: task.type, url, answer: `Bing News found no articles for "${task.topic}"${task.period !== 'any' ? ` in the past ${task.period}` : ''}. Try a shorter topic or a longer period.`, data: { columns: COLUMNS.news_research, rows: [] }, steps: 0, stoppedEarly: false, finalUrl: page.url(), usedLogin: false, usage: { model } };
  }

  // 1) the AI picks the most relevant, distinct stories
  log.action(`AI (${model}) is picking the ${task.count} most relevant articles`);
  const picked = await askJson(
    model,
    'You pick news articles for a reader. Choose the most relevant articles for the topic, newest first, each about a different story, preferring real news reports from known outlets over product listings, buying guides or ads. Reply with JSON: {"picked": [the article numbers, best first]}.',
    `Topic: ${task.topic}${focus}\nPick ${task.count}.\n\nArticles:\n${cards.map((c, i) => `${i + 1}. ${c.title} — ${c.source}${c.published ? `, ${c.published}` : ''}${c.snippet ? `: ${c.snippet.slice(0, 200)}` : ''}`).join('\n')}`,
    AgentError,
  );
  addUsage(usage, picked.usage);
  let chosen = (Array.isArray(picked.data.picked) ? picked.data.picked : [])
    .map((n) => cards[Number(n) - 1])
    .filter((c, i, a) => c && a.indexOf(c) === i);
  if (!chosen.length) chosen = cards;
  chosen = chosen.slice(0, task.count);

  // 2) read the articles (our code, not the AI)
  let steps = 0;
  for (const c of chosen) {
    c.text = '';
    if (!task.readArticles) continue;
    steps++;
    log.action(`Reading ${c.source || 'the article'}: ${c.title.slice(0, 70)}`);
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(1500);
      c.text = (await readPageText(page)).slice(0, NEWS_TEXT_CHARS);
    } catch {
      // slow or blocked: the summary comes from Bing's snippet
    }
    if (c.text.length < 300) {
      c.text = '';
      log.warn('Could not read the article text; using the Bing snippet');
    }
  }

  // 3) the AI writes the summaries and the briefing
  log.action('AI is writing the summaries and the briefing');
  const written = await askJson(
    model,
    'You are a news analyst. Using ONLY the articles given (never your own knowledge), write for each article a 2-3 sentence summary of its facts' +
      (task.focus ? " and what it says about the reader's question" : '') +
      ', then a short briefing: 3-5 key points across the articles, each starting with "- "' +
      (task.focus ? ", then a direct answer to the reader's question" : '') +
      ', and where sources disagree. If an article has only a snippet, summarise the snippet. Write the facts themselves; never mention snippets, the article or the source in a summary. Reply with JSON: {"articles": [{"n": article number, "summary": "..."}], "briefing": "..."}.',
    `Topic: ${task.topic}${focus}\n\n${chosen.map((c, i) => `### Article ${i + 1}: ${c.title}\nSource: ${c.source}${c.published ? ` (${c.published})` : ''}\n${c.text || `Snippet: ${c.snippet || '(none)'}`}`).join('\n\n')}`,
    AgentError,
  );
  addUsage(usage, written.usage);
  const summaries = new Map((Array.isArray(written.data.articles) ? written.data.articles : []).map((a) => [Number(a.n), String(a.summary || '').trim()]));
  const rows = chosen.map((c, i) => [c.title, c.source, c.published, summaries.get(i + 1) || c.snippet, c.url]);
  log.success(`Summed up ${rows.length} article(s)`);

  return {
    kind: task.type,
    url,
    answer: String(written.data.briefing || '').trim() || 'The AI did not write a briefing; the articles are below.',
    data: { columns: COLUMNS.news_research, rows },
    steps,
    stoppedEarly: false,
    finalUrl: page.url(),
    usedLogin: false,
    usage: { model, ...usage },
  };
}

// ---------------------------------------------------------------- run

const PLANS = { travel_research: travelPlan, job_search: jobsPlan };
const NAMES = { travel_research: 'Travel research agent', job_search: 'Job search agent' };

/**
 * Runs one of the research agents. Returns the web agent's result
 * ({ url, answer, data: { columns, rows }, steps, ... }) plus `kind` = the task type.
 */
async function runResearch(page, task, log, helpers) {
  if (task.type === 'news_research') return newsResearch(page, task, log, helpers);
  const plan = PLANS[task.type](task);
  const webTask = { type: task.type, url: plan.startUrl, instructions: '', maxSteps: plan.maxSteps, allowOtherSites: Boolean(plan.allowOtherSites) };
  const result = await runWebAgent(page, webTask, log, helpers, { name: NAMES[task.type], instructions: plan.instructions, columns: COLUMNS[task.type], prepare: plan.prepare });
  if (task.type === 'job_search') result.data.rows = result.data.rows.slice(0, task.count);
  const link = result.data.columns.indexOf('Link');
  result.data.rows.forEach((row) => {
    if (/\/aclk\?|googleadservices/i.test(row[link] || '')) row[link] = ''; // an ad's click counter, not the item
    if (row[link] && !/^https?:\/\//i.test(row[link])) {
      try {
        row[link] = row[link].startsWith('/') ? new URL(row[link], plan.startUrl).toString() : '';
      } catch {
        row[link] = '';
      }
    }
  });
  return { kind: task.type, ...result };
}

module.exports = { runResearch, COLUMNS };
