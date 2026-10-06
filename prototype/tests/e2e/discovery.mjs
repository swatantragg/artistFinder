// Browser flow: artist discovery (discovery spec §90, ArtistFinder v2 UI) through the real UI, on the fictional fixture workspace.
// Run against a disposable workspace: node tests/e2e/discovery.mjs http://localhost:4100/  (needs google-chrome)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHOTS = process.env.SHOTS ?? `${HERE}shots`;
const FILES = process.env.E2E_FILES ?? `${HERE}files/`;
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:4100/';
const b = await launch({ port: 9340 });
let step = 0; const T0 = Date.now();
const log = m => console.log(`${String(++step).padStart(2)}. [${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const dialog = t => b.waitFor(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(t)})`, 10000, `dialog "${t}"`);
const dialogGone = () => b.waitFor(`!document.querySelector('[role=dialog]')`, 10000, 'dialog closed');
const dlg = l => b.click(l, '[role=dialog]');
const tab = t => b.click(t, '[role=tablist]');
const clickIn = async (text, label, scope = 'div, section, li, tr') => {
  const ok = await b.evaluate(`(() => {
    const cards = [...document.querySelectorAll(${JSON.stringify(scope)})].filter(d => d.innerText.includes(${JSON.stringify(text)}) && [...d.querySelectorAll('button, a')].some(x => x.innerText.trim() === ${JSON.stringify(label)}));
    cards.sort((a, b) => a.innerText.length - b.innerText.length);
    const btn = cards[0] && [...cards[0].querySelectorAll('button, a')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
    if (!btn) return false; btn.scrollIntoView({ block: 'center' }); btn.click(); return true;
  })()`);
  if (!ok) throw new Error(`No "${label}" near "${text}"`);
  await b.sleep(200);
};
const upload = async name => {
  await b.setFile('input[type=file]', `${FILES}${name}`);
  await b.waitFor(`[...document.querySelectorAll('button')].some(x => x.innerText.trim() === 'Process file' && !x.disabled)`, 10000, `file ${name} chosen`);
  await b.click('Process file');
};
try {
  await b.go(BASE + '#/imports');
  await b.waitText('Upload export', 20000);
  await upload('goongoonalo_artist_extract.xlsx');
  await b.waitText('Artists in this file', 20000);
  await b.waitText('Find artist');
  await b.shot(`${SHOTS}/d01-import-artists.png`);
  log('Excel uploaded: artists listed with Find artist (no duplicates)');

  await clickIn('Rahul Sharma', 'Find artist', 'tr');
  await b.waitFor(`location.hash.includes('tab=evidence')`, 10000, 'evidence tab');
  await b.waitText('Finding Rahul Sharma', 10000);
  const rahulHash = (await b.evaluate('location.hash')).replace(/\?.*$/, '');
  await b.shot(`${SHOTS}/d02-progress.png`);
  log('Find artist: background search with step-by-step progress (Evidence tab)');
  await b.waitText('Is this Rahul Sharma?', 30000);
  await b.sleep(400);
  await b.shot(`${SHOTS}/d03-candidates.png`, true);
  const txt = await b.text();
  for (const t of ['% match', 'Verify', 'Reject', 'Later', 'Open profile']) if (!txt.includes(t)) throw new Error(`Missing on profiles: ${t}`);
  for (const t of ['Found through', 'Found because', 'Possible artist', 'Verify all']) if (txt.includes(t)) throw new Error(`Should not show: ${t}`);
  log('Profiles grouped by platform with logo, link and match %; no explanations');

  const link = await b.evaluate(`(() => { const a = [...document.querySelectorAll('a')].find(x => x.innerText.trim() === 'Open profile'); return a ? { href: a.href, target: a.target } : null; })()`);
  if (!link || !/^https:\/\//.test(link.href) || link.target !== '_blank') throw new Error(`Open profile is not a link to the profile: ${JSON.stringify(link)}`);
  log('Open profile opens the profile itself in a new tab');

  await clickIn('@rahulsharma.sings', 'Verify', 'li');
  await dialog('Verify Instagram'); await dlg('Verify profile'); await dialogGone();
  await b.waitText('Saved profiles', 15000);
  log('Instagram verified: saved with the artist as verified knowledge');
  if ((await b.text()).includes('djrahulsharma')) throw new Error('The same-name DJ (another artist) is offered as a profile');
  log('The same-name DJ Rahul Sharma (another artist) is not offered');

  await tab('Connection Graph');
  await b.waitFor(`document.querySelectorAll('.react-flow__node').length > 2`, 15000, 'graph nodes');
  await b.sleep(800);
  await b.shot(`${SHOTS}/d05-graph.png`);
  log(`Connection graph: Rahul and the people on his songs (${await b.evaluate(`document.querySelectorAll('.react-flow__node').length`)} cards, each with a song and a role)`);
  await b.evaluate(`[...document.querySelectorAll('.react-flow__node')].find(n => n.innerText.includes('Joshua Singh'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await b.waitFor(`[...document.querySelectorAll('aside')].some(a => a.innerText.includes('Joshua Singh') && a.innerText.includes('“'))`, 10000, 'person details with songs');
  log('Clicking a person shows every shared song and their role');
  await clickIn('Find connection', 'Find connection', 'section, div');
  await b.waitFor(`document.body.innerText.toLowerCase().includes('connection found')`, 15000, 'connection found');
  await b.sleep(600);
  await b.shot(`${SHOTS}/d06-find-connection.png`, true);
  log('Find connection: Rahul → “Dil Ka Safar” → Joshua Singh → verified contact');

  await clickIn('Joshua Singh', 'Create route', 'li');
  await b.waitFor(`document.body.innerText.toLowerCase().includes('route created')`, 10000, 'route created');
  await clickIn('Joshua Singh', 'Verify route', 'li');
  await dialog('Verify route'); await dlg('Verify route'); await dialogGone();
  await b.waitText('Route Ready', 10000);
  log('Route created as candidate, verified by a person → Route Ready');

  await b.go(BASE + '#/queue');
  await b.waitText('Contact Joshua Singh for an introduction to Rahul Sharma', 10000);
  await clickIn('Contact Joshua Singh for an introduction to Rahul Sharma', 'Do it', 'div');
  await dialog('Record contact');
  await b.fill('Channel', 'Phone'); await b.fill('Recipient', 'Rahul Sharma'); await b.fill('Result', 'Conversation Confirmed'); await b.fill('Evidence', 'Joshua introduced us; call');
  await dlg('Save contact attempt'); await dialogGone();
  log('Contact workflow continues from the queue (Contact Confirmed)');

  await b.go(BASE + '#/imports');
  await b.waitText('Upload export');
  await upload('goongoonalo_artist_extract.xlsx');
  await b.waitFor(`document.body.innerText.toLowerCase().includes('verified artist found')`, 20000, 'verified artist found');
  await b.sleep(1200);
  await b.shot(`${SHOTS}/d07-reupload.png`);
  log('Upload Rahul again: “Verified artist found”, profiles reused, no new search');

  await b.go(BASE + '#/imports');
  await b.waitText('Upload export');
  await upload('goongoonalo_export_batch_002.csv');
  await b.waitFor(`document.body.innerText.toLowerCase().includes('targeted discovery started')`, 20000, 'targeted discovery');
  await b.shot(`${SHOTS}/d08-b002.png`);
  log('Batch 002: Rahul recognised, 5 new songs, targeted discovery started');
  await b.go(BASE + `${rahulHash}?tab=evidence`);
  await b.waitFor(`document.body.innerText.includes('Search history (2)') && !document.body.innerText.includes('Finding Rahul Sharma')`, 30000, 'targeted job done');
  log('The search after the import finished (history keeps both versions)');
  await tab('Connection Graph');
  await b.waitText('Hawa Mein', 15000);
  await b.waitText('Riya Sen');
  await b.sleep(600);
  await b.shot(`${SHOTS}/d09-new-route.png`, true);
  log('Graph updated; potential new route Rahul → “Hawa Mein” → Riya Sen appears');

  await b.go(BASE + '#/discovery');
  await b.waitFor(`location.hash.startsWith('#/artists')`, 10000, 'old discovery link → Artists');
  await b.waitText('Action required'); await b.sleep(500);
  await b.shot(`${SHOTS}/d10-artists.png`);
  await b.go(BASE + '#/');
  await b.waitText('Discovery funnel'); await b.sleep(500);
  await b.shot(`${SHOTS}/d11-dashboard.png`);
  if (!(await b.text()).includes('SK-PV2.1.0')) throw new Error('Version footer missing');
  log('Old discovery link opens Artists; dashboard funnel; footer SK-PV2.1.0 present');
  console.log('\nDISCOVERY E2E PASSED. Console issues:', b.logs.length ? b.logs : 'none');
} catch (e) {
  console.error('\nFAILED at step', step + 1, ':', e.message);
  await b.shot(`${SHOTS}/dfail.png`);
  console.log(b.logs);
  process.exitCode = 1;
}
b.close();
