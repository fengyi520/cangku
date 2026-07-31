#!/bin/sh
set -eu

if [ "${CONFIRM_RESTORE:-}" != "RESTORE_CANGKU" ]; then
  printf '%s\n' 'Restore refused. Set CONFIRM_RESTORE=RESTORE_CANGKU after verifying the target database and backup.' >&2
  exit 2
fi

backup_file="${1:-}"
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  printf 'Usage: %s /backups/cangku-YYYYMMDDTHHMMSSZ.dump\n' "$0" >&2
  exit 2
fi

PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
  --host="${POSTGRES_HOST:-postgres}" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  "$backup_file"
printf 'restore_completed=%s\n' "$backup_file"
