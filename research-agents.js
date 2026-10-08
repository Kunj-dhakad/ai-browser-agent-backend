/**
 * research-agents.js
 * ---------------------------------------------------------------------------
 * Three ready-made AI research agents built on the custom web agent (web-agent.js):
 *
 *   travel_research  flights and/or hotels on Google Flights / Google Hotels
 *   job_search       job listings on LinkedIn Jobs (public pages, no login)
 *   news_research    news on Bing News, with a short summary per article
 *
 * Our code opens the search page with the user's choices already in the address (dates,
 * filters), so the AI starts on the results. The AI reads them, opens details where useful,
 * saves rows with fixed columns, and ends with a short recommendation or briefing.
 * Indeed, Naukri and Google News block automated browsers, so they are not used.
 * ---------------------------------------------------------------------------
 */

const { runWebAgent, WORKING_RULES } = require('./web-agent');

const enc = encodeURIComponent;

const COLUMNS = {
  travel_research: ['Type', 'Name', 'Price', 'Details', 'Rating', 'Link'],
  job_search: ['Title', 'Company', 'Location', 'Posted', 'Salary', 'Work type', 'Notes', 'Link'],
  news_research: ['Headline', 'Source', 'Published', 'Summary', 'Link'],
};

const SAFE = `- This is research only: never sign in, sign up, book, buy, pay, apply or submit anything.
- Copy values exactly as the page shows them (prices with their currency). Never invent a value; leave a cell empty when the page doesn't show it.
- For Link, use the address of the item's own page when read_page shows it (the /url under a link); otherwise leave it empty.`;

/** "Nov 12, 2026" for the prompt. */
const niceDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- travel

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
    steps.push(`${flights ? `Then hotels: open_page ${hotelsUrl}` : 'Hotels (Google Hotels is already open with the dates set)'}: read the results and save the ${n} best hotels (good rating for the price). One row each: Type "Hotel", Name, Price (as shown, usually per night), Details = "hotel class · area · key amenities", Rating (e.g. "4.5 (2.1K)"), Link = the hotel's link if read_page shows its /url.`);
  }

  return {
    startUrl: flights ? flightsUrl : hotelsUrl,
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
  let url = `https://www.linkedin.com/jobs/search?keywords=${enc(task.role)}&location=${enc(location)}`;
  if (POSTED[task.posted]) url += `&f_TPR=${POSTED[task.posted]}`;
  if (LEVEL[task.experience]) url += `&f_E=${LEVEL[task.experience]}`;
  if (task.remote) url += '&f_WT=2';
  const n = task.count;
  return {
    startUrl: url,
    maxSteps: Math.min(60, 12 + Math.ceil(n / 4) * 2 + (task.preferences ? 8 : 4)),
    instructions: `You are a job search assistant working in a real browser on LinkedIn Jobs (public job pages, no login).

The search: "${task.role}" in ${location}${task.remote ? ', remote jobs' : ''}${task.experience !== 'any' ? `, ${task.experience}-level` : ''}${task.posted !== 'any' ? `, posted in the last ${task.posted}` : ''}.
${task.preferences ? `The job seeker's wishes (use them to choose, and say in Notes how a job fits): ${task.preferences}\n` : ''}
What to do:
1. LinkedIn is already open with this search. Read the list and save up to ${n} jobs that match the search${task.preferences ? ' and the wishes' : ''}. One row each: Title, Company, Location, Posted (e.g. "2 days ago"), Salary (only if shown), Work type (Remote / Hybrid / On-site, if shown), Notes (short: why it fits, or "Easy Apply", "Actively hiring"), Link = the job's /url from read_page.
2. Need more jobs? scroll down, then read_page again (the list grows); or click the "See more jobs" button. Don't save the same job twice.
3. ${task.preferences ? 'For the best few matches you may open the job page to check salary or requirements, then come back with open_page to the search.' : 'Don\'t open each job; the list has what you need.'}
4. Answer: how many jobs you found, the companies hiring most, any salary range seen, and the 3 best matches. Plain words, no questions.

- If LinkedIn shows a sign-in wall, close it (Escape or the dismiss button) or go on with the jobs that are shown.
${SAFE}

${WORKING_RULES('LinkedIn Jobs', false, false)}`,
  };
}

// ---------------------------------------------------------------- news

const PERIOD = { day: '7', week: '8', month: '9' }; // Bing: past 24 hours / 7 days / 30 days
const MARKET = { us: 'en-US', in: 'en-IN', gb: 'en-GB', au: 'en-AU', ca: 'en-CA' };

function newsPlan(task) {
  let url = `https://www.bing.com/news/search?q=${enc(task.topic)}`;
  if (PERIOD[task.period]) url += `&qft=interval%3d%22${PERIOD[task.period]}%22`;
  url += `&setmkt=${MARKET[task.region] || 'en-US'}&setlang=en`;
  const n = task.count;
  const read = task.readArticles;
  return {
    startUrl: url,
    allowOtherSites: read, // the articles are on the news sites
    maxSteps: Math.min(60, read ? n * 2 + 10 : 12),
    instructions: `You are a news research assistant working in a real browser, starting on Bing News.

The topic: "${task.topic}"${task.period !== 'any' ? `, news from the past ${task.period}` : ''}.
${task.focus ? `What the reader wants to know: ${task.focus}\n` : ''}
What to do:
1. Bing News is already open with this search. Read the results and pick the ${n} most relevant, newest articles from different sources (skip duplicates of the same story).
2. ${read
      ? `Open each picked article (open_page with its /url), read it (read_page), and save one row: Headline, Source, Published (as shown, e.g. "3h ago" or the date), Summary (2-3 sentences in your own words: the facts${task.focus ? ', and what it says about the reader\'s question' : ''}), Link. If an article does not open, is behind a paywall or a cookie wall you can't pass, summarise it from the Bing snippet instead and go on.`
      : 'Save one row per article from the results list: Headline, Source, Published (as shown), Summary (from the snippet, 1-2 sentences), Link = the article\'s /url.'}
3. Answer with a short briefing: the 3-5 key points across the articles${task.focus ? ' and the answer to the reader\'s question' : ''}, and where sources disagree. Plain words, no questions.

- Only news sites and Bing: never sign in, subscribe or accept anything beyond closing a cookie notice.
${SAFE}

${WORKING_RULES('Bing News and the news sites', false, read)}`,
  };
}

// ---------------------------------------------------------------- run

const PLANS = { travel_research: travelPlan, job_search: jobsPlan, news_research: newsPlan };
const NAMES = { travel_research: 'Travel research agent', job_search: 'Job search agent', news_research: 'News research agent' };

/**
 * Runs one of the research agents. Returns the web agent's result
 * ({ url, answer, data: { columns, rows }, steps, ... }) plus `kind` = the task type.
 */
async function runResearch(page, task, log, helpers) {
  const plan = PLANS[task.type](task);
  const webTask = { type: task.type, url: plan.startUrl, instructions: '', maxSteps: plan.maxSteps, allowOtherSites: Boolean(plan.allowOtherSites) };
  const result = await runWebAgent(page, webTask, log, helpers, { name: NAMES[task.type], instructions: plan.instructions, columns: COLUMNS[task.type] });
  return { kind: task.type, ...result };
}

module.exports = { runResearch, COLUMNS };
