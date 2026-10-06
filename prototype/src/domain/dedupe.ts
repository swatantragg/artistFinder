// Possible duplicate artists (v2 §36). Candidates come from name keys only (same name, similar spelling, or the same
// name around words such as "Official"); the match % is built from catalogue evidence, conflicts are shown too.
// Nothing is merged automatically: a person confirms, keeps separate or reviews later (decideIdentity).
import type { Model } from './model';
import { audit, notify } from './ops';
import { isVerified, reopenArtist } from './status';
import type { ArtistCase, Ctx, IdentityConflict } from './types';
import { coreKey, nameKey, similarKey } from './util';

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** Pairs that are already in review or were decided (a "keep separate" decision is never re-flagged). */
export function knownPairs(m: Model): Set<string> {
  const out = new Set<string>();
  for (const x of m.all('conflicts')) for (let i = 0; i < x.caseIds.length; i++) for (let j = i + 1; j < x.caseIds.length; j++) out.add(pairKey(x.caseIds[i], x.caseIds[j]));
  return out;
}

/** Other live artists whose name matches exactly, by similar spelling or by core name. */
export function nameMatches(m: Model, c: ArtistCase): { other: ArtistCase; how: 'Same name' | 'Similar spelling' | 'Similar name' }[] {
  const out = new Map<string, { other: ArtistCase; how: 'Same name' | 'Similar spelling' | 'Similar name' }>();
  for (const n of [c.canonicalName, ...c.aliases]) {
    for (const o of m.casesNamed(n)) if (o.id !== c.id && !out.has(o.id)) out.set(o.id, { other: o, how: 'Same name' });
    for (const o of m.casesSimilar(n)) if (o.id !== c.id && !out.has(o.id)) out.set(o.id, { other: o, how: 'Similar spelling' });
    for (const o of m.casesCore(n)) if (o.id !== c.id && !out.has(o.id)) out.set(o.id, { other: o, how: 'Similar name' });
  }
  return [...out.values()];
}

interface Facts { tracks: Set<string>; isrcs: Map<string, string>; titles: Map<string, string>; labels: Set<string>; people: Map<string, string>; roles: Set<string> }
function factsOf(m: Model, c: ArtistCase): Facts {
  const fam = new Set(m.family(c.id));
  const f: Facts = { tracks: new Set(), isrcs: new Map(), titles: new Map(), labels: new Set(), people: new Map(), roles: new Set() };
  for (const tid of m.trackIdsOfCase(c.id)) {
    const t = m.get('tracks', tid);
    if (!t) continue;
    f.tracks.add(tid);
    if (t.isrc) f.isrcs.set(t.isrc, t.title);
    f.titles.set(nameKey(t.title), t.title);
    if (t.label) f.labels.add(t.label);
    for (const cr of m.creditsOfTrack(tid)) {
      if (cr.status !== 'Active') continue;
      if (cr.caseId && fam.has(cr.caseId)) { f.roles.add(cr.role); continue; }
      f.people.set(cr.caseId ? m.canonical(cr.caseId) : `name:${nameKey(cr.personName)}`, cr.personName);
    }
  }
  return f;
}

/** Match % between two artists from evidence, with the conflicts that speak against it. */
export function duplicateEvidence(m: Model, a: ArtistCase, b: ArtistCase): { score: number; evidence: string[]; conflicts: string[] } {
  const evidence: string[] = [], conflicts: string[] = [];
  let score = 0;
  const namesA = [a.canonicalName, ...a.aliases], namesB = [b.canonicalName, ...b.aliases];
  if (namesA.some(x => namesB.some(y => nameKey(x) === nameKey(y)))) { score += 45; evidence.push(nameKey(a.canonicalName) === nameKey(b.canonicalName) ? 'Same name' : 'Same name as an alias'); }
  else if (namesA.some(x => namesB.some(y => coreKey(x) === coreKey(y)))) { score += 35; evidence.push(`Same name apart from words like “Official” or “Music”`); }
  else if (namesA.some(x => namesB.some(y => similarKey(x) === similarKey(y)))) { score += 30; evidence.push('Similar spelling'); }
  const fa = factsOf(m, a), fb = factsOf(m, b);
  const sameIsrc = [...fa.isrcs.keys()].filter(i => fb.isrcs.has(i));
  if (sameIsrc.length) { score += 30; evidence.push(`Same ISRC${sameIsrc.length > 1 ? `s (${sameIsrc.length})` : ''}: “${fa.isrcs.get(sameIsrc[0])}” ${sameIsrc[0]}`); }
  const sameTitle = [...fa.titles.keys()].filter(t => fb.titles.has(t) && !sameIsrc.some(i => nameKey(fa.isrcs.get(i) ?? '') === t));
  if (sameTitle.length) { score += 10; evidence.push(`Same song title: “${fa.titles.get(sameTitle[0])}”`); }
  const people = [...fa.people.keys()].filter(k => fb.people.has(k) && k !== a.id && k !== b.id);
  if (people.length) { score += Math.min(18, 6 * people.length); evidence.push(`Same collaborator${people.length > 1 ? 's' : ''}: ${people.slice(0, 3).map(k => fa.people.get(k)).join(', ')}`); }
  const labels = [...fa.labels].filter(l => fb.labels.has(l));
  if (labels.length) { score += 8; evidence.push(`Same label: ${labels[0]}`); }
  if (a.language && b.language) { if (a.language === b.language) { score += 4; evidence.push(`Same language: ${a.language}`); } else conflicts.push(`Different language (${a.language} vs ${b.language})`); }
  if (a.backendProfileIds.length && b.backendProfileIds.length && !a.backendProfileIds.some(x => b.backendProfileIds.includes(x))) conflicts.push(`Different backend artist IDs (${a.backendProfileIds[0]} vs ${b.backendProfileIds[0]})`);
  if (fa.roles.size && fb.roles.size && ![...fa.roles].some(r => fb.roles.has(r))) conflicts.push(`Different roles (${[...fa.roles].join(', ')} vs ${[...fb.roles].join(', ')})`);
  const va = m.byCase('verifiedProfiles', a.id).filter(v => v.verificationStatus === 'VERIFIED'), vb = m.byCase('verifiedProfiles', b.id).filter(v => v.verificationStatus === 'VERIFIED');
  for (const v of va) { const w = vb.find(x => x.platform === v.platform && x.url !== v.url); if (w) conflicts.push(`Different verified ${v.platform} profiles`); }
  if (!labels.length && fa.labels.size && fb.labels.size) conflicts.push('No label in common');
  score -= Math.min(20, 8 * conflicts.length);
  return { score: Math.max(5, Math.min(99, score)), evidence, conflicts };
}

/** Opens one duplicate candidate for an artist and its name matches; a reviewed artist that gets a look-alike is reopened. */
export function openDuplicate(m: Model, ctx: Ctx, c: ArtistCase, matches: ArtistCase[], kind: IdentityConflict['kind'], reason: string, known: Set<string> = knownPairs(m)): IdentityConflict | null {
  const fresh = matches.filter(o => !known.has(pairKey(c.id, o.id)));
  if (!fresh.length) return null;
  for (const o of fresh) known.add(pairKey(c.id, o.id));
  const conflict = m.insert('conflicts', { id: m.nextId('IC', 4), caseIds: [c.id, ...fresh.map(o => o.id)], kind, reason, status: 'Open', createdAt: ctx.now, createdBy: ctx.userId, decisionId: null });
  audit(m, ctx, { caseId: c.id, entity: 'IdentityConflict', entityId: conflict.id, action: 'Possible duplicate found', to: fresh.map(o => `${o.canonicalName} (${o.id})`).join(', '), reason, next: 'Confirm same artist, keep separate or review later' });
  // A verified artist with a new look-alike is reopened (its identity may be shared); others are just listed in Deduplicate.
  for (const o of fresh) if (isVerified(o)) reopenArtist(m, ctx, o.id, 'duplicate', `Possible duplicate: ${c.canonicalName} (${c.id})`);
  return conflict;
}

/** Look for possible duplicates among the given artists (or all). Used after imports and by Deduplicate → Scan. */
export function scanDuplicates(m: Model, ctx: Ctx, caseIds?: Iterable<string>): IdentityConflict[] {
  const out: IdentityConflict[] = [];
  const known = knownPairs(m);
  const ids = caseIds ? [...new Set(caseIds)] : m.all('cases').filter(c => !c.mergedIntoId).map(c => c.id);
  for (const id of ids) {
    const c = m.get('cases', id);
    if (!c || c.mergedIntoId || c.rejectedAt) continue;
    const matches = nameMatches(m, c).filter(x => !x.other.rejectedAt);
    // Same exact name without evidence is common in big catalogues; it is still listed, the match % shows how little supports it.
    if (!matches.length || matches.length > 6) continue;
    const kind = matches.some(x => x.how === 'Same name') ? 'Same name' : matches.some(x => x.how === 'Similar spelling') ? 'Similar spelling' : 'Similar name';
    const conflict = openDuplicate(m, ctx, c, matches.map(x => x.other), kind, `${c.canonicalName} (${c.id}) looks like ${matches.map(x => `${x.other.canonicalName} (${x.other.id})`).join(', ')}. Names alone never merge artists.`, known);
    if (conflict) out.push(conflict);
  }
  if (out.length) notify(m, ctx, 'Identity conflict', `${out.length} possible duplicate${out.length === 1 ? '' : 's'} to review in Deduplicate.`, null);
  return out;
}
