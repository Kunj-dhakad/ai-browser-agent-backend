# AI Browser Agent

An Express + Playwright service that takes a natural-language command such as

> Send an email to John with subject 'Meeting' and message 'Let's catch up at 4 PM'

and carries it out in a real Chromium browser. It opens Gmail, clicks **Compose**, types the recipient, subject and message one character at a time, and clicks **Send**. Each step is logged, and the logs can be streamed live to a Next.js (or any other) frontend.

```
Next.js frontend ──POST /api/agent/stream──▶ Express (server.js)
      ▲                                           │
      └──────── Server-Sent Events (logs) ◀────── agent.js ──▶ Playwright ──▶ Chromium ──▶ Gmail
                                                     │
                                          .browser-profile/ (saved Google session)
```

## Features

- **AI planning with OpenAI:** a single sentence in English, Hindi or Hinglish (rough notes are fine) becomes a Gmail task through Structured Outputs. The AI writes a complete, well-structured English email: specific subject, greeting, short paragraphs and a closing, in a tone that fits the recipient, keeping every fact you gave. It is signed with `SENDER_NAME` when set. The AI also summarizes search and inbox results in English. Without a key, a rule-based parser handles simple English commands.
- **Natural-language commands:** send or draft emails, search Gmail, and read the inbox.
- **Persistent login:** `chromium.launchPersistentContext` keeps the Google cookies in `USER_DATA_DIR`. You sign in and pass 2FA once, and the session is reused after that.
- **Human-like typing:** each character is typed with a random delay, with longer pauses after spaces and punctuation.
- **Headed or headless:** `HEADLESS=false` shows the browser for local testing. `HEADLESS=true` runs without a window on servers.
- **Step logs:** you can get all logs at once in the JSON response, or stream them live over Server-Sent Events.
- **Production details:** API-key auth, a CORS allow-list, a task queue (one browser action at a time), typed error codes, screenshots on failure, a `DRY_RUN` mode and graceful shutdown.

## Project structure

| File | Purpose |
| --- | --- |
| `server.js` | Express API: CORS, auth, JSON and SSE endpoints, shutdown |
| `planner.js` | OpenAI "brain": `planTask(prompt)` turns a request into a task and writes the email; `createSummarizer()` summarizes results |
| `scheduler.js` | Scheduled tasks (once / daily / weekly), saved to `data/schedules.json` and checked every 15 seconds |
| `agent.js` | Browser lifecycle, Gmail automation, `runBrowserAgent(task | prompt)`, `validateTask`, rule-based fallback parser, CLI |
| `.env.example` | All configuration options with comments |
| `package.json` | Dependencies and scripts |

## Installation

Requirements: **Node.js 18+**.

```bash
# 1. Install the Node dependencies
npm install

# 2. Download the Chromium build Playwright uses
npx playwright install chromium
#    On a bare Linux server, also install the system libraries Chromium needs:
#    npx playwright install --with-deps chromium

# 3. Create your config
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
#    then edit .env: set AGENT_API_KEY, OPENAI_API_KEY and CORS_ORIGINS
```

## First-time Gmail login (one time only)

Google requires a real person to sign in the first time. Run this on the machine that will run the agent:

```bash
npm run login
```

A browser window opens on Gmail. Sign in, complete 2FA, and wait for your inbox to load. Then close the window. The session is now stored in `USER_DATA_DIR` (default `./.browser-profile`), and later runs, including headless ones, stay logged in.

> **If Google says "This browser or app may not be secure":** set `BROWSER_CHANNEL=chrome` in `.env` to use your installed Google Chrome, then run `npm run login` again. Use the same channel for both the login and the server.

> **Headless servers with no display:** run `npm run login` on your own computer, then copy the whole `.browser-profile` folder to the server, using the same `BROWSER_CHANNEL`. On Linux you can also run the login under `xvfb-run npm run login` over VNC.

**Security:** `.browser-profile/` holds live Google session cookies, so anyone with the folder can use your mailbox. It is listed in `.gitignore`. Keep it private.

## Running

```bash
npm start          # production
npm run dev        # restarts automatically when files change (Node 18.11+)
```

Test a command from the terminal without the API:

```bash
node agent.js "Send an email to john@example.com with subject 'Hi' and message 'Hello from the agent'"
```

**Tip:** set `DRY_RUN=true` (or start the command with "Draft ...") while you test. The agent fills in the email and saves it to **Drafts** without sending it.

## Supported commands

| Example prompt | Interpreted as |
| --- | --- |
| `Send an email to John with subject 'Meeting' and message 'Let's catch up at 4 PM'` | send to the contact "John" (resolved by Gmail autocomplete) |
| `Send an email to jane@x.com and bob@y.org with subject "Q3" and body "Report attached"` | send to several addresses |
| `Email sarah@acme.io saying 'Running 5 min late'` | send with no subject |
| `Send a message to John Smith with subject Lunch and message see you at noon` | values without quotes also work |
| `Draft an email to jane@x.com with subject 'Hi' and message 'Hello'` | save to Drafts, don't send |
| `Search for emails from amazon about invoices` | Gmail search `from:amazon invoices` |
| `Find unread emails from boss@corp.com` | Gmail search `is:unread from:boss@corp.com` |
| `Show me the latest 3 emails in my inbox` / `Check my inbox` | read the newest inbox rows |

Recipients given by name are typed into the **To** field, and the agent picks the first suggestion from Gmail's contact list. If no contact matches, the task fails with `CONTACT_NOT_FOUND` instead of guessing. Use a full email address when the name could match more than one contact.

Before you run a command, you can check how it will be understood with `POST /api/agent/parse`.

## API

Every `/api/*` route needs the `x-api-key` header whenever `AGENT_API_KEY` is set. The request body is `{ "prompt": "...", "dryRun": false }`. `dryRun` is optional; set it to `true` to save that one email to Drafts instead of sending it. The dashboard's Safe mode switch uses it.

The ready-made dashboard in `../frontend` already calls these endpoints through a server-side proxy. The `fetch` example below is for building your own client.

### `GET /health`
```json
{ "status": "ok", "uptimeSeconds": 42, "agent": { "browserRunning": true, "pendingTasks": 0, "headless": true, "dryRun": false } }
```

### `POST /api/agent/parse`
Interprets the prompt only. No browser is opened.
```json
{ "success": true, "task": { "type": "send_email", "to": ["John"], "subject": "Meeting", "body": "Let's catch up at 4 PM", "sendMode": "send" } }
```

### `POST /api/agent/run`
Runs the task and replies once it is done.
```bash
curl -X POST http://localhost:4000/api/agent/run \
  -H "Content-Type: application/json" -H "x-api-key: YOUR_KEY" \
  -d '{"prompt":"Send an email to john@example.com with subject \"Hi\" and message \"Hello!\""}'
```
```json
{
  "success": true,
  "task": { "type": "send_email", "to": ["john@example.com"], "subject": "Hi", "body": "Hello!", "sendMode": "send" },
  "result": { "sent": true, "to": ["john@example.com"], "subject": "Hi" },
  "durationMs": 14210,
  "logs": [
    { "step": 1, "time": "...", "level": "info",    "message": "Received prompt: \"...\"" },
    { "step": 2, "time": "...", "level": "success", "message": "Interpreted task: send_email", "data": { } },
    { "step": 3, "time": "...", "level": "action",  "message": "Launching Chromium (headless) with profile ..." },
    { "step": 4, "time": "...", "level": "action",  "message": "Navigating to Gmail" },
    { "step": 5, "time": "...", "level": "success", "message": "Gmail inbox loaded (session restored from persistent profile)" },
    { "step": 6, "time": "...", "level": "action",  "message": "Clicking \"Compose\"" },
    { "step": 8, "time": "...", "level": "action",  "message": "Typing recipient \"john@example.com\"" },
    { "step": 10, "time": "...", "level": "action", "message": "Typing subject: \"Hi\"" },
    { "step": 12, "time": "...", "level": "action", "message": "Clicking \"Send\"" },
    { "step": 13, "time": "...", "level": "success","message": "Email sent to john@example.com (Gmail: \"Message sent\")" }
  ]
}
```

### `POST /api/agent/stream` (live logs)
Takes the same input. The response is `text/event-stream` with these events:

- `event: log`: one log entry, `{ step, time, level, message, data? }`
- `event: result`: the final report, in the same shape as `/api/agent/run`

The endpoint uses POST so the prompt and API key never appear in URLs. Read the stream with `fetch` in your Next.js app:

```ts
// app/lib/runAgent.ts (Next.js client component helper)
export async function runAgent(prompt: string, onLog: (log: any) => void) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_AGENT_URL}/api/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.NEXT_PUBLIC_AGENT_KEY! },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok || !res.body) throw new Error(`Agent request failed: ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result: any = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split('\n\n');
    buffer = events.pop()!; // keep any incomplete event for the next chunk
    for (const raw of events) {
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (!event || !data) continue; // heartbeat comments
      if (event === 'log') onLog(JSON.parse(data));
      if (event === 'result') result = JSON.parse(data);
    }
  }
  return result;
}
```

> A `NEXT_PUBLIC_*` key is visible to anyone who opens your site. For a public deployment, call the agent from a Next.js **Route Handler or Server Action** that adds the `x-api-key` header on the server, and keep the key in a server-only env var.

### `GET /api/agent/screencast` (live browser preview)
A long-lived SSE stream of what the agent's browser shows, captured with Chrome's DevTools screencast. It works in headless and headed mode.

- `event: state`: `{ active, url }`, sent when a task starts, navigates or ends
- `event: frame`: `{ data, width, height, url, time }`, where `data` is a base64 JPEG (`<img src="data:image/jpeg;base64,...">`)

When a viewer connects, it immediately gets the current state and the most recent frame. Each viewer receives at most `SCREENCAST_MAX_FPS` frames per second. If a viewer's connection is slow, older frames are skipped so the picture never falls behind. The frames show your real mailbox, so the endpoint requires the API key like every other `/api` route.

### `POST /api/agent/plan` (AI)
Turns `{ "prompt": "..." }` into a task without running anything, so a person can review the AI-written email first.
```json
{ "success": true, "ai": true, "model": "gpt-4.1-mini",
  "task": { "type": "send_email", "to": ["rahul@gmail.com"], "subject": "Meeting moved to 4 PM tomorrow", "body": "Hi Rahul, ...", "sendMode": "send" },
  "summary": "Rahul ko kal 4 baje wali meeting ka email bhejunga" }
```
- The model answers with a strict JSON schema: `send_email | draft_email | search_email | read_inbox | needs_info | unsupported`.
- It is told never to invent email addresses. The result is still checked by `validateTask`.
- `needs_info` (for example, no recipient) and `unsupported` (for example, Google Maps) return `400` with the model's explanation in the user's language.
- OpenAI failures map to `AI_AUTH`, `AI_QUOTA`, `AI_RATE_LIMIT` (429), `AI_MODEL` and `AI_UNREACHABLE`/`AI_ERROR` (502).
- Without `OPENAI_API_KEY`, the rule-based parser is used and the response has `"ai": false`.

### Runs (used by the dashboard)
A run is a task that keeps going in the background and can be watched from any page. Reopening the page replays its logs instead of starting the task again. Runs are kept in memory for 1 hour (at most 50), and are lost when the server restarts.

| Endpoint | What it does |
| --- | --- |
| `POST /api/agent/runs` | Start a run. The body is a reviewed `{ "task": {...}, "prompt"?: "original words" }` **or** just `{ "prompt": "..." }` (planned with AI first), plus an optional `dryRun`. For search and inbox runs, the AI adds `result.summary` when enabled. It returns `202 { success, run: { id, status, task, ... } }` right away. Invalid input returns `400` (`INVALID_TASK` / `INVALID_PROMPT` / `UNSUPPORTED_TASK`) before any browser work starts |
| `GET /api/agent/runs` | Recent runs, newest first |
| `GET /api/agent/runs/:id` | One run with its logs and final report. Returns `404 RUN_NOT_FOUND` if it doesn't exist |
| `GET /api/agent/runs/:id/stream` | SSE. It sends `run` (summary), then replays past `log` events and streams new ones live, then sends `result` and closes |

Structured task shapes (validated by `validateTask` in `agent.js`):
```json
{ "type": "send_email", "to": ["a@b.com"], "subject": "Hi", "body": "Hello\nsecond line", "sendMode": "send" }
{ "type": "search_email", "query": "is:unread from:amazon", "limit": 10 }
{ "type": "read_inbox", "limit": 5 }
```
Because the form sends these fields directly, quotes, apostrophes and new lines in the message reach Gmail exactly as typed.

### Schedules
Run a planned task later or repeatedly. The task (for example, the AI-written email) is fixed when you create the schedule.

| Endpoint | What it does |
| --- | --- |
| `POST /api/agent/schedules` | `{ "task": {...}, "prompt"?: "...", "frequency": "once" \| "daily" \| "weekly", "time": "HH:MM", "date"?: "YYYY-MM-DD" (once), "weekday"?: 0-6 (weekly, 0 = Sunday) }` returns `201 { schedule }`. Invalid input returns `400 INVALID_SCHEDULE`, for example a time that has already passed |
| `GET /api/agent/schedules` | All schedules, soonest `nextRunAt` first, with `lastRunAt`, `lastRunId` and `lastStatus` (`running`, `success`, `error`, `missed`, `interrupted`) |
| `DELETE /api/agent/schedules/:id` | Remove a schedule |

- Times use the backend machine's local time zone.
- Schedules are saved in `data/schedules.json` (or `SCHEDULES_FILE`) and survive restarts. That file holds email text and addresses and is git-ignored.
- Every 15 seconds the scheduler starts any due schedule as a normal run, marked `scheduled: true` in the run list.
- If the backend was off at the scheduled time and more than an hour has passed, the occurrence is recorded as `missed` rather than sent late.

### Connect / disconnect Gmail from the dashboard
The Google sign-in page opens in the agent's own browser and is streamed through the normal live preview (`/api/agent/screencast`). The dashboard forwards the user's clicks and keys, so no VNC and no `npm run login` are needed, even on a headless server.

| Endpoint | What it does |
| --- | --- |
| `POST /api/agent/login/start` | Opens Google's sign-in page. Returns `409 ALREADY_LOGGED_IN` if already connected. While it is open, the task queue is held |
| `POST /api/agent/login/input` | `{ "type": "click", "x": 0-1, "y": 0-1 }` (fractions of the picture) · `{ "type": "type", "text": "…" }` · `{ "type": "key", "key": "Enter" }` (Enter, Tab, Backspace, Delete, Escape, arrows, Home, End) · `{ "type": "scroll", "deltaY": 300 }` |
| `GET /api/agent/login` | `{ active, url }` while signing in, otherwise `{ active: false, lastResult: { reason: success \| cancelled \| timeout \| closed } }` |
| `POST /api/agent/login/cancel` | Closes the sign-in page |
| `POST /api/agent/logout` | Visits Google's sign-out page, clears all cookies of the agent's profile and forgets the saved account |

- The sign-in finishes by itself as soon as Gmail's inbox loads, and the account name is saved at that point.
- A sign-in left open closes after 10 minutes.
- Google refuses sign-ins from Chromium's default headless shell ("This browser or app may not be secure"). In headless mode the agent therefore runs Chromium's **new headless** mode (`channel: "chromium"`) and presents a regular Chrome user agent and client-hint brands. With this setup, testing reached Google's password page.

### `GET /api/agent/session`
Reports whether the browser profile is signed in to Google. It checks Google's session cookies without opening a page. The result is cached for 60 seconds; `?refresh=1` skips the cache.
```json
{ "loggedIn": true, "checkedAt": "2026-09-23T10:47:55.308Z" }
```
If the check isn't possible, `loggedIn` is `null` and `reason` says why (for example `PROFILE_IN_USE` while `npm run login` is open).

### Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_PROMPT`, `INVALID_TASK`, `UNSUPPORTED_TASK` | 400 | The prompt or form task is empty, invalid, or couldn't be understood |
| `NEEDS_INFO` | 400 | The AI needs more information, such as a recipient |
| `AI_AUTH`, `AI_QUOTA`, `AI_MODEL`, `AI_UNREACHABLE`, `AI_ERROR` | 502 | OpenAI rejected the request or failed (bad key, no credit, unknown model, network) |
| `AI_RATE_LIMIT` | 429 | OpenAI rate limit. Retry shortly |
| `RUN_NOT_FOUND` | 404 | The run id is unknown (server restarted, or the run is older than 1 hour) |
| `UNAUTHORIZED` | 401 | The `x-api-key` header is missing or wrong |
| `CONTACT_NOT_FOUND` | 422 | Gmail autocomplete found no contact with that name |
| `LOGIN_REQUIRED` | 503 | The profile isn't signed in. Run `npm run login` |
| `PROFILE_IN_USE` | 503 | Another browser is using `USER_DATA_DIR` |
| `BROWSER_NOT_INSTALLED` | 503 | Run `npx playwright install chromium` |
| `TIMEOUT` | 504 | A Gmail element didn't appear within `ACTION_TIMEOUT_MS` |
| `SEND_FAILED` | 500 | Gmail rejected the message, for example because of an invalid address |

When a browser step fails, the agent saves a screenshot to `./screenshots/` and puts its path in the logs.

## Configuration (`.env`)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated list of allowed frontend origins (`*` allows all) |
| `AGENT_API_KEY` | *(empty)* | Shared secret for the `x-api-key` header. Always set this in production |
| `HEADLESS` | `true` | `false` shows the browser window |
| `USER_DATA_DIR` | `./.browser-profile` | Folder for the persistent browser profile (the saved session) |
| `BROWSER_CHANNEL` | *(bundled Chromium)* | `chrome` or `msedge` to use an installed browser |
| `TYPING_DELAY_MS` | `80` | Average delay between keystrokes |
| `SLOW_MO_MS` | `0` | Extra delay on every Playwright action, useful when watching the agent |
| `ACTION_TIMEOUT_MS` | `30000` | How long to wait for page elements |
| `DRY_RUN` | `false` | Save emails to Drafts instead of sending them |
| `OPENAI_API_KEY` | *(empty)* | OpenAI key. Empty means no AI (rule-based parser, English only) |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Any chat model with Structured Outputs support |
| `OPENAI_SUMMARIZE` | `true` | AI summary of search and inbox results. This sends the senders, subjects and snippets of those emails to OpenAI |
| `SENDER_NAME` | *(empty)* | Your name. When set, AI-written emails end with "Best regards," and this name. When empty, the email ends with the closing line only |
| `SCHEDULES_FILE` | `./data/schedules.json` | Where schedules are saved |
| `SCREENCAST_ENABLED` | `true` | Stream the live browser preview |
| `SCREENCAST_QUALITY` | `80` | JPEG quality of preview frames (1–100). Small text blurs below ~75 |
| `SCREENCAST_MAX_WIDTH` | `1366` | Frames wider than this are scaled down (1366 = native browser width) |
| `SCREENCAST_MAX_FPS` | `8` | Maximum preview frames per second for each viewer |

## Deployment notes

- **Where it can run:** the agent needs a long-running process with a writable disk for the browser profile. A VM, EC2, Railway, Render or Fly.io with a volume, or Docker all work. Serverless functions (Vercel or Amplify functions, Lambda) do **not** work: they have time limits, no persistent disk, and no Chromium. Host the Next.js frontend on Vercel or Amplify and this API somewhere else.
- **Docker:** start from the official `mcr.microsoft.com/playwright` image, which includes Chromium and its libraries, and mount `USER_DATA_DIR` as a volume.
- **One task at a time:** a browser profile can only be driven by one task at a time, so tasks run in order. Concurrent requests wait their turn (see `pendingTasks` in `/health`). To run more at once, start several instances, each with its own profile and account.
- **Behind a proxy:** turn off response buffering for `/api/agent/stream` (the server already sends `X-Accel-Buffering: no` for nginx). The server also sends a heartbeat comment every 15 seconds so idle connections stay open.
- **Gmail markup changes:** all Gmail selectors are kept in `SELECTORS` at the top of `agent.js`. If Google changes its interface, that is the only place to update.
- **Responsible use:** this agent sends real email from your account. Keep `AGENT_API_KEY` secret, use `DRY_RUN` while testing, and follow Google's Terms of Service. Automating accounts you don't own, or sending bulk or unsolicited mail, is not allowed.

## Extending

`parseCommand()` in `agent.js` is a rule-based parser with no external dependencies. To handle free-form requests, replace it with an LLM call that returns the same task shape (`{ type, to, subject, body, ... }`). To add a new action, write a handler `async (page, task, log) => result` and register it in `TASK_HANDLERS`.
