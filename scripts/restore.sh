#!/bin/sh
# ============================================================================
# Compusum — RESTORE explícito y DESTRUCTIVO (PostgreSQL + uploads) — Fase 7
#
# Uso:
#   scripts/restore.sh <directorio_backup> --yes \
#       [--database-url URL] [--uploads-dir DIR]
#
#   --database-url  destino de la restauración (default: $DATABASE_URL).
#   --uploads-dir   directorio de uploads destino (default como backup.sh).
#
# Este script:
#   * valida el manifest y los checksums ANTES de tocar nada;
#   * restaura la DB con pg_restore --clean --if-exists (BORRA y reemplaza el
#     contenido actual del destino);
#   * BORRA el directorio de uploads destino y lo reemplaza por el backup;
#   * NUNCA se ejecuta en el startup del contenedor: es una operación manual
#     de recuperación ante desastres, siempre con --yes explícito.
#
# Entorno opcional:
#   PG_RESTORE_CMD  comando pg_restore alterno, p. ej.
#     PG_RESTORE_CMD="docker run --rm -i postgres:16-alpine pg_restore"
# ============================================================================
set -eu

usage() {
  echo "Uso: $0 <directorio_backup> --yes [--database-url URL] [--uploads-dir DIR]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
BACKUP_DIR="$1"
shift

CONFIRMED=""
TARGET_URL="${DATABASE_URL:-}"
UPLOADS_DIR="${UPLOADS_DIR:-}"
PG_RESTORE_CMD="${PG_RESTORE_CMD:-pg_restore}"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRMED="1"; shift ;;
    --database-url)
      [ $# -ge 2 ] || usage
      TARGET_URL="$2"; shift 2 ;;
    --uploads-dir)
      [ $# -ge 2 ] || usage
      UPLOADS_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ "$CONFIRMED" = "1" ] || {
  echo "ERROR: restore es DESTRUCTIVO. Reejecute con --yes para confirmar." >&2
  exit 2
}
[ -n "$TARGET_URL" ] || { echo "ERROR: falta --database-url o DATABASE_URL." >&2; exit 2; }

# --- Validación del backup (antes de destruir nada) --------------------------
[ -d "$BACKUP_DIR" ] || { echo "ERROR: no existe el directorio de backup '$BACKUP_DIR'." >&2; exit 2; }
[ -f "$BACKUP_DIR/manifest.txt" ] || { echo "ERROR: falta manifest.txt en '$BACKUP_DIR'." >&2; exit 2; }
[ -f "$BACKUP_DIR/SHA256SUMS" ] || { echo "ERROR: falta SHA256SUMS en '$BACKUP_DIR'." >&2; exit 2; }

manifest_value() {
  grep -E "^$1=" "$BACKUP_DIR/manifest.txt" | head -n1 | cut -d= -f2-
}

DB_DUMP="$(manifest_value db_dump)"
DB_SHA="$(manifest_value db_dump_sha256)"
UP_ARCH="$(manifest_value uploads_archive)"
UP_SHA="$(manifest_value uploads_archive_sha256)"
UPLOADS_BASE="$(manifest_value uploads_source_dir)"

[ -n "$DB_DUMP" ] && [ -n "$DB_SHA" ] && [ -n "$UP_ARCH" ] && [ -n "$UP_SHA" ] && [ -n "$UPLOADS_BASE" ] || {
  echo "ERROR: manifest.txt incompleto. Backup no confiable; ABORTANDO." >&2
  exit 1
}
[ -f "$BACKUP_DIR/$DB_DUMP" ] || { echo "ERROR: falta $DB_DUMP en el backup." >&2; exit 1; }
[ -f "$BACKUP_DIR/$UP_ARCH" ] || { echo "ERROR: falta $UP_ARCH en el backup." >&2; exit 1; }
[ "$(head -c 5 "$BACKUP_DIR/$DB_DUMP")" = "PGDMP" ] || {
  echo "ERROR: $DB_DUMP no tiene firma pg_dump custom. ABORTANDO." >&2
  exit 1
}

echo "== Verificando integridad del backup =="
( cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS ) || {
  echo "ERROR: checksums NO coinciden. Backup corrupto o alterado; ABORTANDO sin restaurar." >&2
  exit 1
}

# Resolución del directorio de uploads destino (igual criterio que backup.sh)
if [ -z "$UPLOADS_DIR" ]; then
  if [ -d "./public/uploads" ]; then
    UPLOADS_DIR="./public/uploads"
  elif [ -d "/app/public/uploads" ]; then
    UPLOADS_DIR="/app/public/uploads"
  else
    UPLOADS_DIR="./public/uploads"
  fi
fi

echo "============================================================"
echo "  RESTAURACIÓN DESTRUCTIVA"
echo "  backup:   $BACKUP_DIR"
echo "  db:       $TARGET_URL  (será REEMPLAZADA por --clean)"
echo "  uploads:  $UPLOADS_DIR  (será BORRADO y reemplazado)"
echo "============================================================"

# --- 1. Base de datos --------------------------------------------------------
echo "[$(date -u +%H:%M:%S)] pg_restore --clean --if-exists -> DB"
# pg_restore/libpq no acepta el parámetro Prisma `schema=` en la URI.
PG_URL="$(printf '%s' "$TARGET_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/g; s/\?$//')"
# Sin comillas: PG_RESTORE_CMD puede ser un comando multi-palabra (p. ej. docker run).
if ! $PG_RESTORE_CMD --clean --if-exists --no-owner --dbname "$PG_URL" \
    < "$BACKUP_DIR/$DB_DUMP"; then
  echo "ERROR: pg_restore falló. La DB destino puede quedar parcial." >&2
  echo "       NO intente arrancar la app: repare o repita el restore tras diagnosticar." >&2
  exit 1
fi

# --- 2. Uploads ---------------------------------------------------------------
UPLOADS_PARENT="$(dirname "$UPLOADS_DIR")"
UPLOADS_BASENAME="$(basename "$UPLOADS_DIR")"
echo "[$(date -u +%H:%M:%S)] reemplazando uploads: $UPLOADS_DIR"
mkdir -p "$UPLOADS_PARENT"
rm -rf "$UPLOADS_DIR"
if ! tar -xzf "$BACKUP_DIR/$UP_ARCH" -C "$UPLOADS_PARENT"; then
  echo "ERROR: la extracción de uploads falló. Restaure manualmente desde $UP_ARCH." >&2
  exit 1
fi

# --- 3. Verificación ----------------------------------------------------------
RESTORED_FILES="$(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ')"
echo "[$(date -u +%H:%M:%S)] OK"
echo "   DB restaurada (verifique además: prisma migrate status / bun run db:validate)."
echo "   Uploads restaurados: $RESTORED_FILES archivos en $UPLOADS_DIR"
