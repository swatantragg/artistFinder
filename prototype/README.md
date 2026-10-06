# ArtistFinder (prototype)

Artist identity and outreach workspace for Goongoonalo / G Amplify, organised around one loop:

**software does the discovery → a person verifies → software remembers.**

Upload the media-library export; every artist and collaborator in it becomes one permanent record. *Find artist* searches the
web, music services and collaborators in the background and organises what it finds into candidates with evidence and
conflicts. A person verifies. Verified knowledge is stored and reused by every later import, so a verified artist is never
searched from scratch again, and new evidence (a new song, a new collaborator, a changed profile) reopens the artist with the
reasons listed instead of starting over. Outreach (routes, contact, claim, activation) continues from the same record.

> **Real data only.** The app starts with an empty workspace; every artist, song and credit comes from the export files you
> upload. *Find artist* searches live (Brave or Google web search, Spotify, YouTube, public pages) with the keys in `.env`.
> Without keys it is switched off with the reason; it never invents results. There is no demo mode and no offline copy:
> when the API is not running the app says so.

Version: **SK-PV2.1.0** (shown in the footer). After each update a one-time *What's new* window lists the changes in one line
each; click the version in the footer to see it again (the list lives in `src/client/lib/version.ts`).

Look: black navigation with a purple theme (#000000, #52057B, #892CDC, #BC6FF1) in light and dark mode (Settings →
Appearance), 15 px body text, full-width pages. The layout adapts from phones (lists become cards, the menu becomes a
drawer) to wide screens (more table columns appear from 1536 px and 1600 px).

---

## 1. Quick start

Prerequisites: **Node.js 20+** (tested on 24) and **Docker** (for PostgreSQL).

```bash
cd prototype
npm install            # also generates the Prisma client
npm run setup          # starts PostgreSQL in Docker (port 5433) and applies migrations
cp .env.example .env   # first time only: add the search keys (SEARCH_PROVIDER_API_KEY, Spotify, YouTube)
npm run dev            # starts PostgreSQL if needed, then the API on :4000 + the web app on :5173
```

Open **http://localhost:5173**. You act as *Swatantra (System Owner)*; switch user/role from the top-right menu.
Upload the media-library export on **Imports**, then open an artist and click **Find artist**.

If the page says *ArtistFinder cannot start*, the API is not running: run `npm run dev` in the `prototype` folder (Docker must
be running for PostgreSQL). `npx tsx tests/live-smoke.ts` checks that the search keys work (one call per provider).

**Upgrading an existing installation** (for example a workspace with an imported catalogue):

1. `npm run db:migrate` applies `20261005000000_artistfinder_v2`. It is **purely additive** (new columns, the `status_events`
   table, indexes) and fills the new columns from what already happened (discovery results, work started, do-not-contact).
2. Restart the API. The first start runs a one-time upgrade that only writes the new fields; nothing is deleted or renamed.
3. Existing records keep their IDs (`C0001` …); new workspaces number artists `A000001` …. IDs never change.
4. On **Deduplicate**, click **Scan all artists** once to check the whole existing catalogue (new imports are checked automatically).
5. Weekly and monthly Goongoonalo numbers come from status changes, so they count from the upgrade onwards.

| Command | What it does |
|---|---|
| `npm run dev` | API (Express, auto-reload) + web app (Vite) |
| `npm run build` then `npm start` | Production build; one server on **http://localhost:4000** serves API + app |
| `npm test` | 201 domain checks + 92 ArtistFinder v2 checks + 24 live-provider adapter checks (no network, fictional test fixtures) |
| `npm run test:e2e` | Four browser flows against an in-memory test server with fictional fixtures (no database, no API quota), see §11 |
| `npx tsx tests/live-smoke.ts` | One real call to each configured search provider: confirms the keys work (uses a little quota) |
| `npm run typecheck` | TypeScript, whole project |
| `npm run db:up` / `db:down` | Start / stop the PostgreSQL container |
| `npm run db:migrate` | Apply Prisma migrations |

### Environment variables (`.env`, see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://gamplify:gamplify@localhost:5433/gamplify?schema=public` | PostgreSQL used by Prisma (the Docker container from `docker-compose.yml`) |
| `PORT` | `4000` | API port (and app port in production) |
| `SEARCH_PROVIDER` | `brave` | Web search API: `brave` (Brave Search API) or `google` (Programmable Search Engine) |
| `SEARCH_PROVIDER_API_KEY` | empty | Key for that web search API. With no search, Spotify or YouTube key, **Find artist is off** |
| `GOOGLE_CSE_ID` | empty | Search engine ID, only for `SEARCH_PROVIDER=google` |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | empty | Spotify Web API (client credentials): artist search and ISRC lookup |
| `YOUTUBE_API_KEY` | empty | YouTube Data API v3: channels and videos |
| `CRAWLER_ENABLED` | `1` | `0` switches the public web crawler off |
| `SEARCH_MONTHLY_LIMIT` / `SEARCH_DAILY_LIMIT` | `500` / `0` | Web search calls per calendar month / day (Brave free plan: 1,000 a month). `0` = no limit |
| `SEARCH_QUERIES_PER_ARTIST` / `SEARCH_MIN_INTERVAL_MS` | `8` / `1100` | Web search calls one artist search may use (most useful queries first); spacing between calls (Brave free: 1 per second) |
| `YOUTUBE_MONTHLY_LIMIT` / `YOUTUBE_DAILY_LIMIT` | `500` / `50` | YouTube searches per month / day (a search costs 100 of the 10,000 daily units) |
| `YOUTUBE_SEARCHES_PER_ARTIST` | `3` | YouTube searches one artist search may use |
| `SPOTIFY_MONTHLY_LIMIT` / `SPOTIFY_SEARCHES_PER_ARTIST` | `0` / `6` | Spotify has no fixed quota; calls are spaced 0.25 s apart |

The Docker database listens on **127.0.0.1:5433**, so it does not clash with a local PostgreSQL on 5432.
Keys are read on the server only; they never reach the browser and are never stored in the database.

---

## 2. Screens

| Menu | Route | What it is for |
|---|---|---|
| **Dashboard** | `#/` | Where the artists stand: total, new, pending, searching, needs review, reopened, possible duplicates, verified, Goongoonalo, rejected (each number opens those artists); this week / this month; discovery funnel; your next actions; recent imports |
| **Artists** | `#/artists` | The one master list. Status filters (All, New, Pending, Searching, Needs review, Reopened, Verified, Rejected) are views of it, not separate pages. Artists / Collaborators / Everyone. One search box: name, alias, Artist ID, source ID, ISRC, song, album, label, profile URL or username (best match first). Each row shows songs, collaborators, identity, discovery, Goongoonalo, last discovery, last evidence and the one action required |
| **Deduplicate** | `#/deduplicate` | Records that may be the same artist, with match %, evidence and conflicts: *Confirm same artist*, *Keep separate*, *Review later*; *Decided* keeps the merge history and can reverse any decision |
| **Verified Artists** | `#/verified` | Artists whose identity a person verified. The Goongoonalo status is decided here (filter by status, change it per row) |
| **Imports** | `#/imports`, `#/imports/:id` | Upload the export (CSV or Excel), what the file can contain, every import with its summary, rows to review |
| **Settings** | `#/settings` | Users and roles, artist discovery (providers, usage limits, stale threshold), storage, theme, delete all data, **More tools** |
| Artist | `#/artists/:id` | The dossier: one artist, everything known about it (§6) |
| More tools | `#/queue`, `#/routes`, `#/research`, `#/reports`, `#/audit` | Task queue, contacts & routes, manual research, reports, audit log, across all artists |

Old links keep working: `#/cases` → Artists, `#/discovery/:id` → the artist's Evidence tab, `#/identity` → Deduplicate,
`#/reopened` → Artists filtered on Reopened, `#/claims` → Verified Artists.

---

## 3. Two statuses per artist, never mixed

### Identity status (set by the software from what happened)

| Status | Meaning | How it changes |
|---|---|---|
| **NEW** | Extracted from an import; nobody has searched for this artist yet | Find artist, or any work on the artist |
| **PENDING** | Worked on, identity not verified yet (no match, search failed, set aside) | A new search, a verification |
| **SEARCHING** | Find artist is running in the background | The search finishes |
| **NEEDS_REVIEW** | Candidate profiles are waiting for a person | A person verifies, rejects, keeps separate or sets aside |
| **REOPENED** | Something changed since the last review; earlier verification is kept | A person marks the changes reviewed |
| **VERIFIED** | A person verified the identity: verified profiles, a completed claim, or a confirmation by hand | New evidence reopens it; it never silently drops back |
| **REJECTED** | Not a real artist record (test content, a label name …); kept with the reason | *Restore artist record* |

Precedence when several apply: Rejected → Searching → Needs review → Reopened → Verified → Pending → New. Every change is
stored as a timestamped `StatusEvent` (who, from, to, why); the dossier shows the history.

**Reopened** is a filter with reasons, not a reset. Reasons: new songs where the artist is a lead, a new collaborator, a new
lead (a verified route through a new song or contact), a profile change found by a refresh, a possible duplicate of a verified
artist, a verified profile not checked for longer than the stale threshold, or a person (*Reopen for review…*). People only
credited on new songs (composer, lyricist …) are not reopened; their last-evidence date moves. *Mark changes reviewed*
returns the artist to its status; verified profiles and history are never lost.

### Goongoonalo status (set only by a person)

| Status | Meaning |
|---|---|
| **PENDING** | No decision yet (default) |
| **GOONGOONALO** | The artist is on Goongoonalo |
| **REJECTED** | Not a fit for Goongoonalo (reason required) |
| **DO_NOT_CONTACT** | The artist asked not to be contacted; outreach is blocked (reason required) |

Only a verified artist can be set to *Goongoonalo* or *Rejected*; *Do not contact* works for anyone. Discovery never changes it,
and changing it never changes the identity verification. Every change is audited with name and time.

The **outreach stage** (Unresearched → … → Route Ready → Contact Confirmed → Claim … → Activated → Ongoing ARM) remains a third,
separate field, shown in the dossier's Overview and Outreach progress.

---

## 4. Imports

Upload **CSV or XLSX** on Imports. The upload returns at once and runs as a **background job** with progress
(`POST /api/import` → 202 with the job; the page follows `GET /api/import/jobs/:id`); large files are processed in slices so
the app stays responsive. Nothing depends on one file name or one exact column list.

**Reading the file**

* Encoding detected (UTF-8, UTF-16 with BOM, Windows-1252 fallback); delimiter sniffed (comma, semicolon, tab); the header row
  is found even below title rows; in a workbook, the sheet whose columns map best is read.
* Columns are mapped **by name** using synonyms seen in Goongoonalo exports and distributor sheets: e.g. *Track Name / Song /
  Title*, *Artist Name / Lead Artists / Singer*, *Lyric Writer / Lyricist*, *Composer / Music Director*, *ISRC Code*, *Album
  Name*, *Album cat. No.*, *UPC*, *Label*, *Language*, *Genre*, *Release Date*, *God Name* …. Missing optional columns are fine;
  unknown columns are kept in the raw row. The result page shows **How the file was read** (header row, mapping, unmapped columns).
* **Every row is kept** with its raw values and its mapped values (`ImportRow.raw` / `mapped`); the original data is never
  overwritten. A song's detail shows the rows it came from.

**From rows to artists**

* Several artists in one cell (`A, B`, `A; B`, `A / B`, `A feat. B`, `A ft. B`, `A featuring B`) become separate artists; a duo
  written `A & B` stays one credited name. Indian-language and Unicode names are kept as written.
* Lead and performing artists become **Artists**; lyric writers, composers and producers become **Collaborators** (the same
  person becomes an Artist as soon as a file credits them as a lead or singer).
* Songs are de-duplicated by track ID, then ISRC, then title + lead artists + album; the same song in another file updates it
  instead of adding a copy.
* A name alone never merges records: an existing artist is matched by source artist ID or by evidence (shared songs, ISRCs,
  collaborators, label). Look-alikes go to **Deduplicate**.
* Artists already searched or verified get a **targeted discovery** around the new evidence only (new song titles, ISRCs,
  collaborators); verified profiles are reused, not searched again.

**Import summary**: rows received / accepted / skipped / to review, artists found, new artists, existing artists updated,
new songs, new collaborators, possible duplicates, reopened artists, errors; tabs list the artists in the file, new artists,
new collaborators, updated, possible duplicates, reopened (with reasons), rows to review, accepted and skipped rows, and tasks.

**Other rules**: invalid rows go to *Rows to review* (never dropped); an exact repeat (same SHA-256) creates nothing
(*“Repeat upload detected. Existing batch retained. No duplicate work created.”*); a corrected file with the same name becomes
version 2; a *Full* export flags missing songs without deleting anything.

Also recognised: the **G Amplify standard** layout (blank template on the Imports page; one row per song with `artist_id`,
`artist_name`, `artist_role`, `track_id`, `credits` …) and an **artist directory sheet** (artist name, social link).

---

## 5. Deduplicate

* Candidates come from imports (same name, similar spelling, shared core name such as *Rahul Sharma* / *Rahul Sharma Music*)
  and from **Scan all artists**.
* Each pair shows a **match %** computed from shared songs, ISRCs, collaborators and labels, the evidence and the conflicts
  (different language, different source IDs, different roles, no label in common …). Name similarity alone stays low.
* **Confirm same artist**: pick the record to keep; the other is merged into it. Source IDs, aliases, songs and history are kept.
  **Keep separate**: the pair is not flagged again. **Review later**: set aside.
* **Decided** lists every decision with who, when and why; **Reverse** undoes a merge or a keep-separate (reason required) and
  puts the pair back in *To review*.
* A possible duplicate of a verified artist reopens that artist with the reason.

---

## 6. Artist dossier

Header: name, Artist ID and source IDs, songs and collaborators, and three status blocks side by side: **Identity**, **Discovery**,
**Goongoonalo** (with *change*). A reopen banner lists what changed. The *Next step* card always shows one obvious action
(Find artist, Review candidates, Mark changes reviewed, the open outreach task …); *More* holds the rest (Set Goongoonalo
status, Confirm identity by hand, Reopen for review, Reject / Restore artist record, contact preference, close …).

| Tab | Shows |
|---|---|
| **Overview** | Songs, albums, collaborators, labels, verified profiles, possible routes; where the artist stands; record (IDs, aliases, type, language, labels, first/last seen, the imports it came from, merged records); open tasks; outreach progress; status history |
| **Profiles** | Verified profiles (who verified, when, last checked, stale warning), profile links on file, earlier replaced profiles |
| **Songs** | Search (title, ISRC, album, label or a person), sort, 50 per page; click a song for its details: song facts, credits grouped by role, where it came from (file, row, the original row on request), later changes; link a song, add a credit |
| **Collaborators** | People credited with the artist, their roles, verified profiles and contacts |
| **Evidence** | Find artist progress; **Saved profiles** (verified); the artist's own profiles found, one block per platform with the platform logo, name, link and **match %**: *Verify* (saved with the artist), *Reject*, *Later*; rejected profiles and search history folded away; manual research as the fallback |
| **Connection Graph** | The artist and the people credited on the artist's songs: each card shows a shared song and the person's role; click a card for every shared song; *Find connection* (§7.6) |
| **Routes**, **Claims**, **Activation** | Shown only when relevant: routes and contact attempts; claim steps; access, feature and first use |
| **Timeline** | Every meaningful change: who, what, why, evidence, result and next step |

---

## 7. Artist discovery engine

Code: `src/domain/discovery/` (shared by server and browser) and `src/server/providers.ts` (live providers, server only).

| File | Role |
|---|---|
| `queries.ts` | Builds the artist's facts (name, aliases, songs, ISRCs, labels, distributors, roles, collaborators, earlier rejections) and generates the queries |
| `providers.ts` | Provider interface (`search`, optional `crawl`), `InternalCatalogueProvider`, usage limits |
| `budget.ts` | Usage counting and per-artist query caps (§7.8) |
| `normalize.ts` | URL normalization (Instagram, YouTube, Facebook, Spotify, X, SoundCloud, websites) and text matching |
| `evidence.ts` | Evidence scoring, conflicts and grouping into possible artists |
| `pipeline.ts` | Job creation, caching, aggregation, saving results, profile change detection, graph updates, notifications |
| `runner.ts` | Background queue: concurrency, per-provider limits and spacing, retries with backoff, circuit breaker, cache |
| `commands.ts` / `views.ts` | Human decisions and read models |

### 7.1 Find artist

*Find artist* is on the Artists list, the dossier and the import result. It returns at once (status **SEARCHING**) and runs in
the background with seven visible steps. **Only the artist is searched** (never songs): the name alone, the name on Instagram,
YouTube, Facebook, X, JioSaavn, SoundCloud and Apple Music (`site:` searches), the name with the role and with *official*, and
aliases. The Spotify API looks the artist up by name and by the catalogue's ISRCs (which point at the right artist page); the
YouTube API searches channels by name. Songs, ISRCs, labels and collaborators are only used as evidence when scoring results.

**Only artist profile links become candidates**: Spotify `/artist/` pages, YouTube channels (`@handle`, `/channel/`, `/c/`),
Instagram, Facebook and X accounts, SoundCloud accounts, Apple Music, JioSaavn, Gaana and Deezer artist pages, and an official
website's home page. Song, track, album, playlist, video and post pages are dropped (a SoundCloud track or an X post still names
its account, which is kept). **Same-name artists are never merged**: another artist's songs on a page are a hard conflict.

Each profile gets a **match %** (0–100): mostly identity (exact name 35, name with other words 20, handle or web address made of
the name 10–20, an artist page on a music service or a YouTube *Topic* channel 20, singer/music in the bio 10–15, linked from the
artist's other profiles 15, a link already on file 40), raised by catalogue evidence (songs 10 each, ISRC 30, label, collaborators)
and lowered by conflicts (fan or compilation pages −25, another profession −40, another artist's songs −45, rejected before −60).
A different name, or a social profile with no sign of music at all, stays below 50.

**Shown to people: profiles with a match of 50% or more. When none reaches 50%, the best one or two are shown** (with a note).
The rest is not stored (or, from older searches, kept out of the way) and never keeps an artist in *needs review*. The list is
one block per platform with the platform's logo; no page texts or explanations (the reasons are kept on the profile record).

### 7.2 A person decides

Nothing is verified automatically, and the system never declares "this is the artist" on its own.

| Action | Effect |
|---|---|
| **Verify** | Creates a `VerifiedProfile` (who, when, evidence) saved with the artist; identity becomes **VERIFIED** once nothing is left to review |
| **Reject** (reason required) | Kept with the reason; the same URL is rejected again automatically in later searches |
| **Later** | Put aside: still listed, but no longer keeps the artist in *needs review* |
| **Reconsider** | Brings a rejected profile back to review |

### 7.3 Software remembers

* **Verified artist found**: an import that contains a verified artist shows *Verified artist found* with its verified profiles.
  No new search is started.
* **Targeted discovery**: new songs for an artist already searched start a small search around the new evidence only.
* **Refresh search** creates a new version (v2, v3 …); every older version stays in the search history.
* **Profile change detection**: a refresh that finds a new profile where a verified one used to be reopens the artist with
  *Verify new* (old one kept as replaced), *Keep old* or *Reject new*. Nothing is overwritten.
* **Stale profiles**: verified profiles older than the threshold (default 90 days, Settings → Artist discovery) reopen the
  artist for a check (maintenance runs at start-up and every 6 hours).
* **Search cache**: repeated queries within 7 days are answered from the cache.

### 7.4 Failures and empty results

* A provider error marks the search **FAILED** with the reason (e.g. *Search provider unavailable*) and a **Retry** button. It is
  never reported as "artist not found". Transient errors are retried with backoff; a provider that keeps failing is paused.
* When nothing is found: *No verified candidate found*, with the sources and queries used and three options: **Retry**,
  **Add manual evidence**, **Wait for new evidence**. The artist becomes PENDING and is kept.

### 7.5 Find all not yet searched

Artists → **Find all not yet searched** (System Owner, Lead, Admin) asks for confirmation, then queues every artist that has not
been searched yet (or whose search failed), within the usage limits, with live progress. **Stop remaining** stops the searches
that have not started; those artists keep their earlier status (never shown as failed).

### 7.6 Connection graph and Find connection

* Only people: the artist in the middle and everyone credited on the artist's songs around it, most shared songs first (24
  at first, *Show all* for the rest, a search box for a person or a song). Each card shows a shared song and the person's
  role on it (e.g. *“Dil Ka Safar” · Producer*); click it for every shared song with both people's roles and *Open* the artist.
  A green line marks a verified artist; a thicker line means more songs together.
* **Find connection** searches up to six relationships for a person with a **verified contact**, e.g.
  *Rahul Sharma → “Dil Ka Safar” → Joshua Singh → Verified WhatsApp*. A path is **evidence, not a relationship**: the UI says
  *possible connection path*, never "knows".
* **Create route** turns a path into a *Candidate* route; **Verify route** (a person) makes it Route Ready with an outreach
  task; **Reject** needs a reason. **Do Not Contact** artists get no route or outreach task.

### 7.7 Providers (live)

| Provider | Needs | What it does |
|---|---|---|
| Web search | `SEARCH_PROVIDER_API_KEY` (Brave Search API, or Google Programmable Search with `GOOGLE_CSE_ID`) | Web pages and social profiles for the generated queries |
| Spotify | `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` | Artist search and ISRC search (tracks with ISRCs are strong evidence) |
| YouTube | `YOUTUBE_API_KEY` | Channels, and videos grouped by channel |
| Public web crawler | on when any key is set (`CRAWLER_ENABLED=0` turns it off) | Reads public pages for title, description, JSON-LD and social links |
| Internal catalogue | nothing | Profile URLs already on the artist |

* **Configure**: put the keys in `.env` (table in §1) and restart the API. The start-up log (`Artist discovery: LIVE search · …`),
  Settings → Artist discovery and the header (*Live search*) show the providers in use. `npx tsx tests/live-smoke.ts` makes one
  call per provider to confirm the keys work.
* **No keys → Find artist is off.** The single and bulk searches and the targeted searches after an import are refused with the
  reason and what to set; manual research stays available. Discovery never invents results.
* *Open profile* opens the profile itself in a new tab.

### 7.8 Usage limits (protect free tiers)

* Every call to a quota API is **counted in the database before it is made**, so parallel searches and restarts can never go
  over a limit. Cached answers are free.
* Calls are **spaced** per provider (Brave free plan: 1 request per second) and each artist search gets only its **most useful
  queries** (8 web, 3 YouTube, 6 Spotify by default).
* When a limit is reached, searches are refused with the reason and the reset date; a search that runs out mid-way fails with
  *Search limit reached*, never *no candidate*. Settings → Artist discovery and the Artists page show used / limit.

### 7.9 Safety rules (enforced in code)

* Official APIs and public pages only. No login, no CAPTCHA solving, no private profiles, no impersonation, no bypassing
  platform restrictions; contact details are never invented.
* The crawler honours robots.txt, never fetches social networks, refuses private network addresses (SSRF guard, re-checked on
  every redirect), limits size (1.5 MB) and time (8 s), and waits 1 s between requests to the same host.
* No message is ever sent automatically and no artist is claimed automatically; outreach remains with the operator.
* Secrets come from environment variables only.

---

## 8. Architecture

```
React + TypeScript + Tailwind (src/client)          React Flow for the connection graph
  pages/ ── components/ (UI kit, action forms, status badges, discovery panel, graph) ── lib/ (state, polling, formatting)
        │
        ▼  api/backend.ts: fetch → Express API (no offline copy: without the API the app shows how to start it)
  ┌──────────────────────────────────────────┐
  │ src/server/index.ts + app.ts (routes)     │
  │ live providers from .env (server/providers.ts) │
  └──────────────────────┬───────────────────┘
                         ▼
        src/domain (pure TypeScript)
          commands.ts  every write: validation, business rules, audit, tasks
          importer.ts  import jobs: mapping, artist extraction, de-duplication, reopening, targeted discovery
          importmap.ts encoding, delimiter, header row and column mapping
          status.ts    identity status, Goongoonalo status, reopen reasons, status history
          dedupe.ts    duplicate scoring, evidence and conflicts
          views.ts     Artists, Verified Artists, Deduplicate, Dashboard read models; search
          refresh.ts   new songs/credits/verified contacts → routes, reopened artists, tasks
          queries.ts   dossier and other read models (paged lists, one tab at a time)
          graph.ts     relationship graph store, graph view, Find connection
          discovery/   artist discovery engine (§7)
          model.ts     in-memory relational store with indexes, change tracking and transactions
                 ▼
        src/server/store.ts → Prisma → PostgreSQL   (system of record)
```

* **One rule book.** Business rules live only in `src/domain`. The UI never decides whether a step is allowed; it asks the engine.
* **Atomic writes.** Each command runs in a transaction: if a rule fails or the database write fails, nothing is kept.
* **Background work never blocks a screen.** Imports and discovery jobs run in the engine; each step is saved in its own short
  transaction, so other people keep working.
* **Append-only history.** Every meaningful change writes an `AuditEvent`; every status change a `StatusEvent`.

### API

| Route | Purpose |
|---|---|
| `GET /api/health` | Server check, with the discovery mode (`live` or `off`) |
| `POST /api/query/:name` | Read models (`overview`, `artists`, `verifiedArtists`, `dedupeQueue`, `caseDetail`, `songDetail`, `importBatch`, `discoveryDetail`, `caseGraph`, …) |
| `POST /api/command/:name` | Writes (`startDiscovery`, `verifyProfile`, `rejectProfile`, `decideIdentity`, `setGoongoonaloStatus`, `markReopenReviewed`, `findConnection`, …). Rule violations return **422** with a readable message |
| `POST /api/import?filename=…&importType=…&exportDate=…&source=…` | Raw file upload; returns **202** with the background import job |
| `GET /api/import/jobs/:id` | Import job status and progress |
| `POST /api/discovery/:caseId/start` | Start *Find artist*; returns **202** with the queued job at once |
| `GET /api/discovery/:caseId` | Discovery state: jobs and progress, candidates, verified profiles, history, paths |
| `POST /api/discovery/bulk` | *Find all not yet searched* (System Owner, Lead, Admin) |
| `GET /api/discovery/config` | Discovery mode (`live` or `off` with the reason), providers, usage |
| `POST /api/admin/reset` | Delete all data and start with an empty workspace (System Owner or Admin) |

The acting user is sent in the `x-user-id` header (prototype role switch, no passwords).

---

## 9. Database schema

`prisma/schema.prisma` (PostgreSQL). Field names match `src/domain/types.ts` one to one. Timestamps are ISO-8601 text.

| Model | Holds |
|---|---|
| `ArtistCase` | One real artist or collaborator (permanent ID): names, aliases, source IDs, **`kind`** (Artist / Collaborator), **`artistStatus`**, **`goongoonaloStatus`** (+ who/when), **`reopen`** (reasons), **`firstVerifiedAt`**, manual verification, rejection, outreach stage, contact preference, owner, next action, discovery status, verified profile count |
| **`StatusEvent`** | Every identity and Goongoonalo status change: from, to, when, who, why (dashboard weekly/monthly numbers) |
| `ImportBatch` / `ImportRow` | Every upload (checksum, version, counts, summary with mapping) and every row with **raw and mapped values**, its classification or the reason it needs review |
| `Release`, `Track`, `Credit` | Songs, who did what on each song (`Superseded`, never deleted) |
| `IdentityConflict` / `IdentityDecision` | Possible duplicates and reversible decisions (merge history) |
| `Contact`, `Route` | Verified contact directory; routes artist → song → collaborator/organisation → contact |
| `ResearchActivity`, `ContactAttempt`, `Task` | Research log, outreach attempts, tasks |
| `ClaimEvent`, `ActivationEvent`, `ReopenEvent` | Claim and activation timelines, reopen history |
| `DiscoveryJob`, `DiscoveryQuery`, `DiscoveryResult` | Search runs (versions, modes, steps, failures), their queries and raw hits |
| `ArtistProfile`, `DiscoveryEvidence`, `VerifiedProfile` | Candidate profiles with evidence and decisions; permanent verified knowledge |
| `Collaborator`, `GraphNode`, `GraphEdge`, `ConnectionPath` | Collaborators, the relationship graph and paths found by Find connection |
| `AuditEvent`, `Notification`, `User`, `Meta` | History, alerts, users/roles, ID sequences, usage counters and settings |

Migrations: `prisma/migrations/`. `20261004000000_discovery` (discovery and graph tables) and `20261005000000_artistfinder_v2`
(statuses, collaborator kind, reopen reasons, status history, mapped rows) are purely additive.

---

## 10. Typical workflow (real data)

1. **Imports**: drop the media-library export (CSV or Excel) and click **Process file**. The job runs in the background; the
   summary shows rows, artists, collaborators, possible duplicates and reopened artists, and how the file was read.
2. **Artists → New**: the extracted artists. Search works on names, aliases, Artist IDs, ISRCs, songs, albums, labels and profiles.
3. **Deduplicate**: look-alike records with match %, evidence and conflicts → *Confirm same artist*, *Keep separate* or *Review later*.
4. Open an artist → **Find artist**: the Evidence tab shows the seven steps live, then the candidates grouped as possible
   artists, with evidence and conflicts. **Verify**, **Reject** or **Keep separate**; identity becomes **VERIFIED** when nothing is left to review.
5. **Connection Graph → Find connection**: a possible path to a person with a verified contact → **Create route** → **Verify route**.
6. **Verified Artists**: decide the Goongoonalo status; identity stays VERIFIED.
7. Upload the next export: known artists are recognised (no duplicates), verified artists get only a **targeted** search
   around the new songs, and artists with new evidence are **REOPENED** with the reasons.

---

## 11. Tests

All tests use **fictional fixtures** in `tests/fixtures/` (a made-up catalogue, workspace and web). They never touch the
real database, the real catalogue or the search APIs. The app itself contains no fixture or demo code.

* `npm test`
  * **201 domain checks**: import rules, refresh engine, lifecycle rules, every query, and the discovery engine (queries,
    normalization, grouping, same-name separation, decisions, graph, Find connection, Excel reuse, targeted discovery, refresh
    versions, profile change, cache, outage and retry, Do Not Contact, bulk search and stop, usage limits, Find artist off
    without search keys).
  * **92 ArtistFinder v2 checks** (`tests/v2.test.ts`): column mapping and header detection, encodings and delimiters,
    multi-artist cells, raw rows kept, Artist vs Collaborator, stable IDs, identity statuses and their history, Goongoonalo
    status rules, reopening with reasons, targeted discovery, deduplicate scoring/merge/reverse, search (name, alias, ID,
    ISRC, song, album, label, profile; best match first), dashboard numbers, background import jobs.
  * **24 provider checks**: Brave, Google, Spotify, YouTube adapters with mocked responses; robots.txt; page extraction;
    crawler redirects, robots and SSRF guard against a local server; live/off selection from `.env`.
* `npm run test:e2e` builds the web app and drives Chrome through the real UI and API: the v2 walkthrough (13 steps,
  `v2-flow.mjs`), discovery (15), outreach (15) and an interaction pass (9). `tests/e2e/run.mjs` starts
  `tests/e2e/server.ts`, an in-memory server on the fixtures (port 4100, no PostgreSQL, no keys), restores it before each flow
  and uploads the fixture files through the real file picker.
* `npx tsx tests/live-smoke.ts ["artist name"]`: one real call per configured provider to confirm the keys (spends a little quota,
  writes nothing).

---

## 12. What is real and what is not connected

| Real (works end to end) | Not connected |
|---|---|
| Import jobs, column mapping, artist extraction, de-duplication, raw rows, repeat detection, versioning | Users: role switch without passwords |
| Identity and Goongoonalo statuses with history, reopening, Deduplicate with reversible merges | Goongoonalo backend/admin: claim verification and activation evidence are typed in |
| Lifecycle, tasks, routes, attempts, claims, activation, ARM, audit | Outreach: messages are recorded, never sent |
| PostgreSQL persistence with migrations and transactions | |
| Live discovery (web search, Spotify, YouTube, public pages), scoring, grouping, verification memory, graph, Find connection, usage limits | |

---

## 13. Known limitations

* No authentication; the acting user is chosen in the UI and sent as a header.
* One API process holds the working set in memory (loaded from PostgreSQL at start) and runs import and discovery jobs
  in-process. Discovery jobs interrupted by a restart are queued again; an import interrupted by a restart must be uploaded again.
* Live providers are implemented and unit-tested against recorded response shapes; quotas and rate limits of each API apply.
* Deduplicate scores use the catalogue (songs, ISRCs, collaborators, labels); two records with no shared evidence stay low even
  when they are the same person, so a person decides.
* Graph layout is a simple layered layout; very large graphs show the most relevant 24 songs at depth 1.
* Contact data is visible to every role.

## 14. Future production requirements

* **Job queue and workers**: move import and discovery jobs to Redis + BullMQ (or similar) workers with per-provider rate
  limits, retries and dead-letter handling; stream progress over WebSocket/SSE instead of polling.
* **Provider terms**: review each provider's terms of service and attribution rules; add more official APIs (Apple Music,
  JioSaavn where permitted); never scrape where an API or robots.txt says no.
* **Authentication and permissions**: SSO, then enforce `PERMISSIONS` (central in `src/domain/ops.ts`) per field, including contacts.
* **Scale**: SQL read models (or a search index) for lists and search over hundreds of thousands of rows; a graph database or SQL
  for path queries over the whole catalogue; multiple API instances.
* **Backend integration**: scheduled export feed into `POST /api/import`, claim verification and activation events from the admin API.
* **Monitoring**: provider error rates, job durations and verification throughput on a dashboard.
