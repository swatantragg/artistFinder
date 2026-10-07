// The app version (shown in the footer) and a one-line summary of each change, shown once after an update.
export const VERSION = 'V02.3.0';

export const CHANGES: Record<string, string[]> = {
  'V02.3.0': [
    'Three roles: System Owner, Admin and User. Leads became Admins; Operators and Claim Reviewers became Users.',
    'System Owner: adds people, changes anyone’s role, sets anyone’s password and can delete all data. Everyone else sees the owner as Admin.',
    'Admin: adds people (Admin or User), sees the team and makes Users Admins, plus imports, claims and discovery settings.',
    'User: finds and verifies artists, deduplicates and sees the team’s work.',
    'Settings → People and roles: “Add person” and “Set password”.',
    'Connection graph: “Open …” is now a clear full-width button above the shared songs.',
    'The version now sits in a footer pinned to the bottom-right corner of the window.',
  ],
  'SK-PV2.2.0': [
    'Sign in and sign up: everyone has their own account; the first account is the System Owner.',
    'Every change is recorded under the signed-in person (no more “Act as”).',
    'Settings → People and roles: the System Owner or an Admin sets each person’s role.',
    'Settings → Your account: change your password or sign out (also in the menu at the top right).',
    'The app starts empty: no sample people or data. Upload your export on the Imports page.',
    'Runs with Docker: “docker compose up --build” starts the web app and the API.',
  ],
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
