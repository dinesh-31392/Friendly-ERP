#!/bin/sh
# Restore an encrypted Friendly CRM backup produced by backup.sh.
#
# ⚠️ This OVERWRITES the current database. Test it on a throwaway DB first — an
# untested backup is not a backup.
#
#   docker compose -f docker-compose.prod.yml exec backup \
#     /bin/sh /usr/local/bin/restore.sh /backups/friendly_crm-YYYYMMDD-HHMMSS.sql.gz.gpg
set -eu

FILE="${1:?usage: restore.sh <path-to-.sql.gz.gpg>}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-friendly_crm}"

[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }

echo "restoring $FILE into $DB_NAME on $DB_HOST ..."
gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" "$FILE" \
  | gunzip \
  | PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1

echo "restore complete."
