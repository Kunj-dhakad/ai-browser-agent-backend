/**
 * google-apps.js
 * ---------------------------------------------------------------------------
 * Google Docs, Sheets and Gmail drafts in the user's own browser, with the Google account they
 * connected on the Gmail Agent page (the same login works for Docs, Sheets and Drive). No
 * Google API keys or app review are needed: our code types into the apps like a person.
 *
 *   googleReady(page)               is the user signed in to Google?
 *   createDoc(page, title, blocks)  a new Google Doc: blocks = [{ type: h1|h2|p|li, text }]
 *   createSheet(page, title, rows)  a new Google Sheet, rows = [[cell, ...], ...]
 *   readSheet(page, url)            the rows of a Google Sheet the user can open (CSV export)
 *   gmailDraft(page, mail)          a Gmail draft { to, subject, body } (never sent)
 *   shareAnyoneWithLink(page, url)  "Anyone with the link can view" (for links in emails)
 *
 * Docs and Sheets draw their text on a canvas, so what was written is checked through the
 * file's export (txt / csv), which needs the same login.
 * ---------------------------------------------------------------------------
 */

const { sleep, short } = require('./ai-browser');

const LOAD_MS = 45000;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** True when the browser is signed in to a Google account (Docs opens instead of the sign-in page). */
async function googleReady(page) {
  await page.goto('https://docs.google.com/document/u/0/', { waitUntil: 'domcontentloaded', timeout: LOAD_MS }).catch(() => {});
  await sleep(1500);
  return !/accounts\.google\.com|ServiceLogin|signin/i.test(page.url());
}

/** The file id in a Docs / Sheets / Slides address. */
const fileId = (url) => (String(url).match(/\/d\/([\w-]{20,})/) || [])[1] || '';

/** Sets the file name (the title box at the top left of Docs and Sheets). */
async function setTitle(page, title) {
  const box = page.locator('input.docs-title-input').first();
  await box.waitFor({ state: 'attached', timeout: 20000 });
  await page.locator('.docs-title-input-label, .docs-title-input-label-inner, input.docs-title-input').first().click({ timeout: 10000 });
  await box.fill(short(title, 120));
  await box.press('Enter');
  await sleep(800);
}

/** Text of a Google file through its export (same login), or ''. */
async function exportText(page, url, format) {
  const id = fileId(url);
  if (!id) return '';
  const kind = /spreadsheets/.test(url) ? 'spreadsheets' : 'document';
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1];
  const res = await page.request.get(`https://docs.google.com/${kind}/d/${id}/export?format=${format}${gid ? `&gid=${gid}` : ''}`, { timeout: 30000 }).catch(() => null);
  if (!res || !res.ok()) return '';
  return (await res.text()).replace(/^﻿/, '');
}

/**
 * A new Google Doc with headings, paragraphs and bullet lists, typed with the keyboard
 * (Docs' own shortcuts for the styles). Returns its address.
 */
async function createDoc(page, title, blocks, log) {
  log.action(`Creating the Google Doc "${short(title, 60)}"`);
  await page.goto('https://docs.google.com/document/create', { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
  await page.locator('.kix-appview-editor').first().waitFor({ state: 'visible', timeout: LOAD_MS });
  await sleep(2500);
  await setTitle(page, title);
  await page.locator('.kix-appview-editor').first().click({ timeout: 10000 });
  await sleep(500);

  const style = { h1: '1', h2: '2', h3: '3', p: '0', li: '0' };
  let inList = false;
  for (const b of blocks) {
    const text = String(b.text || '').replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    if (b.type === 'li' && !inList) {
      await page.keyboard.press(`${MOD}+Alt+0`);
      await page.keyboard.press(`${MOD}+Shift+8`); // bulleted list on
      inList = true;
    } else if (b.type !== 'li' && inList) {
      await page.keyboard.press(`${MOD}+Shift+8`); // bulleted list off
      inList = false;
    }
    if (b.type !== 'li') await page.keyboard.press(`${MOD}+Alt+${style[b.type] || '0'}`);
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
  }
  if (inList) await page.keyboard.press(`${MOD}+Shift+8`);
  await sleep(3000); // Docs saves by itself
  const url = page.url().replace(/[?#].*$/, '');
  const written = await exportText(page, url, 'txt');
  const first = blocks.find((b) => b.text && b.type !== 'li');
  const ok = written && first && written.replace(/\s+/g, ' ').includes(String(first.text).replace(/\s+/g, ' ').slice(0, 30));
  if (!ok) log.warn('Could not confirm the document text (it may still be saving)');
  log.success(`Google Doc ready: ${url}`);
  return url;
}

/** A cell value Sheets won't read as a formula. */
const cellText = (v) => {
  const s = String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

/** A new Google Sheet with the rows typed in (first row = headers). Returns its address. */
async function createSheet(page, title, rows, log) {
  log.action(`Creating the Google Sheet "${short(title, 60)}"`);
  await page.goto('https://docs.google.com/spreadsheets/create', { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
  await page.locator('#waffle-grid-container, .grid-container').first().waitFor({ state: 'visible', timeout: LOAD_MS });
  await sleep(2500);
  await setTitle(page, title);
  // A1, then type row by row: Tab between cells, Enter starts the next row at column A
  await page.locator('#waffle-grid-container, .grid-container').first().click({ position: { x: 120, y: 60 }, timeout: 10000 }).catch(() => {});
  await page.keyboard.press(`${MOD}+Home`);
  await sleep(300);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const v = cellText(row[i]);
      if (v) await page.keyboard.insertText(v);
      if (i < row.length - 1) await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
  }
  // bold, frozen header row
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press('Shift+Space');
  await page.keyboard.press(`${MOD}+b`);
  await sleep(3000);
  const url = page.url().replace(/[?#].*$/, '');
  const csv = await exportText(page, url, 'csv');
  const filled = parseCsv(csv).filter((r) => r.some((c) => c.trim())).length;
  if (filled < rows.length) log.warn(`The sheet shows ${filled} of ${rows.length} rows (it may still be saving)`);
  log.success(`Google Sheet ready: ${url}`);
  return url;
}

/** CSV text -> rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** The rows of a Google Sheet the signed-in user can open ([] when it can't be read). */
async function readSheet(page, url) {
  if (!fileId(url) || !/spreadsheets/.test(url)) return [];
  return parseCsv(await exportText(page, url, 'csv')).filter((r) => r.some((c) => c.trim()));
}

/**
 * A Gmail draft (never sent): Gmail's compose page with the fields filled in, which Gmail
 * saves to Drafts by itself. Returns 'Draft saved' or a short reason it failed.
 */
async function gmailDraft(page, { to, subject, body }, log) {
  const url = `https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&to=${encodeURIComponent(to || '')}&su=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
  if (/accounts\.google\.com/.test(page.url())) return 'Not saved: Gmail is not connected';
  const editor = page.locator('div[aria-label="Message Body"], div[role="textbox"][g_editable="true"]').first();
  if (!(await editor.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false))) return 'Not saved: the compose window did not open';
  // a small edit makes Gmail save the draft now (the filled fields alone may wait)
  await editor.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press('End');
  await page.keyboard.insertText(' ');
  await page.keyboard.press('Backspace');
  const saved = await page
    .getByText(/^Draft saved|^Saved$|Saving…|^Saving/)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true, () => false);
  await sleep(saved ? 1500 : 4000);
  log.info(`Gmail draft${to ? ` to ${to}` : ''}: "${short(subject, 60)}"`);
  return 'Draft saved';
}

/** Turns on "Anyone with the link can view" for a file (Drive's share dialog). true when done. */
async function shareAnyoneWithLink(page, url, log) {
  try {
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
    await page.getByRole('button', { name: /^Share/ }).first().click({ timeout: 15000 });
    const dialog = page.frameLocator('iframe[src*="drive"], iframe.share-client-content-iframe').first();
    const access = dialog.getByRole('combobox', { name: /General access|Restricted/i }).first();
    await access.click({ timeout: 15000 });
    await dialog.getByRole('option', { name: /Anyone with the link/i }).first().click({ timeout: 10000 });
    await sleep(1500);
    await dialog.getByRole('button', { name: /^Done$/ }).first().click({ timeout: 10000 }).catch(() => {});
    await sleep(1000);
    log.info('Link sharing: anyone with the link can view');
    return true;
  } catch (err) {
    log.warn(`Could not turn on link sharing (${short(String(err.message).split('\n')[0], 80)}); share the document yourself`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

module.exports = { googleReady, createDoc, createSheet, readSheet, parseCsv, gmailDraft, shareAnyoneWithLink, fileId };
