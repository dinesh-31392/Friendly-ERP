#!/bin/sh
# Encrypted Postgres backup for Friendly CRM.
#
# Dumps the whole database, gzips it, and symmetrically encrypts it with AES-256
# (passphrase from BACKUP_PASSPHRASE) so a backup file is useless if the volume,
# a snapshot, or an off-site copy leaks. A full pg_dump preserves the schema,
# RLS policies and tenant_id columns, so tenant isolation is intact on restore.
#
# Run continuously by the `backup` service in docker-compose.prod.yml, or once:
#   docker compose -f docker-compose.prod.yml exec backup /bin/sh /usr/local/bin/backup.sh
set -eu

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-friendly_crm}"
KEEP="${BACKUP_KEEP:-14}"          # how many backups to retain
DIR="/backups"

mkdir -p "$DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/friendly_crm-$STAMP.sql.gz.gpg"

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$DB_HOST" -U postgres -d "$DB_NAME" \
  | gzip -9 \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_PASSPHRASE" -o "$OUT"

echo "backup ok: $OUT ($(wc -c < "$OUT") bytes)"

# Retention: delete all but the newest $KEEP encrypted dumps.
ls -1t "$DIR"/friendly_crm-*.sql.gz.gpg 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" && echo "pruned old backup: $old"
done
