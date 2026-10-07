// Typed models. They mirror prisma/schema.prisma one-to-one, so the in-memory model and PostgreSQL hold the same shapes.
// Dates are ISO strings: timestamps "2026-10-02T15:20:00.000Z", calendar dates "2026-10-02".
import type { ArtistKind, ArtistStatus, GoongoonaloStatus } from './constants';
import type {
  ActivationStatus, AttemptResult, Channel, ChecklistStatus, ClaimStatus, ContactPreference, CreditRole, DiscoveryCaseStatus, DiscoveryJobStatus,
  DiscoveryMode, DiscoveryStrength, EdgeStatus, EvidenceKind, GraphNodeType, IdentityStatus, ImportClass, LifecycleStage, Platform, Priority,
  ProfileReview, RelationshipType, Role, RouteState, TaskKind, TaskStatus, WorkReason,
} from './constants';

export interface User { id: string; name: string; role: Role }

export interface ChecklistItem { step: number; status: ChecklistStatus; note: string; updatedAt: string | null; updatedBy: string | null }

export interface WaitingInfo {
  blocker: string;
  routesTested: string[];
  coverage: string;
  lastReview: string;
  futureTrigger: string;
  nextReviewDate: string;
}

export interface ArmInfo {
  relationshipOwnerId: string;
  interests: string;
  language: string;
  supportNeeds: string;
  nextParticipationCheck: string;
  since: string;
}

export interface ArtistCase {
  id: string;                     // permanent Artist ID, e.g. A000001 (older workspaces: C0001)
  canonicalName: string;
  aliases: string[];
  backendProfileIds: string[];    // artist IDs seen in backend exports, e.g. A001
  profileUrls: string[];
  roles: string[];
  language: string | null;
  identityStatus: IdentityStatus;
  identityEvidence: string | null;
  lifecycleStage: LifecycleStage;
  previousStage: LifecycleStage | null;
  stageReason: string;            // why the case is in this stage
  stageSince: string;
  workReason: WorkReason;
  contactPreference: ContactPreference;
  contactPreferenceUntil: string | null;
  ownerId: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  firstSeen: string;
  lastSeen: string;
  lastEvidenceChange: string | null;
  lastEvidenceNote: string | null;
  firstSeenBatchId: string | null;
  lastSeenBatchId: string | null;
  claimStatus: ClaimStatus;
  activationStatus: ActivationStatus;
  priority: Priority;
  priorityScore: number;
  mergedIntoId: string | null;
  closedReason: string | null;
  waiting: WaitingInfo | null;
  checklist: ChecklistItem[];
  arm: ArmInfo | null;
  discoveryStatus: DiscoveryCaseStatus;   // separate from the lifecycle stage
  discoveryUpdatedAt: string | null;
  verifiedProfileCount: number;
  /** v2: credited-only people (composer, lyricist, producer …) are Collaborators; lead/performing artists are Artists. */
  kind: ArtistKind;
  /** v2 identity/discovery status (derived, see status.ts) and when it last changed. */
  artistStatus: ArtistStatus;
  artistStatusAt: string | null;
  firstVerifiedAt: string | null;
  /** Identity confirmed by a person outside discovery (e.g. on a call); counts as verified. */
  manualVerifiedAt: string | null;
  manualVerifiedBy: string | null;
  /** Artist-level rejection (not a real artist record). */
  rejectedAt: string | null;
  rejectedReason: string | null;
  /** Why the artist was reopened and what changed; cleared when a person has reviewed it. */
  reopen: ReopenInfo | null;
  /** v2 Goongoonalo status: only a person changes it, every change is a StatusEvent. */
  goongoonaloStatus: GoongoonaloStatus;
  goongoonaloStatusAt: string | null;
  goongoonaloStatusBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ReopenReason { kind: 'new_song' | 'new_collaborator' | 'new_lead' | 'profile_change' | 'stale' | 'duplicate' | 'manual'; text: string; at: string }
export interface ReopenInfo { at: string; by: string; reasons: ReopenReason[]; previousStatus: ArtistStatus }
/** History of both status families (dashboard week/month numbers come from these timestamps). */
export interface StatusEvent { id: string; caseId: string; kind: 'identity' | 'goongoonalo'; from: string | null; to: string; at: string; by: string; reason: string | null }

export interface ImportSummary {
  artistsCreated: number;
  artistsUpdated: number;
  newSongs: number;
  updatedSongs: number;
  newCredits: number;
  reopenedCases: number;
  newTasks: number;
  newRoutes: number;
  claimChanges: number;
  activationChanges: number;
  identityExceptions: number;
  errors: string[];
  warnings: string[];
  classes: Record<ImportClass, number>;
  newArtistIds: string[];
  updatedArtistIds: string[];
  reopenedCaseIds: string[];
  taskIds: string[];
  routeIds: string[];
  artistCaseIds?: string[];         // primary artists named in the file (also for repeats)
  targetedJobIds?: string[];        // targeted discovery queued for verified artists with new evidence
  // v2 import summary (§37)
  artistsFound?: number;            // distinct lead artists named in the file
  newCollaborators?: number;        // credited-only people created
  newCollaboratorIds?: string[];
  possibleDuplicates?: number;      // duplicate candidates opened by this file
  duplicateIds?: string[];
  reopenedArtistIds?: string[];     // artists moved to REOPENED by new evidence
  mapping?: { field: string; column: string }[];   // how the file's columns were understood
  unmappedColumns?: string[];       // columns kept in the raw row only
  headerRow?: number;
  encoding?: string;
}

export type ImportFormat = 'G Amplify standard' | 'Media Library export' | 'Catalogue export' | 'Artist directory';

export interface ImportBatch {
  id: string;                      // B001
  originalFilename: string;
  source: string;
  format: ImportFormat;
  exportDate: string;
  uploadDate: string;
  uploaderId: string;
  importType: 'Full' | 'Incremental';
  checksum: string;
  version: number;
  versionOfId: string | null;
  repeatOfId: string | null;
  rowCount: number;
  acceptedCount: number;
  quarantinedCount: number;
  skippedCount: number;
  status: 'Processed' | 'Repeat' | 'Failed';
  summary: ImportSummary;
  createdAt: string;
}

export interface ImportRow {
  id: string;
  batchId: string;
  rowNumber: number;
  raw: Record<string, string> | null;
  status: 'Accepted' | 'Quarantined' | 'Skipped';
  classification: ImportClass | null;
  reason: string | null;
  ownerId: string | null;
  exceptionStatus: 'Open' | 'Resolved' | 'Dismissed' | null;
  resolution: string | null;
  resolvedAt: string | null;
  caseIds: string[];
  trackId: string | null;
  /** v2: the row as the importer understood it (field → value), next to the untouched raw row. */
  mapped: Record<string, string> | null;
}

export interface Release { id: string; backendReleaseId: string; title: string; firstSeen: string }

export interface TrackChange { at: string; batchId: string; field: string; from: string; to: string }

export interface Track {
  id: string;
  backendTrackId: string;
  releaseId: string | null;
  title: string;
  version: string;
  isrc: string;
  label: string;
  distributor: string;
  language: string;
  releaseDate: string;
  source: string;
  flags: string[];
  sig: string;                    // fingerprint of the last imported row, used to skip unchanged rows
  firstSeen: string;
  lastSeen: string;
  firstBatchId: string;
  lastBatchId: string;
  history: TrackChange[];
}

export interface Credit {
  id: string;
  trackId: string;
  caseId: string | null;          // null when the credited person/entity has no case (e.g. unresolved identity)
  personName: string;
  personBackendId: string | null;
  role: CreditRole;
  isPrimary: boolean;
  source: string;
  sourceVersion: string;          // batch that first reported it
  firstSeen: string;
  lastSeen: string;
  status: 'Active' | 'Superseded';
  statusReason: string | null;
}

export interface IdentityConflict {
  id: string;
  caseIds: string[];
  kind: 'Same name' | 'Similar spelling' | 'Similar name' | 'Manual flag' | 'Import exception';
  reason: string;
  status: 'Open' | 'Decided' | 'Deferred';
  createdAt: string;
  createdBy: string;
  decisionId: string | null;
}

export interface IdentityDecision {
  id: string;
  conflictId: string;
  caseIds: string[];
  decision: 'Same Person' | 'Keep Separate' | 'Defer';
  canonicalId: string | null;
  reviewerId: string;
  date: string;
  reason: string;
  evidence: string;
  added: { aliases: string[]; backendProfileIds: string[] } | null;
  snapshot: Record<string, Partial<ArtistCase>> | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reverseReason: string | null;
}

export interface Contact {
  id: string;
  personName: string;
  caseId: string | null;
  organisation: string | null;
  role: 'Artist' | 'Collaborator' | 'Manager' | 'Representative' | 'Label' | 'Distributor';
  channel: Channel;
  value: string;
  authorityEvidence: string;
  verified: boolean;
  verifiedById: string | null;
  verifiedAt: string | null;
  willingIntroducer: boolean;
  source: string;
  createdAt: string;
}

export interface Route {
  id: string;
  targetCaseId: string;
  trackId: string | null;
  collaboratorName: string | null;
  collaboratorCaseId: string | null;
  organisation: string | null;
  contactId: string | null;
  sourceUrl: string | null;
  evidence: string;
  confidence: number;
  state: RouteState;
  ranking: number;
  lastChecked: string | null;
  rejectionReason: string | null;
  ownerId: string | null;
  origin: string;                 // "Batch B002", "Research", "Manual", "Find connection"
  path: PathStep[] | null;        // multi-hop route found by Find connection
  pathId: string | null;
  createdAt: string;
}
export interface PathStep { nodeId: string; kind: string; label: string; sub?: string | null; via?: string | null }

export interface ResearchActivity {
  id: string;
  caseId: string;
  source: string;
  query: string;
  url: string;
  result: string;
  evidence: string;
  confidence: number;
  researcherId: string;
  date: string;
  minutes: number;
  checklistStep: number | null;
}

export interface ContactAttempt {
  id: string;
  caseId: string;
  routeId: string | null;
  date: string;
  channel: Channel;
  recipient: string;
  message: string;
  result: AttemptResult;
  evidence: string;
  nextAction: string;
  nextActionDate: string | null;
  ownerId: string;
}

export interface TaskNote { at: string; by: string; text: string; kind: 'note' | 'evidence' | 'change' }

export interface Task {
  id: string;
  caseId: string;
  ownerId: string | null;
  kind: TaskKind;
  step: string;
  trigger: string;
  why: string;
  evidenceChange: string | null;
  dueDate: string;
  priority: Priority;
  status: TaskStatus;
  workReason: WorkReason;
  action: string | null;
  channel: Channel | null;
  recipient: string | null;
  result: string | null;
  evidence: string[];
  notes: TaskNote[];
  nextAction: string | null;
  focusedMinutes: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string;
}

export type ClaimEventType = 'Invited' | 'Submitted' | 'Sent to Review' | 'Approved' | 'Rejected' | 'Clarification Requested'
  | 'Backend Verified' | 'Backend Mismatch' | 'Backend Reported Claimed';

export interface ClaimEvent {
  id: string;
  caseId: string;
  type: ClaimEventType;
  date: string;
  profileId: string | null;
  claimRequestId: string | null;
  recipient: string | null;
  reviewerId: string | null;
  notes: string;
  evidence: string;
  actorId: string;
  source: 'User' | 'Import';
}

export type ActivationEventType = 'Access Verified' | 'Feature Selected' | 'Login Only' | 'Meaningful Use' | 'Backend Activity'
  | 'ARM Handover' | 'Participation Check';

export interface ActivationEvent {
  id: string;
  caseId: string;
  type: ActivationEventType;
  date: string;
  feature: string | null;
  expectedOutcome: string | null;
  operatorId: string | null;
  agreedDate: string | null;
  backendRef: string | null;
  evidence: string;
  result: string | null;
  actorId: string;
}

export interface ReopenEvent {
  id: string;
  caseId: string;
  date: string;
  oldStage: LifecycleStage;
  newStage: LifecycleStage;
  evidence: string;
  why: string;
  routeId: string | null;
  taskId: string | null;
  batchId: string | null;
  contactId: string | null;
  ownerId: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  userId: string;
  caseId: string | null;
  entity: string;
  entityId: string;
  action: string;
  field: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  evidence: string | null;
  result: string | null;
  next: string | null;
}

export type NotificationType = 'New lead' | 'Case reopened' | 'Identity conflict' | 'Claim submitted' | 'Claim approved'
  | 'Activation pending' | 'Task overdue' | 'New reply' | 'Do-not-contact protected' | 'Import' | 'Discovery';

export interface Notification { id: string; type: NotificationType; text: string; caseId: string | null; at: string; read: boolean }

export interface Meta { id: string; value: string }

// ---------------------------------------------------------------------------------------------------------------
// Artist discovery
export interface JobStep { label: string; state: 'todo' | 'running' | 'done' | 'failed' | 'skipped'; detail: string | null }
export interface JobProvider { id: string; label: string; kind: string; status: 'ok' | 'failed' | 'skipped' | 'partial' | 'limited'; queries: number; results: number; cached: number; error: string | null }

export interface DiscoveryJob {
  id: string;                       // DJ0001
  caseId: string;
  version: number;                  // search version for this artist (v1, v2 ...); old versions are kept
  mode: DiscoveryMode;
  status: DiscoveryJobStatus;
  trigger: string;
  focus: string[];                  // targeted: the new evidence searched around
  focusTrackIds: string[];
  bulkId: string | null;
  requestedBy: string;
  demo: boolean;                    // stored column from the retired demo mode; always false
  step: number;
  steps: JobStep[];
  providers: JobProvider[];
  queryCount: number;
  cachedCount: number;
  resultCount: number;
  profileCount: number;
  newProfileCount: number;
  groupCount: number;
  pathCount: number;
  outcome: 'candidates' | 'no_candidates' | 'failed' | 'stopped' | null;
  failureReason: string | null;
  attempt: number;
  retryOf: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export type QueryKind = 'name' | 'role' | 'platform' | 'site' | 'song' | 'isrc' | 'label' | 'distributor' | 'alias' | 'collaborator';
export interface DiscoveryQuery {
  id: string;
  jobId: string;
  caseId: string;
  provider: string;
  query: string;
  kind: QueryKind;
  subject: string;                  // who the query is about
  status: 'ok' | 'failed' | 'cached' | 'skipped';
  resultCount: number;
  cacheKey: string;
  error: string | null;
  ranAt: string;
}

export interface ProfileTrack { title: string; isrc?: string | null }
/** One search hit (provider + query + URL). Kept as history and as the cache for repeated queries. */
export interface DiscoveryResult {
  id: string;
  caseId: string;
  jobId: string;
  queryId: string;
  version: number;
  provider: string;
  query: string;
  url: string;
  normalizedUrl: string;
  platform: Platform;
  title: string;
  snippet: string;
  displayName: string | null;
  username: string | null;
  structured: { description?: string; location?: string | null; language?: string | null; links?: string[]; tracks?: ProfileTrack[]; followers?: number | null } | null;
  profileId: string | null;
  demo: boolean;                    // stored column from the retired demo mode; always false
  discoveredAt: string;
}

export interface FoundVia { jobId: string; version: number; provider: string; query: string; kind: QueryKind }
/** A public profile that may belong to an artist. Created by discovery, decided by a person. */
export interface ArtistProfile {
  id: string;                       // PF0001
  caseId: string | null;
  collaboratorId: string | null;    // for credited people who have no artist case
  platform: Platform;
  url: string;
  normalizedUrl: string;
  displayName: string;
  username: string | null;
  title: string;
  description: string;
  location: string | null;
  language: string | null;
  links: string[];                  // normalized outbound links (cross-platform evidence)
  tracks: ProfileTrack[];
  followers: number | null;
  source: string;                   // providers that found it
  foundVia: FoundVia[];
  discoveryStatus: 'FOUND' | 'NOT_FOUND';   // NOT_FOUND = not seen again in the latest refresh (never auto-invalidated)
  verificationStatus: ProfileReview;
  evidenceScore: number;            // "discovery evidence score", never an identity confidence
  strength: DiscoveryStrength;
  matched: string[];
  conflicts: string[];
  matchedSongs: string[];
  otherCaseId: string | null;       // evidence points at a different artist with the same name
  groupKey: string | null;
  groupLabel: string | null;
  changeOfProfileId: string | null; // refresh found a possible replacement for this verified profile
  scoreAtReview: number | null;
  firstJobId: string;
  lastJobId: string;
  lastVersion: number;
  discoveredAt: string;
  lastCheckedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  rejectionReason: string | null;
  demo: boolean;                    // stored column from the retired demo mode; always false
}

export interface VerifiedProfile {
  id: string;                       // VP0001
  caseId: string;
  profileId: string | null;
  platform: Platform;
  url: string;
  username: string | null;
  displayName: string;
  verificationStatus: 'VERIFIED' | 'REPLACED';
  verifiedBy: string;
  verifiedAt: string;
  lastCheckedAt: string;
  source: string;
  evidence: string;
  replacedBy: string | null;
}

export interface DiscoveryEvidence {
  id: string;
  caseId: string | null;
  profileId: string;
  jobId: string;
  version: number;
  kind: EvidenceKind;
  polarity: 'match' | 'conflict';
  detail: string;
  weight: number;
  sourceUrl: string | null;
  createdAt: string;
}

export interface GraphNode { id: string; type: GraphNodeType; label: string; refId: string | null; sub: string | null; url: string | null; createdAt: string }
export interface GraphEdge {
  id: string;
  key: string;                      // deterministic: repeated imports never duplicate an edge
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  label: string;
  evidence: string;
  source: string;
  sourceUrl: string | null;
  sourceType: 'Backend export' | 'Discovery' | 'Human' | 'Directory' | 'Route' | 'Manual';
  status: EdgeStatus;
  active: boolean;
  confidence: number;
  discoveredAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

/** A credited person found while discovering an artist. Linked to their case when one exists. */
export interface Collaborator {
  id: string;
  key: string;
  name: string;
  caseId: string | null;
  status: 'Linked case' | 'Candidate';
  roles: string[];
  songs: string[];
  firstJobId: string;
  lastJobId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ConnectionPath {
  id: string;
  caseId: string;
  signature: string;
  steps: PathStep[];
  targetType: 'contact' | 'profile';
  targetContactId: string | null;
  targetProfileId: string | null;
  edgeCount: number;
  score: number;
  strength: DiscoveryStrength;
  evidence: string[];
  status: 'SUGGESTED' | 'ROUTE_CREATED' | 'REJECTED';
  routeId: string | null;
  foundAt: string;
  lastFoundAt: string;
  foundBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;            // why a person rejected the path
  note: string | null;              // system note, e.g. "Already tried: route RT0003 exhausted"
}

/** `discovery`: 'live' when search providers are configured, 'off' when none are (Find artist is then switched off). */
export interface Ctx {
  userId: string; now: string; today: string; discovery?: 'live' | 'off';
  /** Search-API budget left (null or missing = no limit): complete artist searches left, and why nothing can run. */
  searchBudget?: { artists: number; exhausted: string | null } | null;
}
