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
└── .env.example        every setting, documented
```

## Run it

1. Copy `.env.example` to `.env` and set `DATABASE_URL` (the Neon pooled connection string). Add the search keys if
   you want Find artist to search the web, Spotify and YouTube.
2. Start everything:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:8080**. The first person to sign up becomes the **System Owner** (there is only one). That
   first sign-up needs the **owner setup code**: `OWNER_SETUP_TOKEN` from `.env`, or the code the API prints in its log
   (`docker compose logs backend`). People who ask for an account later wait for an Admin's approval and start as
   **User**; the System Owner and Admins can also add people in **Settings → People and roles**.
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
| `ALLOW_SIGNUP` | `false` turns "Ask for an account" off after the first account (an Admin then adds people) |
| `OWNER_SETUP_TOKEN` | Code needed to create the first account (the System Owner). Empty: a random code is printed in the API log |
| `AUTH_SECRET` | Encrypts two-step sign-in secrets. Set once, keep it (changing it turns app codes off; recovery codes still work) |
| `PASSWORD_BREACH_CHECK` | `true` refuses passwords found in known data breaches (Have I Been Pwned, k-anonymity) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile "I am human" check on sign-up |
| `COOKIE_SECURE` | `true` when the app is served over HTTPS |
| `SEARCH_PROVIDER_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY` | Live artist search. Without them Find artist is off and says why |
| `SEARCH_*_LIMIT`, `YOUTUBE_*`, `SPOTIFY_*` | Usage limits that protect the free tiers |

## Accounts and security

- Passwords: at least 12 characters, not built from the email or name, not a well-known or breached password; hashed with
  scrypt (N=2^14, r=8, p=5). Older hashes are upgraded at the next sign-in.
- Two-step sign-in (optional, per person): an authenticator app code after the password, plus 10 one-time recovery codes.
  The System Owner can reset it for someone who lost their phone.
- Sessions: random tokens in an httpOnly, SameSite=Lax cookie; only a SHA-256 is stored. They end after 30 days, or after
  7 days without use. Changing a password signs out the other devices; a password set by the System Owner, switching a
  person off or resetting two-step sign-in signs that person out everywhere.
- Sign-up: the first account needs the owner setup code; later requests wait for an Admin's approval, are limited per
  address and per hour, carry a hidden bot trap, and can use Cloudflare Turnstile.
- Wrong passwords are limited per email and address (10 per 15 minutes) and per email from anywhere (30 per 15 minutes);
  wrong two-step codes end the sign-in after 5 tries.
- Find artist: each person can start a set number of searches in 24 hours (Settings → Artist discovery; the System Owner
  has no limit), so nobody can use up the team's search quota.
- Every API route except health and sign-in needs a signed-in user; every change is recorded under that person.
- Never commit `.env` or anything with real catalogue data (`.gitignore` and `.dockerignore` keep them out).

## Development without Docker

```bash
cd backend && npm install && npm run db:migrate && npm run dev     # API on :4000 (reads ../.env)
cd frontend && npm install && npm run dev                          # web app on :5173, proxies /api to :4000
```

Tests (no database or keys needed): `cd backend && npm test`.
