// Browser pass over the remaining interactions (deduplicate merge + reversal, contacts, task actions, songs, do-not-contact, roles, search).
// Run against a disposable workspace. Needs google-chrome.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHOTS = process.env.SHOTS ?? `${HERE}shots`;
mkdirSync(SHOTS, { recursive: true });
const BASE = process.argv[2] ?? 'http://localhost:4100/';
const b = await launch({ port: 9334 });
let step = 0;
const log = m => console.log(`${String(++step).padStart(2)}. ${m}`);
const dialog = t => b.waitFor(`document.querySelector('[role=dialog]')?.innerText.includes(${JSON.stringify(t)})`, 8000, `dialog "${t}"`);
const dialogGone = () => b.waitFor(`!document.querySelector('[role=dialog]')`, 8000, 'dialog closed');
const dlg = l => b.click(l, '[role=dialog]');
const tab = t => b.click(t, '[role=tablist]');
const toast = t => b.waitFor(`[...document.querySelectorAll('[aria-live] div')].some(d => d.innerText.includes(${JSON.stringify(t)}))`, 8000, `toast "${t}"`);
const openArtist = async (aid, tab = '') => {
  await b.go(BASE + '#/artists?q=' + aid); await b.waitFor(`document.querySelector('tbody tr')?.innerText.includes(${JSON.stringify('source ' + aid)})`, 8000, 'artist row ' + aid);
  await b.clickRow('source ' + aid); await b.waitText('Where the artist stands');
  if (tab) { await b.go((await b.evaluate('location.href')).split('?')[0] + '?tab=' + tab); await b.sleep(300); }
};
/** Opens the ⋯ menu of the task card that mentions `text`. */
const taskMenu = async text => {
  const ok = await b.evaluate(`(() => { const cards = [...document.querySelectorAll('div')].filter(d => d.innerText.includes(${JSON.stringify(text)}) && d.querySelector('button[aria-label="More actions"]')); cards.sort((a, b) => a.innerText.length - b.innerText.length); const btn = cards[0]?.querySelector('button[aria-label="More actions"]'); if (!btn) return false; btn.click(); return true; })()`);
  if (!ok) throw new Error('No task menu near ' + text);
  await b.sleep(150);
};
const more = async (item) => { await b.click('More'); await b.click(item); };
const caseSearch = async (q, pick) => {
  await b.evaluate(`(() => { const el = document.querySelector('[role=dialog] input[placeholder="Search by name or artist ID"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.waitFor(`[...document.querySelectorAll('[role=dialog] button')].some(x => x.innerText.includes(${JSON.stringify(pick)}))`, 6000, `case option ${pick}`);
  await b.evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(x => x.innerText.includes(${JSON.stringify(pick)})).click()`);
  await b.sleep(100);
};
try {
  // Deduplicate: merge with a reason, then reverse it (nothing lost, history kept)
  await b.go(BASE + '#/deduplicate');
  await b.waitText('Ishitaa Rao');
  await b.evaluate(`(() => { const li = [...document.querySelectorAll('li')].filter(l => l.innerText.includes('Ishitaa Rao') && l.innerText.includes('Confirm same artist')).sort((a, b) => a.innerText.length - b.innerText.length)[0]; [...li.querySelectorAll('button')].find(x => x.innerText.trim() === 'Confirm same artist').click(); })()`);
  await dialog('Confirm same artist');
  await b.fill('Reason', 'Same ISRC family and label; spelling variant');
  await dlg('Confirm same artist'); await dialogGone();
  await toast('Merged into');
  await b.waitFor(`document.querySelector('ul li') && ![...document.querySelectorAll('li')].some(l => l.innerText.includes('Ishitaa Rao') && l.innerText.includes('Confirm same artist'))`, 8000, 'merged');
  log('Deduplicate: Confirm same artist with a reason → records merged');
  await tab('Decided');
  await b.waitText('Confirmed same artist');
  await b.evaluate(`(() => { const li = [...document.querySelectorAll('li')].find(l => l.innerText.includes('Ishitaa Rao') && l.innerText.includes('Reverse')); [...li.querySelectorAll('button')].find(x => x.innerText.trim() === 'Reverse').click(); })()`);
  await dialog('Reverse identity decision'); await b.fill('Why the decision was wrong', 'Label says these are two singers');
  await dlg('Reverse decision'); await dialog('Please confirm'); await dlg('Yes, reverse decision'); await dialogGone();
  await b.waitFor(`![...document.querySelectorAll('li')].some(l => l.innerText.includes('Ishitaa Rao') && l.innerText.includes('Confirmed same artist'))`, 8000, 'decision reversed');
  await tab('To review');
  await b.waitFor(`[...document.querySelectorAll('li')].some(l => l.innerText.includes('Ishitaa Rao') && l.innerText.includes('Confirm same artist'))`, 8000, 'pair back in the queue');
  log('Merge reversed: both records back, pair back in To review');

  // Verified collaborator contact reopens a waiting artist (Sameer Mehta composes for Rahul)
  await b.go(BASE + '#/routes?tab=contacts');
  await b.waitText('Willing introducer');
  await b.click('Add contact'); await dialog('Add contact to directory');
  await b.fill('Person or organisation', 'Sameer Mehta'); await b.fill('Role', 'Collaborator'); await b.fill('Address, number or handle', '+91 90000 00141 (test)');
  await caseSearch('Sameer Mehta', 'Sameer Mehta');
  await b.fill('Where the contact comes from', 'Producer on Rahul Sharma songs');
  await dlg('Add contact'); await dialogGone();
  await b.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('Sameer Mehta') && r.innerText.includes('Verify'))`, 8000, 'unverified contact row');
  await b.evaluate(`(() => { const tr = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('Sameer Mehta')); [...tr.querySelectorAll('button')].find(x => x.innerText.trim() === 'Verify').click(); })()`);
  await dialog('Verify contact'); await b.fill('How the identity was corroborated', 'Called Imran; he confirmed he composes for Rahul');
  await dlg('Mark verified'); await dialogGone();
  await toast('waiting case(s) reopened');
  log('Verifying Sameer Mehta’s contact reopened a waiting artist (no new song needed)');
  await b.go(BASE + '#/reopened');
  await b.waitFor(`location.hash.includes('status=REOPENED') && [...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('Rahul Sharma'))`, 8000, 'Rahul in REOPENED');
  await openArtist('A001');
  await b.waitText('something changed since the last review');
  await b.waitText('Sameer Mehta');
  log('REOPENED filter lists Rahul; his banner names Sameer Mehta as the reason');

  // Task actions on Rahul's new task (Overview → Open tasks)
  await b.waitFor(`[...document.querySelectorAll('div')].some(d => d.innerText.includes('Sameer Mehta') && d.querySelector('button[aria-label="More actions"]'))`, 8000, 'Sameer task card');
  const T = 'Sameer Mehta for an introduction';
  await taskMenu(T); await b.click('Start task'); await toast('Started');
  await taskMenu(T); await b.click('Add note…'); await dialog('Add note'); await b.fill('Note', 'Imran prefers calls after 6pm'); await dlg('Add note'); await dialogGone();
  await taskMenu(T); await b.click('Add evidence…'); await dialog('Add evidence'); await b.fill('Evidence (link, reference or note)', 'Call log 18:20'); await dlg('Add evidence'); await dialogGone();
  await taskMenu(T); await b.click('Reschedule…'); await dialog('Reschedule task'); await b.fill('Reason', 'Imran travelling'); await dlg('Reschedule'); await dialogGone();
  await taskMenu(T); await b.click('Reassign…'); await dialog('Reassign task'); await b.fill('Owner', 'u-vikram'); await dlg('Reassign'); await dialogGone();
  await taskMenu(T); await b.click('Change next action…'); await dialog('Change next action'); await b.fill('Next action', 'Call Imran in the evening'); await dlg('Save'); await dialogGone();
  await taskMenu(T); await b.click('Put on hold…'); await dialog('Put task on hold'); await b.fill('Reason', 'Waiting for Imran to return'); await dlg('Put on hold'); await dialogGone();
  await taskMenu(T); await b.click('Create follow-up…'); await dialog('Create follow-up'); await b.fill('Follow-up', 'Check Imran is back'); await dlg('Create follow-up'); await dialogGone();
  await b.waitFor(`document.body.innerText.includes('Check Imran is back')`, 8000, 'follow-up task');
  await taskMenu('Check Imran is back'); await b.click('Complete with outcome…'); await dialog('Complete task'); await dlg('Complete task');
  await b.waitText('Outcome is required.');
  await b.fill('Outcome', 'Imran is back in town'); await b.fill('Next action', 'Call Imran'); await dlg('Complete task'); await dialogGone();
  // Reassigned to Vikram, so it is no longer in my queue: cancel it from the artist's open tasks.
  await openArtist('A001'); await b.waitText('Sameer Mehta for an introduction');
  await taskMenu(T); await b.click('Cancel task…'); await dialog('Cancel task'); await b.fill('Reason', 'Will go through Joshua instead'); await dlg('Cancel task'); await dialogGone().catch(async () => { await dlg('Yes, cancel task'); await dialogGone(); });
  await openArtist('A001', 'timeline'); await b.waitText('Every meaningful change');
  const tl = await b.text();
  for (const a of ['Task started', 'Note added', 'Evidence added', 'Task rescheduled', 'Task reassigned', 'Next action changed', 'Task put on hold', 'Task completed', 'Task cancelled']) if (!tl.includes(a)) throw new Error(`Timeline missing: ${a}`);
  log('Task actions: start, note, evidence, reschedule, reassign, next action, hold, follow-up, complete (outcome required), cancel → all in the timeline');

  // Manual song + credit
  await openArtist('A016', 'songs'); await b.waitText('Link a song');
  const pooja = await b.evaluate(`document.querySelector('h1').innerText`);
  await b.click('Link a song'); await dialog('Link a song'); await b.fill('Song title', 'Kinare Ki Dhun'); await dlg('Link song'); await dialogGone();
  await b.clickRow('Kinare Ki Dhun'); await b.click('Add credit'); await dialog('Add a credit');
  await caseSearch('Joshua', 'Joshua Singh'); await dlg('Add credit'); await dialogGone();
  await toast('waiting case(s) reopened');
  log(`Linked a song to ${pooja} and credited Joshua Singh → waiting artist reopened with a route`);

  // Do-not-contact
  await openArtist('A006');
  await more('Contact preference'); await dialog('Contact preference');
  await b.click('Do Not Contact', '[role=dialog]'); await b.fill('Reason', 'Artist asked by DM not to be contacted');
  await dlg('Save preference'); await dialog('Please confirm'); await dlg('Yes, save preference'); await dialogGone();
  await b.waitText('Outreach is blocked');
  const canContact = await b.evaluate(`[...document.querySelectorAll('button')].some(x => x.innerText.trim() === 'Record contact' && !x.disabled)`);
  if (canContact) throw new Error('Record contact still enabled for DNC');
  log('Do-not-contact recorded: outreach blocked');

  // Close case needs permission: operator cannot
  await b.evaluate(`localStorage.setItem('gamplify.user', 'u-tara')`);
  await b.evaluate('location.reload()'); await b.sleep(800); await openArtist('A003'); await b.waitText('Tara');
  await b.click('More');
  const closeDisabled = await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Close case')?.disabled`);
  if (!closeDisabled) throw new Error('Operator can close cases');
  log('Role-aware UI: an Operator cannot close a case');
  await b.evaluate(`localStorage.setItem('gamplify.user', 'u-swatantra')`);

  // Global search by ISRC
  await b.go(BASE + '#/'); await b.evaluate('location.reload()'); await b.waitText('Total artists');
  await b.evaluate(`(() => { const el = document.querySelector('input[aria-label="Global search"]'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'INGAM2601001'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.waitText('Dil Mera'); log('Global search finds a song by ISRC');
  await b.shot(`${SHOTS}/20-search.png`);
  console.log('\nINTERACTIONS PASSED. Console issues:', b.logs.length ? b.logs : 'none');
} catch (e) {
  console.error('\nFAILED at step', step + 1, ':', e.message);
  await b.shot(`${SHOTS}/fail2.png`);
  console.log(b.logs);
  process.exitCode = 1;
}
b.close();
