#!/bin/sh
# Restore an encrypted Friendly CRM backup produced by backup.sh.
#
# ⚠️ This OVERWRITES what it restores. Test it on a throwaway DB first — an
# untested backup is not a backup.
#
# TWO ARTEFACTS, RESTORED SEPARATELY
#
# backup.sh writes a database dump AND an archive of the uploaded documents,
# because the database stores a storage_key and never the bytes. Restoring the
# dump alone gives you a complete file list in which every download 404s — an
# archive that is lost but looks intact. The file argument decides which is
# being restored, by suffix:
#
#   restore.sh /backups/friendly_crm-20260904-020000.sql.gz.gpg        → database
#   restore.sh /backups/friendly_crm-files-20260904-020000.tar.gz.gpg  → documents
#
# A full recovery needs BOTH, and the pair must carry the same timestamp: a
# database newer than the files references documents that were never archived.
#
#   docker compose -f docker-compose.prod.yml exec backup \
#     /bin/sh /usr/local/bin/restore.sh /backups/friendly_crm-YYYYMMDD-HHMMSS.sql.gz.gpg
set -eu

FILE="${1:?usage: restore.sh <path-to-.sql.gz.gpg|.tar.gz.gpg>}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-friendly_crm}"
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"

[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }

case "$FILE" in
  *.tar.gz.gpg)
    # The documents. The backup service mounts the volume read-only, so this
    # branch is run with the volume mounted read-write — say so plainly rather
    # than failing on a permission error that looks like a corrupt archive.
    [ -w "$UPLOADS_DIR" ] || {
      echo "$UPLOADS_DIR is not writable."
      echo "The backup service mounts it read-only on purpose. Restore files with:"
      echo "  docker compose -f docker-compose.prod.yml run --rm \\"
      echo "    -v friendly_uploads:/data/uploads backup \\"
      echo "    /bin/sh /usr/local/bin/restore.sh $FILE"
      exit 1
    }
    echo "restoring documents from $FILE into $UPLOADS_DIR ..."
    gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" "$FILE" \
      | gunzip \
      | tar -C "$UPLOADS_DIR" -xf -
    echo "restore complete: $(find "$UPLOADS_DIR" -type f | wc -l) file(s) present."
    ;;
  *.sql.gz.gpg)
    : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
    echo "restoring $FILE into $DB_NAME on $DB_HOST ..."
    gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" "$FILE" \
      | gunzip \
      | PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1
    echo "restore complete."
    echo "Remember the documents: restore.sh $(dirname "$FILE")/friendly_crm-files-<same-stamp>.tar.gz.gpg"
    ;;
  *)
    echo "unrecognised backup file: $FILE"
    echo "expected a .sql.gz.gpg (database) or .tar.gz.gpg (documents) artefact"
    exit 1
    ;;
esac
