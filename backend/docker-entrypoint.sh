#!/bin/sh
# Apply the database migrations, then start the API.
# Neon (and other PgBouncer poolers): migrations need a direct connection. When DIRECT_URL is not set it is derived from
# DATABASE_URL by dropping "-pooler" from the host name (Neon's convention); otherwise DATABASE_URL is used as is.
set -e
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set. Put your PostgreSQL connection string in .env (see .env.example)." >&2
  exit 1
fi
if [ -z "$DIRECT_URL" ]; then
  DIRECT_URL=$(printf '%s' "$DATABASE_URL" | sed 's/-pooler\././')
  export DIRECT_URL
fi
echo "Applying database migrations…"
tries=0
until NPM_CONFIG_UPDATE_NOTIFIER=false npx --no-install prisma migrate deploy; do
  tries=$((tries + 1))
  if [ "$tries" -ge 10 ]; then echo "Could not apply the migrations. Check DATABASE_URL." >&2; exit 1; fi
  echo "Database not reachable yet, retrying in 3 s ($tries/10)…"
  sleep 3
done
exec "$@"
