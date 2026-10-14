// Keep only the verified artists (V2.7.2, asked for by the System Owner before importing a new artist directory). Every
// verified artist keeps everything that belongs to them: songs (with all credits on them), profiles, routes, contacts,
// messages, contact/claim/activation history, searches and timeline. Every other artist, the other songs, all import
// batches and import rows are removed. People, accounts, message templates, festivals and settings stay.
// Credits on kept songs that point at a removed artist keep the person's name (no artist link). A backup comes first.
import { isDerived, Model, type CollectionName, type Snapshot } from './model';
import { isVerified } from './status';

export interface PruneResult { snap: Snapshot; kept: string[]; before: Record<string, number>; after: Record<string, number> }

export function keepOnlyVerified(m: Model): PruneResult {
  const keep = new Set<string>();
  for (const c of m.all('cases')) if (!c.mergedIntoId && !c.rejectedAt && isVerified(c)) for (const id of m.family(c.id)) keep.add(id);
  const kept = (id: string | null | undefined): id is string => !!id && keep.has(id);
  const ids = <T extends { id: string }>(rows: T[]) => new Set(rows.map(r => r.id));

  // songs of the kept artists, with every credit on them
  const trackIds = new Set<string>();
  for (const id of keep) for (const t of m.trackIdsOfCase(id)) trackIds.add(t);
  const tracks = m.all('tracks').filter(t => trackIds.has(t.id));
  const releaseIds = new Set(tracks.map(t => t.releaseId).filter((x): x is string => !!x));
  const credits = m.all('credits').filter(cr => trackIds.has(cr.trackId)).map(cr => (cr.caseId && !kept(m.canonical(cr.caseId)) && !kept(cr.caseId) ? { ...cr, caseId: null } : cr));

  const routes = m.all('routes').filter(r => kept(r.targetCaseId)).map(r => (r.collaboratorCaseId && !kept(r.collaboratorCaseId) ? { ...r, collaboratorCaseId: null } : r));
  const contactIds = new Set(routes.map(r => r.contactId).filter((x): x is string => !!x));
  const contacts = m.all('contacts').filter(k => kept(k.caseId) || contactIds.has(k.id));
  const profiles0 = m.all('profiles').filter(p => kept(p.caseId));
  const collabIds = new Set(profiles0.map(p => p.collaboratorId).filter((x): x is string => !!x));
  const collaborators = m.all('collaborators').filter(c => kept(c.caseId) || collabIds.has(c.id)).map(c => (c.caseId && !kept(c.caseId) ? { ...c, caseId: null } : c));
  const collabKept = ids(collaborators);
  const profiles = [...profiles0, ...m.all('profiles').filter(p => !p.caseId && p.collaboratorId && collabKept.has(p.collaboratorId))]
    .map(p => (p.otherCaseId && !kept(p.otherCaseId) ? { ...p, otherCaseId: null } : p));
  const profileIds = ids(profiles), routeIds = ids(routes), contactKept = ids(contacts);
  const jobs = m.all('discoveryJobs').filter(j => kept(j.caseId));
  const jobIds = ids(jobs);
  const conflicts = m.all('conflicts').filter(x => x.caseIds.every(id => kept(id)));
  const conflictIds = ids(conflicts);

  // stored graph rows (profiles, routes, contacts, collaborators and what a person verified); the catalogue part is rebuilt on load
  const nodeOk = (id: string): boolean => {
    const [kind, ref] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    switch (kind) {
      case 'case': return kept(ref);
      case 'song': return trackIds.has(ref);
      case 'profile': return profileIds.has(ref);
      case 'route': return routeIds.has(ref);
      case 'contact': return contactKept.has(ref);
      case 'collab': case 'collaborator': return collabKept.has(ref);
      default: return true;   // person / label / distributor / release: names, not records
    }
  };
  const graphNodes = m.all('graphNodes').filter(n => !isDerived('graphNodes', n) && nodeOk(n.id));
  const graphEdges = m.all('graphEdges').filter(e => !isDerived('graphEdges', e) && nodeOk(e.sourceId) && nodeOk(e.targetId));

  const byCase = <K extends CollectionName>(c: K) => (m.all(c) as { caseId?: string | null }[]).filter(r => kept(r.caseId)) as Snapshot[K];
  const snap: Snapshot = {
    users: m.all('users'),
    cases: m.all('cases').filter(c => keep.has(c.id)),
    batches: [], importRows: [],
    releases: m.all('releases').filter(r => releaseIds.has(r.id)),
    tracks, credits, conflicts,
    decisions: m.all('decisions').filter(d => conflictIds.has(d.conflictId)),
    contacts, routes,
    research: byCase('research'), attempts: byCase('attempts'), tasks: byCase('tasks'), claimEvents: byCase('claimEvents'), activationEvents: byCase('activationEvents'),
    reopens: byCase('reopens'), statusEvents: byCase('statusEvents'), messages: byCase('messages'),
    // global history stays except the import and bulk-search entries of what is removed
    audit: m.all('audit').filter(a => (a.caseId ? kept(a.caseId) : !['ImportBatch', 'ImportRow', 'DiscoveryBulk'].includes(a.entity))),
    notifications: m.all('notifications').filter(n => kept(n.caseId)),
    meta: m.all('meta'),
    collaborators, profiles,
    verifiedProfiles: byCase('verifiedProfiles'),
    discoveryJobs: jobs,
    discoveryQueries: m.all('discoveryQueries').filter(q => jobIds.has(q.jobId)),
    discoveryResults: m.all('discoveryResults').filter(r => jobIds.has(r.jobId)),
    discoveryEvidence: m.all('discoveryEvidence').filter(e => profileIds.has(e.profileId)),
    graphNodes, graphEdges,
    connectionPaths: m.all('connectionPaths').filter(p => kept(p.caseId) && (!p.targetContactId || contactKept.has(p.targetContactId)) && (!p.targetProfileId || profileIds.has(p.targetProfileId))),
  };
  const count = (s: Snapshot | null) => Object.fromEntries((Object.keys(snap) as CollectionName[]).map(c => [c, s ? (s[c]?.length ?? 0) : m.all(c).filter(r => !isDerived(c, r)).length]));
  return { snap, kept: [...keep], before: count(null), after: count(snap) };
}
