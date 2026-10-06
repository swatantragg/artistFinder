// Browser flow: outreach (Rahul: Batch 002 → contact → claim → activation → ARM → repeat), through the ArtistFinder v2 UI,
// on the fictional fixture workspace of the e2e server (tests/e2e/run.mjs starts it). Needs google-chrome.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FILES = process.env.E2E_FILES ?? fileURLToPath(new URL('./files/', import.meta.url));
const SHOTS = process.env.SHOTS ?? `${HERE}shots`;
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:4100/';
const b = await launch();
let step = 0;
const T0 = Date.now(); const log = m => console.log(`${String(++step).padStart(2)}. [${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const expect = async (cond, msg) => { if (!(await b.evaluate(cond))) throw new Error(`Expectation failed: ${msg}`); };
const dialog = (t) => b.waitFor(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(t)})`, 8000, `dialog "${t}"`);
const dialogGone = () => b.waitFor(`!document.querySelector('[role=dialog]')`, 8000, 'dialog closed');
const tab = (t) => b.click(t, '[role=tablist]');
/** Click a button inside the smallest card that contains `text`. */
const clickIn = async (text, label) => {
  const ok = await b.evaluate(`(() => {
    const cards = [...document.querySelectorAll('div')].filter(d => d.innerText.includes(${JSON.stringify(text)}) && [...d.querySelectorAll('button')].some(x => x.innerText.trim() === ${JSON.stringify(label)}));
    cards.sort((a, b) => a.innerText.length - b.innerText.length);
    const btn = cards[0] && [...cards[0].querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
    if (!btn) return false; btn.click(); return true;
  })()`);
  if (!ok) throw new Error(`No "${label}" near "${text}"`);
  await b.sleep(150);
};
try {
  await b.go(BASE + '#/');
  await b.waitText('Total artists', 20000);
  await b.waitText('1,251');
  log('Dashboard shows 1,251 artists');

  await b.click('Artists', 'nav');
  await b.waitText('Action required');
  await b.evaluate(`(() => { const el = document.querySelector('input[aria-label="Search artists"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Rahul Sharma'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.waitFor(`(() => { const r = [...document.querySelectorAll('tbody tr')].map(x => x.innerText); return r.length >= 2 && r[0].startsWith('Rahul Sharma') && r[1].startsWith('Rahul Sharma') && r.slice(0, 2).join(' ').includes('A099'); })()`, 8000, 'two Rahul Sharma records first');
  log('Search "Rahul Sharma" → the two same-name artists first (A001 + A099, never merged)');
  await b.clickRow('source A001');
  await b.waitText('Where the artist stands');
  await expect(`document.body.innerText.includes('12 songs') && document.body.innerText.includes('Waiting for Evidence') && document.body.innerText.includes('No verified contact route found')`, 'Rahul: 12 songs, Waiting for Evidence with the waiting record');
  log('Dossier: 12 songs, Waiting for Evidence, waiting record (no verified route)');
  const rahulUrl = await b.evaluate('location.hash');

  await tab('Evidence');
  await b.waitText('Manual research');
  // Opens on its own when the artist has research records and was never searched.
  if (!(await b.text()).includes('Research checklist')) await b.click('Manual research');
  await b.waitText('Research checklist');
  await b.shot(`${SHOTS}/10-research.png`, true);
  log('Evidence tab: manual research checklist kept as the fallback');
  await tab('Timeline');
  await b.waitText('Every meaningful change');
  await expect(`document.body.innerText.includes('Route rejected') && document.body.innerText.includes('Route exhausted')`, 'timeline shows tried routes');
  log('Timeline shows previous research and failed routes');

  await b.click('Imports', 'nav');
  await b.waitText('Upload export');
  await b.setFile('input[type=file]', `${FILES}goongoonalo_export_batch_002.csv`);
  await b.waitText('goongoonalo_export_batch_002.csv');
  await b.click('Process file');
  await b.waitFor(`/Import B\\d+ complete/.test(document.body.innerText)`, 20000, 'import complete');
  await expect(`/New songs\\s*5/.test(document.body.innerText) && /Reopened artists\\s*1/.test(document.body.innerText) && /New artists\\s*0/.test(document.body.innerText)`, 'B002: 5 new songs, 0 new artists, 1 reopened');
  await b.shot(`${SHOTS}/11-import-b002.png`, true);
  log('Physical upload of Batch 002: 5 new songs, no new artist, 1 reopened');
  await tab('Reopened');
  await b.waitText('is now a verified route');
  log('Result tab "Reopened" explains why');

  await b.go(BASE + rahulUrl);
  await b.waitText('Where the artist stands');
  await b.waitText('17 songs');
  await expect(`document.body.innerText.includes('Researching') && document.body.innerText.includes('something changed since the last review')`, 'Rahul reopened, Researching');
  await b.shot(`${SHOTS}/12-rahul-reopened.png`);
  log('Rahul: 17 songs, Researching, reopen banner with the reasons');

  await b.go(BASE + '#/queue');
  await b.waitText('Contact Joshua Singh for an introduction to Rahul Sharma');
  await b.shot(`${SHOTS}/13-queue.png`);
  log('Queue shows: Contact Joshua Singh for an introduction to Rahul Sharma');
  await clickIn('Contact Joshua Singh for an introduction to Rahul Sharma', 'Do it');
  await dialog('Record contact: Rahul Sharma');
  await b.fill('Channel', 'Phone');
  await b.fill('Recipient', 'Rahul Sharma');
  await b.fill('Message / action', 'Joshua introduced us; call with Rahul');
  await b.fill('Result', 'Conversation Confirmed');
  await b.fill('Evidence', 'Call 14:10, Rahul confirmed his songs');
  await b.shot(`${SHOTS}/14-record-contact.png`);
  await b.click('Save contact attempt', '[role=dialog]');
  await dialogGone();
  log('Task done from the queue: conversation confirmed via Joshua');

  await b.go(BASE + rahulUrl.replace(/\?.*$/, '') + '?tab=claims');
  await b.waitText('Claim record');
  await expect(`document.body.innerText.includes('Contact Confirmed')`, 'Contact Confirmed');
  await b.click('Send Claim Invitation'); await dialog('Send claim invitation'); await b.click('Record invitation', '[role=dialog]'); await dialogGone();
  await b.waitFor(`document.body.innerText.includes('Claim Invited')`, 8000, 'Claim Invited');
  await b.click('Record Submission'); await dialog('Record claim submission'); await b.fill('Claim request ID', 'CR-2026-9001'); await b.click('Record submission', '[role=dialog]'); await dialogGone();
  await b.click('Send to Review'); await dialog('Send claim to review'); await b.click('Send to review', '[role=dialog]'); await dialogGone();
  await b.click('Approve Claim'); await dialog('Review claim'); await b.fill('What was checked', 'ID and label letter match profile A001'); await b.click('Save decision', '[role=dialog]'); await dialogGone();
  await b.waitFor(`document.body.innerText.includes('Approved')`, 8000, 'approved');
  await expect(`!document.body.innerText.includes('Stage: Claimed')`, 'not claimed yet');
  await b.click('Verify Backend Claim'); await dialog('Verify claim in the backend'); await b.fill('Backend reference', 'ADMIN-A001-CLAIMED'); await b.click('Save verification', '[role=dialog]'); await dialogGone();
  await b.waitFor(`document.body.innerText.includes('Backend Verified') && document.body.innerText.includes('Completed')`, 8000, 'claim completed');
  await expect(`[...document.querySelectorAll('section')].some(s => s.innerText.includes('IDENTITY') && s.innerText.includes('VERIFIED') && s.innerText.includes('Backend-verified claim'))`, 'claim completed → identity VERIFIED');
  await b.shot(`${SHOTS}/15-claims.png`, true);
  log('Claim: invited → submitted → review → approved → backend verified → Claimed, identity VERIFIED');

  await tab('Activation');
  await b.waitText('Feature and first use');
  await b.click('Verify access'); await dialog('Confirm profile access'); await b.fill('How access was confirmed', 'Logged in on a call'); await b.click('Confirm access', '[role=dialog]'); await dialogGone();
  await b.click('Choose feature'); await dialog('Choose a useful feature'); await b.click('Save plan', '[role=dialog]'); await dialogGone();
  await b.click('Record first use'); await dialog('Record first use'); await b.click('Login only', '[role=dialog]'); await b.fill('Evidence', 'Logged in, nothing changed'); await b.click('Save', '[role=dialog]'); await dialogGone();
  await b.waitText('login alone is not activation');
  log('Login only recorded: activation stays pending');
  await b.click('Record first use'); await dialog('Record first use'); await b.fill('Backend event / reference', 'EVT-90001'); await b.fill('Evidence', 'Profile photo and bio updated'); await b.click('Save', '[role=dialog]'); await dialogGone();
  await b.waitFor(`document.body.innerText.includes('Activated')`, 8000, 'activated');
  await b.click('Handover to ARM'); await dialog('Hand over to ARM'); await b.click('Hand over', '[role=dialog]'); await dialogGone();
  await tab('Overview');
  await b.waitText('Ongoing ARM');
  await b.shot(`${SHOTS}/16-arm.png`, true);
  log('Access → Correct Profile → meaningful use → Activated → Ongoing ARM');

  await b.click('Imports', 'nav');
  await b.waitText('Upload export');
  await b.setFile('input[type=file]', `${FILES}goongoonalo_export_batch_003.csv`);
  await b.waitText('goongoonalo_export_batch_003.csv');
  await b.click('Process file');
  await b.waitText('Repeat upload detected. Existing batch retained. No duplicate work created.', 20000);
  await b.shot(`${SHOTS}/17-repeat.png`);
  log('Batch 003 (exact copy): repeat detected, nothing created');

  await b.go(BASE + rahulUrl.replace(/\?.*$/, ''));
  await b.waitText('17 songs');
  await expect(`document.body.innerText.includes('Ongoing ARM')`, 'still ARM after repeat');
  log('Rahul still 17 songs and Ongoing ARM after the repeat');
  console.log('\nE2E PASSED. Browser console issues:', b.logs.length ? b.logs : 'none');
} catch (e) {
  console.error('\nE2E FAILED at step', step + 1, ':', e.message);
  await b.shot(`${SHOTS}/fail.png`);
  console.log('console:', b.logs);
  process.exitCode = 1;
}
b.close();
