// Bringing an existing workspace up to date after a release (run once at start-up, idempotent).
import { ENGINE_USER, rescoreOpenCandidates } from './discovery/pipeline';
import { syncContactGraph, syncRouteGraph, syncTrackGraph } from './graph';
import type { Model } from './model';
import { deriveArtistStatus, isVerified, kindOf } from './status';
import type { ArtistCase, Ctx } from './types';

export function upgradeWorkspace(m: Model, ctx: Ctx): string[] {
  const notes: string[] = [];
  if (!m.get('users', ENGINE_USER)) { m.insert('users', { id: ENGINE_USER, name: 'Discovery engine', role: 'Automation' }); notes.push('added the discovery engine user'); }
  // The evidence graph arrived with the discovery engine: build it once from the catalogue, contacts and routes.
  if (m.count('graphEdges') === 0 && m.count('tracks') > 0) {
    for (const t of m.all('tracks')) syncTrackGraph(m, ctx, t.id);
    for (const k of m.all('contacts')) syncContactGraph(m, ctx, k.id);
    for (const r of m.all('routes')) syncRouteGraph(m, ctx, r.id);
    notes.push(`built the evidence graph (${m.count('graphNodes')} nodes, ${m.count('graphEdges')} relationships)`);
  }
  // v2: artist vs collaborator, the identity status and the Goongoonalo status on every artist. Rows that already
  // carry the right values (the database migration sets most of them) are not written again.
  if (m.getMeta('upgrade:v2') !== 'done' && m.count('cases') > 0) {
    let changed = 0;
    for (const c of m.all('cases')) {
      const patch: Partial<ArtistCase> = {};
      if (c.reopen === undefined) Object.assign(patch, { reopen: null, rejectedAt: null, rejectedReason: null, manualVerifiedAt: null, manualVerifiedBy: null, goongoonaloStatusAt: null, goongoonaloStatusBy: null, firstVerifiedAt: null, artistStatusAt: null });
      const probe = { ...c, ...patch } as ArtistCase;
      const kind = kindOf(m, probe);
      if (c.kind !== kind) patch.kind = kind;
      if (!c.goongoonaloStatus) patch.goongoonaloStatus = c.contactPreference === 'Do Not Contact' ? 'DO_NOT_CONTACT' : 'PENDING';
      if (!c.mergedIntoId) {
        const status = deriveArtistStatus(m, probe);
        if (c.artistStatus !== status) { patch.artistStatus = status; patch.artistStatusAt = c.discoveryUpdatedAt ?? c.updatedAt; }
        if (isVerified(probe) && !probe.firstVerifiedAt) patch.firstVerifiedAt = m.byCase('verifiedProfiles', c.id).map(v => v.verifiedAt).sort()[0] ?? c.updatedAt;
      }
      if (Object.keys(patch).length) { m.update('cases', c.id, patch); changed++; }
    }
    for (const r of m.all('importRows')) if (r.mapped === undefined) (r as { mapped: null }).mapped = null;
    m.setMeta('upgrade:v2', 'done');
    notes.push(`artist status model v2 (${changed} artist record${changed === 1 ? '' : 's'} updated)`);
  }
  // v2.1: candidates are scored as artist-profile matches (match %) and only profile links count. Undecided candidates
  // from earlier searches are scored again once; decided ones keep their decision and nothing is deleted.
  if (m.getMeta('upgrade:discovery-v2.1') !== 'done') {
    const cases = new Set(m.all('profiles').filter(p => p.caseId && (p.verificationStatus === 'UNREVIEWED' || p.verificationStatus === 'DEFERRED')).map(p => m.canonical(p.caseId!)));
    let n = 0;
    for (const id of cases) if (m.get('cases', id)) n += rescoreOpenCandidates(m, ctx, id);
    m.setMeta('upgrade:discovery-v2.1', 'done');
    notes.push(`artist-profile match % (${n} candidate profile${n === 1 ? '' : 's'} of ${cases.size} artist${cases.size === 1 ? '' : 's'} scored again)`);
  }
  return notes;
}
