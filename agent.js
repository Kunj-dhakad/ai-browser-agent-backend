/**
 * agent.js
 * ---------------------------------------------------------------------------
 * Playwright-powered browser agent.
 *
 *   runBrowserAgent(prompt, { onLog })
 *     1. Interprets a natural-language prompt into a structured task.
 *     2. Opens Gmail in a *persistent* Chromium profile (login survives restarts).
 *     3. Executes the task (compose + send, search, read inbox) typing like a human.
 *     4. Returns step-by-step logs (and streams each one through `onLog`).
 *
 * CLI helpers:
 *   node agent.js --login            Open a visible browser so you can sign in to Google once.
 *   node agent.js "<prompt>"         Run a single command from the terminal.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { chromium, errors: playwrightErrors } = require('playwright');
const { users: userStore } = require('./db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const envBool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);
const envInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const CONFIG = {
  headless: envBool(process.env.HEADLESS, true),
  // Multi-user: each user gets their own browser profile folder under PROFILES_DIR.
  profilesDir: path.resolve(process.env.PROFILES_DIR || './data/profiles'),
  maxBrowsers: Math.max(1, envInt(process.env.MAX_BROWSERS, 10)), // browsers open at the same time
  idleCloseMs: Math.max(1, envInt(process.env.BROWSER_IDLE_MINUTES, 5)) * 60 * 1000, // close an unused browser after this
  // The single-user profile from before multi-user mode (moved to the first admin; see scripts/add-user.js).
  legacyProfileDir: path.resolve(process.env.USER_DATA_DIR || './.browser-profile'),
  channel: process.env.BROWSER_CHANNEL || undefined, // e.g. "chrome" to use installed Google Chrome
  typingDelayMs: envInt(process.env.TYPING_DELAY_MS, 80),
  slowMoMs: envInt(process.env.SLOW_MO_MS, 0),
  actionTimeoutMs: envInt(process.env.ACTION_TIMEOUT_MS, 30000),
  dryRun: envBool(process.env.DRY_RUN, false),
  screenshotDir: path.resolve('./screenshots'),
  // 16:9-ish like a laptop screen, so the dashboard preview fills its panel with no empty bars.
  viewport: { width: 1366, height: 768 },
  // Live browser preview (Chrome DevTools screencast -> SSE -> dashboard)
  screencast: {
    enabled: envBool(process.env.SCREENCAST_ENABLED, true),
    quality: envInt(process.env.SCREENCAST_QUALITY, 80), // JPEG quality 1-100 (below ~75 small text gets blurry)
    maxWidth: envInt(process.env.SCREENCAST_MAX_WIDTH, 1366), // = viewport width: send frames at native size
    maxFps: envInt(process.env.SCREENCAST_MAX_FPS, 8), // per viewer, enforced in server.js
  },
};

const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';

/**
 * Gmail DOM selectors, kept in one place because Gmail changes its markup
 * occasionally. Each entry lists several fallbacks, most specific first.
 * Attribute-based selectors are preferred over English aria-labels so the
 * agent keeps working when the Gmail UI language is not English.
 */
const SELECTORS = {
  composeButton: 'div[gh="cm"]',
  subjectInput: 'input[name="subjectbox"]',
  toInput: 'input[peoplekit-id], input[aria-label*="recipient" i], textarea[name="to"]',
  bodyEditor: 'div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]',
  sendButton: 'div[role="button"].aoO, div[role="button"][data-tooltip^="Send"]',
  contactSuggestion: '[role="listbox"] [role="option"]:visible',
  errorDialog: 'div[role="alertdialog"]:visible',
  toast: 'div[role="alert"]:visible, span.bAq:visible',
  searchInput: 'input[name="q"]',
  mailRow: 'tr.zA:visible',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error with a machine-readable `code` so the API/frontend can react to it. */
class AgentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Creates a step logger. Every entry is stored (for the final JSON response)
 * and forwarded to `onLog` immediately (for live streaming over SSE).
 */
function createLogger(onLog) {
  const logs = [];
  let step = 0;

  const write = (level, message, data) => {
    const entry = {
      step: ++step,
      time: new Date().toISOString(),
      level, // "info" | "action" | "success" | "warn" | "error"
      message,
      ...(data !== undefined ? { data } : {}),
    };
    logs.push(entry);
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[agent] #${entry.step} ${level.toUpperCase().padEnd(7)} ${message}`);
    }
    if (typeof onLog === 'function') {
      try {
        onLog(entry);
      } catch {
        // A broken listener (e.g. a disconnected client) must never kill the task.
      }
    }
    return entry;
  };

  return {
    logs,
    info: (msg, data) => write('info', msg, data),
    action: (msg, data) => write('action', msg, data),
    success: (msg, data) => write('success', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}

// ---------------------------------------------------------------------------
// Prompt interpretation (rule-based natural-language parser)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SUBJECT_KEYWORDS = ['subject line', 'subject', 'titled', 'title'];
const BODY_KEYWORDS = ['message', 'body', 'that says', 'saying', 'content', 'text'];
// Words that start a new "field" in a sentence; used to know where a value ends.
const FIELD_STOP = String.raw`(?:subject|titled|title|message|body|saying|that says|content|text)`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Converts smart quotes to plain quotes and trims. */
function normalizePrompt(prompt) {
  return prompt
    .replace(/[“”„″]/g, '"')
    .replace(/[‘’‚′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the value that follows one of `keywords`, e.g.
 *   subject 'Meeting'            -> Meeting
 *   message "Let's catch up"     -> Let's catch up   (apostrophes are fine)
 *   saying see you at 4          -> see you at 4     (unquoted fallback)
 */
function extractField(text, keywords) {
  const kw = `(?:${keywords.map(escapeRe).join('|')})`;
  const sep = String.raw`\s*(?:of|as|is|=|:|-)?\s*`;

  // 1) Quoted value. The closing quote only counts if it's followed by the end of
  //    the sentence or by another field, so "Let's" doesn't end the value early.
  const quoted = new RegExp(
    String.raw`\b${kw}\b${sep}(["'])([\s\S]*?)\1(?=\s*[,.;!?]?\s*(?:$|and\b|with\b|then\b|${FIELD_STOP}\b))`,
    'i'
  );
  const q = text.match(quoted);
  if (q) return q[2].trim();

  // 2) Unquoted value: runs until the next field keyword or the end.
  //    We take the *last* sensible match because "Send a message to John..."
  //    uses the word "message" as a noun rather than as a field label.
  const unquoted = new RegExp(
    String.raw`\b${kw}\b${sep}([^"'][\s\S]*?)(?=\s*[,;]?\s*(?:and\s+|with\s+)?(?:the\s+|a\s+)?${FIELD_STOP}\b|\s*$)`,
    'gi'
  );
  const candidates = [...text.matchAll(unquoted)]
    .map((m) => m[1].trim().replace(/[.]$/, ''))
    .filter((v) => v && !/^to\b/i.test(v));
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** Finds recipients: email addresses or contact names after "to" (or "email John ..."). */
function extractRecipients(text) {
  // Remove quoted segments so words inside the subject/body are never mistaken for recipients,
  // and ignore everything after "that / saying / about …" (the message itself: "moved to 4 PM"
  // must not turn "4 PM" into a recipient).
  const unquotedText = text
    .replace(/(["'])(?:(?!\1).)*\1(?=\s|$|[,.;])/g, ' ')
    .replace(/\s\b(?:that|saying|to say|(?:to\s+)?tell(?:ing)?\s+(?:him|her|them)|let(?:ting)?\s+(?:him|her|them)\s+know|about|regarding|ki)\b[\s\S]*$/i, ' ');

  // Any email address in the command part is a recipient: "Email a@b.com …", "… to a@b.com and c@d.com".
  const addresses = unquotedText.match(EMAIL_RE);
  if (addresses) return [...new Set(addresses)];

  const segmentMatch =
    unquotedText.match(
      /\bto\s+([\s\S]+?)(?=\s+(?:with|saying|about|regarding|that|and\s+(?:say|tell|ask|the\s+subject|subject|message|body))\b|\s*[,;:]\s*(?:subject|message|body|saying)\b|\s+(?:subject|message|body)\b|[.!?]?\s*$)/i
    ) ||
    // "Email John saying hi" / "mail john@x.com ..."
    unquotedText.match(
      /^(?:please\s+)?(?:e-?mail|mail|message|tell|inform|notify|let)\s+(?!to\b|an?\b|the\b)([\s\S]+?)(?=\s+(?:with|saying|about|regarding|that|subject|message|body|know)\b|[.!?]?\s*$)/i
    );
  if (!segmentMatch) return [];

  const segment = segmentMatch[1].trim();
  const emails = segment.match(EMAIL_RE);
  if (emails) return [...new Set(emails)];

  // Contact names: "John", "John Smith", "John and Sarah", "John, Sarah"
  return segment
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((n) => n.replace(/^(?:my|our)\s+/i, '').trim())
    .filter((n) => n && n.length <= 60);
}

// --- Filling in a missing subject / message (used when the AI is off) ---------

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The message itself: "that …", "saying …", "tell him …", "let her know …", "ki …".
const SAID_RE = /\b(?:that|saying|to say|(?:to\s+)?tell(?:ing)?\s+(?:him|her|them)|let(?:ting)?\s+(?:him|her|them)\s+know|ki)\b\s+([\s\S]+)$/i;
// "Tell / inform / notify <recipient> <message>" without "that": everything after the recipient.
const TELL_RE = /^(?:please\s+)?(?:tell|inform|notify)\s+(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\S+)\s+(?!about\b|regarding\b)([\s\S]+)$/i;
// Only the topic: "about …", "regarding …".
const ABOUT_RE = /\b(?:about|regarding)\b\s+([\s\S]+)$/i;

const tailOf = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').replace(/[\s.]+$/, '') : '';
};

/** Fallback topic: the sentence minus the command words and recipients ("a leave request for this Friday"). */
function extractTopic(text, recipients) {
  // (?=\s) keeps "a" in "Email a@b.com" from being taken as the article "a".
  let t = text.replace(/^(?:please\s+)?(?:send|compose|write|draft|e-?mail|mail)\b(?:\s+(?:an?|the)(?=\s))?(?:\s+(?:e-?mail|mail|message|note)\b)?/i, '');
  for (const r of recipients) {
    t = t.replace(new RegExp(String.raw`(?:\bto\s+)?${escapeRe(r)}`, 'gi'), ' ');
  }
  t = t.replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  if (t.replace(/^(?:an?|the)\s+/i, '').length < 3) return '';
  // Reads naturally after "I'm writing to you about …".
  return /^(?:an?|the|my|our|your)\s/i.test(t) ? t : `the ${t}`;
}

/** A short subject from a sentence: first sentence, at most 8 words, no leading article or trailing punctuation. */
function subjectFrom(sentence) {
  const first = sentence.split(/(?<=[.!?])\s|\n/)[0].replace(/^(?:the|an?)\s+/i, '');
  const words = first.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return capitalize(words.replace(/[\s.,;:!?-]+$/, ''));
}

// Shared mailboxes and roles are not people's names ("hr@…" -> "Hello,", not "Hi Hr,").
const NOT_A_NAME = new Set(
  'hr info admin support contact sales team office hello help mail noreply no reply jobs careers billing accounts account service services enquiry enquiries inquiry marketing boss manager ceo hiring recruitment'.split(' ')
);

/**
 * First name for the greeting: "rahul.sharma@x.com" -> "Rahul", "John Smith" -> "John".
 * Only when it clearly looks like a first name: a long run of letters like "paretarenu6@"
 * may be two names joined, so that gets "Hello," rather than a wrong guess.
 */
function greetingName(recipients) {
  if (recipients.length !== 1) return '';
  const r = recipients[0];
  if (!r.includes('@')) {
    const first = (r.split(/\s+/)[0] || '').toLowerCase();
    return /^[a-z]{2,20}$/.test(first) && !NOT_A_NAME.has(first) ? capitalize(first) : '';
  }
  const local = r.split('@')[0];
  const token = (local.split(/[._\-+\d]/)[0] || '').toLowerCase();
  const hasSeparator = /[._-]/.test(local);
  const looksLikeName = hasSeparator ? /^[a-z]{2,12}$/.test(token) : /^[a-z]{2,8}$/.test(token);
  return looksLikeName && !NOT_A_NAME.has(token) ? capitalize(token) : '';
}

/**
 * What kind of email it is decides the helpful follow-up lines, the closing and a subject prefix.
 * The lines only add polite, generic next steps. They never add facts the user didn't give.
 * Order matters: the first match wins.
 */
const MEETING = String.raw`(?:meeting|call|sync|stand-?up|discussion|appointment|interview|session|demo|class)`;
const CHANGED = String.raw`(?:moved|shifted|rescheduled|postponed|changed|preponed|pushed|delayed)`;
const INTENTS = [
  {
    test: new RegExp(String.raw`\b${MEETING}\b[\s\S]*\b(?:cancel(?:l?ed)?|called off)\b|\b(?:cancel(?:l?ed)?|called off)\b`, 'i'),
    lines: ['I apologize for any inconvenience this may cause.', 'I will share an updated plan with you as soon as possible.'],
    closing: 'Thank you for your understanding.',
    subjectPrefix: 'Update: ',
  },
  {
    test: new RegExp(String.raw`\b${MEETING}\b[\s\S]*\b${CHANGED}\b|\b${CHANGED}\b[\s\S]*\b${MEETING}\b`, 'i'),
    lines: [
      'Please update your calendar accordingly.',
      'If the new time does not work for you, just let me know and we can find another slot that suits everyone.',
      'Apologies for any inconvenience caused by the change.',
    ],
    closing: 'Thank you for your understanding.',
    subjectPrefix: 'Update: ',
  },
  {
    // Leave/late come before "done/ready": in "please finish your work today, I am on leave" the leave is the news.
    test: /\b(?:leave|day off|off on|holiday|vacation|sick|unwell|absent|work(?:ing)? from home|wfh|not (?:be )?(?:available|coming))\b/i,
    lines: [
      'I will make sure any pending work is handed over beforehand, and I will be reachable by email for anything urgent.',
      'Please let me know if you need any further information from my side.',
    ],
    closing: 'Thank you for your understanding.',
    subject: 'Leave Notice',
  },
  {
    test: /\b(?:late|running behind|stuck in traffic|delay)\b/i,
    lines: ['I apologize for the inconvenience and will be there as soon as I can.'],
    closing: 'Thank you for your patience.',
    subject: 'Running Late',
  },
  {
    // Before the generic meeting check, so "the demo is ready" is about something ready, not a meeting time.
    test: /\b(?:report|files?|documents?|attached|attachment|uploaded|shared|ready|completed|done|finished|sent)\b/i,
    lines: ['Please take a look when you get a chance.', 'Let me know if you have any questions or if anything needs to be changed.'],
    closing: 'Thank you.',
  },
  {
    test: new RegExp(String.raw`\b${MEETING}\b`, 'i'),
    lines: ['Please let me know if this works for you, or if you would like to suggest a different time.', 'Looking forward to speaking with you.'],
    closing: 'Thank you.',
  },
  {
    test: /\b(?:thank|thanks|grateful|appreciate)\b/i,
    lines: ['I really appreciate your time and support.'],
    closing: 'Thanks again.',
  },
  {
    test: /\b(?:remind|reminder|deadline|due|don'?t forget)\b/i,
    lines: ['Please make sure it is taken care of on time, and let me know if you need any help.'],
    closing: 'Thank you.',
  },
  {
    test: /\b(?:invoice|payment|paid|pay|bill|amount|fee)\b/i,
    lines: ['Please let me know if you need any additional details to process this.'],
    closing: 'Thank you.',
  },
];
const DEFAULT_INTENT = { lines: ['Please let me know if you have any questions or need any further details.'], closing: 'Thank you.' };

const intentOf = (text) => INTENTS.find((i) => i.test.test(text)) || DEFAULT_INTENT;

/** "Tomorrow's meeting …" -> "tomorrow's meeting …" (keeps "I", names like "Rahul", acronyms like "PM"). */
function lowerFirst(s) {
  const word = s.split(/\s/)[0];
  if (word === 'I' || /^I'/.test(word) || /^[A-Z]{2,}/.test(word)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const endSentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * Light clean-up of quickly typed text (no AI): common short forms and typos, "i" -> "I",
 * "i am leave" -> "I am on leave", and a sentence break before "I am / I will …".
 * It can't truly rewrite broken English; that needs the AI (see planner.js).
 */
function tidy(text) {
  let t = ` ${text.trim()} `
    .replace(/\s+/g, ' ')
    .replace(/\b(?:pl[sz]+|ple+a?[sc]e?|plase|pleas)\b/gi, 'please')
    .replace(/\b(?:thx|thnx|thanx|thanku|thank u)\b/gi, 'thanks')
    .replace(/\b(?:tmrw|tmr|tomm?orr?ow)\b/gi, 'tomorrow')
    .replace(/\btday\b/gi, 'today')
    .replace(/\bur\b/gi, 'your')
    .replace(/\bu\b/gi, 'you')
    .replace(/\b(?:im|i m)\b/gi, "I'm")
    .replace(/\bi\b/g, 'I')
    .replace(/\bI(?: am|'m)(?: on)? leave\b/gi, 'I am on leave')
    .replace(/\bdone (your|the|my|this|that) work\b/gi, 'complete $1 work')
    .replace(/\bplease (today|tomorrow|now) ([^.!?]+?)(?=\s+I\b|[.!?]|\s*$)/gi, 'please $2 $1')
    .trim();
  // Start a new sentence at "I am / I will / I'm …" when the user ran two thoughts together.
  t = t.replace(/([a-z0-9])\s+(?=I(?: am| will| have| was| can| won't|'m|'ll)\b)/g, '$1. ');
  return t
    .split(/(?<=[.!?])\s+/)
    .map((s) => capitalize(s.trim()))
    .filter(Boolean)
    .join(' ');
}

/**
 * Writes a complete email around the user's words: greeting, a friendly opener, the message,
 * helpful next steps for this kind of email, a closing line and the sign-off.
 * content: { message } the user's own words (kept as a sentence), { said } what to tell them
 * ("that …"), { topic } what it is about, or { subject } only.
 */
function composeBody(recipients, content) {
  const message = content.message && tidy(content.message);
  const said = content.said && tidy(content.said);
  const { topic, subject } = content;
  const name = greetingName(recipients);
  const core = (message || said || topic || subject || '').trim();
  const intent = intentOf(core);

  let main;
  if (message) {
    main = endSentence(message);
  } else if (said && /[.!?]\s/.test(said)) {
    // Several sentences ("Please complete your work today. I am on leave."): keep them as they are.
    main = endSentence(said);
  } else if (said) {
    const request = said.match(/^(?:please\s+|kindly\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?([\s\S]+)$|^(?:please|kindly)\s+([\s\S]+)$/i);
    main = request
      ? `Could you please ${(request[1] || request[2]).replace(/[.?!]+$/, '')}?`
      : endSentence(`I wanted to let you know that ${lowerFirst(said)}`);
  } else {
    main = endSentence(`I am writing to you regarding ${lowerFirst(topic || subject)}`);
  }
  const followUps = message || said || intent !== DEFAULT_INTENT
    ? intent.lines
    : ['Could we find some time to discuss this? Please let me know what works best for you.'];

  const sender = ''; // the user's name is added under "Best regards," at run time (signBody)
  return [
    name ? `Hi ${name},` : 'Hello,',
    'I hope you are doing well.',
    main,
    followUps.join(' '),
    intent.closing,
    `Best regards,${sender ? `\n${sender}` : ''}`,
  ].join('\n\n');
}

/**
 * Subject: a fixed one for some kinds of email ("Leave Notice"), otherwise the first words of the
 * (cleaned) message, with a small prefix for updates ("Update: Tomorrow's meeting is moved to 4 PM").
 */
function composeSubject(content) {
  const clean = tidy(content);
  const intent = intentOf(clean);
  if (intent.subject) return intent.subject;
  const base = subjectFrom(clean);
  const prefix = intent.subjectPrefix || '';
  return prefix && !base.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix}${base}` : base;
}

/** Turns "emails from John about invoices" into Gmail search syntax: from:John invoices */
function toGmailQuery(raw) {
  return raw
    .replace(/\b(?:the\s+)?(?:top|last|latest|first|recent)\s+(?:\d{1,2}\s+)?/gi, '')
    .replace(/\b(?:all|my|the|any)\s+(?=(?:e-?mails?|mails?|messages?)\b)/gi, '')
    .replace(/\b(?:e-?mails?|mails?|messages?)\b/gi, '')
    .replace(/^\s*(?:for|with)\s+/i, '')
    .replace(/\bfrom\s+(\S+)/gi, 'from:$1')
    .replace(/\bto\s+(\S+@\S+)/gi, 'to:$1')
    .replace(/\b(?:about|regarding|containing|mentioning)\s+/gi, '')
    .replace(/\bunread\b/gi, 'is:unread')
    .replace(/\bin (?:my )?inbox\b/gi, 'in:inbox')
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Interprets a natural-language prompt into a structured task object.
 * Supported tasks:
 *   { type: 'send_email', to: string[], subject, body, sendMode: 'send' | 'draft' }
 *   { type: 'search_email', query, limit }
 *   { type: 'read_inbox', limit }
 *
 * Throws AgentError('UNSUPPORTED_TASK') when nothing matches.
 */
function parseCommand(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new AgentError('INVALID_PROMPT', 'Prompt must be a non-empty string.');
  }
  const text = normalizePrompt(prompt);
  const lower = text.toLowerCase();
  const limitMatch = lower.match(/\b(?:top|last|latest|first)\s+(\d{1,2})\b/);
  const limit = limitMatch ? Math.min(parseInt(limitMatch[1], 10), 50) : 5;

  // --- Send / draft an email --------------------------------------------------
  if (/\b(send|compose|write|draft|e-?mail|mail|reply|tell|inform|notify)\b|\blet\b[\s\S]*\bknow\b/i.test(text)) {
    const to = extractRecipients(text);
    if (to.length) {
      let subject = extractField(text, SUBJECT_KEYWORDS) || '';
      let body = extractField(text, BODY_KEYWORDS) || '';
      // Only a quoted message is sent word for word. An unquoted one ("saying I'll be late")
      // is what to say, so it gets written up into a full email below.
      const quoted = body && new RegExp(`["']${escapeRe(body)}["']`).test(text);
      let dictated = '';
      if (body && !quoted) {
        dictated = body;
        body = '';
      }

      // Fill in whatever the user left out, from what they did say
      // ("Email a@b.com that the meeting moved to 4 PM" -> subject + a short email).
      if (!subject || !body) {
        let said = dictated ? '' : tailOf(text, SAID_RE) || tailOf(text, TELL_RE);
        // A topic is only needed when there's no message; the sentence-remainder fallback
        // only when the user gave neither a subject nor a message.
        let topic = said || dictated ? '' : tailOf(text, ABOUT_RE) || (!subject && !body ? extractTopic(text, to) : '');
        // "Email a@b.com can you send the invoice" is a request, not a topic.
        const asked = topic.replace(/^the\s+/i, '');
        if (/^(?:please|kindly|can|could|would|will)\b/i.test(asked)) {
          said = asked;
          topic = '';
        }
        if (!subject && !body && !said && !dictated && !topic) {
          throw new AgentError(
            'INVALID_PROMPT',
            'What should the email say? Example: Email john@example.com that the meeting is moved to 4 PM'
          );
        }
        if (!subject) subject = composeSubject(body || dictated || said || topic);
        if (!body) body = composeBody(to, dictated ? { message: dictated } : said ? { said } : topic ? { topic } : { subject });
      }
      const isDraft = /\bdraft\b/i.test(text) && !/\bsend\b/i.test(text);
      return { type: 'send_email', to, subject, body, sendMode: isDraft ? 'draft' : 'send' };
    }
  }

  // --- Search -------------------------------------------------------------------
  const search = text.match(/\b(?:search(?:\s+for)?|find|look\s+(?:for|up)|show\s+me)\s+([\s\S]+)/i);
  if (search) {
    const quotedQuery = search[1].match(/["']([^"']+)["']/);
    const query = quotedQuery ? quotedQuery[1] : toGmailQuery(search[1]);
    // "Show me the latest 3 emails in my inbox" has no real filter: just read the inbox.
    if (!query || query === 'in:inbox') return { type: 'read_inbox', limit };
    return { type: 'search_email', query, limit };
  }

  // --- Read inbox ---------------------------------------------------------------
  if (/\b(open|check|read|show|list|what(?:'s| is))\b[\s\S]*\b(inbox|gmail|e-?mails?|mails?)\b/i.test(text)) {
    return { type: 'read_inbox', limit };
  }

  throw new AgentError(
    'UNSUPPORTED_TASK',
    'Sorry, I can only send/draft emails, search Gmail, or read the inbox. ' +
      "Example: Send an email to John with subject 'Meeting' and message 'Let's catch up at 4 PM'"
  );
}

/**
 * Validates a structured task sent by the dashboard form (no parsing needed,
 * so quotes/apostrophes in the message can never be misread).
 * Returns a clean task object or throws AgentError('INVALID_TASK').
 */
function validateTask(input) {
  const fail = (message) => {
    throw new AgentError('INVALID_TASK', message);
  };
  if (!input || typeof input !== 'object') fail('Task must be an object.');
  const str = (v, name, max) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') fail(`"${name}" must be text.`);
    if (v.length > max) fail(`"${name}" must be at most ${max} characters.`);
    return v.trim();
  };
  const limitOf = (v) => {
    if (v === undefined) return 5;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 50) fail('"limit" must be a whole number from 1 to 50.');
    return n;
  };

  switch (input.type) {
    case 'send_email': {
      if (!Array.isArray(input.to) || input.to.length === 0) fail('Add at least one recipient.');
      if (input.to.length > 20) fail('At most 20 recipients.');
      const to = [...new Set(input.to.map((r, i) => str(r, `to[${i}]`, 254)).filter(Boolean))];
      if (!to.length) fail('Add at least one recipient.');
      const subject = str(input.subject, 'subject', 500);
      const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trimEnd() : str(input.body, 'body', 10000);
      if (body.length > 10000) fail('"body" must be at most 10000 characters.');
      if (!subject && !body.trim()) fail('Write a subject or a message.');
      const sendMode = input.sendMode === 'draft' ? 'draft' : 'send';
      return { type: 'send_email', to, subject, body, sendMode };
    }
    case 'search_email': {
      const query = str(input.query, 'query', 500);
      if (!query) fail('Write what to search for.');
      return { type: 'search_email', query, limit: limitOf(input.limit) };
    }
    case 'read_inbox':
      return { type: 'read_inbox', limit: limitOf(input.limit) };
    default:
      return fail(`Unknown task type "${input.type}".`);
  }
}

// ---------------------------------------------------------------------------
// Browsers: one per user, at most CONFIG.maxBrowsers open at the same time
// ---------------------------------------------------------------------------
//
// Each user has a "session": their own Chrome profile folder (Gmail login), task queue,
// sign-in state and live preview. A browser is opened for a user when they need it and
// closed again after CONFIG.idleCloseMs without use.
//
// The pool allows CONFIG.maxBrowsers open browsers. When it is full and another user
// needs one: an idle browser (no task, no sign-in) is closed to make room; if every
// browser is busy, the user waits in line and gets the next browser that frees up.

const sessions = new Map(); // userId -> session
const pool = { open: new Set(), waiters: [] }; // userIds with an open (or opening) browser; FIFO line

const USER_ID_RE = /^[0-9a-f-]{36}$/i;

/** The user's session (created on first use). */
function userSession(userId) {
  if (!USER_ID_RE.test(String(userId || ''))) throw new AgentError('NO_USER', 'Unknown user.');
  let s = sessions.get(userId);
  if (!s) {
    s = {
      userId,
      profileDir: path.join(CONFIG.profilesDir, userId),
      contextPromise: null,
      queue: Promise.resolve(),
      pending: 0, // tasks queued or running (a sign-in counts as one)
      lastUsed: Date.now(),
      idleTimer: null,
      login: null, // sign-in in progress (Connect Gmail)
      lastLoginResult: null,
      sessionCache: null, // { result, at } of the last Gmail login check
      accountLookup: null,
      viewport: { state: { active: false, url: null }, lastFrame: null, viewers: 0 }, // viewers: open preview streams
    };
    sessions.set(userId, s);
  }
  return s;
}

/** Launch options shared by the agent and the interactive login helper. */
function launchOptions(overrides = {}) {
  const headless = overrides.headless ?? CONFIG.headless;
  return {
    headless,
    // Headless uses Chromium's "new headless" mode (the full browser, just without a window).
    // The default headless shell is easy to detect and Google refuses sign-ins from it.
    channel: CONFIG.channel || (headless ? 'chromium' : undefined),
    slowMo: CONFIG.slowMoMs,
    viewport: CONFIG.viewport,
    // Google blocks sign-in from browsers that announce they're automated.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      // Keep painting when the headed window is hidden behind others, so the live preview doesn't freeze.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // Less background work per browser (several run on one server).
      '--disable-extensions',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
    ],
    ...overrides,
  };
}

const isIdle = (s) => s.pending === 0 && !s.login;

/** Wakes the first user waiting in line, so they can take a freed (or now idle) browser. */
function wakeOneWaiter() {
  const next = pool.waiters.shift();
  if (next) next();
}

/** True when the user has a browser, or one can be opened now (free slot or an idle browser to close). */
function canOpenBrowser(s) {
  if (s.contextPromise || pool.open.has(s.userId) || pool.open.size < CONFIG.maxBrowsers) return true;
  return [...pool.open].some((id) => {
    const x = sessions.get(id);
    return x && x !== s && isIdle(x);
  });
}

/** Reserves a browser for the user: free slot → take it; full → close an idle one; all busy → wait. */
async function acquireBrowserSlot(s, log) {
  if (pool.open.has(s.userId)) return;
  let announced = false;
  for (;;) {
    if (pool.open.size < CONFIG.maxBrowsers) {
      pool.open.add(s.userId);
      return;
    }
    const idle = [...pool.open]
      .map((id) => sessions.get(id))
      .filter((x) => x && x !== s && isIdle(x))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle) {
      await closeUserBrowser(idle);
      continue;
    }
    if (!announced) {
      log.info(`All ${CONFIG.maxBrowsers} browsers are busy. Waiting for a free one (${pool.waiters.length + 1} in line)…`);
      announced = true;
      await new Promise((resolve) => pool.waiters.push(resolve));
    } else {
      // Woken, but someone else was faster: keep the place at the front of the line.
      await new Promise((resolve) => pool.waiters.unshift(resolve));
    }
  }
}

function releaseBrowserSlot(userId) {
  if (pool.open.delete(userId)) wakeOneWaiter();
}

function launchError(err) {
  if (/ProcessSingleton|already in use|SingletonLock/i.test(err.message)) {
    return new AgentError('PROFILE_IN_USE', 'This browser profile is already in use (for example by `npm run login`). Close it and retry.');
  }
  if (/Executable doesn't exist|npx playwright install/i.test(err.message)) {
    return new AgentError('BROWSER_NOT_INSTALLED', 'Chromium is not installed. Run: npx playwright install chromium');
  }
  return new AgentError('BROWSER_LAUNCH_FAILED', `Failed to launch browser: ${err.message}`);
}

/**
 * The user's browser, opened on first use (waiting for a free slot if needed). A persistent
 * context keeps the cookies in the user's profile folder, so their Gmail stays signed in.
 */
async function getContext(s, log) {
  clearTimeout(s.idleTimer);
  if (!s.contextPromise) {
    const promise = (s.contextPromise = (async () => {
      await acquireBrowserSlot(s, log);
      try {
        fs.mkdirSync(s.profileDir, { recursive: true });
        log.action(`Opening your browser (${CONFIG.headless ? 'headless' : 'headed'})`);
        const context = await chromium.launchPersistentContext(s.profileDir, launchOptions());
        context.setDefaultTimeout(CONFIG.actionTimeoutMs);
        // Closed by us (idle / shutdown) or crashed: free the slot, relaunch next time.
        context.on('close', () => {
          if (s.contextPromise !== promise) return; // already replaced by closeUserBrowser()
          s.contextPromise = null;
          releaseBrowserSlot(s.userId);
        });
        return context;
      } catch (err) {
        releaseBrowserSlot(s.userId);
        throw launchError(err);
      }
    })().catch((err) => {
      if (s.contextPromise === promise) s.contextPromise = null;
      throw err;
    }));
  }
  return s.contextPromise;
}

async function closeUserBrowser(s) {
  clearTimeout(s.idleTimer);
  const p = s.contextPromise;
  s.contextPromise = null;
  if (p) {
    try {
      await (await p).close();
    } catch {
      // Already closed or never opened.
    }
  }
  releaseBrowserSlot(s.userId);
}

/** Closes every browser (server shutdown). */
async function closeBrowser() {
  await Promise.all([...sessions.values()].map(closeUserBrowser));
}

function scheduleIdleClose(s) {
  clearTimeout(s.idleTimer);
  if (!s.contextPromise) return;
  s.idleTimer = setTimeout(() => {
    if (isIdle(s)) closeUserBrowser(s);
  }, CONFIG.idleCloseMs);
}

/**
 * Runs `fn` after the user's earlier tasks finish. One browser per user, and two tasks
 * typing into the same Gmail at once would interfere, so a user's tasks run one by one.
 * Different users run in parallel (up to the pool size).
 */
function enqueue(s, fn) {
  s.pending++;
  clearTimeout(s.idleTimer);
  const run = s.queue.then(fn, fn).finally(() => {
    s.pending--;
    s.lastUsed = Date.now();
    if (isIdle(s)) {
      scheduleIdleClose(s);
      wakeOneWaiter(); // someone waiting may now take this idle browser
    }
  });
  s.queue = run.catch(() => {});
  return run;
}

/** Deletes everything the agent keeps for a user (used when an admin removes the user). */
async function removeUserData(userId) {
  const s = sessions.get(userId);
  if (s) {
    if (s.login) await endLogin(s, 'cancelled');
    await closeUserBrowser(s);
    sessions.delete(userId);
  }
  if (USER_ID_RE.test(userId)) fs.rmSync(path.join(CONFIG.profilesDir, userId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The user's Gmail account (name + address), used to sign their emails
// ---------------------------------------------------------------------------

/** The user's Gmail account, or null if not known yet. */
function getAccount(userId) {
  const u = userStore.get(userId);
  return u && u.gmail_email ? { name: u.gmail_name, email: u.gmail_email } : null;
}

/** Name under "Best regards,": the Gmail account's name (or the user's name as a fallback). */
function senderName(userId) {
  const u = userId && userStore.get(userId);
  if (!u) return '';
  return (u.gmail_name || u.name || '').trim();
}

/** "kunj dhakad" -> "Kunj Dhakad" (names typed all lowercase); other names are kept as they are. */
const tidyName = (n) => (n === n.toLowerCase() ? n.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : n);

/**
 * Reads the account from Gmail's profile button. Its label looks like
 * "Google Account: Kunj Dhakad (kunj@gmail.com)" (the words vary with the Gmail language,
 * the "Name (address)" part doesn't). Never throws; a miss just keeps the old value.
 */
async function readAccount(page, s) {
  try {
    const label = await page
      .locator('a[aria-label*="@"][href*="accounts.google.com"]')
      .first()
      .getAttribute('aria-label', { timeout: 4000 });
    const m = label && label.match(/:\s*([^\n(]+?)\s*\(\s*([^()\s]+@[^()\s]+)\s*\)/);
    if (m) userStore.setGmailAccount(s.userId, tidyName(m[1].trim()), m[2].trim());
  } catch {
    // Profile button not found (layout change / not loaded): keep what we have.
  }
}

const CLOSING_LINE = /^(?:best regards|kind regards|warm regards|regards|best wishes|best|thanks|thank you|many thanks|thanks again|sincerely|yours sincerely|yours truly|cheers)[,!.]?$/i;

/**
 * Puts the sender's name under the closing line ("Best regards," -> "Best regards,\nKunj Dhakad")
 * when the email ends with a closing but no name. Leaves everything else untouched.
 */
function signBody(body, name) {
  if (!name || !body) return body;
  const lines = body.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1].trim();
  if (!CLOSING_LINE.test(last)) return body; // already signed, or no closing to sign under
  return `${lines.join('\n')}\n${name}`;
}

/** One-time background lookup of the account name (opens Gmail briefly, queued behind the user's tasks). */
function lookupAccountInBackground(s) {
  if (getAccount(s.userId) || s.accountLookup) return;
  s.accountLookup = enqueue(s, async () => {
    let page;
    try {
      const context = await getContext(s, createLogger());
      page = await openPage(context);
      await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' });
      await page.locator(SELECTORS.composeButton).first().waitFor({ state: 'visible', timeout: 30_000 });
      await readAccount(page, s);
    } catch {
      // Not logged in or slow: try again on the next check.
    } finally {
      if (page && !page.isClosed()) await page.close().catch(() => {});
      s.accountLookup = null;
    }
  });
}

const SESSION_CACHE_MS = 60_000;

/**
 * Is the user's agent browser signed in to Google? Returns
 * { loggedIn: true|false|null, reason?, message?, checkedAt, account?, signature? }.
 */
async function checkSession(userId, options) {
  const s = userSession(userId);
  const result = await checkLogin(s, options);
  if (result.loggedIn && !getAccount(userId)) lookupAccountInBackground(s);
  const account = result.loggedIn ? getAccount(userId) : null;
  const signature = result.loggedIn ? senderName(userId) : '';
  return { ...result, ...(account ? { account } : {}), ...(signature ? { signature } : {}) };
}

/**
 * Reads Google's session cookies when the user's browser is open. When it isn't, it avoids
 * taking one of the shared browsers just to look: a new user has no profile yet (not signed
 * in), otherwise the last known state is used, and only if unknown (and a browser is free)
 * the browser is opened to check.
 */
async function checkLogin(s, { force = false } = {}) {
  if (!force && s.sessionCache && Date.now() - s.sessionCache.at < SESSION_CACHE_MS) return s.sessionCache.result;
  const now = new Date().toISOString();
  const stored = (userStore.get(s.userId) || {}).gmail_status || 'unknown';
  let result;
  try {
    if (!s.contextPromise && !fs.existsSync(s.profileDir)) {
      result = { loggedIn: false, checkedAt: now };
    } else if (!s.contextPromise && stored !== 'unknown' && !force) {
      result = { loggedIn: stored === 'connected', checkedAt: now };
    } else if (!canOpenBrowser(s)) {
      result = {
        loggedIn: stored === 'connected' ? true : stored === 'disconnected' ? false : null,
        reason: 'BROWSERS_BUSY',
        message: 'All browsers are busy right now. Try again in a moment.',
        checkedAt: now,
      };
    } else {
      const context = await getContext(s, createLogger());
      const cookies = await context.cookies('https://mail.google.com');
      result = { loggedIn: cookies.some((c) => /^(SID|__Secure-1PSID|__Secure-3PSID)$/.test(c.name)), checkedAt: now };
      if (isIdle(s)) scheduleIdleClose(s);
    }
  } catch (err) {
    result = { loggedIn: null, reason: err instanceof AgentError ? err.code : 'UNKNOWN', message: err.message, checkedAt: now };
  }
  if (result.loggedIn === true) userStore.setGmailStatus(s.userId, 'connected');
  if (result.loggedIn === false) userStore.setGmailStatus(s.userId, 'disconnected');
  s.sessionCache = { result, at: Date.now() };
  return result;
}

// ---------------------------------------------------------------------------
// Connect / disconnect Gmail from the dashboard (per user)
// ---------------------------------------------------------------------------
//
// "Connect Gmail" opens Google's sign-in page in the user's own agent browser and streams it
// to their dashboard (the live preview). Their clicks and keys are sent back with
// sendLoginInput(), so they sign in from any device, with no VNC needed. While a sign-in is
// open it holds the user's task queue, so none of their tasks touch the browser meanwhile.

const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space']);

function loginStatus(userId) {
  const s = userSession(userId);
  if (!s.login) return { active: false, ...(s.lastLoginResult ? { lastResult: s.lastLoginResult } : {}) };
  const l = s.login;
  return { active: true, id: l.id, startedAt: l.startedAt, url: l.page.isClosed() ? null : l.page.url() };
}

/**
 * Headless Chromium calls itself "HeadlessChrome" in its user agent and in the client-hint
 * brands, which makes Google refuse sign-ins ("This browser or app may not be secure").
 * Presents the normal Chrome name in both. Returns the CDP session (kept on the page so the
 * override stays active), or null when nothing needed changing.
 */
async function useRegularUserAgent(page) {
  try {
    const { ua, brands } = await page.evaluate(() => ({
      ua: navigator.userAgent,
      brands: navigator.userAgentData ? navigator.userAgentData.brands : [],
    }));
    if (!/Headless/i.test(ua)) return null;
    const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || 'Linux';
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: ua.replace(/HeadlessChrome/g, 'Chrome'),
      userAgentMetadata: {
        brands: brands.map((b) => ({ brand: b.brand.replace('HeadlessChrome', 'Google Chrome'), version: b.version })),
        fullVersion: '',
        platform,
        platformVersion: '',
        architecture: process.arch === 'arm64' ? 'arm' : 'x86',
        model: '',
        mobile: false,
      },
    });
    return cdp;
  } catch {
    return null;
  }
}

/** New tab in the agent's browser, presented as regular Chrome (see useRegularUserAgent). */
async function openPage(context) {
  const page = await context.newPage();
  page.uaSession = await useRegularUserAgent(page);
  return page;
}

/** Opens Google's sign-in page in the user's browser, for them to fill in through the dashboard. */
async function startLogin(userId) {
  const s = userSession(userId);
  if (s.login) return loginStatus(userId);
  if (!canOpenBrowser(s)) {
    throw new AgentError('BROWSERS_BUSY', `All ${CONFIG.maxBrowsers} browsers are busy right now. Try again in a minute.`);
  }
  const current = await checkLogin(s, { force: true });
  if (current.loggedIn) {
    throw new AgentError('ALREADY_LOGGED_IN', 'Gmail is already connected. Log out first to connect a different account.');
  }

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const opened = new Promise((resolve, reject) => {
    enqueue(s, async () => {
      try {
        const log = createLogger();
        const context = await getContext(s, log);
        const page = await openPage(context);
        const stopScreencast = await startScreencast(page, log, s);
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        s.login = { id: crypto.randomUUID(), page, stopScreencast, release, startedAt: new Date().toISOString() };
        s.login.watcher = setInterval(() => checkLoginDone(s), 1500);
        s.login.timer = setTimeout(() => endLogin(s, 'timeout'), LOGIN_TIMEOUT_MS);
        page.on('close', () => endLogin(s, 'closed'));
        resolve();
      } catch (err) {
        release();
        reject(err instanceof AgentError ? err : new AgentError('LOGIN_FAILED', `Could not open the Google sign-in page: ${err.message}`));
      }
      await held; // keep the user's queue until the sign-in ends
    });
  });
  await opened;
  return loginStatus(userId);
}

/** Finishes the sign-in automatically once Gmail's inbox has loaded. */
async function checkLoginDone(s) {
  const l = s.login;
  if (!l || l.checking || l.page.isClosed()) return;
  l.checking = true;
  try {
    if (/^https:\/\/mail\.google\.com\/mail\//.test(l.page.url())) {
      const inbox = await l.page.locator(SELECTORS.composeButton).first().isVisible().catch(() => false);
      if (inbox && s.login === l) {
        userStore.setGmailStatus(s.userId, 'connected');
        await readAccount(l.page, s);
        await endLogin(s, 'success');
      }
    }
  } finally {
    l.checking = false;
  }
}

async function endLogin(s, reason) {
  const l = s.login;
  if (!l) return;
  s.login = null;
  clearInterval(l.watcher);
  clearTimeout(l.timer);
  await l.stopScreencast().catch(() => {});
  if (!l.page.isClosed()) await l.page.close().catch(() => {});
  s.sessionCache = null; // next check re-reads the cookies
  s.lastLoginResult = { reason, at: new Date().toISOString() };
  l.release();
}

const cancelLogin = (userId) => endLogin(userSession(userId), 'cancelled');

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * A click / key / text / scroll from the dashboard, applied to the user's sign-in page.
 * Click positions are fractions (0-1) of the picture, so they don't depend on screen size.
 */
async function sendLoginInput(userId, input) {
  const s = userSession(userId);
  const l = s.login;
  if (!l || l.page.isClosed()) throw new AgentError('NO_LOGIN', 'No Gmail sign-in is in progress.');
  const bad = (m) => {
    throw new AgentError('INVALID_INPUT', m);
  };
  const { page } = l;
  switch (input && input.type) {
    case 'click': {
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) bad('Click needs x and y.');
      await page.mouse.click(clamp(x, 0, 1) * CONFIG.viewport.width, clamp(y, 0, 1) * CONFIG.viewport.height);
      break;
    }
    case 'type':
      if (typeof input.text !== 'string' || !input.text || input.text.length > 500) bad('Text must be 1-500 characters.');
      await page.keyboard.type(input.text); // no per-key delay: the user's own typing speed already reached us
      break;
    case 'key':
      if (!LOGIN_KEYS.has(input.key)) bad('That key is not allowed.');
      await page.keyboard.press(input.key === 'Space' ? ' ' : input.key);
      break;
    case 'scroll': {
      const dy = Number(input.deltaY);
      if (!Number.isFinite(dy)) bad('Scroll needs deltaY.');
      await page.mouse.wheel(0, clamp(dy, -2000, 2000));
      break;
    }
    default:
      bad('Unknown input type.');
  }
  setTimeout(() => checkLoginDone(s), 800); // a click or Enter may just have finished the sign-in
}

/**
 * Signs the user's agent browser out of Google: visits Google's sign-out page, clears every
 * cookie of their profile and forgets their account name. Other users are not affected.
 */
async function logoutGmail(userId) {
  const s = userSession(userId);
  if (s.login) await endLogin(s, 'cancelled');
  return enqueue(s, async () => {
    const context = await getContext(s, createLogger());
    const page = await openPage(context);
    try {
      await page.goto('https://accounts.google.com/Logout', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await sleep(1500);
    } catch {
      // Offline or slow: clearing the cookies below still signs this browser out.
    } finally {
      await page.close().catch(() => {});
    }
    await context.clearCookies();
    userStore.clearGmail(userId);
    s.viewport.lastFrame = null; // don't keep showing the old inbox in the preview
    s.sessionCache = { result: { loggedIn: false, checkedAt: new Date().toISOString() }, at: Date.now() };
    return { loggedIn: false };
  });
}

/** Server-wide numbers for /health (no user data). */
function getStatus() {
  let pendingTasks = 0;
  for (const s of sessions.values()) pendingTasks += s.pending;
  return {
    openBrowsers: pool.open.size,
    maxBrowsers: CONFIG.maxBrowsers,
    waitingForBrowser: pool.waiters.length,
    pendingTasks,
    headless: CONFIG.headless,
    dryRun: CONFIG.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Live browser preview (screencast), per user
// ---------------------------------------------------------------------------
//
// Chrome's DevTools protocol can push a JPEG every time the page repaints
// (Page.startScreencast). Frames are published on `viewportBus` tagged with the user's
// id; server.js relays them over SSE only to that user. Works headless and headed.

const viewportBus = new EventEmitter();
viewportBus.setMaxListeners(200); // one listener pair per connected dashboard

function publishFrame(s, frame) {
  s.viewport.lastFrame = frame;
  viewportBus.emit('frame', s.userId, frame);
}

function publishState(s, patch) {
  s.viewport.state = { ...s.viewport.state, ...patch };
  viewportBus.emit('state', s.userId, s.viewport.state);
}

/** Subscribes to one user's preview frames and state changes. Returns an unsubscribe function. */
function subscribeViewport(userId, onFrame, onState) {
  const s = userSession(userId);
  const frameListener = (uid, frame) => uid === userId && onFrame(frame);
  const stateListener = (uid, state) => uid === userId && onState(state);
  viewportBus.on('frame', frameListener);
  viewportBus.on('state', stateListener);
  s.viewport.viewers++;
  return () => {
    s.viewport.viewers = Math.max(0, s.viewport.viewers - 1);
    viewportBus.off('frame', frameListener);
    viewportBus.off('state', stateListener);
  };
}

function getViewportSnapshot(userId) {
  const s = userSession(userId);
  return { state: s.viewport.state, lastFrame: s.viewport.lastFrame };
}

/**
 * Starts streaming `page` to the user's preview. Returns an async stop function that
 * publishes one final still (so they see the end state, e.g. "Message sent") and then
 * stops the screencast. Never throws: the preview is best-effort.
 */
async function startScreencast(page, log, s) {
  const { enabled, quality, maxWidth } = CONFIG.screencast;
  if (!enabled) return async () => {};

  let session;
  let stopped = false;
  let nextAckAt = 0; // acks are spaced evenly (Chrome keeps up to 2 frames in flight)
  const onNavigate = (frame) => {
    if (frame === page.mainFrame()) publishState(s, { url: frame.url() });
  };

  // Chrome sends the next frame only after the previous one is acknowledged, and would
  // otherwise encode up to 60 JPEGs a second. Delaying the ack caps that at what viewers get
  // (maxFps), or 1 per second when nobody is watching: most of a browser's CPU otherwise
  // goes into frames that are thrown away, which slows every browser on the server.
  const ackLater = (sessionId) => {
    const fps = s.viewport.viewers > 0 ? Math.max(1, CONFIG.screencast.maxFps) : 1;
    nextAckAt = Math.max(Date.now(), nextAckAt + 1000 / fps);
    setTimeout(() => {
      if (!stopped) session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }, Math.max(0, nextAckAt - Date.now()));
  };

  try {
    session = await page.context().newCDPSession(page);
    session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      ackLater(sessionId);
      publishFrame(s, {
        data, // base64 JPEG
        width: Math.round(metadata.deviceWidth),
        height: Math.round(metadata.deviceHeight),
        url: page.url(),
        time: Date.now(),
      });
    });
    page.on('framenavigated', onNavigate);
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight: Math.round((maxWidth * CONFIG.viewport.height) / CONFIG.viewport.width),
      everyNthFrame: 1,
    });
    publishState(s, { active: true, url: page.url() });
  } catch (err) {
    log.warn(`Live preview unavailable: ${err.message}`);
    return async () => {};
  }

  return async () => {
    stopped = true;
    page.off('framenavigated', onNavigate);
    try {
      if (!page.isClosed()) {
        const still = await page.screenshot({ type: 'jpeg', quality });
        publishFrame(s, {
          data: still.toString('base64'),
          width: CONFIG.viewport.width,
          height: CONFIG.viewport.height,
          url: page.url(),
          time: Date.now(),
        });
      }
    } catch {
      // Page may already be gone; keep the last streamed frame.
    }
    await session.send('Page.stopScreencast').catch(() => {});
    await session.detach().catch(() => {});
    publishState(s, { active: false });
  };
}

// ---------------------------------------------------------------------------
// Human-like interaction helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random delay around `base` (+/- 50%). */
const jitter = (base) => Math.max(0, Math.round(base * (0.5 + Math.random())));

/**
 * Types text one character at a time with randomised delays (typewriter effect).
 * Slightly longer pauses after spaces and punctuation mimic real typing rhythm.
 */
async function humanType(page, locator, text) {
  await locator.click();
  await sleep(jitter(200));
  for (const char of text) {
    // keyboard.type handles unicode; "\n" becomes Enter (a new line in the body editor).
    await page.keyboard.type(char);
    let delay = jitter(CONFIG.typingDelayMs);
    if (char === ' ') delay += jitter(CONFIG.typingDelayMs / 2);
    if (/[.,!?;:\n]/.test(char)) delay += jitter(CONFIG.typingDelayMs * 3);
    await sleep(delay);
  }
}

/** Short pause between actions, like a person moving the mouse. */
const think = () => sleep(jitter(400));

/** Returns the first visible element matching any selector in a comma-list, or null. */
async function firstVisible(scope, selector, timeout = 5000) {
  const locator = scope.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return locator;
  } catch {
    return null;
  }
}

/** Saves a screenshot for debugging failed runs, in the user's own folder. Never throws. */
async function captureScreenshot(page, log, userId) {
  if (!page || page.isClosed()) return null;
  try {
    const dir = path.join(CONFIG.screenshotDir, userId || 'shared');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `error-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log.info('Saved a screenshot of the failure for debugging');
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gmail actions
// ---------------------------------------------------------------------------

/** Navigates to Gmail and verifies the session is logged in. */
async function openGmail(page, log) {
  log.action('Navigating to Gmail');
  await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' });

  // Logged-out users are redirected to accounts.google.com or the marketing page.
  const composeOrLogin = await Promise.race([
    page
      .locator(SELECTORS.composeButton)
      .first()
      .waitFor({ state: 'visible' })
      .then(() => 'inbox'),
    page
      .waitForURL((url) => /accounts\.google\.com|workspace\.google\.com|\/intl\//.test(url.href))
      .then(() => 'login'),
  ]).catch(() => 'timeout');

  if (composeOrLogin !== 'inbox') {
    throw new AgentError(
      'LOGIN_REQUIRED',
      composeOrLogin === 'login'
        ? 'Gmail is not connected (or was signed out). Click "Connect Gmail" on the dashboard, sign in, then retry.'
        : 'Gmail did not finish loading in time. Check the network connection or increase ACTION_TIMEOUT_MS.',
      { url: page.url() }
    );
  }
  log.success('Gmail inbox loaded (session restored from persistent profile)');
}

/** Adds one recipient to the "To" field, resolving contact names via Gmail autocomplete. */
async function addRecipient(page, compose, recipient, log) {
  const toInput = await firstVisible(compose, SELECTORS.toInput);
  if (toInput) {
    await toInput.click();
  } // else: Gmail auto-focuses "To" when compose opens, so typing still lands there.

  log.action(`Typing recipient "${recipient}"`);
  for (const char of recipient) {
    await page.keyboard.type(char);
    await sleep(jitter(CONFIG.typingDelayMs));
  }

  const isEmail = new RegExp(`^${EMAIL_RE.source}$`, 'i').test(recipient);
  if (isEmail) {
    // Tab turns the typed address into a recipient "chip" without picking a suggestion.
    await page.keyboard.press('Tab');
    log.success(`Recipient added: ${recipient}`);
    return;
  }

  // A contact name: wait for Gmail's autocomplete and pick the top suggestion.
  const suggestion = await firstVisible(page, SELECTORS.contactSuggestion, 6000);
  if (!suggestion) {
    throw new AgentError(
      'CONTACT_NOT_FOUND',
      `No Gmail contact matched "${recipient}". Use a full email address or add the contact to Google Contacts.`
    );
  }
  const label = (await suggestion.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  await page.keyboard.press('Enter');
  log.success(`Recipient resolved from contacts: ${label || recipient}`);
}

/** Opens compose, fills recipients/subject/body with a typewriter effect, then sends (or saves a draft). */
async function sendEmail(page, task, log) {
  const dryRun = CONFIG.dryRun || task.sendMode === 'draft';

  log.action('Clicking "Compose"');
  await page.locator(SELECTORS.composeButton).first().click();

  const subjectInput = page.locator(SELECTORS.subjectInput).last();
  await subjectInput.waitFor({ state: 'visible' });
  // Scope further lookups to the compose window when Gmail exposes it as a dialog.
  const dialog = page.locator('div[role="dialog"]').filter({ has: page.locator(SELECTORS.subjectInput) }).last();
  const compose = (await dialog.count()) ? dialog : page;
  log.success('Compose window opened');
  await think();

  for (const recipient of task.to) {
    await addRecipient(page, compose, recipient, log);
    await think();
  }

  if (task.subject) {
    log.action(`Typing subject: "${task.subject}"`);
    await humanType(page, subjectInput, task.subject);
    await think();
  }

  if (task.body) {
    log.action(`Typing message body (${task.body.length} chars)`);
    const body = compose.locator(SELECTORS.bodyEditor).last();
    await body.waitFor({ state: 'visible' });
    await humanType(page, body, task.body);
    await think();
  }

  if (dryRun) {
    // Escape closes the compose window and Gmail saves it to Drafts.
    await page.keyboard.press('Escape');
    await sleep(1500);
    log.warn(
      task.sendMode === 'draft'
        ? 'Draft requested: email saved to Drafts, not sent.'
        : 'DRY_RUN is enabled: email saved to Drafts instead of being sent.'
    );
    return { sent: false, savedAsDraft: true, to: task.to, subject: task.subject };
  }

  log.action('Clicking "Send"');
  const sendButton = await firstVisible(compose, SELECTORS.sendButton, 3000);
  if (sendButton) {
    await sendButton.click();
  } else {
    log.warn('Send button not found, using the Ctrl/Cmd+Enter shortcut instead');
    // Focus the body so the shortcut applies to this compose window.
    await compose.locator(SELECTORS.bodyEditor).last().click().catch(() => {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  }

  // Success = the compose window closes. Gmail shows an alert dialog on problems (e.g. bad address).
  const outcome = await Promise.race([
    subjectInput.waitFor({ state: 'detached', timeout: 15000 }).then(() => 'closed'),
    page
      .locator(SELECTORS.errorDialog)
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome !== 'closed') {
    const reason =
      outcome === 'error'
        ? (await page.locator(SELECTORS.errorDialog).first().innerText().catch(() => '')).trim()
        : 'The compose window did not close after clicking Send.';
    throw new AgentError('SEND_FAILED', `Gmail did not send the email. ${reason}`.trim());
  }

  const toast = await firstVisible(page, SELECTORS.toast, 5000);
  const toastText = toast ? (await toast.innerText().catch(() => '')).trim() : '';
  log.success(`Email sent to ${task.to.join(', ')}${toastText ? ` (Gmail: "${toastText}")` : ''}`);
  return { sent: true, to: task.to, subject: task.subject };
}

/** Reads up to `limit` visible rows from the current Gmail list view. */
async function readMailRows(page, limit) {
  const rows = page.locator(SELECTORS.mailRow);
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return []; // Empty inbox or no search results.
  }
  return rows.evaluateAll(
    (els, max) =>
      els.slice(0, max).map((row) => {
        const sender = row.querySelector('.yW span[email], .yW span[name], .yW span');
        const text = (sel) => (row.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
        const date = row.querySelector('td.xW span');
        return {
          from: sender?.getAttribute('name') || sender?.textContent?.trim() || '',
          fromEmail: sender?.getAttribute('email') || '',
          subject: text('.bog'),
          snippet: text('.y2').replace(/^[-–\s]+/, ''),
          date: date?.getAttribute('title') || date?.textContent?.trim() || '',
          unread: row.classList.contains('zE'),
        };
      }),
    limit
  );
}

/** Types a query into Gmail search and returns the top results. */
async function searchEmail(page, task, log) {
  log.action(`Typing search query: "${task.query}"`);
  const searchInput = page.locator(SELECTORS.searchInput).first();
  await humanType(page, searchInput, task.query);
  await page.keyboard.press('Enter');
  await page.waitForURL(/#search\//, { timeout: CONFIG.actionTimeoutMs }).catch(() => {});
  await sleep(1000); // Let Gmail swap the list view.

  const results = await readMailRows(page, task.limit);
  log.success(`Found ${results.length} result(s) for "${task.query}"`, { results });
  return { query: task.query, results };
}

/** Lists the most recent emails in the inbox. */
async function readInbox(page, task, log) {
  log.action(`Reading the latest ${task.limit} inbox emails`);
  const emails = await readMailRows(page, task.limit);
  log.success(`Read ${emails.length} email(s) from the inbox`, { emails });
  return { emails };
}

const TASK_HANDLERS = {
  send_email: sendEmail,
  search_email: searchEmail,
  read_inbox: readInbox,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Interprets `prompt`, drives the browser, and returns the execution report.
 * Never throws: failures are returned as `{ success: false, error }`.
 *
 * @param {string|object} input          Natural-language command, or a structured task
 *                                        object from the form (see validateTask).
 * @param {object} options
 * @param {string} options.userId    The user whose browser (and Gmail) runs the task.
 * @param {(entry: object) => void} [options.onLog]  Called for every log entry (live streaming).
 * @param {boolean} [options.dryRun]  Save emails to Drafts instead of sending (per-request safe mode).
 * @param {(task, result, log) => Promise<object>} [options.postProcess]  Runs after the task succeeds and may
 *                                        return an enriched result (planner.js uses it for AI summaries).
 * @returns {Promise<{success: boolean, task?: object, result?: object, error?: {code: string, message: string}, logs: object[], durationMs: number}>}
 */
async function runBrowserAgent(input, { userId, onLog, dryRun = false, postProcess } = {}) {
  const log = createLogger(onLog);
  const startedAt = Date.now();
  let task;
  let s;

  // Interpret/validate before queueing so bad input fails instantly.
  try {
    if (typeof input === 'string') {
      log.info(`Received prompt: "${input}"`);
      task = parseCommand(input);
    } else {
      log.info('Received the reviewed task');
      task = validateTask(input);
    }
    if (dryRun && task.type === 'send_email' && task.sendMode !== 'draft') {
      task.sendMode = 'draft';
      log.info('Safe mode is on: the email will be saved to Drafts, not sent');
    }
    log.success(`Interpreted task: ${task.type}`, task);
    s = userSession(userId);
  } catch (err) {
    return finish(err);
  }

  if (s.pending > 0) log.info(`Waiting for your ${s.pending} earlier task(s) to finish…`);

  return enqueue(s, async () => {
    let page;
    let stopScreencast = async () => {};
    try {
      // Never connected: no need to take one of the shared browsers to find that out.
      if (!s.contextPromise && !fs.existsSync(s.profileDir)) {
        throw new AgentError('LOGIN_REQUIRED', 'Gmail is not connected yet. Click "Connect Gmail" on the dashboard, sign in once, then retry.');
      }
      const context = await getContext(s, log);
      page = await openPage(context);
      stopScreencast = await startScreencast(page, log, s);
      await openGmail(page, log);
      await readAccount(page, s); // remember who is signed in (used to sign emails)
      if (task.type === 'send_email') {
        // The email may have been written before the account name was known (first run,
        // schedules): add the name under the closing line now, just before typing.
        const name = senderName(userId);
        const signed = signBody(task.body, name);
        if (signed !== task.body) {
          task.body = signed;
          log.info(`Signed the email as "${name}"`);
        }
      }
      let result = await TASK_HANDLERS[task.type](page, task, log);
      // Optional extra step, e.g. an AI summary of search results (see planner.js).
      if (postProcess) result = await postProcess(task, result, log);
      return finish(null, result);
    } catch (err) {
      await captureScreenshot(page, log, userId);
      return finish(err);
    } finally {
      await stopScreencast();
      if (page && !page.isClosed()) await page.close().catch(() => {});
    }
  });

  function finish(err, result) {
    const durationMs = Date.now() - startedAt;
    // A finished run is the most reliable login check there is; remember it for this user.
    if (s && (!err || err.code === 'LOGIN_REQUIRED')) {
      s.sessionCache = { result: { loggedIn: !err, checkedAt: new Date().toISOString() }, at: Date.now() };
      userStore.setGmailStatus(s.userId, err ? 'disconnected' : 'connected');
    }
    if (!err) {
      log.success(`Task completed in ${(durationMs / 1000).toFixed(1)}s`);
      return { success: true, task, result, logs: log.logs, durationMs };
    }
    const error =
      err instanceof AgentError
        ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        : err instanceof playwrightErrors.TimeoutError
          ? { code: 'TIMEOUT', message: `A page element did not appear in time: ${err.message.split('\n')[0]}` }
          : { code: 'UNKNOWN', message: err.message || String(err) };
    log.error(error.message, { code: error.code });
    return { success: false, task, error, logs: log.logs, durationMs };
  }
}

// ---------------------------------------------------------------------------
// CLI: `node agent.js --login <email>` (sign a user's agent browser in to Google)
// ---------------------------------------------------------------------------

/**
 * Opens a visible browser on the user's profile so they can sign in to Google on this
 * computer. (The dashboard's "Connect Gmail" does the same from any device.)
 */
async function interactiveLogin(email) {
  const user = email && userStore.getByEmail(email);
  if (!user) {
    console.log('Usage: node agent.js --login <email of a user>   (create users with: npm run add-user)');
    process.exitCode = 1;
    return;
  }
  const profileDir = path.join(CONFIG.profilesDir, user.id);
  fs.mkdirSync(profileDir, { recursive: true });
  console.log(`\nOpening a browser for ${user.email}`);
  console.log('1. Sign in to Google (complete 2FA if asked).');
  console.log('2. Wait until the Gmail inbox is visible.');
  console.log('3. Close the browser window. The session is saved for this user.\n');

  const context = await chromium.launchPersistentContext(profileDir, launchOptions({ headless: false, slowMo: 0 }));
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(GMAIL_URL);
  page
    .locator(SELECTORS.composeButton)
    .first()
    .waitFor({ state: 'visible', timeout: 0 })
    .then(async () => {
      userStore.setGmailStatus(user.id, 'connected');
      await readAccount(page, { userId: user.id });
      console.log('Gmail inbox detected: login saved. You can close the browser window now.');
    })
    .catch(() => {});
  await new Promise((resolve) => context.on('close', resolve));
  console.log('Browser closed. Session stored for this user.');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args[0] === '--login') return interactiveLogin(args[1]);
    console.log('Usage:\n  node agent.js --login <email>\n\nTasks are run through the dashboard (npm start).');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runBrowserAgent,
  parseCommand,
  validateTask,
  checkSession,
  getAccount,
  readAccount,
  senderName,
  startLogin,
  sendLoginInput,
  cancelLogin,
  loginStatus,
  logoutGmail,
  removeUserData,
  closeBrowser,
  getStatus,
  subscribeViewport,
  getViewportSnapshot,
  AgentError,
  CONFIG,
};
