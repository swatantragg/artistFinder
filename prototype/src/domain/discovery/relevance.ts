// Which candidate profiles a person is asked to review: the artist's own profile links (never song, video or track
// pages) with a match of 50% or more; when none reaches 50%, the best two. Everything else stays stored, out of the way,
// and does not keep an artist in "needs review".
import type { Platform } from '../constants';
import type { Model } from '../model';
import type { ArtistProfile } from '../types';
import { MATCH_THRESHOLD } from './evidence';
import { artistProfileUrl } from './normalize';

const isOpen = (p: ArtistProfile) => p.verificationStatus === 'UNREVIEWED' || p.verificationStatus === 'DEFERRED';
/** True when the stored link is an artist profile itself (older searches also stored song and video pages). */
export const isArtistProfile = (p: Pick<ArtistProfile, 'url' | 'platform' | 'normalizedUrl'>) => artistProfileUrl(p.url, p.platform as Platform)?.normalized === p.normalizedUrl;

/** The candidates to show, best match first. */
export function pickRelevant(list: ArtistProfile[]): ArtistProfile[] {
  const pool = list.filter(p => isOpen(p) && !p.changeOfProfileId && isArtistProfile(p))
    .sort((a, b) => b.evidenceScore - a.evidenceScore || (b.followers ?? 0) - (a.followers ?? 0) || a.id.localeCompare(b.id));
  const good = pool.filter(p => p.evidenceScore >= MATCH_THRESHOLD);
  return good.length ? good : pool.filter(p => p.evidenceScore > 0).slice(0, 2);
}
export const relevantOpen = (m: Model, caseId: string) => pickRelevant(m.byCase('profiles', caseId));
/** Profile changes of verified profiles wait for a person whatever their match. */
export const pendingChanges = (m: Model, caseId: string) => m.byCase('profiles', caseId).filter(p => p.changeOfProfileId && p.verificationStatus === 'UNREVIEWED');
/** How many decisions wait for a person (relevant candidates not put aside, plus profile changes). */
export const reviewCount = (m: Model, caseId: string) => relevantOpen(m, caseId).filter(p => p.verificationStatus === 'UNREVIEWED').length + pendingChanges(m, caseId).length;
