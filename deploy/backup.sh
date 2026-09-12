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

# ── Uploaded documents ───────────────────────────────────────────────────────
#
# The database stores a storage_key, never the bytes. So a backup of Postgres
# alone restores a complete file LIST in which every download 404s — which for
# a product holding signed agreements, KYC scans and demand letters is not a
# partial restore, it is a lost archive that looks intact.
#
# Same encryption as the dump, same retention, and written as its own artefact
# so the two can be restored independently.
#
# UPLOADS_DIR is skipped rather than failed when absent: a workspace that has
# never had an upload has no directory, and that is not an error worth waking
# somebody for. An unreadable directory IS an error and is reported.
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
if [ -d "$UPLOADS_DIR" ]; then
  FILES_OUT="$DIR/friendly_crm-files-$STAMP.tar.gz.gpg"
  # -C so the archive holds relative paths and can be restored anywhere.
  tar -C "$UPLOADS_DIR" -cf - . \
    | gzip -9 \
    | gpg --batch --yes --symmetric --cipher-algo AES256 \
          --passphrase "$BACKUP_PASSPHRASE" -o "$FILES_OUT"
  echo "backup ok: $FILES_OUT ($(wc -c < "$FILES_OUT") bytes)"
else
  echo "note: $UPLOADS_DIR does not exist — no uploaded files to archive yet"
fi

# Retention: delete all but the newest $KEEP of each artefact.
for pattern in "friendly_crm-*.sql.gz.gpg" "friendly_crm-files-*.tar.gz.gpg"; do
  # shellcheck disable=SC2086
  ls -1t $DIR/$pattern 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && echo "pruned old backup: $old"
  done
done
