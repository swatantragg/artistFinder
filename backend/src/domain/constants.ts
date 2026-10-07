// Central status definitions. Lifecycle stage, task status, work reason and contact preference
// are four separate fields (spec §18) and must never be merged into one generic status.

export const LIFECYCLE_STAGES = [
  'Unresearched', 'Identity Review', 'Researching', 'Waiting for Evidence', 'Route Ready',
  'Introduction Pending', 'Contact Attempted', 'Contact Confirmed', 'Claim Invited', 'Claim Submitted',
  'Claim Review', 'Claimed', 'Activation Pending', 'Activated', 'Ongoing ARM', 'Closed',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red' | 'violet' | 'gold';

export const STAGE_INFO: Record<LifecycleStage, { tone: Tone; meaning: string }> = {
  'Unresearched': { tone: 'neutral', meaning: 'Accepted from an import. Nobody has researched this artist yet.' },
  'Identity Review': { tone: 'orange', meaning: 'Possible duplicate or unclear identity. A reviewer must decide before any contact.' },
  'Researching': { tone: 'blue', meaning: 'An operator is working the research checklist.' },
  'Waiting for Evidence': { tone: 'orange', meaning: 'No usable route yet. Kept with its blocker until new evidence arrives.' },
  'Route Ready': { tone: 'blue', meaning: 'A verified route is selected. Outreach is due.' },
  'Introduction Pending': { tone: 'blue', meaning: 'An introducer agreed to connect us. Waiting for the introduction.' },
  'Contact Attempted': { tone: 'blue', meaning: 'Message or call logged. No confirmed conversation yet.' },
  'Contact Confirmed': { tone: 'green', meaning: 'The artist or an authorised representative was actually reached.' },
  'Claim Invited': { tone: 'violet', meaning: 'Claim link sent. A sent link is not a submitted claim.' },
  'Claim Submitted': { tone: 'violet', meaning: 'The artist submitted a claim request. Not approved yet.' },
  'Claim Review': { tone: 'violet', meaning: 'An admin is reviewing the claim, or it is approved and waiting for backend verification.' },
  'Claimed': { tone: 'green', meaning: 'Backend verified the completed claim.' },
  'Activation Pending': { tone: 'orange', meaning: 'Claimed. Waiting for verified access plus one meaningful feature action.' },
  'Activated': { tone: 'green', meaning: 'Access verified and a meaningful feature action recorded with evidence.' },
  'Ongoing ARM': { tone: 'green', meaning: 'Handed over to ARM with a participation check scheduled.' },
  'Closed': { tone: 'neutral', meaning: 'Closed with a reason. History is kept.' },
};

// Two status families that are never mixed (v2 §9, §44):
//  - identity/discovery: where the artist stands in "software discovers → human verifies → software remembers"
//  - Goongoonalo: the operator's decision about the artist on Goongoonalo (never changed by discovery)
export const ARTIST_STATUSES = ['NEW', 'PENDING', 'SEARCHING', 'NEEDS_REVIEW', 'REOPENED', 'VERIFIED', 'REJECTED'] as const;
export type ArtistStatus = (typeof ARTIST_STATUSES)[number];
export const ARTIST_STATUS_INFO: Record<ArtistStatus, { label: string; tone: Tone; meaning: string }> = {
  NEW: { label: 'New', tone: 'neutral', meaning: 'Extracted from an import. Nobody has searched for this artist yet.' },
  PENDING: { label: 'Pending', tone: 'gold', meaning: 'Worked on, but the identity is not verified yet (no match found, search failed or set aside).' },
  SEARCHING: { label: 'Searching', tone: 'blue', meaning: 'Find artist is running in the background.' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'orange', meaning: 'The software found candidate profiles. A person verifies or rejects them.' },
  REOPENED: { label: 'Reopened', tone: 'violet', meaning: 'Something changed since the last review (new song, collaborator, profile change, stale check). Earlier verification is kept.' },
  VERIFIED: { label: 'Verified', tone: 'green', meaning: 'A person verified the artist’s identity (verified profiles, a completed claim or a confirmation by hand).' },
  REJECTED: { label: 'Rejected', tone: 'red', meaning: 'Not a real artist record (e.g. test content or a label name). Kept with the reason.' },
};
export const GOONGOONALO_STATUSES = ['PENDING', 'GOONGOONALO', 'REJECTED', 'DO_NOT_CONTACT'] as const;
export type GoongoonaloStatus = (typeof GOONGOONALO_STATUSES)[number];
export const GOONGOONALO_INFO: Record<GoongoonaloStatus, { label: string; tone: Tone; meaning: string }> = {
  PENDING: { label: 'Pending', tone: 'neutral', meaning: 'No decision about Goongoonalo yet.' },
  GOONGOONALO: { label: 'Goongoonalo', tone: 'green', meaning: 'The artist is on Goongoonalo.' },
  REJECTED: { label: 'Rejected', tone: 'red', meaning: 'Not a fit for Goongoonalo (decided by a person).' },
  DO_NOT_CONTACT: { label: 'Do not contact', tone: 'orange', meaning: 'The artist asked not to be contacted. Outreach is blocked.' },
};
export const ARTIST_KINDS = ['Artist', 'Collaborator'] as const;
export type ArtistKind = (typeof ARTIST_KINDS)[number];

export const WORK_REASONS = ['New Artist', 'New Lead', 'Follow-up', 'Metadata Gap', 'Technical Issue', 'Re-engagement'] as const;
export type WorkReason = (typeof WORK_REASONS)[number];

export const TASK_STATUSES = ['Queued', 'In Progress', 'Waiting', 'Completed', 'Cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_TASK_STATUSES: TaskStatus[] = ['Queued', 'In Progress', 'Waiting'];

export const CONTACT_PREFERENCES = ['Allowed', 'Later', 'Declined', 'Do Not Contact'] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

export const CLAIM_STATUSES = ['Not Invited', 'Invited', 'Submitted', 'In Review', 'Approved', 'Completed', 'Rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const ACTIVATION_STATUSES = ['Not Started', 'Access Verified', 'Feature Selected', 'Activated'] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export const ROUTE_STATES = ['Candidate', 'Verified', 'Selected', 'Rejected', 'Exhausted'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export const CHANNELS = ['Email', 'Phone', 'WhatsApp', 'Instagram', 'Introducer', 'Other'] as const;
/** "Verified WhatsApp", "Verified email": brand names keep their capitals. */
export const contactLabel = (verified: boolean, channel: string) => `${verified ? 'Verified' : 'Unverified'} ${channel === 'Email' || channel === 'Phone' || channel === 'Other' ? channel.toLowerCase() : channel}`;
export type Channel = (typeof CHANNELS)[number];

export const ATTEMPT_RESULTS = [
  'No Response', 'Wrong Person', 'Bounce', 'Introduction Requested', 'Interested', 'Needs Help', 'Later',
  'Declined', 'Do Not Contact', 'Conversation Confirmed',
] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];
/** Results that mean the correct artist or authorised representative was really reached. */
export const CONFIRMING_RESULTS: AttemptResult[] = ['Interested', 'Needs Help', 'Conversation Confirmed'];

export const PRIORITIES = ['High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** One System Owner (everything), Admins (people + admin work), Users (finding, deduplicating, everyday work). */
export const ROLES = ['System Owner', 'Admin', 'User', 'Automation'] as const;
export type Role = (typeof ROLES)[number];
/** The roles people can be given (the System Owner is the first account and never changes). */
export const PEOPLE_ROLES = ['Admin', 'User'] as const;

export const CREDIT_ROLES = ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

export const IDENTITY_STATUSES = ['Verified', 'Provisional', 'Under Review'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export const CHECKLIST_STEPS = [
  { title: 'Read existing history', help: 'Check claim status, prior searches, attempted routes and open follow-ups. Do not restart from zero.' },
  { title: 'Verify artist dossier', help: 'Open the profile and linked songs. Confirm the person matches the catalogue and role.' },
  { title: 'Check available direct details', help: 'Authorised internal contacts, official websites, previously verified details.' },
  { title: 'Inspect song credits', help: 'Performers, writers, producers, label and distributor on each relevant song.' },
  { title: 'Check professional profiles', help: 'DSPs, YouTube, SoundCloud and social profiles. Log query, URL and result.' },
  { title: 'Build introduction route', help: 'Match credited collaborators and organisations against the verified contact directory.' },
  { title: 'Verify and select route', help: 'Corroborate the contact identity. Select one route; keep the others.' },
  { title: 'Save outcome', help: 'Route ready, identity review, metadata request, waiting for introduction or waiting for evidence.' },
] as const;
export const CHECKLIST_STATUSES = ['Not Started', 'In Progress', 'Complete', 'Blocked'] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export const FEATURES = ['Correct Profile', 'Submit Content', 'Artist Post', 'Other Approved Feature'] as const;

export const IMPORT_CLASSES = [
  'Unchanged', 'New Relationship', 'Updated Metadata', 'New Artist', 'Identity Exception',
  'New Evidence (route)', 'Claim State Change', 'Activation State Change',
] as const;
export type ImportClass = (typeof IMPORT_CLASSES)[number];

export const TASK_KINDS = ['Research', 'Outreach', 'Follow-up', 'Introduction', 'Claim', 'Claim Review', 'Backend Check', 'Activation', 'ARM', 'Identity', 'Metadata', 'Re-engagement', 'Manual'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Pilot cadence from the operating design (p6 D4): follow-ups after 3 and 7 working days, supervisor review after 14.
export const FOLLOW_UP_DAYS = [3, 7, 14] as const;
export const PARTICIPATION_CHECK_DAYS = 30;
export const WAITING_REVIEW_DAYS = 30;

// ---------------------------------------------------------------------------------------------------------------
// Artist discovery: software searches, a human verifies, the system remembers.
/** CANCELLED = stopped by a person before it started (nothing was searched; the artist goes back to its earlier status). */
export const DISCOVERY_JOB_STATUSES = ['QUEUED', 'SEARCHING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'] as const;
export type DiscoveryJobStatus = (typeof DISCOVERY_JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: DiscoveryJobStatus[] = ['QUEUED', 'SEARCHING', 'PROCESSING'];
/** Per-artist discovery state, kept separate from the lifecycle stage. */
export const DISCOVERY_CASE_STATUSES = ['Not started', 'Queued', 'Searching', 'Needs verification', 'Verified', 'No candidate', 'Failed'] as const;
export type DiscoveryCaseStatus = (typeof DISCOVERY_CASE_STATUSES)[number];
export const DISCOVERY_STEPS = ['Generating queries', 'Searching web', 'Searching supported APIs', 'Analyzing songs', 'Analyzing collaborators', 'Building graph', 'Preparing candidates'] as const;
export type DiscoveryMode = 'full' | 'refresh' | 'targeted';

export const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'Spotify', 'SoundCloud', 'X', 'Apple Music', 'JioSaavn', 'Gaana', 'Deezer', 'Website', 'Label website'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PROFILE_REVIEW = ['UNREVIEWED', 'VERIFIED', 'REJECTED', 'DEFERRED', 'REPLACED'] as const;
export type ProfileReview = (typeof PROFILE_REVIEW)[number];
/** Discovery strength describes the evidence. It is never an identity decision: only a person verifies. */
export const DISCOVERY_STRENGTHS = ['STRONG', 'POSSIBLE', 'WEAK'] as const;
export type DiscoveryStrength = (typeof DISCOVERY_STRENGTHS)[number];
export const STRENGTH_LABEL: Record<DiscoveryStrength, string> = { STRONG: 'Strong candidate', POSSIBLE: 'Possible candidate', WEAK: 'Weak candidate' };

export const EVIDENCE_KINDS = [
  'Name match', 'Alias match', 'Partial name match', 'Song match', 'ISRC match', 'Catalogue match', 'Role match', 'Label match', 'Distributor match',
  'Collaborator match', 'Official website match', 'Cross-platform match', 'Language match', 'Location match',
  'Different profession', 'Songs of another artist', 'Previously rejected', 'Name differs', 'Different language', 'Different location',
  'Handle match', 'Music profile', 'Fan or compilation page',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const GRAPH_NODE_TYPES = ['Artist', 'Song', 'Release', 'Person', 'Collaborator', 'Label', 'Distributor', 'Profile', 'Contact', 'Route'] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];
export const RELATIONSHIP_TYPES = [
  'ARTIST_PERFORMED_SONG', 'ARTIST_COMPOSED_SONG', 'ARTIST_PRODUCED_SONG', 'PERSON_CREDITED_ON_SONG', 'ARTIST_SIGNED_TO_LABEL', 'SONG_RELEASED_ON_LABEL',
  'SONG_DISTRIBUTED_BY', 'SONG_ON_RELEASE', 'ARTIST_HAS_PROFILE', 'PERSON_HAS_PROFILE', 'PERSON_HAS_CONTACT', 'ORGANISATION_HAS_CONTACT',
  'PERSON_CONNECTED_TO_ARTIST', 'PROFILE_SUPPORTS_IDENTITY', 'ROUTE_CONNECTS_ARTIST', 'ROUTE_USES_CONTACT',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
/** Verified = confirmed by a person · Discovered = found in the catalogue or by discovery, with a source · Possible = candidate, needs review. */
export const EDGE_STATUSES = ['verified', 'discovered', 'possible', 'rejected'] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

export const DISCOVERY_DEFAULTS = { staleDays: 90, cacheDays: 7, concurrency: 2 } as const;

/** Progress steps shown at the top of every dossier. */
export const PROGRESS_STEPS = ['Identified', 'Identity Verified', 'Research', 'Route Ready', 'Contact', 'Claim', 'Activation', 'ARM'] as const;
