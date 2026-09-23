/**
 * planner.js
 * ---------------------------------------------------------------------------
 * The "brain" of the agent, powered by OpenAI.
 *
 *   planTask(prompt)      Natural language (English / Hindi / Hinglish, even rough notes) -> a Gmail
 *                         task. Writes a complete English email (subject + body, signed with
 *                         SENDER_NAME, or else the signed-in Gmail account's name) so the user
 *                         only has to say what they want.
 *   createSummarizer(...) Short English summary of search / inbox results.
 *
 * The browser work itself stays in agent.js (Playwright): OpenAI only decides
 * *what* to do and writes text, it never clicks anything.
 *
 * Without OPENAI_API_KEY the planner falls back to the rule-based parser in agent.js.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const { OpenAI, APIError, APIConnectionError } = require('openai');
const { parseCommand, validateTask, AgentError, senderName } = require('./agent');

const AI = {
  apiKey: process.env.OPENAI_API_KEY || '',
  // Any OpenAI-compatible service works: OpenAI (default), Google Gemini, Groq, a local Ollama… (see .env.example)
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  summarize: !/^(0|false|no|off)$/i.test(process.env.OPENAI_SUMMARIZE || 'true'),
};

let client = null;
function getClient() {
  if (!AI.apiKey) return null;
  if (!client) client = new OpenAI({ apiKey: AI.apiKey, baseURL: AI.baseURL, timeout: 45_000, maxRetries: 2 });
  return client;
}

/** For /health and the dashboard: is AI planning on, and which model? */
function aiStatus() {
  return {
    enabled: Boolean(AI.apiKey),
    model: AI.apiKey ? AI.model : null,
    summarize: Boolean(AI.apiKey) && AI.summarize,
    senderName: senderName() || null, // SENDER_NAME, else the signed-in Gmail account's name
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * JSON schema for OpenAI Structured Outputs. With `strict: true` the model can
 * only answer in exactly this shape. Every field is required; unused ones are
 * returned empty.
 */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'to', 'subject', 'body', 'query', 'limit', 'summary', 'question'],
  properties: {
    action: {
      type: 'string',
      enum: ['send_email', 'draft_email', 'search_email', 'read_inbox', 'needs_info', 'unsupported'],
    },
    to: { type: 'array', items: { type: 'string' }, description: 'Recipients exactly as the user gave them (email addresses or names).' },
    subject: { type: 'string' },
    body: { type: 'string', description: 'The full email text: greeting, 3+ short paragraphs (90-180 words unless the user asked for short), closing and sign-off.' },
    query: { type: 'string', description: 'Gmail search query using Gmail operators.' },
    limit: { type: 'integer', description: 'How many emails to return for search/inbox, 1-50.' },
    summary: { type: 'string', description: 'One short English sentence describing what the agent will do.' },
    question: { type: 'string', description: 'For needs_info/unsupported: in English, what is missing or why. Otherwise empty.' },
  },
};

function systemPrompt() {
  const now = new Date();
  const name = senderName(); // SENDER_NAME from .env, else the signed-in Gmail account's name
  const signOff = name
    ? `End with a closing line and the sender's name on the next line, e.g. "Best regards,\\n${name}".`
    : 'End with a short closing line such as "Best regards," or "Thanks,". Do not add any name or placeholder like [Your Name] (Gmail adds the signature).';

  return `You turn a user's request into ONE Gmail task for a browser agent, doing as much as possible yourself so the user types as little as possible.
The user may write in English, Hindi or Hinglish, often briefly or roughly. You always answer in English.
Today is ${now.toDateString()}.

The agent can ONLY do these actions in the user's own Gmail:
- send_email: compose and send an email.
- draft_email: compose an email and save it to Drafts (use when the user says draft / save / don't send / "rakh do").
- search_email: search the mailbox and list results.
- read_inbox: list the latest emails in the inbox.

RECIPIENTS ("to"):
- Use ONLY addresses or names the user actually gave. NEVER invent or guess an email address.
- If the user gave a name and an address, use the address. A name alone is fine (Gmail finds the contact), so keep it, e.g. ["Rahul"].
- If no recipient at all is given for an email, use "needs_info".

WRITING THE EMAIL (subject + body). This is the most important part; write it like a skilled professional assistant:
- Always produce a complete, ready-to-send email in clear, natural, grammatically correct English, even when the user wrote Hindi/Hinglish or rough notes.
- Keep every fact the user gave (names, dates, days, times, amounts, places, reasons) exactly right. Never add facts, promises or details the user did not give.
- Resolve relative dates only in wording ("tomorrow", "this Friday"); do not convert them to a date unless the user gave one.
- Subject: short and specific (3-8 words), e.g. "Meeting moved to 4 PM tomorrow". No "Re:" and no emojis.
- Body structure (blank line between each part):
  1. Greeting with the recipient's first name if the user wrote it, or if the part before "@" is clearly one first name
     (rahul@…, priya.sharma@…) → "Hi Rahul,". If the address is unclear (e.g. "paretarenu6@"), use "Hello,". Never guess.
  2. A short friendly opener, e.g. "I hope you are doing well."
  3. The main message in the first sentences of the next paragraph, clearly and politely.
  4. A second paragraph with helpful, natural next steps that fit the situation WITHOUT inventing facts. Examples:
     - meeting moved/rescheduled: ask them to update their calendar, and to reply if the new time doesn't work so another slot can be found; apologize for the change.
     - meeting cancelled: apologize for the inconvenience and say an update/new time will follow.
     - leave / absence: mention pending work will be handed over and that you can be reached for anything urgent; offer more information if needed.
     - running late: apologize and say you'll be there as soon as possible.
     - report / file / work done: invite them to review it and share questions or changes.
     - request: say what you need and thank them in advance.
  5. A courteous closing sentence (e.g. "Thank you for your understanding." / "Thanks in advance.").
  6. The sign-off. ${signOff}
- Tone: match the situation. Formal and respectful for HR, a manager, a client, a teacher or a leave/job request; warm and casual for friends and family.
- Length: the body MUST be a complete, well-developed email of 90-180 words with at least 3 short paragraphs between the greeting and the sign-off, even when the user wrote only a few words. Count the words; never go under 90. Only if the user explicitly asks for a short/brief/one-line email, keep it under 50 words.
- Language: English, unless the user explicitly asks for another language.
- Word-for-word: ONLY if the user explicitly asks ("exactly", "as it is", "word for word", "same text") or puts the message in quotes. Then use their text unchanged, but still add the greeting and closing if they are missing.

SEARCH (search_email): turn the request into a Gmail query with operators like from:, to:, subject:, is:unread, has:attachment, newer_than:7d, after:YYYY/MM/DD.
LIMIT: the number the user asked for, else 5 (max 50). For email actions use 5.
SUMMARY: one short English sentence saying what will happen, e.g. "Send Rahul an email that tomorrow's meeting moved to 4 PM."
UNSUPPORTED: anything else (other websites, Google Maps, shopping, deleting emails, several different tasks at once) -> "unsupported", and in "question" explain briefly in English what the agent can do instead.
Unused fields must be empty strings / an empty array; limit 5.`;
}

/** Used when a service has no strict-schema support: the same fields, explained in words. */
const JSON_ONLY_INSTRUCTIONS = `Reply with ONLY one JSON object (no markdown, no extra text) with exactly these keys:
{"action": one of "send_email" | "draft_email" | "search_email" | "read_inbox" | "needs_info" | "unsupported",
 "to": array of strings, "subject": string, "body": string, "query": string, "limit": integer,
 "summary": string, "question": string}`;

/** Pulls the JSON object out of a reply (some models wrap it in ```json fences). */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

/** Fills in missing/odd fields so a looser (non-strict) answer has the same shape as a strict one. */
function normalizePlan(p) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    action: str(p.action),
    to: Array.isArray(p.to) ? p.to.filter((x) => typeof x === 'string') : typeof p.to === 'string' && p.to ? [p.to] : [],
    subject: str(p.subject),
    body: str(p.body),
    query: str(p.query),
    limit: Number.isInteger(p.limit) ? p.limit : parseInt(p.limit, 10) || 5,
    summary: str(p.summary),
    question: str(p.question),
  };
}

/** Converts OpenAI SDK errors into AgentErrors the dashboard understands. */
function toAgentError(err) {
  if (err instanceof AgentError) return err;
  if (err instanceof APIConnectionError) {
    return new AgentError('AI_UNREACHABLE', 'Could not reach OpenAI. Check the internet connection and try again.');
  }
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      return new AgentError('AI_AUTH', 'The AI API key is invalid. Check OPENAI_API_KEY (and OPENAI_BASE_URL) in backend/.env.');
    }
    if (err.status === 429 && /quota/i.test(`${err.code} ${err.message}`)) {
      return new AgentError('AI_QUOTA', 'Your OpenAI account has no credit left. Add billing at platform.openai.com.');
    }
    if (err.status === 429) return new AgentError('AI_RATE_LIMIT', 'OpenAI is rate-limiting requests. Wait a moment and try again.');
    if (err.status === 404) {
      return new AgentError('AI_MODEL', `The OpenAI model "${AI.model}" is not available for this key. Change OPENAI_MODEL in backend/.env.`);
    }
    return new AgentError('AI_ERROR', `OpenAI error (${err.status ?? 'unknown'}): ${err.message}`);
  }
  return new AgentError('AI_ERROR', `OpenAI error: ${err.message}`);
}

/** Maps the model's plan onto the agent's task shape (validated by validateTask). */
function planToTask(plan) {
  const limit = Math.min(50, Math.max(1, Number.isInteger(plan.limit) ? plan.limit : 5));
  switch (plan.action) {
    case 'send_email':
    case 'draft_email':
      return {
        type: 'send_email',
        to: plan.to,
        subject: plan.subject,
        body: plan.body,
        sendMode: plan.action === 'draft_email' ? 'draft' : 'send',
      };
    case 'search_email':
      return { type: 'search_email', query: plan.query, limit };
    case 'read_inbox':
      return { type: 'read_inbox', limit };
    default:
      return null;
  }
}

/** Fallback one-liner when AI is off. */
function describeTask(task) {
  if (task.type === 'send_email') return `${task.sendMode === 'draft' ? 'Save a draft' : 'Send an email'} to ${task.to.join(', ')}`;
  if (task.type === 'search_email') return `Search Gmail for "${task.query}"`;
  return `Read the latest ${task.limit} inbox emails`;
}

/**
 * Plans a task from a natural-language prompt.
 * Returns { ai, model, task, summary }. Throws AgentError (NEEDS_INFO, UNSUPPORTED_TASK, AI_*).
 */
async function planTask(prompt) {
  const openai = getClient();
  if (!openai) {
    const task = parseCommand(prompt); // rule-based fallback
    return { ai: false, model: null, task, summary: describeTask(task) };
  }

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: prompt },
  ];
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: AI.model,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'gmail_task', strict: true, schema: PLAN_SCHEMA } },
    });
  } catch (err) {
    // Some OpenAI-compatible services don't support strict JSON schemas. Retry with plain JSON mode
    // and describe the fields in the prompt instead; the answer is still checked below.
    if (!(err instanceof APIError && err.status === 400)) throw toAgentError(err);
    try {
      completion = await openai.chat.completions.create({
        model: AI.model,
        messages: [
          { role: 'system', content: `${systemPrompt()}\n\n${JSON_ONLY_INSTRUCTIONS}` },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      });
    } catch (retryErr) {
      throw toAgentError(retryErr);
    }
  }

  const message = completion.choices[0] && completion.choices[0].message;
  if (!message || message.refusal) {
    throw new AgentError('UNSUPPORTED_TASK', (message && message.refusal) || 'The AI could not plan this request.');
  }

  let plan;
  try {
    plan = normalizePlan(JSON.parse(extractJson(message.content)));
  } catch {
    throw new AgentError('AI_ERROR', 'The AI returned an unreadable plan. Please try again.');
  }

  if (plan.action === 'needs_info') {
    throw new AgentError('NEEDS_INFO', plan.question || 'Some information is missing. Please add it to your request.');
  }
  const task = planToTask(plan);
  if (!task) {
    throw new AgentError('UNSUPPORTED_TASK', plan.question || 'The agent can only send/draft emails, search Gmail or read the inbox.');
  }
  if (task.type === 'send_email') task.body = cleanBody(task.body);
  if (task.type === 'send_email' && !task.to.length) {
    throw new AgentError('NEEDS_INFO', 'Who should the email go to? Add an email address to your request.');
  }
  // Models sometimes ignore the length rule; one extra pass makes the email fuller (same facts).
  if (task.type === 'send_email' && wordCount(task.body) < MIN_BODY_WORDS && !WANTS_SHORT.test(prompt)) {
    task.body = await expandBody(openai, prompt, task).catch(() => task.body);
  }
  return { ai: true, model: AI.model, task: validateTask(task), summary: plan.summary || describeTask(task) };
}

const MIN_BODY_WORDS = 70;
const WANTS_SHORT = /\b(short|brief|one[- ]line|quick|chhota|chota|kam shabd)\b/i;
const wordCount = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

/** Rewrites a too-short email into a fuller one without adding facts. Returns the new body. */
async function expandBody(openai, prompt, task) {
  const completion = await openai.chat.completions.create({
    model: AI.model,
    messages: [
      {
        role: 'system',
        content:
          'You improve email drafts. Rewrite the draft into a complete, polite, professional email of 100-160 words in English, ' +
          'with a greeting, a friendly opener, 2-3 short paragraphs, a courteous closing line and the same sign-off. ' +
          'Keep every fact exactly (names, dates, times, requests). Do NOT invent new facts, promises, numbers or names. ' +
          'Keep the greeting exactly as in the draft. ' +
          (senderName()
            ? `End with "Best regards," and "${senderName()}" on the next line. `
            : 'End with "Best regards," and NOTHING after it: no name and no placeholder such as [Your Name]. ') +
          'Return only the email body text, no subject line and no explanations.',
      },
      { role: 'user', content: `User's request: ${prompt}\n\nSubject: ${task.subject}\n\nDraft:\n${task.body}` },
    ],
  });
  const text = cleanBody((completion.choices[0] && completion.choices[0].message.content) || '');
  return wordCount(text) > wordCount(task.body) ? text : task.body;
}

/**
 * Last safety net before an AI-written email is typed into Gmail: removes template
 * placeholders like "[Your Name]" / "[Recipient]" and trailing spaces.
 */
function cleanBody(body) {
  return String(body)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]*\[(?:your|my|recipient'?s?|sender'?s?|company|insert)[^\]\n]*\][ \t]*/gi, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Summaries of search / inbox results
// ---------------------------------------------------------------------------

/**
 * Hook for runBrowserAgent's `postProcess`: adds `result.summary` for search and
 * inbox results. Failures only log a warning, the run itself still succeeds.
 * Note: this sends sender names, subjects and snippets of those emails to OpenAI.
 */
function createSummarizer(userPrompt) {
  return async (task, result, log) => {
    const openai = getClient();
    const rows = (result && (result.results || result.emails)) || [];
    if (!openai || !AI.summarize || !rows.length) return result;

    log.action('Asking AI to summarize the emails');
    try {
      const completion = await openai.chat.completions.create({
        model: AI.model,
        messages: [
          {
            role: 'system',
            content:
              'Summarize these Gmail results for the user in 2-4 short bullet points ("- " prefix), in clear English. ' +
              'Point out anything that looks important, urgent or needs a reply. Plain text only, no headings.',
          },
          {
            role: 'user',
            content: `User's request: ${userPrompt || (task.type === 'search_email' ? `search "${task.query}"` : 'read my inbox')}\n\nEmails (JSON):\n${JSON.stringify(
              rows.map(({ from, fromEmail, subject, snippet, date, unread }) => ({ from, fromEmail, subject, snippet, date, unread }))
            )}`,
          },
        ],
      });
      const summary = (completion.choices[0] && completion.choices[0].message.content || '').trim();
      if (summary) {
        log.success('AI summary ready');
        return { ...result, summary };
      }
    } catch (err) {
      log.warn(`AI summary skipped: ${toAgentError(err).message}`);
    }
    return result;
  };
}

module.exports = { planTask, createSummarizer, aiStatus };
