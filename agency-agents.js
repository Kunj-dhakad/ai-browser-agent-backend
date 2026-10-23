/**
 * agency-agents.js
 * ---------------------------------------------------------------------------
 * Four agents for a digital-marketing agency (from the Browser Crew task list):
 *
 *   product_report      a product -> web research (official site, pricing, reviews,
 *                       competitors) -> an 18-section research report, optionally as a Google Doc
 *   lead_generation     a business type + place -> Google Maps leads -> their websites' emails
 *                       -> qualified by the user's criteria -> a Google Sheet + Gmail drafts
 *   agency_outreach     the agency and a client list -> each client's website read -> an
 *                       agency introduction Google Doc + a personalized Gmail draft per client
 *   proposal_builder    a client's requirements + the pricing (a Google Sheet or text) -> a
 *                       proposal Google Doc + a Gmail draft with its link
 *
 * Google Docs / Sheets / Gmail go through the user's own Google login (google-apps.js). When
 * it is not connected the agents still do the research and writing and say what they could
 * not save. Emails are only ever saved as drafts.
 * ---------------------------------------------------------------------------
 */

const { useOpenAI, readUrl, findSources, askJson, addUsage, aiModel, short, sleep } = require('./ai-browser');
const google = require('./google-apps');

const REPORT_SECTIONS = [
  ['Executive summary', 'Product name, purpose, key findings, risks, and final recommendation'],
  ['Company overview', 'Company background, mission, customers, business model, funding, reputation'],
  ['Product overview', 'What the product is, the problem it solves, target market, and differentiators'],
  ['Users and personas', 'End users, buyers, administrators, goals, pain points, and usage patterns'],
  ['Use cases', 'Real situations, user goals, product capabilities, and outcomes'],
  ['Feature assessment', 'Feature list, purpose, user value, business value, maturity, and rating'],
  ['User experience', 'Onboarding, navigation, design, speed, mobile experience, and ease of use'],
  ['Quality and security', 'Reliability, performance, privacy, security, support, accessibility, compatibility'],
  ['Pricing and value', 'Plans, cost, free trial, hidden costs, competitor pricing, value assessment'],
  ['Customer feedback', 'Positive themes, negative themes, evidence, frequency, and impact'],
  ['Metrics', 'Adoption, retention, engagement, churn, NPS, support tickets, revenue impact'],
  ['Competitor comparison', 'Product versus alternatives across features, price, usability, and support'],
  ['Strengths', 'Main advantages with supporting evidence'],
  ['Weaknesses and gaps', 'Main disadvantages, missing capabilities, and user complaints'],
  ['Risks', 'Likelihood, impact, evidence, and recommended mitigation'],
  ['Recommendations', 'Prioritized actions with owners and deadlines'],
  ['Final recommendation', 'Clear decision: adopt, improve, invest, avoid, or research further'],
];

const SOURCE_CHARS = 4000;
const SITE_CHARS = 3000;
const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const cell = (v) => (Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v).trim());
const today = (plusDays = 0) => new Date(Date.now() + plusDays * 86400000).toISOString().slice(0, 10);

function needAi(AgentError, what) {
  if (!useOpenAI()) throw new AgentError('AI_REQUIRED', `The ${what} needs an OpenAI API key (OPENAI_API_KEY in backend/.env).`);
}

/** The result the pages show (same shape as the other AI agents). */
function result(task, url, answer, columns, rows, steps, page, usage, model, extra = {}) {
  return { kind: task.type, url, answer, data: { columns, rows }, steps, stoppedEarly: false, finalUrl: page.url(), usedLogin: false, usage: { model, ...usage }, ...extra };
}

/** Google signed in? Says so in the log when it is not (the agent then only writes). */
async function googleCheck(page, log, what) {
  log.action('Checking your Google account');
  const ok = await google.googleReady(page);
  if (ok) log.info('Google account connected');
  else log.warn(`Google is not connected: ${what} will not be created. Connect it on the Gmail Agent page (Connect Gmail) and run the task again.`);
  return ok;
}

/** Blocks for a Google Doc from text with "- " bullet lines. */
function textBlocks(text) {
  return String(text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^[-•*]\s+/.test(l) ? { type: 'li', text: l.replace(/^[-•*]\s+/, '') } : { type: 'p', text: l }));
}

/** Emails / websites / names out of pasted lines ("Name, https://site.com, a@b.com"). */
function parseClients(text, normalizeSiteUrl) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const email = (line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0] || '';
      const urlText = (line.replace(email, '').match(/https?:\/\/[^\s,|;]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,|;]*)?/i) || [])[0] || '';
      const website = urlText ? normalizeSiteUrl(urlText) || '' : '';
      const name = line.replace(email, '').replace(urlText, '').split(/[,|;\t]/).map((s) => s.trim()).filter(Boolean)[0] || (website ? domainOf(website) : email.split('@')[1] || '');
      return { name: short(name, 100), website, email };
    })
    .filter((c) => c.name || c.website || c.email);
}

/** Clients out of a Google Sheet's rows: the columns are found by their header names. */
function clientsFromSheet(rows, normalizeSiteUrl) {
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const iName = col(/name|business|company|client/);
  const iSite = col(/website|site|url|domain/);
  const iEmail = col(/e-?mail/);
  return rows.slice(1).map((r) => ({
    name: short(cell(r[iName >= 0 ? iName : 0]), 100),
    website: iSite >= 0 ? normalizeSiteUrl(cell(r[iSite])) || '' : '',
    email: iEmail >= 0 ? (cell(r[iEmail]).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0] : '',
  })).filter((c) => c.name || c.website || c.email);
}

// ---------------------------------------------------------------- product research report

async function productReport(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  needAi(AgentError, 'product research agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  await blockPrivateHosts(page, { skipMedia: true });

  log.action(`Searching the web about ${task.product}`);
  const found = await findSources(
    model,
    `Find the most useful web pages to research the product "${task.product}"${task.website ? ` (${task.website})` : ''}: its official site and pricing page, ` +
      `independent reviews and user ratings (e.g. G2, Capterra, Trustpilot), the company's background and funding, and comparisons with ${task.competitors || 'its main competitors'}. List each page with its title and URL.`,
    AgentError,
  );
  addUsage(usage, found.usage);
  const sources = found.sources.filter((s) => normalizeSiteUrl(s.url)).slice(0, 12);
  if (task.website && !sources.some((s) => domainOf(s.url) === domainOf(task.website))) sources.unshift({ title: `${task.product} website`, url: task.website });
  let steps = 0;
  for (const s of sources) {
    if (sources.filter((x) => x.text).length >= 9) break;
    steps++;
    log.action(`Reading ${domainOf(s.url)}`);
    s.text = await readUrl(page, s.url, SOURCE_CHARS);
    if (!s.title) s.title = short(await page.title().catch(() => ''), 150);
    if (s.text.length < 300) {
      s.text = '';
      log.warn(`Could not read ${domainOf(s.url)}; using other sources`);
    }
  }
  const read = sources.filter((s) => s.text);
  if (!read.length) throw new AgentError('NOT_FOUND', 'No web pages about this product could be read. Check the product name or add its website.');

  log.action(`Writing the report from ${read.length} source(s)`);
  const written = await askJson(
    model,
    'You are a senior product analyst. Write a product research report using ONLY the numbered sources (never your own knowledge); after facts put the source number in brackets, e.g. [3]. ' +
      'When the sources do not cover something (e.g. metrics like churn or NPS are rarely public), say "Not publicly available" for it instead of guessing. ' +
      `Write these sections, each 3-6 short sentences or "- " bullet points: ${REPORT_SECTIONS.map(([t, w]) => `${t} (${w})`).join('; ')}. ` +
      'For "Final recommendation" start with one of: Adopt, Improve, Invest, Avoid, Research further. ' +
      'Reply with JSON: {"sections": [{"title": "...", "text": "..."}], "decision": "Adopt|Improve|Invest|Avoid|Research further"}.',
    `Product: ${task.product}${task.website ? `\nWebsite: ${task.website}` : ''}${task.competitors ? `\nCompare with: ${task.competitors}` : ''}${task.audience ? `\nThe report is for: ${task.audience}` : ''}\n\n` +
      read.map((s, i) => `### Source ${i + 1}: ${s.title} (${domainOf(s.url)})\n${s.text}`).join('\n\n'),
    AgentError,
  );
  addUsage(usage, written.usage);
  const sections = (Array.isArray(written.data.sections) ? written.data.sections : []).map((x) => ({ title: cell(x.title), text: cell(x.text) })).filter((x) => x.title && x.text);
  if (!sections.length) throw new AgentError('AI_FAILED', 'The AI did not write the report. Run the task again.');
  sections.push({ title: 'Sources', text: read.map((s, i) => `- [${i + 1}] ${s.title}: ${s.url}`).join('\n') });

  let docUrl = '';
  if (task.saveToDocs && (await googleCheck(page, log, 'the Google Doc'))) {
    const blocks = [{ type: 'h1', text: `${task.product}: product research report` }, { type: 'p', text: `Prepared ${today()} by Browser Crew. Decision: ${cell(written.data.decision) || 'see the final recommendation'}.` }];
    sections.forEach((s) => blocks.push({ type: 'h2', text: s.title }, ...textBlocks(s.text)));
    docUrl = await google.createDoc(page, task.docName || `${task.product} - Product Research Report`, blocks, log);
  }
  const summary = (sections.find((s) => /executive/i.test(s.title)) || sections[0]).text;
  const answer = `${summary}${docUrl ? `\n\nGoogle Doc: ${docUrl}` : ''}`;
  log.success(`Report written: ${sections.length} sections${docUrl ? ', saved as a Google Doc' : ''}`);
  return result(task, docUrl || read[0].url, answer, ['Section', 'Content'], sections.map((s) => [s.title, s.text]), steps, page, usage, model, docUrl ? { links: [{ label: 'Google Doc', url: docUrl }] } : {});
}

// ---------------------------------------------------------------- lead generation

async function leadGeneration(page, task, log, helpers) {
  const { blockPrivateHosts, AgentError, mapsSearch, checkSite } = helpers;
  needAi(AgentError, 'lead generation agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  const found = await mapsSearch(page, { query: task.industry, location: task.location, limit: task.count }, log);
  const leads = found.leads.slice(0, task.count);
  if (!leads.length) throw new AgentError('NOT_FOUND', `No ${task.industry} businesses were found in ${task.location}. Try a wider place or another business type.`);

  // Maps keeps changing its own address in the background: leave it before opening the websites
  await page.goto('about:blank').catch(() => {});
  await sleep(500);
  await blockPrivateHosts(page);
  let steps = 1;
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    if (!l.website) continue;
    steps++;
    // a fresh start for each website: the last one's scripts may still be redirecting the tab
    await page.goto('about:blank').catch(() => {});
    let site = await checkSite(page, l.website, `${i + 1}/${leads.length}`, log);
    if (/interrupted/i.test(site.error || '')) {
      await sleep(2000);
      await page.goto('about:blank').catch(() => {});
      site = await checkSite(page, l.website, `${i + 1}/${leads.length} (again)`, log);
    }
    l.email = site.emails[0] || '';
    l.siteText = site.error ? '' : short(site.name || '', 100);
  }

  log.action('Qualifying the leads and writing the outreach emails');
  const written = await askJson(
    model,
    `You qualify leads for a digital marketing agency and write first outreach emails. For each numbered business decide: needs (which of the agency's services it most likely needs, 1 short phrase), qualified (true / false by the user's criteria; when unsure use what is known: a business with a website and some reviews is usually fine), reason (short). ` +
      `For each qualified business that has an email, write a personalized email: subject (under 60 characters) and body (4-6 short sentences: something specific about the business, how the agency can help with its needs, one clear call to action, signed by the agency${task.senderName ? ` / ${task.senderName}` : ''}; no placeholders). ` +
      'Reply with JSON: {"leads": [{"n": number, "needs": "", "qualified": true, "reason": "", "subject": "", "body": ""}]}.',
    `Agency: ${task.agencyName}\nServices to promote: ${task.services}\nQualification criteria: ${task.criteria || 'has an active website'}\nIndustry: ${task.industry}, ${task.location}\n\n` +
      leads.map((l, i) => `${i + 1}. ${l.name} | website: ${l.website || 'none'} | email: ${l.email || 'none'} | phone: ${l.phone || ''} | rating: ${l.rating || ''} (${l.reviews || 0} reviews) | category: ${l.category || ''} | address: ${l.address || ''}`).join('\n'),
    AgentError,
  );
  addUsage(usage, written.usage);
  const by = new Map((Array.isArray(written.data.leads) ? written.data.leads : []).map((x) => [Number(x.n), x]));

  const google_ = task.saveToSheets || task.draftEmails ? await googleCheck(page, log, 'the Google Sheet and Gmail drafts') : false;
  let drafts = 0;
  const rows = leads.map((l, i) => {
    const x = by.get(i + 1) || {};
    const qualified = x.qualified === true || x.qualified === 'true';
    return { l, x, qualified, status: qualified ? 'Qualified' : 'Not qualified', draft: '' };
  });
  if (google_ && task.draftEmails) {
    for (const r of rows) {
      if (drafts >= task.maxDrafts) break;
      if (!r.qualified || !r.l.email || !cell(r.x.body)) {
        r.draft = r.qualified && !r.l.email ? 'No public email' : '';
        continue;
      }
      steps++;
      r.draft = await google.gmailDraft(page, { to: r.l.email, subject: cell(r.x.subject), body: cell(r.x.body) }, log).catch((err) => `Not saved: ${short(err.message, 60)}`);
      if (/^Draft saved/.test(r.draft)) {
        drafts++;
        r.status = 'Contacted (draft)';
      }
    }
  }
  const columns = ['Business Name', 'Website', 'Email', 'Phone', 'Industry', 'Potential Service Needs', 'Lead Status', 'Next Follow-up Date', 'Email Draft Status', 'Notes'];
  const table = rows.map((r) => [r.l.name, r.l.website || '', r.l.email || '', r.l.phone || '', r.l.category || task.industry, cell(r.x.needs), r.status, r.qualified ? today(3) : '', r.draft, cell(r.x.reason)]);

  let sheetUrl = '';
  if (google_ && task.saveToSheets) {
    steps++;
    sheetUrl = await google.createSheet(page, task.sheetName || `${task.industry} leads - ${task.location} (${today()})`, [columns, ...table], log);
  }
  const qualified = rows.filter((r) => r.qualified).length;
  const answer = `Found ${leads.length} ${task.industry} business(es) in ${task.location}: ${qualified} qualified, ${leads.filter((l) => l.email).length} with a public email.` +
    `${drafts ? ` ${drafts} outreach email draft(s) saved in Gmail (Drafts) for you to review and send.` : ''}${sheetUrl ? `\n\nGoogle Sheet: ${sheetUrl}` : ''}`;
  log.success(answer.split('\n')[0]);
  return result(task, sheetUrl || 'https://www.google.com/maps', answer, columns, table, steps, page, usage, model, sheetUrl ? { links: [{ label: 'Google Sheet', url: sheetUrl }] } : {});
}

// ---------------------------------------------------------------- agency outreach

async function agencyOutreach(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }) {
  needAi(AgentError, 'agency outreach agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const google_ = await googleCheck(page, log, 'the Google Doc and Gmail drafts');

  let clients = [];
  if (/docs\.google\.com\/spreadsheets/.test(task.clients)) {
    if (!google_) throw new AgentError('LOGIN_REQUIRED', 'Connect Google first to read the client list from Google Sheets, or paste the list instead.');
    log.action('Reading the client list from Google Sheets');
    clients = clientsFromSheet(await google.readSheet(page, task.clients.match(/https?:\/\/\S+/)[0]), normalizeSiteUrl);
  } else clients = parseClients(task.clients, normalizeSiteUrl);
  clients = clients.slice(0, task.maxClients);
  if (!clients.length) throw new AgentError('INVALID_TASK', 'No clients found in the list: one per line, e.g. "GreenLeaf Realty, greenleaf.com, owner@greenleaf.com".');
  log.info(`${clients.length} client(s) to research`);

  await blockPrivateHosts(page, { skipMedia: true });
  let steps = 0;
  if (task.website) {
    steps++;
    log.action(`Reading your website ${domainOf(task.website)}`);
    task.siteText = await readUrl(page, task.website, SITE_CHARS);
  }
  for (const c of clients) {
    if (!c.website) continue;
    steps++;
    log.action(`Reading ${c.name || domainOf(c.website)} (${domainOf(c.website)})`);
    c.text = await readUrl(page, c.website, SITE_CHARS);
    if (!c.text) log.warn(`Could not read ${domainOf(c.website)}; its email is written from the name only`);
  }

  log.action('Writing the introduction document and the emails');
  const written = await askJson(
    model,
    'You write for a digital marketing agency. 1) An agency introduction document: sections About us, Our services (each service and what the client gets), Why work with us (the value proposition, with proof from the portfolio when given), How we work, Next steps / contact. Use only the facts given; no made-up numbers or clients. ' +
      `2) For each numbered client: what (1 sentence on what the business does, from its website text), subject (under 60 characters) and body (5-7 short sentences, ${task.tone || 'friendly and professional'}: something specific about their business, the services that fit them, the value proposition, the line "You can read more about us here: {{DOC_LINK}}", one clear call to action, signed by the agency). ` +
      'Reply with JSON: {"doc": [{"title": "...", "text": "..."}], "clients": [{"n": number, "what": "", "subject": "", "body": ""}]}.',
    `Agency: ${task.agencyName}${task.website ? ` (${task.website})` : ''}\nServices: ${task.services}\nValue proposition: ${task.valueProposition}${task.portfolio ? `\nPortfolio: ${task.portfolio}` : ''}` +
      (task.siteText ? `\nAgency website text:\n${short(task.siteText, 2000)}` : '') +
      `\n\n${clients.map((c, i) => `### Client ${i + 1}: ${c.name}${c.website ? ` (${c.website})` : ''}\n${c.text ? short(c.text, 2500) : '(no website text)'}`).join('\n\n')}`,
    AgentError,
  );
  addUsage(usage, written.usage);
  const docSections = (Array.isArray(written.data.doc) ? written.data.doc : []).map((x) => ({ title: cell(x.title), text: cell(x.text) })).filter((x) => x.title && x.text);
  const by = new Map((Array.isArray(written.data.clients) ? written.data.clients : []).map((x) => [Number(x.n), x]));

  let docUrl = '';
  let shared = false;
  if (google_) {
    steps++;
    docUrl = await google.createDoc(page, `${task.agencyName} - Agency Introduction`, [{ type: 'h1', text: `${task.agencyName}: Agency Introduction` }, ...docSections.flatMap((s) => [{ type: 'h2', text: s.title }, ...textBlocks(s.text)])], log);
    if (task.shareLink) shared = await google.shareAnyoneWithLink(page, docUrl, log);
  }
  const rows = [];
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const x = by.get(i + 1) || {};
    const body = cell(x.body).split('{{DOC_LINK}}').join(docUrl || (task.website || ''));
    let status = '';
    if (!c.email) status = 'No email in the list';
    else if (!google_) status = 'Not saved: Google not connected';
    else {
      steps++;
      status = await google.gmailDraft(page, { to: c.email, subject: cell(x.subject), body }, log).catch((err) => `Not saved: ${short(err.message, 60)}`);
    }
    rows.push([c.name, c.website, c.email, cell(x.what), cell(x.subject), body, status]);
  }
  const drafts = rows.filter((r) => /^Draft saved/.test(r[6])).length;
  const answer = `Researched ${clients.length} client(s)${docUrl ? ', wrote the agency introduction document' : ''} and ${drafts ? `saved ${drafts} personalized email draft(s) in Gmail for you to review` : 'wrote a personalized email for each'}.` +
    (docUrl ? `\n\nGoogle Doc: ${docUrl}${task.shareLink ? (shared ? ' (anyone with the link can view)' : ' (link sharing could not be turned on: share it yourself before sending)') : ' (private: share it before sending the emails)'}` : '');
  log.success(answer.split('\n')[0]);
  return result(task, docUrl || task.website || '', answer, ['Client', 'Website', 'Email', 'What they do', 'Email subject', 'Email body', 'Draft status'], rows, steps, page, usage, model, docUrl ? { links: [{ label: 'Google Doc', url: docUrl }] } : {});
}

// ---------------------------------------------------------------- proposal builder

async function proposalBuilder(page, task, log, { AgentError }) {
  needAi(AgentError, 'proposal builder agent');
  const model = aiModel();
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const google_ = await googleCheck(page, log, 'the Google Doc and the Gmail draft');
  let steps = 0;

  let pricing = task.pricingText || '';
  if (task.pricingSheet) {
    if (!google_) throw new AgentError('LOGIN_REQUIRED', 'Connect Google first to read the pricing sheet, or paste the prices instead.');
    steps++;
    log.action('Reading the pricing sheet');
    const rows = await google.readSheet(page, task.pricingSheet);
    if (!rows.length) throw new AgentError('NOT_FOUND', 'The pricing sheet could not be read: check the link and that this Google account can open it.');
    pricing = rows.slice(0, 60).map((r) => r.join(' | ')).join('\n');
    log.info(`Pricing: ${rows.length - 1} row(s)`);
  }

  log.action('Writing the proposal');
  const written = await askJson(
    model,
    'You write client proposals for a digital marketing agency. Use only the requirements, services, prices and timeline given (never invent prices; when a service has no price say "To be confirmed"). ' +
      'Sections: Overview (the client and what they want), Objectives (measurable where possible), Services and scope, Deliverables, Timeline (dated milestones from the timeline given), Investment (the pricing), Why us, Next steps. ' +
      'Also the pricing as rows: service, what is included, price (exactly as in the pricing), billing (one-time / monthly). ' +
      `And a short email to the client (subject under 60 characters; body 4-6 sentences, friendly and professional, with the line "Here is the proposal: {{DOC_LINK}}" and a call to review it and book a short call). ` +
      'Reply with JSON: {"sections": [{"title": "...", "text": "..."}], "pricing": [{"service": "", "included": "", "price": "", "billing": ""}], "total": "", "subject": "", "body": ""}.',
    `Agency: ${task.agencyName}\nClient: ${task.clientName}\nClient requirements: ${task.requirements}\nServices to include: ${task.services}\nTimeline: ${task.timeline || 'not given'}\n\nPricing:\n${pricing || '(no prices given)'}`,
    AgentError,
  );
  addUsage(usage, written.usage);
  const sections = (Array.isArray(written.data.sections) ? written.data.sections : []).map((x) => ({ title: cell(x.title), text: cell(x.text) })).filter((x) => x.title && x.text);
  const prices = (Array.isArray(written.data.pricing) ? written.data.pricing : []).map((p) => [cell(p.service), cell(p.included), cell(p.price), cell(p.billing)]).filter((p) => p[0]);
  if (!sections.length) throw new AgentError('AI_FAILED', 'The AI did not write the proposal. Run the task again.');

  let docUrl = '';
  let draft = '';
  if (google_) {
    steps++;
    const blocks = [{ type: 'h1', text: task.docName }, { type: 'p', text: `Prepared for ${task.clientName} by ${task.agencyName}, ${today()}` }];
    sections.forEach((s) => {
      blocks.push({ type: 'h2', text: s.title }, ...textBlocks(s.text));
      if (/investment|pricing|price/i.test(s.title) && prices.length) {
        prices.forEach((p) => blocks.push({ type: 'li', text: `${p[0]}: ${p[2] || 'To be confirmed'}${p[3] ? ` (${p[3]})` : ''}${p[1] ? ` - ${p[1]}` : ''}` }));
        if (cell(written.data.total)) blocks.push({ type: 'p', text: `Total: ${cell(written.data.total)}` });
      }
    });
    docUrl = await google.createDoc(page, task.docName, blocks, log);
    if (task.shareLink) await google.shareAnyoneWithLink(page, docUrl, log);
    if (task.clientEmail) {
      steps++;
      draft = await google.gmailDraft(page, { to: task.clientEmail, subject: cell(written.data.subject), body: cell(written.data.body).split('{{DOC_LINK}}').join(docUrl) }, log).catch((err) => `Not saved: ${short(err.message, 60)}`);
    }
  }
  const answer = `Proposal for ${task.clientName} written${docUrl ? ' as a Google Doc' : ''}${/^Draft saved/.test(draft) ? `, and an email draft to ${task.clientEmail} is in Gmail (Drafts) for you to review` : ''}.` +
    `${cell(written.data.total) ? ` Total: ${cell(written.data.total)}.` : ''}${docUrl ? `\n\nGoogle Doc: ${docUrl}` : ''}${!google_ ? '\n\nGoogle is not connected, so the document and email were not created; the proposal text is below.' : ''}`;
  log.success(answer.split('\n')[0]);
  const rows = prices.length ? prices : sections.map((s) => [s.title, s.text, '', '']);
  return result(task, docUrl || '', answer, prices.length ? ['Service', 'Included', 'Price', 'Billing'] : ['Section', 'Content', '', ''], rows, steps, page, usage, model, {
    ...(docUrl ? { links: [{ label: 'Google Doc', url: docUrl }] } : {}),
    proposal: sections,
    email: { to: task.clientEmail, subject: cell(written.data.subject), body: cell(written.data.body).split('{{DOC_LINK}}').join(docUrl || '(document link)'), status: draft },
  });
}

const HANDLERS = { product_report: productReport, lead_generation: leadGeneration, agency_outreach: agencyOutreach, proposal_builder: proposalBuilder };

/** Runs one of the agents above (by task.type). */
function runAgency(page, task, log, helpers) {
  return HANDLERS[task.type](page, task, log, helpers);
}

module.exports = { runAgency, REPORT_SECTIONS, parseClients, clientsFromSheet };
