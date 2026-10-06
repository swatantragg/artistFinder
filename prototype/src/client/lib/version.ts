// The app version (shown in the footer) and a one-line summary of each change, shown once after an update.
export const VERSION = 'SK-PV2.1.0';

export const CHANGES: Record<string, string[]> = {
  'SK-PV2.1.0': [
    'Find artist now searches only for the artist’s own profiles: Spotify, YouTube, Instagram, Facebook, X, SoundCloud, Apple Music, JioSaavn and the official website.',
    'Song, video and track pages are no longer offered as profiles.',
    'Only profiles with a match of 50% or more are shown; when none reach 50%, the best one or two are shown.',
    'Each profile shows its platform logo, name, link and match %: verify it and it is saved with the artist.',
    'Explanations such as “found because” and “found through” and the page texts are gone from the list.',
    'Songs tab: a search box, a cleaner table and a song details window (song, credits by role, source row).',
    'Connection graph: only people, each card showing the shared song and the person’s role.',
    'This summary appears once after each update; click the version in the footer to see it again.',
  ],
};
