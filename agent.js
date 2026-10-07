

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
  profilesDir: path.resolve(process.env.PROFILES_DIR || './data/profiles'),
  maxBrowsers: Math.max(1, envInt(process.env.MAX_BROWSERS, 10)), // browsers open at the same time
  idleCloseMs: Math.max(1, envInt(process.env.BROWSER_IDLE_MINUTES, 5)) * 60 * 1000, // close an unused browser after this
  legacyProfileDir: path.resolve(process.env.USER_DATA_DIR || './.browser-profile'),
  channel: process.env.BROWSER_CHANNEL || undefined, // e.g. "chrome" to use installed Google Chrome
  typingDelayMs: envInt(process.env.TYPING_DELAY_MS, 80),
  slowMoMs: envInt(process.env.SLOW_MO_MS, 0),
  actionTimeoutMs: envInt(process.env.ACTION_TIMEOUT_MS, 30000),
  dryRun: envBool(process.env.DRY_RUN, false),
  screenshotDir: path.resolve('./screenshots'),
  
  viewport: { width: 1366, height: 768 },
  screencast: {
    enabled: envBool(process.env.SCREENCAST_ENABLED, true),
    quality: envInt(process.env.SCREENCAST_QUALITY, 80), 
    maxWidth: envInt(process.env.SCREENCAST_MAX_WIDTH, 1366), 
    maxFps: envInt(process.env.SCREENCAST_MAX_FPS, 8), 
  },
};

const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const MAPS_MAX_RESULTS = 100; // Google Maps lists stop around 120 places per search anyway
const CONTACTS_MAX_SITES = 50; // websites per contact-extractor task (~3-8 s each)
const AMAZON_MAX_RESULTS = 30; // products per Amazon research task (one search page)
const AMAZON_MAX_DETAILS = 10; // of those, product pages opened for features and reviews (~5 s each)
const PRICE_MAX_ITEMS = 20; // product links per price watch (~5 s each)
const QA_MAX_STEPS = 60; // AI tester actions per website test (each one is an AI request)


function normalizeSiteUrl(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return null; // "localhost", "intranet"
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    const privateV4 =
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    if (privateV4) return null;
  } else if (host.includes(':')) {
    return null; // IPv6 literals: not needed for real websites
  } else if (/^\d+$/.test(host.replace(/\./g, ''))) {
    return null; // odd numeric forms like 2130706433 or 0x7f.1
  }
  u.hash = '';
  return u.toString();
}

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


function extractField(text, keywords) {
  const kw = `(?:${keywords.map(escapeRe).join('|')})`;
  const sep = String.raw`\s*(?:of|as|is|=|:|-)?\s*`;

  // 1) Quoted value. The closing quote only counts if it's followed by the end of
  const quoted = new RegExp(
    String.raw`\b${kw}\b${sep}(["'])([\s\S]*?)\1(?=\s*[,.;!?]?\s*(?:$|and\b|with\b|then\b|${FIELD_STOP}\b))`,
    'i'
  );
  const q = text.match(quoted);
  if (q) return q[2].trim();

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
  
  const unquotedText = text
    .replace(/(["'])(?:(?!\1).)*\1(?=\s|$|[,.;])/g, ' ')
    .replace(/\s\b(?:that|saying|to say|(?:to\s+)?tell(?:ing)?\s+(?:him|her|them)|let(?:ting)?\s+(?:him|her|them)\s+know|about|regarding|ki)\b[\s\S]*$/i, ' ');

  const addresses = unquotedText.match(EMAIL_RE);
  if (addresses) return [...new Set(addresses)];

  const segmentMatch =
    unquotedText.match(
      /\bto\s+([\s\S]+?)(?=\s+(?:with|saying|about|regarding|that|and\s+(?:say|tell|ask|the\s+subject|subject|message|body))\b|\s*[,;:]\s*(?:subject|message|body|saying)\b|\s+(?:subject|message|body)\b|[.!?]?\s*$)/i
    ) ||
    unquotedText.match(
      /^(?:please\s+)?(?:e-?mail|mail|message|tell|inform|notify|let)\s+(?!to\b|an?\b|the\b)([\s\S]+?)(?=\s+(?:with|saying|about|regarding|that|subject|message|body|know)\b|[.!?]?\s*$)/i
    );
  if (!segmentMatch) return [];

  const segment = segmentMatch[1].trim();
  const emails = segment.match(EMAIL_RE);
  if (emails) return [...new Set(emails)];

  return segment
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((n) => n.replace(/^(?:my|our)\s+/i, '').trim())
    .filter((n) => n && n.length <= 60);
}


const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const SAID_RE = /\b(?:that|saying|to say|(?:to\s+)?tell(?:ing)?\s+(?:him|her|them)|let(?:ting)?\s+(?:him|her|them)\s+know|ki)\b\s+([\s\S]+)$/i;
const TELL_RE = /^(?:please\s+)?(?:tell|inform|notify)\s+(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\S+)\s+(?!about\b|regarding\b)([\s\S]+)$/i;
const ABOUT_RE = /\b(?:about|regarding)\b\s+([\s\S]+)$/i;

const tailOf = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').replace(/[\s.]+$/, '') : '';
};

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
    case 'maps_search': {
      const query = str(input.query, 'query', 200);
      if (!query) fail('Write what kind of business to search for, e.g. "dentists".');
      const location = str(input.location, 'location', 200);
      let limit = 20;
      if (input.limit !== undefined) {
        limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAPS_MAX_RESULTS) fail(`"limit" must be a whole number from 1 to ${MAPS_MAX_RESULTS}.`);
      }
      return { type: 'maps_search', query, location, limit };
    }
    case 'website_contacts': {
      const list = typeof input.urls === 'string' ? input.urls.split(/[\s,]+/) : input.urls;
      if (!Array.isArray(list)) fail('"urls" must be a list of website addresses.');
      const urls = [];
      const seen = new Set();
      list.forEach((u, i) => {
        const raw = str(u, `urls[${i}]`, 500);
        if (!raw) return;
        const url = normalizeSiteUrl(raw);
        if (!url) fail(`"${raw.slice(0, 80)}" is not a public website address.`);
        const key = url.replace(/\/$/, '').toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          urls.push(url);
        }
      });
      if (!urls.length) fail('Add at least one website address.');
      if (urls.length > CONTACTS_MAX_SITES) fail(`At most ${CONTACTS_MAX_SITES} websites per task.`);
      return { type: 'website_contacts', urls };
    }
    case 'amazon_research': {
      const query = str(input.query, 'query', 200);
      if (!query) fail('Write what product to research, e.g. "wireless earbuds".');
      let limit = 10;
      if (input.limit !== undefined) {
        limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > AMAZON_MAX_RESULTS) fail(`"limit" must be a whole number from 1 to ${AMAZON_MAX_RESULTS}.`);
      }
      return { type: 'amazon_research', query, limit, details: input.details !== false };
    }
    case 'price_check': {
      if (!Array.isArray(input.items) || !input.items.length) fail('Add at least one product link.');
      if (input.items.length > PRICE_MAX_ITEMS) fail(`At most ${PRICE_MAX_ITEMS} products per price watch.`);
      const seen = new Set();
      const items = [];
      input.items.forEach((it, i) => {
        const raw = str(it && it.url, `items[${i}].url`, 1000);
        if (!raw) return;
        const url = normalizeSiteUrl(raw);
        if (!url) fail(`"${raw.slice(0, 80)}" is not a public product link.`);
        let target = null;
        if (it.target !== undefined && it.target !== null && it.target !== '') {
          target = Number(String(it.target).replace(/[$,\s]/g, '')); // "$1,299.50" -> 1299.5
          if (!Number.isFinite(target) || target <= 0) fail(`The target price for product ${i + 1} must be a number above 0.`);
        }
        if (!seen.has(url)) {
          seen.add(url);
          items.push({ url, target });
        }
      });
      if (!items.length) fail('Add at least one product link.');
      const alertEmail = str(input.alertEmail, 'alertEmail', 254);
      if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(alertEmail)) fail('The alert email address is not valid.');
      return { type: 'price_check', items, alertEmail };
    }
    case 'qa_test': {
      const raw = str(input.url, 'url', 1000);
      if (!raw) fail('Add the website address to test.');
      const url = normalizeSiteUrl(raw);
      if (!url) fail(`"${raw.slice(0, 80)}" is not a public website address.`);
      const instructions = str(input.instructions, 'instructions', 2000);
      let maxSteps = 30;
      if (input.maxSteps !== undefined && input.maxSteps !== null && input.maxSteps !== '') {
        maxSteps = Number(input.maxSteps);
        if (!Number.isInteger(maxSteps) || maxSteps < 5 || maxSteps > QA_MAX_STEPS) fail(`"maxSteps" must be a whole number from 5 to ${QA_MAX_STEPS}.`);
      }
      return { type: 'qa_test', url, instructions, maxSteps, mobile: input.mobile === true };
    }
    case 'web_task': {
      const raw = str(input.url, 'url', 1000);
      if (!raw) fail('Add the website address.');
      const url = normalizeSiteUrl(raw);
      if (!url) fail(`"${raw.slice(0, 80)}" is not a public website address.`);
      const instructions = str(input.instructions, 'instructions', 3000);
      if (!instructions) fail('Write what the agent should do on the website.');
      let maxSteps = 30;
      if (input.maxSteps !== undefined && input.maxSteps !== null && input.maxSteps !== '') {
        maxSteps = Number(input.maxSteps);
        if (!Number.isInteger(maxSteps) || maxSteps < 5 || maxSteps > QA_MAX_STEPS) fail(`"maxSteps" must be a whole number from 5 to ${QA_MAX_STEPS}.`);
      }
      // Login details: from the form (username / password) or carried over from an earlier check.
      const given = input.secrets || {};
      const username = typeof input.username === 'string' ? input.username : given.USERNAME || '';
      const password = typeof input.password === 'string' ? input.password : given.PASSWORD || '';
      if (username.length > 300 || password.length > 300) fail('The login details are too long.');
      const task = { type: 'web_task', url, instructions, maxSteps, allowOtherSites: input.allowOtherSites === true, hasLogin: Boolean(username || password) };
      // Not enumerable: JSON (the saved task, run history, API answers, schedules) never contains them.
      Object.defineProperty(task, 'secrets', { value: { USERNAME: username, PASSWORD: password }, enumerable: false });
      return task;
    }
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

function senderName(userId) {
  const u = userId && userStore.get(userId);
  if (!u) return '';
  return (u.gmail_name || u.name || '').trim();
}

const tidyName = (n) => (n === n.toLowerCase() ? n.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : n);


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
/**
 * New tab. The user-agent override is what Google's sign-in needs, but Amazon answers it
 * with "Sorry! Something went wrong!" (measured), so tasks can open a tab without it.
 */
async function openPage(context, { regularUserAgent = true } = {}) {
  const page = await context.newPage();
  if (regularUserAgent) page.uaSession = await useRegularUserAgent(page);
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
      // Ends the session on Google's side too. Kept short: clearing the cookies below is what
      // signs this browser out, and callers (e.g. a PHP proxy) may have a 30 s time limit.
      await page.goto('https://accounts.google.com/Logout', { waitUntil: 'domcontentloaded', timeout: 8_000 });
      await sleep(700);
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

function getViewportSnapshot(userId, { polled = false } = {}) {
  const s = userSession(userId);
  if (polled) s.viewport.polledAt = Date.now(); // a page polling frames counts as watching
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
    const watching = s.viewport.viewers > 0 || Date.now() - (s.viewport.polledAt || 0) < 5000;
    const fps = watching ? Math.max(1, CONFIG.screencast.maxFps) : 1;
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

// ---------------------------------------------------------------------------
// Google Maps lead scraper (no Gmail needed)
// ---------------------------------------------------------------------------

const MAPS_SELECTORS = {
  feed: 'div[role="feed"]',
  placeLink: 'div[role="feed"] a.hfpxzc', // one per place in the result list; aria-label = name
  listEnd: 'div[role="feed"] span.HlvSq', // "You've reached the end of the list."
  placeTitle: 'h1.DUwDvf',
  consentAccept: 'form[action*="consent"] button, button[aria-label*="Accept all" i]',
};

/**
 * Reads the open place panel (right of the list, or the whole page on a place's own page).
 * Missing fields are left empty. Without `name`, the first panel with a title is read.
 */
async function readPlacePanel(page, name) {
  const panel = name
    ? page.locator(`div[role="main"][aria-label="${name.replace(/["\\]/g, '\\$&')}"]`).first()
    : page.locator(`div[role="main"]:has(${MAPS_SELECTORS.placeTitle})`).first();
  await panel.locator('h1').first().waitFor({ timeout: 8000 });
  // Contact rows load a moment after the title.
  await panel
    .locator('button[data-item-id="address"], a[data-item-id="authority"], button[data-item-id^="phone:tel:"]')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  return panel.evaluate((el) => {
    const q = (s) => el.querySelector(s);
    const text = (s) => (q(s) ? q(s).textContent.trim() : '');
    const attr = (s, a) => (q(s) ? q(s).getAttribute(a) || '' : '');
    const reviewsLabel = [...el.querySelectorAll('[aria-label]')]
      .map((e) => e.getAttribute('aria-label'))
      .find((l) => /^[\d,.]+\s+reviews?$/i.test(l.trim()));
    return {
      category: text('button.DkEaL'),
      rating: text('div.F7nice span[aria-hidden="true"]'),
      reviews: reviewsLabel ? reviewsLabel.replace(/[^\d]/g, '') : '',
      phone: attr('button[data-item-id^="phone:tel:"]', 'aria-label').replace(/^Phone:\s*/i, '').trim(),
      website: attr('a[data-item-id="authority"]', 'href'),
      address: attr('button[data-item-id="address"]', 'aria-label').replace(/^Address:\s*/i, '').trim(),
    };
  });
}

/**
 * Second try for a place whose panel showed no phone and no website (e.g. a sponsored
 * listing opens a shorter panel): opens the place's own page in a new tab and reads it there.
 */
async function readPlacePage(context, url) {
  const tab = await context.newPage();
  try {
    await tab.goto(url + (url.includes('?') ? '&' : '?') + 'hl=en', { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
    await tab.locator(MAPS_SELECTORS.placeTitle).first().waitFor({ timeout: 10000 });
    return await readPlacePanel(tab, null);
  } catch {
    return {};
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * Searches Google Maps for "<query> in <location>" and collects up to `limit` businesses:
 * name, category, rating, reviews, phone, website, address and the Maps link.
 */
async function mapsSearch(page, task, log) {
  const search = task.location ? `${task.query} in ${task.location}` : task.query;
  log.action(`Opening Google Maps and searching "${search}"`);
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(search)}?hl=en`, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.actionTimeoutMs,
  });
  if (/consent\.google\./.test(page.url())) {
    log.info('Accepting Google\'s cookie notice');
    await page.locator(MAPS_SELECTORS.consentAccept).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForURL(/google\.[^/]+\/maps/, { timeout: CONFIG.actionTimeoutMs }).catch(() => {});
  }
  await page.locator(`${MAPS_SELECTORS.feed}, ${MAPS_SELECTORS.placeTitle}`).first().waitFor({ timeout: CONFIG.actionTimeoutMs });

  // The search matched one exact place: Maps opens it directly instead of a list.
  if (!(await page.locator(MAPS_SELECTORS.feed).count())) {
    const name = (await page.locator(MAPS_SELECTORS.placeTitle).first().textContent()).trim();
    const lead = { name, ...(await readPlacePanel(page, name).catch(() => ({}))), url: page.url() };
    log.success(`Found 1 business: ${name}`);
    return { query: task.query, location: task.location, leads: [lead] };
  }

  // 1. Scroll the result list until it holds enough places (or Maps has no more).
  log.action(`Loading up to ${task.limit} businesses from the list`);
  let count = 0;
  let unchanged = 0;
  for (let i = 0; i < 60; i++) {
    count = await page.locator(MAPS_SELECTORS.placeLink).count();
    if (count >= task.limit || (await page.locator(MAPS_SELECTORS.listEnd).count())) break;
    const before = count;
    await page.locator(MAPS_SELECTORS.feed).evaluate((feed) => feed.scrollBy(0, feed.scrollHeight));
    await sleep(1200);
    count = await page.locator(MAPS_SELECTORS.placeLink).count();
    unchanged = count === before ? unchanged + 1 : 0;
    if (unchanged >= 4) break; // nothing new after ~5 s: end of the results
  }
  const places = await page
    .locator(MAPS_SELECTORS.placeLink)
    .evaluateAll((links, max) => links.slice(0, max).map((a) => ({ name: a.getAttribute('aria-label') || '', url: a.href })), task.limit);
  if (!places.length) {
    log.success(`No businesses found for "${search}"`);
    return { query: task.query, location: task.location, leads: [] };
  }
  log.info(`Found ${places.length} businesses, reading their details…`);

  // 2. Open each place to read its phone, website and address.
  const leads = [];
  const seen = new Set();
  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    let details = {};
    try {
      const link = page.locator(MAPS_SELECTORS.placeLink).nth(i);
      await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await link.click({ timeout: 10000 });
      details = await readPlacePanel(page, place.name);
    } catch {
      // handled below: the place's own page is tried next
    }
    if (!details.phone && !details.website) {
      const again = await readPlacePage(page.context(), place.url.split('?')[0]);
      Object.keys(again).forEach((k) => {
        if (again[k] && !details[k]) details[k] = again[k];
      });
      if (!details.address && !details.phone && !details.website) {
        log.warn(`Could not read the details of "${place.name}"; kept its name and link`);
      }
    }
    const lead = {
      name: place.name,
      category: details.category || '',
      rating: details.rating || '',
      reviews: details.reviews || '',
      phone: details.phone || '',
      website: details.website || '',
      address: details.address || '',
      url: place.url.split('?')[0],
    };
    const key = `${lead.name}|${lead.address}`.toLowerCase();
    if (seen.has(key)) continue; // sponsored places can appear twice
    seen.add(key);
    leads.push(lead);
    log.info(`${leads.length}. ${lead.name}${lead.phone ? ` · ${lead.phone}` : ''}`);
  }

  const withPhone = leads.filter((l) => l.phone).length;
  const withSite = leads.filter((l) => l.website).length;
  log.success(`Collected ${leads.length} lead(s): ${withPhone} with a phone number, ${withSite} with a website`);
  return { query: task.query, location: task.location, leads };
}

// ---------------------------------------------------------------------------
// Website contact extractor (no Gmail needed)
// ---------------------------------------------------------------------------

const SOCIAL_SITES = {
  facebook: /(^|\.)facebook\.com$/,
  instagram: /(^|\.)instagram\.com$/,
  linkedin: /(^|\.)linkedin\.com$/,
  x: /(^|\.)(twitter|x)\.com$/,
  youtube: /(^|\.)youtube\.com$/,
  tiktok: /(^|\.)tiktok\.com$/,
};
// Share buttons and the site builder's own pages are not the business's profile.
const NOT_A_PROFILE = /\/(sharer|share|intent|dialog|plugins|hashtag|watch|embed|tr)(\b|\/|\.php)|[?&](u|url)=/i;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|avif|css|js)$|@(example|domain|email|yourdomain|sentry|wixpress|sentry-next)\.|^(name|email|your|you|user|info@example)@/i;

/** Reads emails, phones and links from the open page. Runs inside the browser. */
function readContactsInPage() {
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const emails = new Set();
  const phones = new Set();
  const links = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^mailto:/i.test(href)) {
      try {
        decodeURIComponent(href.slice(7).split('?')[0]).split(/[,;]/).forEach((e) => emails.add(e.trim()));
      } catch {
        /* bad encoding */
      }
    } else if (/^tel:/i.test(href)) {
      phones.add(href.slice(4).replace(/%20/g, ' ').trim());
    } else if (/^https?:/i.test(a.href)) {
      links.push({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
  });
  // Cloudflare hides emails as data-cfemail="<hex>" (XOR with the first byte).
  document.querySelectorAll('[data-cfemail]').forEach((el) => {
    const h = el.getAttribute('data-cfemail') || '';
    const key = parseInt(h.slice(0, 2), 16);
    let s = '';
    for (let i = 2; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key);
    emails.add(s);
  });
  const text = document.body ? document.body.innerText : '';
  (text.match(EMAIL) || []).forEach((e) => emails.add(e));
  // Phone numbers written as text, only when the page has no tel: links (text matches are noisier).
  const textPhones = phones.size
    ? []
    : (text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}/g) || [])
        .filter((p) => {
          const digits = p.replace(/\D/g, '').length;
          return digits >= 10 && digits <= 13;
        })
        .slice(0, 3);
  const siteName = document.querySelector('meta[property="og:site_name"]');
  return {
    title: document.title || '',
    siteName: siteName ? siteName.getAttribute('content') || '' : '',
    emails: [...emails],
    phones: [...phones, ...textPhones],
    links,
  };
}

/** Aborts requests of `page` to the server itself or a private network, and pictures / fonts / video. */
async function blockPrivateHosts(page, { skipMedia = true } = {}) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (!/^(data|blob|about):/i.test(url) && !normalizeSiteUrl(url)) return route.abort('blockedbyclient');
    // Only the text and links are needed: skipping pictures, fonts and video makes sites open much faster.
    if (skipMedia && ['image', 'font', 'media'].includes(route.request().resourceType())) return route.abort();
    return route.continue();
  });
}

/** Opens `url` and returns what it shows, or throws when the page can't be opened. */
async function readSitePage(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (response && response.status() >= 400) throw new Error(`the site answered ${response.status()}`);
  await page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
  await sleep(500); // footers with contact details often render a moment later
  return page.evaluate(readContactsInPage);
}

/**
 * "2146127292" -> "214-612-7292", "+12146127292" -> "+1 214-612-7292". Numbers already
 * written with spaces, dashes or brackets stay as they are.
 */
function formatPhone(p) {
  const t = p.trim();
  if (/[\s().-]/.test(t)) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return t;
}

/** Keeps real, unique emails (lowercase) and phones (unique by their digits). */
function cleanContacts(emails, phones) {
  const okEmails = [...new Set(emails.map((e) => e.toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '')))]
    .filter((e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) && !JUNK_EMAIL.test(e))
    .slice(0, 10);
  const byDigits = new Map();
  phones.forEach((p) => {
    const digits = p.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15 && !byDigits.has(digits.slice(-10))) byDigits.set(digits.slice(-10), formatPhone(p));
  });
  return { emails: okEmails, phones: [...byDigits.values()].slice(0, 5) };
}

/**
 * Visits each website (home page, then its contact page) and collects emails, phone
 * numbers, social profiles and the contact page link. One site after the other: Chrome
 * slows down background tabs so much that parallel tabs were measured 2x slower.
 */
async function websiteContacts(page, task, log) {
  await blockPrivateHosts(page);
  const sites = [];
  for (let i = 0; i < task.urls.length; i++) {
    sites.push(await checkSite(page, task.urls[i], `${i + 1}/${task.urls.length}`, log));
  }
  const withEmail = sites.filter((s) => s.emails.length).length;
  log.success(`Checked ${sites.length} website(s): ${withEmail} with an email address`);
  return { sites };
}

/** One website for websiteContacts(). Never throws: problems end up in `site.error`. */
async function checkSite(page, url, label, log) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  log.action(`${label}: opening ${host}`);
  const site = { website: url, name: '', emails: [], phones: [], socials: {}, contactPage: '', error: '' };
  try {
    const home = await readSitePage(page, url);
    const finalHost = new URL(page.url()).hostname.replace(/^www\./, '');
    site.name = (home.siteName || home.title.split(/\s[|–—-]\s/)[0]).trim().slice(0, 120);
    let emails = home.emails;
    let phones = home.phones;
    let links = home.links;

    // The contact page (same site): "Contact", "Contact us", "/contact-us", "Get in touch"...
    const contact = home.links.find((l) => {
      try {
        const u = new URL(l.href);
        return u.hostname.replace(/^www\./, '') === finalHost && u.pathname !== '/' &&
          (/contact|get-in-touch|reach-us/i.test(u.pathname) || /^(contact|contact us|get in touch|reach us)$/i.test(l.text));
      } catch {
        return false;
      }
    });
    if (contact) {
      site.contactPage = contact.href.split('#')[0];
      try {
        const more = await readSitePage(page, site.contactPage);
        emails = emails.concat(more.emails);
        phones = phones.concat(more.phones);
        links = links.concat(more.links);
      } catch {
        // keep what the home page had
      }
    }

    Object.assign(site, cleanContacts(emails, phones));
    links.forEach((l) => {
      let u;
      try {
        u = new URL(l.href);
      } catch {
        return;
      }
      const h = u.hostname.toLowerCase();
      Object.keys(SOCIAL_SITES).forEach((k) => {
        if (!site.socials[k] && SOCIAL_SITES[k].test(h) && u.pathname.length > 1 && !NOT_A_PROFILE.test(u.pathname + u.search)) {
          // facebook.com/profile.php?id=... is only a profile with its id
          const id = /\/profile\.php$/i.test(u.pathname) && u.searchParams.get('id');
          site.socials[k] = id ? `${u.origin}${u.pathname}?id=${id}` : `${u.origin}${u.pathname}`.replace(/\/$/, '');
        }
      });
    });
    const found = [
      site.emails.length && `${site.emails.length} email${site.emails.length > 1 ? 's' : ''}`,
      site.phones.length && `${site.phones.length} phone${site.phones.length > 1 ? 's' : ''}`,
      Object.keys(site.socials).length && `${Object.keys(site.socials).length} social`,
    ].filter(Boolean);
    log.info(`${host}: ${found.length ? found.join(', ') : 'no contact details found'}`);
  } catch (err) {
    site.error = /net::ERR_NAME_NOT_RESOLVED/.test(err.message)
      ? 'Website not found'
      : /Timeout/i.test(err.message)
        ? 'The website took too long to open'
        : /blockedbyclient|ERR_BLOCKED/i.test(err.message)
          ? 'This address is not allowed'
          : `Could not open it (${err.message.split('\n')[0].slice(0, 80)})`;
    log.warn(`${host}: ${site.error}`);
  }
  return site;
}

// ---------------------------------------------------------------------------
// Amazon product researcher (no Gmail needed)
// ---------------------------------------------------------------------------

const AMAZON_URL = 'https://www.amazon.com';

/** Amazon shows a captcha page instead of results when it suspects a bot. */
async function checkAmazonBlock(page) {
  const blocked = await page
    .locator('form[action*="validateCaptcha"], #captchacharacters')
    .count()
    .catch(() => 0);
  if (blocked) {
    throw new AgentError('SITE_BLOCKED', 'Amazon asked for a captcha (too many requests from this server). Try again in a while.');
  }
}

/**
 * Amazon hides prices of products it can't ship to the visitor's country, so the delivery
 * location is set to a US ZIP code (New York, 10001) once; it stays in the user's browser
 * profile. Best effort: if it fails, the search runs anyway (some prices may be missing).
 */
async function ensureUsDelivery(page, log) {
  const where = ((await page.locator('#glow-ingress-line2').first().textContent().catch(() => '')) || '').trim();
  if (!where || /\b\d{5}\b/.test(where)) return false;
  log.info(`Setting Amazon's delivery location to the US (was "${where}") so prices show`);
  try {
    await page.goto(`${AMAZON_URL}/?language=en_US`, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
    await sleep(1500);
    await page.locator('#nav-global-location-popover-link, #glow-ingress-block').first().click({ timeout: 10000 });
    await page.locator('#GLUXZipUpdateInput').waitFor({ timeout: 10000 });
    await page.fill('#GLUXZipUpdateInput', '10001');
    await page.locator('#GLUXZipUpdate input, #GLUXZipUpdate').first().click({ timeout: 10000 });
    await sleep(2500);
    await page.locator('#GLUXConfirmClose, [name="glowDoneButton"]').first().click({ timeout: 3000 }).catch(() => {});
    await sleep(1000);
    return true;
  } catch {
    log.warn('Could not set a US delivery location; some prices may be missing');
    return false;
  }
}

/** Reads the product cards on an Amazon search results page. Runs inside the browser. */
function readAmazonResults(max) {
  const price = (box) => {
    const p = box && box.querySelector('.a-price:not(.a-text-price)');
    if (!p) return '';
    const whole = (p.querySelector('.a-price-whole') || {}).textContent || '';
    const fraction = (p.querySelector('.a-price-fraction') || {}).textContent || '';
    const symbol = (p.querySelector('.a-price-symbol') || {}).textContent || '';
    return whole ? `${symbol}${whole.replace(/[^\d,]/g, '')}${fraction ? `.${fraction}` : ''}` : '';
  };
  const seen = new Set();
  const out = [];
  document.querySelectorAll('[data-component-type="s-search-result"][data-asin]').forEach((card) => {
    const asin = card.getAttribute('data-asin');
    if (!asin || seen.has(asin) || out.length >= max) return;
    seen.add(asin);
    const text = (sel) => ((card.querySelector(sel) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const ratingText = text('i[class*="a-icon-star"] .a-icon-alt, span.a-icon-alt');
    const ratingsEl = card.querySelector('[aria-label$="ratings"], [aria-label$="rating"]');
    out.push({
      asin,
      title: text('h2 span') || text('h2'),
      price: price(card),
      rating: (ratingText.match(/^[\d.]+/) || [''])[0],
      ratings: ratingsEl ? ratingsEl.getAttribute('aria-label').replace(/[^\d]/g, '') : '',
      boughtPastMonth: ((card.innerText.match(/([\d.,]+K?\+?) bought in past month/i) || [])[1]) || '',
      sponsored: /\bSponsored\b/.test(card.innerText.slice(0, 300)),
      url: `https://www.amazon.com/dp/${asin}`,
    });
  });
  return out;
}

/** Reads an Amazon product page: brand, price, rating, features, Best Sellers Rank, top reviews. */
function readAmazonProduct() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const core = document.querySelector('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop');
  const p = core && core.querySelector('.a-price:not(.a-text-price)');
  let price = '';
  if (p) {
    const whole = text(p.querySelector('.a-price-whole')).replace(/[^\d,]/g, '');
    const fraction = text(p.querySelector('.a-price-fraction'));
    price = whole ? `${text(p.querySelector('.a-price-symbol'))}${whole}${fraction ? `.${fraction}` : ''}` : '';
  }
  const rank = [...document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #detailBulletsWrapper_feature_div li, #prodDetails tr')]
    .map(text)
    .find((t) => /Best Sellers Rank/i.test(t));
  return {
    brand: text(document.querySelector('#bylineInfo')).replace(/^(Visit the |Brand: )/i, '').replace(/ Store$/i, ''),
    price,
    rating: ((document.querySelector('#acrPopover') || { getAttribute: () => '' }).getAttribute('title') || '').replace(/ out of.*/, ''),
    ratings: text(document.querySelector('#acrCustomerReviewText')).replace(/[^\d]/g, ''),
    features: [...document.querySelectorAll('#feature-bullets li span.a-list-item')].map(text).filter(Boolean).slice(0, 6),
    bestSellersRank: rank ? rank.replace(/^Best Sellers Rank:?\s*/i, '').replace(/\s*\(See Top 100[^)]*\)/g, '').slice(0, 160) : '',
    // Amazon's own AI summary of all reviews ("Customers say"), shown even when review texts need a login.
    customersSay: text(
      [...document.querySelectorAll('p, span, div')].find(
        (e) => !e.children.length && e.getAttribute('data-testid') !== 'aspect-summary' && /^Customers (find|like|appreciate|say|mention|are|report|praise|have)/.test(e.textContent.trim())
      )
    ).slice(0, 600),
    // "Performance (3.1K)" with a positive / negative / mixed icon
    aspects: [...document.querySelectorAll('[data-testid="aspect-label"]')].slice(0, 10).map((l) => {
      const holder = l.closest('button, a, li') || l.parentElement;
      const icon = holder && holder.querySelector('[data-testid^="aspect-icon"]');
      const m = l.textContent.trim().match(/^(.*?)\s*\(([\d.,]+K?)\)$/);
      return {
        name: m ? m[1] : l.textContent.trim(),
        mentions: m ? m[2] : '',
        sentiment: icon ? icon.getAttribute('data-testid').replace('aspect-icon-', '') : '',
      };
    }),
    reviews: [...document.querySelectorAll('[data-hook="review"]')].slice(0, 8).map((r) => ({
      stars: (text(r.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')).match(/^[\d.]+/) || [''])[0],
      title: text(r.querySelector('[data-hook="reviewTitle"], [data-hook="review-title"] span:last-child')).slice(0, 150),
      text: text(r.querySelector('[data-hook="reviewRichContentContainer"], [data-hook="review-body"]')).replace(/\s*Read more\s*$/i, '').slice(0, 600),
      // "Reviewed in the United States on September 29, 2026" -> "September 29, 2026"
      date: (text(r.querySelector('[data-hook="review-date"]')).match(/ on (.+)$/) || ['', ''])[1],
      verified: !!r.querySelector('[data-hook="avp-badge"]'),
    })),
  };
}

/**
 * Searches Amazon.com and collects up to `limit` products (title, price, rating, ratings,
 * "bought in past month", sponsored). With `details`, also opens the top products for
 * their brand, features, Best Sellers Rank and top reviews (the AI then compares them).
 */
async function amazonResearch(page, task, log) {
  // Prices in US dollars and pages in English, wherever the server is.
  await page.context().addCookies([
    { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
    { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' },
  ]);
  log.action(`Searching Amazon for "${task.query}"`);
  const searchUrl = `${AMAZON_URL}/s?k=${encodeURIComponent(task.query)}&language=en_US`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
  await checkAmazonBlock(page);
  if (await ensureUsDelivery(page, log)) {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
    await checkAmazonBlock(page);
  }
  try {
    await page.locator('[data-component-type="s-search-result"]').first().waitFor({ timeout: 15000 });
  } catch {
    await checkAmazonBlock(page);
    if (/something went wrong/i.test(await page.title())) {
      throw new AgentError('SITE_BLOCKED', 'Amazon refused the search ("Sorry! Something went wrong"). Try again in a while.');
    }
    log.success(`No products found for "${task.query}"`);
    return { query: task.query, products: [] };
  }
  const products = await page.evaluate(readAmazonResults, task.limit);
  log.info(`Found ${products.length} products${products.filter((p) => p.sponsored).length ? ` (${products.filter((p) => p.sponsored).length} sponsored)` : ''}`);

  if (task.details) {
    const top = products.slice(0, AMAZON_MAX_DETAILS);
    log.action(`Reading features and reviews of the top ${top.length}`);
    for (let i = 0; i < top.length; i++) {
      const product = top[i];
      try {
        await page.goto(`${product.url}?language=en_US`, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
        await checkAmazonBlock(page);
        await page.locator('span#productTitle').waitFor({ timeout: 15000 });
        // Reviews sit far down and load when scrolled to.
        await page.locator('#reviewsMedley, #cm-cr-dp-review-list, #customerReviews').first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await page.locator('[data-hook="review"]').first().waitFor({ timeout: 5000 }).catch(() => {});
        const d = await page.evaluate(readAmazonProduct);
        product.brand = d.brand;
        product.price = d.price || product.price;
        product.rating = d.rating || product.rating;
        product.ratings = d.ratings || product.ratings;
        product.features = d.features;
        product.bestSellersRank = d.bestSellersRank;
        product.reviews = d.reviews;
        product.customersSay = d.customersSay;
        product.aspects = d.aspects;
        const read = d.reviews.length ? `${d.reviews.length} reviews read` : d.customersSay ? "customers' summary read (reviews need an Amazon login)" : 'no reviews shown';
        log.info(`${i + 1}. ${product.title.slice(0, 60)}${product.price ? ` · ${product.price}` : ''} · ${read}`);
      } catch (err) {
        if (err instanceof AgentError) throw err; // captcha: stop instead of hammering Amazon
        log.warn(`Could not open "${product.title.slice(0, 50)}"; kept the search details`);
      }
    }
  }
  const priced = products.filter((p) => p.price).length;
  log.success(`Collected ${products.length} product(s)${priced < products.length ? `: ${priced} with a price (no price = not sold right now)` : ''}`);
  return { query: task.query, products };
}

// ---------------------------------------------------------------------------
// Price monitor (Gmail only for the optional alert email)
// ---------------------------------------------------------------------------

/**
 * Reads a product's price from a shop page. Runs inside the browser. In order:
 * schema.org Product data (JSON-LD), price meta tags, microdata, and as a last resort the
 * largest "$12.34" shown near the top of the page (source "page": less certain).
 */
function readShopPrice() {
  const meta = (sel) => (document.querySelector(sel) || {}).content || '';
  const title = meta('meta[property="og:title"]') || document.title || '';
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (/Product/i.test([].concat(node['@type'] || []).join(','))) found.push(node);
    if (node['@graph']) walk(node['@graph']);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      walk(JSON.parse(s.textContent));
    } catch {
      /* broken JSON on the page */
    }
  });
  for (const p of found) {
    const offers = [].concat(p.offers || []).flatMap((o) => (o && o.offers ? [].concat(o.offers) : [o]));
    const o = offers.find((x) => x && (x.price || x.lowPrice || (x.priceSpecification && x.priceSpecification.price)));
    if (o) {
      return {
        title: p.name || title,
        amount: String(o.price || o.lowPrice || o.priceSpecification.price),
        currency: o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || '',
        availability: String(o.availability || ''),
        source: 'product data',
      };
    }
  }
  const metaPrice = meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]') || meta('meta[itemprop="price"]');
  if (metaPrice) {
    return {
      title,
      amount: metaPrice,
      currency: meta('meta[property="product:price:currency"]') || meta('meta[property="og:price:currency"]') || meta('meta[itemprop="priceCurrency"]'),
      availability: meta('meta[property="product:availability"]') || meta('meta[property="og:availability"]'),
      source: 'product data',
    };
  }
  const itemprop = document.querySelector('[itemprop="price"]');
  if (itemprop) {
    return { title, amount: itemprop.getAttribute('content') || itemprop.textContent.trim(), currency: meta('[itemprop="priceCurrency"]'), availability: '', source: 'product data' };
  }
  // Last resort: the biggest price-looking text in the top part of the page (not crossed out).
  const RE = /^(?:US)?\s?([$€£₹])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || el.children.length > 3) continue; // skips SVG and other non-HTML nodes
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 16) continue;
    const m = t.match(RE);
    if (!m) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.top < 0 || r.top > 1400) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.textDecorationLine.includes('line-through')) continue;
    const size = parseFloat(st.fontSize) || 0;
    if (!best || size > best.size) best = { size, symbol: m[1], amount: m[2] };
  }
  if (best) {
    const currency = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' }[best.symbol] || '';
    return { title, amount: best.amount, currency, availability: '', source: 'page' };
  }
  return { title, amount: '', currency: '', availability: '', source: '' };
}

/** "$1,299.00" / "1299" -> 1299 (US number format). */
const priceValue = (s) => {
  const n = parseFloat(String(s || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const SYMBOL = { USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'CA$', AUD: 'A$' };
const showPrice = (value, currency) => (value === null ? '' : `${SYMBOL[currency] || (currency ? `${currency} ` : '$')}${value.toFixed(2)}`);

/** Reads one product link: { title, value, currency, inStock, source } or throws. */
async function readProductPrice(page, url, state, log) {
  const host = new URL(url).hostname;
  if (/(^|\.)amazon\.com$/.test(host)) {
    if (!state.amazonReady) {
      await page.context().addCookies([
        { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
        { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' },
      ]);
      await page.goto(`${AMAZON_URL}/?language=en_US`, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
      await checkAmazonBlock(page);
      await ensureUsDelivery(page, log);
      state.amazonReady = true;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.actionTimeoutMs });
    await checkAmazonBlock(page);
    await page.locator('span#productTitle').waitFor({ timeout: 15000 });
    const d = await page.evaluate(() => {
      const t = (sel) => ((document.querySelector(sel) || {}).textContent || '').replace(/\s+/g, ' ').trim();
      const core = document.querySelector('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #apex_desktop');
      const p = core && core.querySelector('.a-price:not(.a-text-price)');
      const whole = p ? ((p.querySelector('.a-price-whole') || {}).textContent || '').replace(/[^\d,]/g, '') : '';
      const fraction = p ? ((p.querySelector('.a-price-fraction') || {}).textContent || '') : '';
      return { title: t('span#productTitle'), amount: whole ? `${whole}.${fraction || '00'}` : '', availability: t('#availability') };
    });
    return {
      title: d.title,
      value: priceValue(d.amount),
      currency: 'USD',
      inStock: d.availability ? !/unavailable|out of stock/i.test(d.availability) : null,
      source: 'amazon',
    };
  }
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  if (response && response.status() >= 400) throw new Error(`the shop answered ${response.status()}`);
  await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
  await sleep(1200); // prices are often filled in by script
  if (/robot or human|are you a human|captcha|access denied|just a moment|attention required/i.test(await page.title())) {
    throw new Error('the shop blocked automated visits');
  }
  const d = await page.evaluate(readShopPrice);
  return {
    title: d.title,
    value: priceValue(d.amount),
    currency: d.currency || 'USD',
    inStock: d.availability ? /InStock|in stock|LimitedAvailability|PreOrder/i.test(d.availability) : null,
    source: d.source,
  };
}

/**
 * Checks the current price of each product link and, when a price is at or below its
 * target, emails an alert from the user's Gmail (if `alertEmail` is set and Gmail is connected).
 */
async function priceCheck(page, task, log) {
  await blockPrivateHosts(page, { skipMedia: false });
  const state = {};
  const items = [];
  for (let i = 0; i < task.items.length; i++) {
    const { url, target } = task.items[i];
    const host = new URL(url).hostname.replace(/^www\./, '');
    log.action(`${i + 1}/${task.items.length}: checking ${host}`);
    const item = { url, title: '', price: '', value: null, currency: '', inStock: null, target, hit: false, source: '', error: '' };
    try {
      const d = await readProductPrice(page, url, state, log);
      Object.assign(item, { title: (d.title || '').trim().slice(0, 200), value: d.value, currency: d.currency, inStock: d.inStock, source: d.source });
      item.price = showPrice(d.value, d.currency);
      item.hit = target !== null && d.value !== null && d.value <= target;
      if (d.value === null) item.error = 'No price found on this page';
      log.info(`${host}: ${item.price || 'no price found'}${item.inStock === false ? ' (out of stock)' : ''}${item.hit ? ` · at or below your target ${showPrice(target, d.currency)}` : ''}`);
    } catch (err) {
      if (err instanceof AgentError && err.code === 'SITE_BLOCKED') item.error = 'Amazon asked for a captcha; try again later';
      else if (/ERR_NAME_NOT_RESOLVED/.test(err.message)) item.error = 'Website not found';
      else if (/blockedbyclient|ERR_BLOCKED/i.test(err.message)) item.error = 'This address is not allowed';
      else item.error = `Could not read the price (${err.message.split('\n')[0].slice(0, 80)})`;
      log.warn(`${host}: ${item.error}`);
    }
    items.push(item);
  }

  const hits = items.filter((it) => it.hit);
  let alerted = '';
  if (hits.length && task.alertEmail) {
    let gmail;
    try {
      log.action(`Emailing a price alert to ${task.alertEmail}`);
      gmail = await openPage(page.context()); // Gmail needs the usual browser identity
      await openGmail(gmail, log);
      const lines = hits.map((h) => `- ${h.title || h.url}\n  Now ${h.price} (your target: ${showPrice(h.target, h.currency)})\n  ${h.url}`);
      await sendEmail(
        gmail,
        {
          type: 'send_email',
          to: [task.alertEmail],
          subject: hits.length === 1 ? `Price drop: ${(hits[0].title || 'your product').slice(0, 60)} is now ${hits[0].price}` : `Price drop on ${hits.length} products you watch`,
          body: `Hello,\n\nThese products are at or below your target price:\n\n${lines.join('\n\n')}\n\nSent by your AI Browser Agent price monitor.`,
          sendMode: 'send',
        },
        log
      );
      alerted = task.alertEmail;
    } catch (err) {
      log.warn(`Price alert email not sent: ${err.code === 'LOGIN_REQUIRED' ? 'Gmail is not connected' : err.message.split('\n')[0].slice(0, 120)}`);
    } finally {
      if (gmail && !gmail.isClosed()) await gmail.close().catch(() => {});
    }
  }
  const found = items.filter((it) => it.value !== null).length;
  log.success(`Checked ${items.length} product(s): ${found} with a price${hits.length ? `, ${hits.length} at or below target` : ''}`);
  return { items, alerted };
}

const TASK_HANDLERS = {
  send_email: sendEmail,
  search_email: searchEmail,
  read_inbox: readInbox,
  maps_search: mapsSearch,
  website_contacts: websiteContacts,
  amazon_research: amazonResearch,
  price_check: priceCheck,
  // AI-driven website tester (qa-agent.js, OpenAI Agents SDK); loaded only when used.
  qa_test: (page, task, log) => require('./qa-agent').runQaAgent(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }),
  // AI agent for any task on a website (web-agent.js); loaded only when used.
  web_task: (page, task, log) => require('./web-agent').runWebAgent(page, task, log, { normalizeSiteUrl, blockPrivateHosts, AgentError }),
};

/** Tasks that work inside the user's Gmail (they need "Connect Gmail" first). */
const GMAIL_TASKS = new Set(['send_email', 'search_email', 'read_inbox']);
const needsGmail = (task) => GMAIL_TASKS.has(task.type);

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
      if (needsGmail(task) && !s.contextPromise && !fs.existsSync(s.profileDir)) {
        throw new AgentError('LOGIN_REQUIRED', 'Gmail is not connected yet. Click "Connect Gmail" on the dashboard, sign in once, then retry.');
      }
      const context = await getContext(s, log);
      page = await openPage(context, { regularUserAgent: !['amazon_research', 'price_check', 'qa_test', 'web_task'].includes(task.type) });
      stopScreencast = await startScreencast(page, log, s);
      if (needsGmail(task)) {
        await openGmail(page, log);
        await readAccount(page, s); // remember who is signed in (used to sign emails)
      }
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
    if (s && task && needsGmail(task) && (!err || err.code === 'LOGIN_REQUIRED')) {
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
