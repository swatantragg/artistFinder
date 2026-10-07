# ArtistFinder

Find every artist in the Goongoonalo catalogue, verify them and bring them on board.
The web app has accounts (sign in / sign up), a React frontend, an Express + Prisma API and a PostgreSQL database (Neon).
It starts empty: no sample people, no sample data. Artists, songs and credits come only from the exports you upload.

```
artistFinder/
├── backend/            API: Express 5, the domain engine (business rules), Prisma on PostgreSQL, accounts + sessions
│   ├── prisma/         schema and migrations (applied automatically on start)
│   ├── src/domain/     business rules, imports, discovery (shared with the frontend for constants and types)
│   ├── src/server/     HTTP API, auth, PostgreSQL store, live search providers
│   └── tests/          unit + API tests on fictional fixtures (no database, no keys)
├── frontend/           web app: React 19, Vite, Tailwind; served by nginx, which proxies /api to the API
├── docker-compose.yml  frontend + backend
├── .env.example        every setting, documented
└── prototype/          the earlier single-folder prototype (reference only)
```

## Run it

1. Copy `.env.example` to `.env` and set `DATABASE_URL` (the Neon pooled connection string). Add the search keys if
   you want Find artist to search the web, Spotify and YouTube.
2. Start everything:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:8080**. The first person to sign up becomes the **System Owner** (there is only one).
   People who sign up later start as **User**; the System Owner and Admins add people in
   **Settings → People and roles**.
4. Upload your export on the **Imports** page.

On start the API loads the whole workspace from the database (a large catalogue on Neon takes about a minute); the web
app shows "Loading the workspace…" until it is ready.

## Roles

| Role | Can do |
| --- | --- |
| **System Owner** (one) | Everything: add people, change anyone's role (Admin / User), set anyone's password, delete all data. Shown as *Admin* to everyone else. |
| **Admin** | Add people (Admin or User), see the team, make Users Admins; imports, claim decisions, closing artists, bulk search, discovery settings, plus everything a User does. |
| **User** | Find and verify artists, deduplicate, research and contact artists, see the team's work. |

The API applies the database migrations every time it starts (`prisma migrate deploy`; for Neon the direct host is
derived from the pooled one by dropping `-pooler`, or set `DIRECT_URL`).

Stop with `Ctrl+C` or `docker compose down`. The data lives in the database, not in the containers.

## Settings (.env)

| Setting | What it does |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `DIRECT_URL` | Direct connection for migrations (optional: derived for Neon) |
| `APP_PORT` | Port of the web app on this machine (default 8080) |
| `ALLOW_SIGNUP` | `false` closes sign-up after the first account (an Admin then adds people) |
| `COOKIE_SECURE` | `true` when the app is served over HTTPS |
| `SEARCH_PROVIDER_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY` | Live artist search. Without them Find artist is off and says why |
| `SEARCH_*_LIMIT`, `YOUTUBE_*`, `SPOTIFY_*` | Usage limits that protect the free tiers |

## Accounts and security

- Passwords are hashed with scrypt; sessions are random tokens in an httpOnly, SameSite=Lax cookie (30 days), and only a
  SHA-256 of the token is stored. Changing your password signs out your other devices.
- Every API route except health and sign-in needs a signed-in user; every change is recorded under that person.
- Repeated wrong passwords are slowed down (10 tries per 15 minutes per email and address).
- Never commit `.env` or anything with real catalogue data (`.gitignore` and `.dockerignore` keep them out).

## Development without Docker

```bash
cd backend && npm install && npm run db:migrate && npm run dev     # API on :4000 (reads ../.env)
cd frontend && npm install && npm run dev                          # web app on :5173, proxies /api to :4000
```

Tests (no database or keys needed): `cd backend && npm test`.
