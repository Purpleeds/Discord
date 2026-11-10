#!/bin/sh
# Copies everything (accounts, logins, messages, servers, files...) from the
# Neon database into a new "chat" database on the NAS's Postgres.
# Run it on the NAS, from this folder, after filling in .env:
#   sudo sh copy-from-neon.sh 'postgresql://...neon.tech/neondb?sslmode=require'
# (the Neon address is DATABASE_URL in the Render dashboard, Environment tab).
# Neon runs Postgres 18, so the copy is made with Postgres 18's tools; the
# NAS's Postgres 17 reads it fine. Nothing on Neon is changed.
set -eu
cd "$(dirname "$0")"
NEON_URL="${1:-${NEON_URL:-}}"
[ -n "$NEON_URL" ] || { echo "Usage: sudo sh copy-from-neon.sh 'postgresql://...neon.tech/neondb?sslmode=require'"; exit 1; }
[ -f .env ] || { echo "Fill in .env first (copy .env.example)."; exit 1; }
set -a; . ./.env; set +a
DB_HOST="${DB_HOST:-host.docker.internal}"; DB_PORT="${DB_PORT:-55432}"; DB_NAME="${DB_NAME:-chat}"
PG="docker run --rm -i --add-host=host.docker.internal:host-gateway -e PGPASSWORD=$POSTGRES_PASSWORD postgres:18"
NAS="-h $DB_HOST -p $DB_PORT -U $POSTGRES_USER"

echo "1/4 Checking the NAS database..."
if ! $PG psql $NAS -d postgres -Atc "SELECT 1" >/dev/null; then
  echo "Can't reach Postgres on the NAS ($DB_HOST:$DB_PORT). Is it running, and are the user and password in .env right?"; exit 1
fi
if [ "$($PG psql $NAS -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'")" = "0" ]; then
  $PG psql $NAS -d postgres -c "CREATE DATABASE \"$DB_NAME\""
fi
if [ "$($PG psql $NAS -d "$DB_NAME" -Atc "SELECT to_regclass('public.users') IS NOT NULL")" = "t" ]; then
  echo "The \"$DB_NAME\" database already has chat data in it - stopping so nothing gets mixed up or overwritten."
  echo "To start over, delete it first:  sudo docker exec postgresql psql -U $POSTGRES_USER -d postgres -c 'DROP DATABASE \"$DB_NAME\"'"
  exit 1
fi

echo "2/4 Copying from Neon (this reads everything; nothing on Neon changes)..."
STAMP=$(date +%Y%m%d-%H%M%S)
$PG pg_dump --no-owner --no-privileges "$NEON_URL" > "neon-$STAMP.sql"
echo "    saved neon-$STAMP.sql ($(du -h "neon-$STAMP.sql" | cut -f1)) - keep it as a backup"

echo "3/4 Loading it into \"$DB_NAME\" on the NAS..."
$PG psql $NAS -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "neon-$STAMP.sql" >/dev/null

echo "4/4 Checking..."
$PG psql $NAS -d "$DB_NAME" -Atc "SELECT 'accounts: ' || (SELECT count(*) FROM users) || ', messages: ' || (SELECT count(*) FROM messages) || ', servers: ' || (SELECT count(*) FROM servers)"
echo "Done. Now start the app:  sudo docker compose up -d --build"
