// Browser flow: the ArtistFinder walkthrough (spec v2 §50) through the real UI, on the fictional fixture workspace.
// Upload the media-library export → artists extracted → duplicates in Deduplicate → open Rahul → Find artist →
// verify → dossier tabs → graph + Find connection → Goongoonalo status → dashboard → upload Rahul again.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHOTS = process.env.SHOTS ?? `${HERE}shots`;
const FILES = process.env.E2E_FILES ?? `${HERE}files/`;
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:4100/';
const b = await launch({ port: 9345 });
let step = 0; const T0 = Date.now();
const log = m => console.log(`${String(++step).padStart(2)}. [${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const lower = t => `document.body.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`;
const waitLower = (t, ms = 15000) => b.waitFor(lower(t), ms, `text "${t}"`);
const dialog = t => b.waitFor(`document.querySelector('[role=dialog]')?.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`, 10000, `dialog "${t}"`);
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
const setInput = (aria, value) => b.evaluate(`(() => { const el = document.querySelector('input[aria-label=${JSON.stringify(aria)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const upload = async name => {
  await b.setFile('input[type=file]', `${FILES}${name}`);
  await b.waitFor(`[...document.querySelectorAll('button')].some(x => x.innerText.trim() === 'Process file' && !x.disabled)`, 10000, `file ${name} chosen`);
  await b.click('Process file');
};
const statText = label => b.evaluate(`(() => { const el = [...document.querySelectorAll('a, div, button')].filter(x => x.innerText.trim().startsWith(${JSON.stringify(label)})).sort((a, b) => a.innerText.length - b.innerText.length)[0]; return el ? el.innerText.replace(${JSON.stringify(label)}, '').trim().split('\\n')[0] : null; })()`);
try {
  await b.go(BASE + '#/imports');
  await b.waitText('Upload export', 30000);
  await upload('media_library_export.csv');
  await waitLower('import started', 10000).catch(() => undefined);
  await b.waitFor(`/Import B\\d+ complete/.test(document.body.innerText)`, 30000, 'import complete');
  await b.sleep(400);
  await b.shot(`${SHOTS}/v01-import-summary.png`, true);
  const txt = await b.text();
  for (const t of ['Rows received', 'Artists found', 'New artists', 'New collaborators', 'Possible duplicates', 'Reopened artists', 'Rows to review', 'How the file was read']) if (!txt.includes(t)) throw new Error(`Summary misses “${t}”`);
  log('Media-library export uploaded as a background job; summary with rows, artists, collaborators, duplicates, reopened');

  await b.click('Artists', 'nav');
  await waitLower('action required');
  await b.click('New', '[role=tablist]');
  await setInput('Search artists', 'Kabir Rathore');
  await b.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('Kabir Rathore') && r.innerText.includes('NEW'))`, 15000, 'Kabir Rathore NEW');
  await b.shot(`${SHOTS}/v02-artists-new.png`);
  log('Artists page shows the newly extracted artists (NEW filter)');
  await setInput('Search artists', 'INXDM2600104');
  await b.waitFor(`document.querySelector('tbody')?.innerText.includes('Sur & Saaz')`, 10000, 'ISRC search');
  log('Search by ISRC finds “Sur & Saaz” (a duo kept as one artist)');

  await b.click('Deduplicate', 'nav');
  await b.waitText('Rahul Sharma Music', 15000);
  await b.shot(`${SHOTS}/v03-dedupe.png`, true);
  await clickIn('Rahul Sharma Music', 'Keep separate', 'li');
  await dialog('Keep as separate artists'); await dlg('Keep as separate artists'); await dialogGone();
  await b.waitFor(`![...document.querySelectorAll('li')].some(l => l.innerText.includes('Rahul Sharma Music') && l.innerText.includes('Keep separate'))`, 10000, 'decided');
  log('Possible duplicate “Rahul Sharma Music” reviewed with evidence and conflicts, kept separate');

  await b.click('Artists', 'nav');
  await waitLower('action required');
  await setInput('Search artists', 'Rahul Sharma');
  await b.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('A000001') || r.innerText.includes('source A001'))`, 10000, 'Rahul row');
  await b.clickRow('source A001');
  await b.waitText('Where the artist stands', 15000);
  const rid = await b.evaluate(`location.hash.match(/artists\\/([^?/]+)/)[1]`);
  log('Opened Rahul Sharma: one dossier with identity, discovery and Goongoonalo shown separately');

  await b.click('Find artist');
  await b.waitFor(`location.hash.includes('tab=evidence')`, 10000, 'evidence tab');
  await waitLower('is this rahul sharma?', 40000);
  await b.sleep(400);
  await b.shot(`${SHOTS}/v04-candidates.png`, true);
  const ev = await b.text();
  for (const t of ['% match', 'Instagram', 'YouTube', 'Spotify', 'Open profile']) if (!ev.includes(t)) throw new Error(`Profiles miss “${t}”`);
  for (const t of ['Found through', 'Found because', 'djrahulsharma', 'rahulsharmavlogs']) if (ev.includes(t)) throw new Error(`Should not show “${t}”`);
  if (!(await b.evaluate(`document.querySelectorAll('[role=img][aria-label=Spotify] svg, [role=img][aria-label=Instagram] svg').length >= 2`))) throw new Error('Platform logos missing');
  log('Find artist ran in the background: only the artist’s own profiles, with logo, link and match % (no song pages, no namesakes)');

  const verify = async (text, platform) => { await clickIn(text, 'Verify', 'li'); await dialog(`Verify ${platform}`); await dlg('Verify profile'); await dialogGone(); };
  await verify('@rahulsharma.sings', 'Instagram');
  await verify('@rahulsharmamusic', 'YouTube');
  await verify('2DemoRahulSharmaA001', 'Spotify');
  await verify('rahulsharma-music.example', 'Website');
  await clickIn('rahulsharmaofficialpage', 'Later', 'li');
  await clickIn('nadaan-music.example', 'Later', 'li');
  await b.waitFor(`[...document.querySelectorAll('section')].some(s => s.innerText.includes('IDENTITY') && s.innerText.includes('VERIFIED'))`, 15000, 'verified header');
  await b.waitText('Saved profiles', 10000);
  log('A person verified Instagram, YouTube, Spotify and the website, put two aside → saved with the artist, identity VERIFIED');

  await tab('Profiles');
  await b.waitText('@rahulsharma.sings', 10000);
  await tab('Songs'); await b.waitText('INGAM2601001', 10000);
  await setInput('Search songs', 'INGAM2601001');
  await b.waitFor(`document.querySelectorAll('tbody tr').length === 1`, 10000, 'song search');
  await b.clickRow('INGAM2601001');
  await dialog('Credits'); for (const t of ['ISRC', 'Release date', 'Where it came from', 'This artist']) await b.waitFor(`document.querySelector('[role=dialog]')?.innerText.toLowerCase().includes(${JSON.stringify(t.toLowerCase())})`, 8000, `song detail “${t}”`);
  await b.shot(`${SHOTS}/v05a-song.png`);
  await dlg('Close'); await dialogGone();
  await tab('Collaborators'); await b.waitText('Joshua Singh', 10000);
  await tab('Overview'); await b.waitText('Where the artist stands', 10000);
  await b.shot(`${SHOTS}/v05-dossier.png`, true);
  log('Dossier tabs: Overview, Profiles (verified), Songs (search, song details with credits by role and source), Collaborators');

  await tab('Connection Graph');
  await b.waitFor(`document.querySelectorAll('.react-flow__node').length > 2`, 15000, 'graph');
  await b.waitFor(`[...document.querySelectorAll('.react-flow__node')].some(n => /Joshua Singh/.test(n.innerText) && /·/.test(n.innerText))`, 10000, 'person card with song and role');
  await clickIn('Possible connections', 'Find connection', 'section, div');
  await waitLower('connection found', 15000);
  await clickIn('Joshua Singh', 'Create route', 'li');
  await waitLower('route created', 10000);
  await clickIn('Joshua Singh', 'Verify route', 'li');
  await dialog('Verify route'); await dlg('Verify route'); await dialogGone();
  await b.sleep(400);
  await b.shot(`${SHOTS}/v06-graph.png`, true);
  log('Connection graph + Find connection: possible path Rahul → “Dil Ka Safar” → Joshua Singh → verified contact; route verified by a person');

  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.title === 'Change the Goongoonalo status')?.click()`);
  await dialog('Goongoonalo status');
  await dlg('Goongoonalo');
  await dlg('Save status'); await dialogGone();
  await b.waitFor(`[...document.querySelectorAll('button')].some(x => x.title === 'Change the Goongoonalo status' && x.innerText.includes('Goongoonalo'))`, 10000, 'goongoonalo badge');
  await b.waitFor(`[...document.querySelectorAll('section')].some(s => /IDENTITY\\s+VERIFIED/.test(s.innerText))`, 10000, 'identity still VERIFIED');
  log('Goongoonalo status set by a person; identity stays VERIFIED');

  await b.click('Dashboard', 'nav');
  await b.waitText('Total artists', 15000);
  await b.sleep(600);
  await b.shot(`${SHOTS}/v07-dashboard.png`, true);
  const goon = await statText('Goongoonalo artists');
  if (goon !== '7') throw new Error(`Dashboard Goongoonalo artists = ${goon}, expected 7`);
  log('Dashboard updated: Goongoonalo artists 7, weekly/monthly numbers from the status changes');

  await b.click('Imports', 'nav');
  await b.waitText('Upload export', 15000);
  await upload('goongoonalo_export_batch_002.csv');
  await b.waitFor(`/Import B\\d+ complete/.test(document.body.innerText)`, 30000, 'batch 002 complete');
  await waitLower('targeted discovery started', 10000);
  const nn = await statText('New artists');
  if (nn !== '0') throw new Error(`Batch 002 created ${nn} artists`);
  await b.shot(`${SHOTS}/v08-reimport.png`, true);
  log('Rahul uploaded again: recognised (0 new artists), verified knowledge reused, only a targeted search runs');

  await b.go(BASE + `#/artists/${rid}`);
  await b.waitFor(`document.body.innerText.includes('Reopened') || document.body.innerText.includes('REOPENED') || document.body.innerText.includes('NEEDS REVIEW')`, 30000, 'reopened artist');
  await b.waitFor(`![...document.querySelectorAll('div')].some(d => d.innerText.startsWith('DISCOVERY') && d.innerText.includes('Searching'))`, 30000, 'targeted search finished').catch(() => undefined);
  for (const t of ['new songs in', 'new collaborator', 'Earlier verification and evidence are kept']) await waitLower(t, 10000);
  await b.shot(`${SHOTS}/v09-reopened.png`, true);
  const foot = await b.text();
  if (!foot.includes('SK-PV2.1.0') || !foot.includes('ArtistFinder')) throw new Error('Footer SK-PV2.1.0 / ArtistFinder name missing');
  log('Rahul reopened with the reasons listed, verification kept; footer SK-PV2.1.0, name ArtistFinder');
  console.log('\nV2 FLOW E2E PASSED. Console issues:', b.logs.length ? b.logs : 'none');
} catch (e) {
  console.error('\nFAILED at step', step + 1, ':', e.message);
  await b.shot(`${SHOTS}/vfail.png`);
  console.log(b.logs);
  process.exitCode = 1;
}
b.close();
