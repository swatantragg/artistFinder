// Evidence graph: artists, songs, releases, labels, distributors, profiles, contacts and routes, with one edge per
// relationship. Every edge keeps its source, evidence and status (verified by a person / discovered with a source / possible).
// Keys are deterministic, so a repeated import or a repeated search never creates a duplicate edge.
import { contactLabel, type DiscoveryStrength, type EdgeStatus, type GraphNodeType, type RelationshipType } from './constants';
import type { Model } from './model';
import type { ArtistProfile, ConnectionPath, Ctx, GraphEdge, GraphNode, PathStep } from './types';
import { daysBetween, nameKey } from './util';

export const nid = {
  case: (id: string) => `case:${id}`,
  song: (trackId: string) => `song:${trackId}`,
  release: (id: string) => `release:${id}`,
  label: (name: string) => `label:${nameKey(name)}`,
  dist: (name: string) => `dist:${nameKey(name)}`,
  person: (name: string) => `person:${nameKey(name)}`,
  profile: (id: string) => `profile:${id}`,
  contact: (id: string) => `contact:${id}`,
  route: (id: string) => `route:${id}`,
};
const RANK: Record<EdgeStatus, number> = { rejected: 0, possible: 1, discovered: 2, verified: 3 };
const CREDIT_TYPES: RelationshipType[] = ['ARTIST_PERFORMED_SONG', 'ARTIST_COMPOSED_SONG', 'ARTIST_PRODUCED_SONG', 'PERSON_CREDITED_ON_SONG'];
export const isCredit = (t: RelationshipType) => CREDIT_TYPES.includes(t);
export const STATUS_WORD: Record<EdgeStatus, string> = { verified: 'Verified by a person', discovered: 'Discovered (with source)', possible: 'Possible (needs review)', rejected: 'Rejected' };

export function ensureNode(m: Model, ctx: Ctx, id: string, type: GraphNodeType, label: string, refId: string | null, sub: string | null = null, url: string | null = null): GraphNode {
  const cur = m.get('graphNodes', id);
  if (cur) { if (cur.label !== label || cur.sub !== sub || cur.url !== url) m.update('graphNodes', id, { label, sub, url }); return cur; }
  return m.insert('graphNodes', { id, type, label, refId, sub, url, createdAt: ctx.now });
}

export interface EdgeInput {
  sourceId: string; targetId: string; type: RelationshipType; label: string; evidence: string; source: string;
  sourceUrl?: string | null; sourceType: GraphEdge['sourceType']; status: EdgeStatus; confidence?: number; active?: boolean;
}
/** Insert or update one relationship. Status only moves up (possible → discovered → verified) unless `force` is set. */
export function upsertEdge(m: Model, ctx: Ctx, e: EdgeInput, force = false): { edge: GraphEdge; created: boolean } {
  const key = `${e.type}|${e.sourceId}|${e.targetId}|${e.label}`;
  const id = m.idx.edgeByKey.get(key);
  const cur = id ? m.get('graphEdges', id) : undefined;
  if (!cur) {
    const edge = m.insert('graphEdges', {
      id: m.nextId('GE', 6), key, sourceId: e.sourceId, targetId: e.targetId, type: e.type, label: e.label, evidence: e.evidence, source: e.source, sourceUrl: e.sourceUrl ?? null,
      sourceType: e.sourceType, status: e.status, active: e.active ?? true, confidence: e.confidence ?? 60, discoveredAt: ctx.now,
      verifiedAt: e.status === 'verified' ? ctx.now : null, verifiedBy: e.status === 'verified' ? ctx.userId : null,
    });
    return { edge, created: true };
  }
  const status = force ? e.status : cur.status === 'rejected' ? 'rejected' : RANK[e.status] > RANK[cur.status] ? e.status : cur.status;
  const patch: Partial<GraphEdge> = {};
  if (status !== cur.status) { patch.status = status; if (status === 'verified') { patch.verifiedAt = ctx.now; patch.verifiedBy = ctx.userId; } }
  if ((e.active ?? true) !== cur.active) patch.active = e.active ?? true;
  if (status !== cur.status || force) { patch.evidence = e.evidence; patch.source = e.source; patch.sourceUrl = e.sourceUrl ?? cur.sourceUrl; patch.sourceType = e.sourceType; if (e.confidence != null) patch.confidence = e.confidence; }
  if (Object.keys(patch).length) m.update('graphEdges', cur.id, patch);
  return { edge: m.get('graphEdges', cur.id)!, created: false };
}

const creditType = (role: string, hasCase: boolean): RelationshipType => {
  if (!hasCase) return 'PERSON_CREDITED_ON_SONG';
  if (role === 'Singer' || role === 'Performer') return 'ARTIST_PERFORMED_SONG';
  if (role === 'Composer' || role === 'Lyricist') return 'ARTIST_COMPOSED_SONG';
  if (role === 'Producer') return 'ARTIST_PRODUCED_SONG';
  return 'PERSON_CREDITED_ON_SONG';
};

/** Catalogue relationships of one song (called by imports and manual song/credit edits). */
export function syncTrackGraph(m: Model, ctx: Ctx, trackId: string) {
  const t = m.get('tracks', trackId);
  if (!t) return;
  const song = nid.song(t.id);
  const src = t.lastBatchId === 'Manual' ? 'Added by hand' : `Backend export ${t.lastBatchId}`;
  const sourceType: GraphEdge['sourceType'] = t.source === 'Manual' ? 'Manual' : 'Backend export';
  ensureNode(m, ctx, song, 'Song', t.title, t.id, t.backendTrackId);
  if (t.label) {
    ensureNode(m, ctx, nid.label(t.label), 'Label', t.label, null, 'Label');
    upsertEdge(m, ctx, { sourceId: song, targetId: nid.label(t.label), type: 'SONG_RELEASED_ON_LABEL', label: 'Released on', evidence: `“${t.title}” is released on ${t.label} (${src}, track ${t.backendTrackId})`, source: src, sourceType, status: 'discovered', confidence: 90 });
  }
  if (t.distributor) {
    ensureNode(m, ctx, nid.dist(t.distributor), 'Distributor', t.distributor, null, 'Distributor');
    upsertEdge(m, ctx, { sourceId: song, targetId: nid.dist(t.distributor), type: 'SONG_DISTRIBUTED_BY', label: 'Distributed by', evidence: `“${t.title}” is distributed by ${t.distributor} (${src})`, source: src, sourceType, status: 'discovered', confidence: 90 });
  }
  if (t.releaseId) {
    const rel = m.get('releases', t.releaseId);
    if (rel) {
      ensureNode(m, ctx, nid.release(rel.id), 'Release', rel.title, rel.id, rel.backendReleaseId);
      upsertEdge(m, ctx, { sourceId: song, targetId: nid.release(rel.id), type: 'SONG_ON_RELEASE', label: 'On release', evidence: `“${t.title}” is on ${rel.title} (${rel.backendReleaseId})`, source: src, sourceType, status: 'discovered', confidence: 90 });
    }
  }
  for (const cr of m.creditsOfTrack(t.id)) {
    const caseId = cr.caseId ? m.canonical(cr.caseId) : null;
    const c = caseId ? m.get('cases', caseId) : null;
    const person = c ? nid.case(c.id) : nid.person(cr.personName);
    ensureNode(m, ctx, person, c ? 'Artist' : 'Person', c?.canonicalName ?? cr.personName, c?.id ?? null, c?.backendProfileIds[0] ?? null);
    upsertEdge(m, ctx, {
      sourceId: person, targetId: song, type: creditType(cr.role, !!c), label: cr.role, sourceType, source: `Backend export ${cr.sourceVersion}`,
      evidence: `${cr.personName} is credited as ${cr.role} on “${t.title}” (backend export ${cr.sourceVersion}, track ${t.backendTrackId})`, status: 'discovered', confidence: 95, active: cr.status === 'Active',
    }, cr.status !== 'Active');
  }
}

/** A contact in the directory: person (or organisation) → contact. Verified contacts become verified edges. */
export function syncContactGraph(m: Model, ctx: Ctx, contactId: string) {
  const k = m.get('contacts', contactId);
  if (!k) return;
  const node = nid.contact(k.id);
  ensureNode(m, ctx, node, 'Contact', contactLabel(k.verified, k.channel), k.id, k.personName);
  const caseId = k.caseId ? m.canonical(k.caseId) : null;
  const owner = k.organisation ? nid.label(k.organisation) : caseId ? nid.case(caseId) : nid.person(k.personName);
  if (k.organisation) ensureNode(m, ctx, owner, k.role === 'Distributor' ? 'Distributor' : 'Label', k.organisation, null, k.role);
  else ensureNode(m, ctx, owner, caseId ? 'Artist' : 'Person', caseId ? m.get('cases', caseId)!.canonicalName : k.personName, caseId, null);
  upsertEdge(m, ctx, {
    sourceId: owner, targetId: node, type: k.organisation ? 'ORGANISATION_HAS_CONTACT' : 'PERSON_HAS_CONTACT', label: k.verified ? 'Verified contact' : 'Contact',
    evidence: `${k.personName}: ${k.channel} contact${k.verified ? ` verified${k.verifiedAt ? ` on ${k.verifiedAt.slice(0, 10)}` : ''}` : ' (not verified yet)'}${k.authorityEvidence ? `. Source: ${k.authorityEvidence}` : ''}`,
    source: k.source || 'Contact directory', sourceType: 'Directory', status: k.verified ? 'verified' : 'possible', confidence: k.verified ? 95 : 40,
  }, true);
}

/** A discovered or verified public profile: artist/person → profile. */
export function syncProfileGraph(m: Model, ctx: Ctx, p: ArtistProfile) {
  const owner = p.caseId ? nid.case(m.canonical(p.caseId)) : p.collaboratorId ? `collab:${p.collaboratorId}` : null;
  if (!owner) return;
  const node = nid.profile(p.id);
  ensureNode(m, ctx, node, 'Profile', `${p.platform}${p.username ? ` @${p.username}` : ''}`, p.id, p.displayName, p.url);
  if (!p.caseId && p.collaboratorId) { const co = m.get('collaborators', p.collaboratorId); ensureNode(m, ctx, owner, 'Collaborator', co?.name ?? 'Collaborator', p.collaboratorId); }
  const status: EdgeStatus = p.verificationStatus === 'VERIFIED' ? 'verified' : p.verificationStatus === 'REJECTED' || p.verificationStatus === 'REPLACED' ? 'rejected' : 'possible';
  const reviewed = p.verificationStatus === 'VERIFIED' ? `Verified by a person${p.verifiedAt ? ` on ${p.verifiedAt.slice(0, 10)}` : ''}` : p.verificationStatus === 'REJECTED' ? `Rejected: ${p.rejectionReason ?? ''}` : 'Candidate: not verified yet';
  upsertEdge(m, ctx, {
    sourceId: owner, targetId: node, type: p.caseId ? 'ARTIST_HAS_PROFILE' : 'PERSON_HAS_PROFILE', label: 'Profile', sourceUrl: p.url, sourceType: 'Discovery',
    evidence: `${p.platform} profile “${p.displayName}”. ${reviewed}. Found by ${p.source}${p.matched.length ? `; ${p.matched.slice(0, 3).join(', ')}` : ''}`,
    source: p.source, status, confidence: p.evidenceScore, active: status !== 'rejected',
  }, true);
  // Songs the profile mentions support the identity (shown as discovered evidence, at most two per profile).
  if (p.caseId) for (const title of p.matchedSongs.slice(0, 2)) {
    const tid = m.trackIdsOfCase(m.canonical(p.caseId)).find(id => m.get('tracks', id)?.title === title);
    if (tid) upsertEdge(m, ctx, { sourceId: node, targetId: nid.song(tid), type: 'PROFILE_SUPPORTS_IDENTITY', label: 'Mentions song', evidence: `The ${p.platform} profile mentions “${title}”`, source: p.source, sourceUrl: p.url, sourceType: 'Discovery', status: status === 'rejected' ? 'rejected' : 'discovered', confidence: 60, active: status !== 'rejected' }, true);
  }
}

/** Routes in the graph: route → artist, route → contact or profile. */
export function syncRouteGraph(m: Model, ctx: Ctx, routeId: string) {
  const r = m.get('routes', routeId);
  if (!r) return;
  const node = nid.route(r.id);
  ensureNode(m, ctx, node, 'Route', `Route ${r.id}`, r.id, r.state);
  const status: EdgeStatus = r.state === 'Rejected' || r.state === 'Exhausted' ? 'rejected' : r.state === 'Candidate' ? 'possible' : 'verified';
  const target = m.canonical(r.targetCaseId);
  upsertEdge(m, ctx, { sourceId: node, targetId: nid.case(target), type: 'ROUTE_CONNECTS_ARTIST', label: `Route (${r.state})`, evidence: r.evidence, source: r.origin, sourceType: 'Route', status, confidence: r.confidence, active: true }, true);
  if (r.contactId) upsertEdge(m, ctx, { sourceId: node, targetId: nid.contact(r.contactId), type: 'ROUTE_USES_CONTACT', label: 'Uses contact', evidence: r.evidence, source: r.origin, sourceType: 'Route', status, confidence: r.confidence }, true);
}

// ------------------------------------------------------------------ dossier graph view
export interface ViewNode { id: string; type: GraphNodeType; label: string; sub: string | null; url: string | null; level: number; refId: string | null; status: string | null; root?: boolean; more?: number }
export interface ViewEdge { id: string; source: string; target: string; type: RelationshipType; label: string; status: EdgeStatus; evidence: string; sourceLabel: string; sourceUrl: string | null; sourceType: string; discoveredAt: string; verifiedAt: string | null; verifiedBy: string | null; confidence: number; derived?: boolean }
export interface GraphView { root: string; nodes: ViewNode[]; edges: ViewEdge[]; hidden: { songs: number } }

export function caseGraph(m: Model, caseId: string, opts: { depth?: number; expand?: string[]; pathId?: string; maxSongs?: number } = {}): GraphView {
  const rootCase = m.canonical(caseId);
  const root = nid.case(rootCase);
  const fam = new Set(m.family(rootCase).map(id => nid.case(id)));
  const nodes = new Map<string, ViewNode>();
  const edges = new Map<string, ViewEdge>();
  const nodeView = (id: string, level: number): ViewNode | null => {
    const mapped = fam.has(id) ? root : id;
    const existing = nodes.get(mapped);
    if (existing) { if (level < existing.level) existing.level = level; return existing; }
    const n = m.get('graphNodes', mapped);
    if (!n) return null;
    const v: ViewNode = { id: n.id, type: n.type, label: n.label, sub: n.sub, url: n.url, level, refId: n.refId, status: null };
    if (n.type === 'Artist' && n.refId) { const c = m.get('cases', m.canonical(n.refId)); if (c) { v.label = c.canonicalName; v.sub = c.backendProfileIds[0] ?? c.id; v.status = c.lifecycleStage; v.refId = c.id; } }
    if (n.type === 'Profile' && n.refId) { const p = m.get('profiles', n.refId); if (p) v.status = p.verificationStatus; }
    if (n.type === 'Contact' && n.refId) { const k = m.get('contacts', n.refId); if (k) { v.status = k.verified ? 'Verified' : 'Unverified'; v.sub = `${k.personName} · ${k.channel}`; } }
    if (n.type === 'Route' && n.refId) { const r = m.get('routes', n.refId); if (r) v.status = r.state; }
    if (mapped === root) v.root = true;
    nodes.set(mapped, v);
    return v;
  };
  const edgeView = (e: GraphEdge, derived = false): void => {
    const s = fam.has(e.sourceId) ? root : e.sourceId, t = fam.has(e.targetId) ? root : e.targetId;
    if (edges.has(e.id) || !nodes.has(s) || !nodes.has(t)) return;
    edges.set(e.id, { id: e.id, source: s, target: t, type: e.type, label: e.label, status: e.status, evidence: e.evidence, sourceLabel: e.source, sourceUrl: e.sourceUrl, sourceType: e.sourceType, discoveredAt: e.discoveredAt, verifiedAt: e.verifiedAt, verifiedBy: e.verifiedBy ? m.get('users', e.verifiedBy)?.name ?? e.verifiedBy : null, confidence: e.confidence, derived });
  };
  const visible = (e: GraphEdge) => e.active && e.status !== 'rejected';
  const rootEdges = [...fam].flatMap(id => m.edgesOf(id)).filter(visible);
  nodeView(root, 0);
  // Level 1: songs (collaborative and recent first), profiles, contacts, routes
  const songEdges = rootEdges.filter(e => isCredit(e.type) && fam.has(e.sourceId));
  const songIds = [...new Set(songEdges.map(e => e.targetId))];
  const collabCount = (sid: string) => m.edgesOf(sid).filter(e => isCredit(e.type) && !fam.has(e.sourceId) && visible(e)).length;
  songIds.sort((a, b) => collabCount(b) - collabCount(a) || (m.get('tracks', b.slice(5))?.releaseDate ?? '').localeCompare(m.get('tracks', a.slice(5))?.releaseDate ?? ''));
  const maxSongs = opts.maxSongs ?? 24;
  const shownSongs = songIds.slice(0, maxSongs);
  for (const sid of shownSongs) nodeView(sid, 1);
  for (const e of songEdges) edgeView(e);
  for (const e of rootEdges) {
    if (e.type === 'ARTIST_HAS_PROFILE' || e.type === 'PERSON_HAS_CONTACT') { if (nodeView(e.targetId, 1)) edgeView(e); }
    if (e.type === 'ROUTE_CONNECTS_ARTIST') { if (nodeView(e.sourceId, 1)) edgeView(e); }
  }
  // Level 2: collaborators on those songs, the label and distributor (one summary edge each), route contacts
  const labels = new Map<string, number>(), dists = new Map<string, number>();
  for (const sid of shownSongs) {
    for (const e of m.edgesOf(sid).filter(visible)) {
      if (isCredit(e.type) && !fam.has(e.sourceId)) { if (nodeView(e.sourceId, 2)) edgeView(e); }
      if (e.type === 'SONG_RELEASED_ON_LABEL') labels.set(e.targetId, (labels.get(e.targetId) ?? 0) + 1);
      if (e.type === 'SONG_DISTRIBUTED_BY') dists.set(e.targetId, (dists.get(e.targetId) ?? 0) + 1);
    }
  }
  for (const [map, type, word] of [[labels, 'ARTIST_SIGNED_TO_LABEL', 'Label'], [dists, 'SONG_DISTRIBUTED_BY', 'Distributor']] as const) {
    for (const [id, n] of map) {
      const v = nodeView(id, 2);
      if (!v) continue;
      edges.set(`derived:${type}:${id}`, { id: `derived:${type}:${id}`, source: root, target: id, type, label: `${word} (${n} song${n === 1 ? '' : 's'})`, status: 'discovered', evidence: `${n} of ${songIds.length} songs by this artist are ${word === 'Label' ? 'released on' : 'distributed by'} ${v.label} (backend catalogue)`, sourceLabel: 'Backend catalogue', sourceUrl: null, sourceType: 'Backend export', discoveredAt: '', verifiedAt: null, verifiedBy: null, confidence: 90, derived: true });
    }
  }
  for (const n of [...nodes.values()].filter(x => x.type === 'Route')) for (const e of m.edgesOf(n.id).filter(visible)) if (e.type === 'ROUTE_USES_CONTACT' && nodeView(e.targetId, 2)) edgeView(e);
  // Publicly mentioned relationships, and each collaborator's verified profiles and contacts (level 3)
  for (const e of rootEdges) if (e.type === 'PERSON_CONNECTED_TO_ARTIST') { const other = e.sourceId === root || fam.has(e.sourceId) ? e.targetId : e.sourceId; if (nodeView(other, 2)) edgeView(e); }
  const collaborators = [...nodes.values()].filter(n => (n.type === 'Artist' || n.type === 'Person' || n.type === 'Collaborator') && !n.root);
  for (const p of collaborators) {
    for (const e of m.edgesOf(p.id).filter(visible)) {
      if ((e.type === 'ARTIST_HAS_PROFILE' || e.type === 'PERSON_HAS_PROFILE') && e.status === 'verified' && nodeView(e.targetId, 3)) edgeView(e);
      if (e.type === 'PERSON_HAS_CONTACT' && nodeView(e.targetId, 3)) edgeView(e);
    }
  }
  // Depth 2: each collaborator's other songs (a few) and the people on them
  if ((opts.depth ?? 1) >= 2) {
    for (const p of collaborators) {
      const other = m.edgesOf(p.id).filter(e => isCredit(e.type) && e.sourceId === p.id && visible(e) && !nodes.has(e.targetId)).slice(0, 4);
      for (const e of other) { if (nodeView(e.targetId, 3)) edgeView(e); for (const e2 of m.edgesOf(e.targetId).filter(x => isCredit(x.type) && visible(x) && x.sourceId !== p.id).slice(0, 3)) if (nodeView(e2.sourceId, 4)) edgeView(e2); }
    }
  }
  // Manual expansion: direct neighbours of the chosen nodes (capped)
  for (const id of opts.expand ?? []) {
    const base = nodes.get(id);
    if (!base) continue;
    for (const e of m.edgesOf(id).filter(visible).slice(0, 24)) { const other = e.sourceId === id ? e.targetId : e.sourceId; if (nodeView(other, base.level + 1)) edgeView(e); }
  }
  // A connection path: make sure every node and edge on it is visible
  if (opts.pathId) {
    const path = m.get('connectionPaths', opts.pathId);
    if (path) {
      path.steps.forEach((s, i) => nodeView(s.nodeId, i));
      const map = (x: string) => (fam.has(x) ? root : x);
      for (let i = 1; i < path.steps.length; i++) {
        const a = map(path.steps[i - 1].nodeId), b = map(path.steps[i].nodeId);
        const pool = a === root ? [...fam].flatMap(f => m.edgesOf(f)) : m.edgesOf(a);
        const e = pool.find(x => (map(x.sourceId) === a && map(x.targetId) === b) || (map(x.sourceId) === b && map(x.targetId) === a));
        if (e) edgeView(e);
      }
    }
  }
  // finally connect everything already on screen (e.g. a collaborator credited on two shown songs)
  for (const n of [...nodes.values()]) for (const e of m.edgesOf(n.id).filter(visible)) { const s = fam.has(e.sourceId) ? root : e.sourceId, t = fam.has(e.targetId) ? root : e.targetId; if (nodes.has(s) && nodes.has(t) && e.type !== 'SONG_RELEASED_ON_LABEL' && e.type !== 'SONG_DISTRIBUTED_BY' && e.type !== 'SONG_ON_RELEASE') edgeView(e); }
  return { root, nodes: [...nodes.values()], edges: [...edges.values()], hidden: { songs: Math.max(0, songIds.length - shownSongs.length) } };
}

// ------------------------------------------------------------------ Find connection
export interface PathCandidate { signature: string; steps: PathStep[]; edgeIds: string[]; targetType: 'contact' | 'profile'; targetContactId: string | null; targetProfileId: string | null; edgeCount: number; score: number; strength: DiscoveryStrength; evidence: string[]; note: string | null; routeId: string | null }
const COST: Record<EdgeStatus, number> = { verified: 0.6, discovered: 1, possible: 1.6, rejected: 99 };
const CONTACTABLE = ['Instagram', 'Facebook', 'X', 'Website'];

/** Shortest evidence paths from the artist to a verified contact (or the artist's own verified profile), up to 6 relationships. */
export function findConnections(m: Model, caseId: string, today: string): PathCandidate[] {
  const rootCase = m.canonical(caseId);
  const c = m.get('cases', rootCase);
  if (!c) return [];
  const root = nid.case(rootCase);
  const fam = new Set(m.family(rootCase).map(id => nid.case(id)));
  const blockedPerson = (nodeId: string) => {
    if (!nodeId.startsWith('case:')) return false;
    const pc = m.get('cases', m.canonical(nodeId.slice(5)));
    return !!pc && (pc.contactPreference === 'Do Not Contact' || pc.contactPreference === 'Declined');
  };
  // A label or distributor speaks for the release's primary artist only.
  const primaryOn = (songId: string) => m.creditsOfTrack(songId.slice(5)).some(cr => cr.isPrimary && cr.status === 'Active' && !!cr.caseId && fam.has(nid.case(cr.caseId)));
  const dist = new Map<string, number>([[root, 0]]);
  const hops = new Map<string, number>([[root, 0]]);
  const prev = new Map<string, { from: string; edge: GraphEdge }>();
  const queue: string[] = [root];
  let expanded = 0;
  const startEdges = (id: string) => (id === root ? [...fam].flatMap(f => m.edgesOf(f)) : m.edgesOf(id));
  while (queue.length && expanded < 6000) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const cur = queue.shift()!;
    expanded++;
    const curNode = cur === root ? null : m.get('graphNodes', cur);
    const type = cur === root ? 'Artist' : curNode?.type;
    if (type === 'Contact' || type === 'Profile' || (hops.get(cur) ?? 0) >= 6) continue;
    let list = startEdges(cur).filter(e => e.active && e.status !== 'rejected');
    if (type === 'Artist' || type === 'Person' || type === 'Collaborator') {
      const songsOut = list.filter(e => isCredit(e.type)).sort((a, b) => (b.discoveredAt ?? '').localeCompare(a.discoveredAt ?? '')).slice(0, cur === root ? 200 : 40);
      list = [...songsOut, ...list.filter(e => e.type === 'PERSON_HAS_CONTACT' || e.type === 'PERSON_CONNECTED_TO_ARTIST' || (cur === root && e.type === 'ARTIST_HAS_PROFILE'))];
    } else if (type === 'Song') list = list.filter(e => isCredit(e.type) || (e.type === 'SONG_RELEASED_ON_LABEL' && primaryOn(cur)));
    else if (type === 'Label' || type === 'Distributor') list = list.filter(e => e.type === 'ORGANISATION_HAS_CONTACT');
    else list = [];
    for (const e of list) {
      const next = e.sourceId === cur || (cur === root && fam.has(e.sourceId)) ? e.targetId : e.sourceId;
      if (fam.has(next) || next === cur) continue;
      const nn = m.get('graphNodes', next);
      if (!nn) continue;
      if (nn.type === 'Contact') { const k = m.get('contacts', nn.refId ?? ''); if (!k?.verified || (k.caseId && blockedPerson(nid.case(k.caseId)))) continue; }
      // Only profiles you can actually write to count as a direct route (not a streaming page).
      if (nn.type === 'Profile') { const p = m.get('profiles', nn.refId ?? ''); if (cur !== root || p?.verificationStatus !== 'VERIFIED' || !CONTACTABLE.includes(p.platform)) continue; }
      if (blockedPerson(next)) continue;
      // Catalogue credits are the backbone; a public mention only helps once a person has verified the relationship.
      const d = dist.get(cur)! + (e.type === 'PERSON_CONNECTED_TO_ARTIST' ? (e.status === 'verified' ? 0.3 : 2.6) : COST[e.status]);
      if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); hops.set(next, (hops.get(cur) ?? 0) + 1); prev.set(next, { from: cur, edge: e }); queue.push(next); }
    }
  }
  const routes = m.byCase('routes', rootCase);
  const out: PathCandidate[] = [];
  for (const [nodeId] of dist) {
    const n = m.get('graphNodes', nodeId);
    if (!n || (n.type !== 'Contact' && n.type !== 'Profile')) continue;
    const chain: { node: string; edge: GraphEdge | null }[] = [{ node: nodeId, edge: null }];
    let at = nodeId;
    while (prev.has(at)) { const p = prev.get(at)!; chain[0].edge = p.edge; chain.unshift({ node: p.from, edge: null }); at = p.from; }
    const edgesOnPath = chain.slice(1).map(x => x.edge!);
    const steps: PathStep[] = chain.map((x, i) => {
      const gn = x.node === root ? null : m.get('graphNodes', x.node);
      const label = x.node === root ? c.canonicalName : gn?.type === 'Artist' && gn.refId ? m.get('cases', m.canonical(gn.refId))?.canonicalName ?? gn.label : gn?.label ?? x.node;
      return { nodeId: x.node, kind: x.node === root ? 'Artist' : gn?.type ?? 'Node', label: gn?.type === 'Song' ? `“${label}”` : label, sub: gn?.type === 'Contact' ? gn.sub : null, via: i === 0 ? null : edgesOnPath[i - 1].label };
    });
    const contact = n.type === 'Contact' ? m.get('contacts', n.refId ?? '') ?? null : null;
    const profile = n.type === 'Profile' ? m.get('profiles', n.refId ?? '') ?? null : null;
    const possible = edgesOnPath.some(e => e.status === 'possible');
    const edgeCount = edgesOnPath.length;
    const songOnPath = steps.find(s => s.kind === 'Song');
    const track = songOnPath ? m.get('tracks', songOnPath.nodeId.slice(5)) : null;
    // A cold message to the artist's own profile ranks below a warm introduction through a verified contact.
    let score = (profile ? 72 : 100) - 12 * Math.max(0, edgeCount - 1);
    if (contact?.willingIntroducer) score += 10;
    if (possible) score -= 15;
    if (edgesOnPath.every(e => e.status === 'verified')) score += 6;
    if (track?.releaseDate && daysBetween(track.releaseDate, today) <= 730) score += 4;
    if (contact?.organisation) score -= 10;
    score = Math.max(5, Math.min(100, score));
    const strength: DiscoveryStrength = score >= 70 && edgeCount <= 3 && !possible ? 'STRONG' : score >= 45 ? 'POSSIBLE' : 'WEAK';
    const existing = routes.find(r => (contact && r.contactId === contact.id) || (profile && r.sourceUrl && nameKey(r.sourceUrl) === nameKey(profile.url)));
    const note = existing ? (existing.state === 'Rejected' || existing.state === 'Exhausted' ? `Already tried: route ${existing.id} ${existing.state.toLowerCase()}${existing.rejectionReason ? ` (${existing.rejectionReason})` : ''}` : `Route ${existing.id} already exists (${existing.state})`) : (c.contactPreference === 'Do Not Contact' || c.contactPreference === 'Declined') ? `${c.contactPreference}: no outreach route can be created` : null;
    out.push({
      signature: chain.map(x => x.node).join('>'), steps, edgeIds: edgesOnPath.map(e => e.id), targetType: contact ? 'contact' : 'profile', targetContactId: contact?.id ?? null, targetProfileId: profile?.id ?? null,
      edgeCount, score, strength, evidence: edgesOnPath.map(e => e.evidence), note, routeId: existing?.id ?? null,
    });
  }
  // At most two direct profile routes (Instagram first), so verified profiles do not crowd out introduction paths.
  const direct = out.filter(p => p.targetType === 'profile').sort((a, b) => CONTACTABLE.indexOf(platformOfPath(m, a)) - CONTACTABLE.indexOf(platformOfPath(m, b))).slice(0, 2);
  return [...out.filter(p => p.targetType === 'contact'), ...direct].sort((a, b) => b.score - a.score || a.edgeCount - b.edgeCount).slice(0, 8);
}

export function savePaths(m: Model, ctx: Ctx, caseId: string, paths: PathCandidate[]): { all: ConnectionPath[]; created: ConnectionPath[] } {
  const created: ConnectionPath[] = [], all: ConnectionPath[] = [];
  for (const p of paths) {
    const id = m.idx.pathByKey.get(`${caseId}|${p.signature}`);
    const cur = id ? m.get('connectionPaths', id) : undefined;
    if (cur) {
      all.push(m.update('connectionPaths', cur.id, { steps: p.steps, score: p.score, strength: p.strength, evidence: p.evidence, note: p.note, lastFoundAt: ctx.now, edgeCount: p.edgeCount, ...(p.routeId && !cur.routeId ? { routeId: p.routeId } : {}) }));
    } else {
      const row = m.insert('connectionPaths', {
        id: m.nextId('CP', 4), caseId, signature: p.signature, steps: p.steps, targetType: p.targetType, targetContactId: p.targetContactId, targetProfileId: p.targetProfileId, edgeCount: p.edgeCount,
        score: p.score, strength: p.strength, evidence: p.evidence, status: 'SUGGESTED', routeId: p.routeId, foundAt: ctx.now, lastFoundAt: ctx.now, foundBy: ctx.userId,
        decidedAt: null, decidedBy: null, reason: null, note: p.note,
      });
      created.push(row); all.push(row);
    }
  }
  return { all, created };
}
export const pathText = (steps: PathStep[]) => steps.map(s => s.label).join(' → ');
const platformOfPath = (m: Model, p: PathCandidate) => m.get('profiles', p.targetProfileId ?? '')?.platform ?? 'Website';
