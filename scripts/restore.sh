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
#                   Los uploads se colocan SIEMPRE exactamente en ese
#                   directorio, independientemente del basename original
#                   contenido en el backup (extracción vía staging temporal).
#
# Este script:
#   * valida el manifest (nombres seguros) y los checksums ANTES de tocar nada;
#   * restaura la DB con pg_restore --clean --if-exists (BORRA y reemplaza el
#     contenido actual del destino);
#   * BORRA el directorio de uploads destino y coloca allí el contenido
#     respaldado (extracción en staging + verificación de estructura antes
#     de reemplazar);
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

# Los nombres del manifest se concatenan en rutas y definen la raíz del tar:
# sólo se aceptan nombres planos seguros (sin separadores, sin .., sin guión
# inicial). Cualquier otra forma = manifest manipulado o backup ajeno.
require_safe_name() {
  case "$1" in
    ""|*[!A-Za-z0-9._-]*|[!A-Za-z0-9]*)
      echo "ERROR: '$2' en manifest no es un nombre seguro ('$1'). ABORTANDO." >&2
      exit 1 ;;
  esac
}
require_safe_name "$DB_DUMP" "db_dump"
require_safe_name "$UP_ARCH" "uploads_archive"
require_safe_name "$UPLOADS_BASE" "uploads_source_dir"

[ -f "$BACKUP_DIR/$DB_DUMP" ] || { echo "ERROR: falta $DB_DUMP en el backup." >&2; exit 1; }
[ -f "$BACKUP_DIR/$UP_ARCH" ] || { echo "ERROR: falta $UP_ARCH en el backup." >&2; exit 1; }
[ "$(head -c 5 "$BACKUP_DIR/$DB_DUMP")" = "PGDMP" ] || {
  echo "ERROR: $DB_DUMP no tiene firma pg_dump custom. ABORTANDO." >&2
  exit 1
}

echo "== Verificando integridad del backup =="
# 1) Cada artefacto debe coincidir con el hash registrado en el manifest
#    (comparación directa, independiente de rutas absolutas en SHA256SUMS).
ACTUAL_DB_SHA="$(sha256sum "$BACKUP_DIR/$DB_DUMP" | cut -d' ' -f1)"
if [ "$ACTUAL_DB_SHA" != "$DB_SHA" ]; then
  echo "ERROR: db.dump NO coincide con db_dump_sha256 del manifest. ABORTANDO sin restaurar." >&2
  exit 1
fi
ACTUAL_UP_SHA="$(sha256sum "$BACKUP_DIR/$UP_ARCH" | cut -d' ' -f1)"
if [ "$ACTUAL_UP_SHA" != "$UP_SHA" ]; then
  echo "ERROR: uploads.tar.gz NO coincide con uploads_archive_sha256 del manifest. ABORTANDO sin restaurar." >&2
  exit 1
fi
# 2) Verificación del archivo SHA256SUMS del backup (formato canónico).
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
# El tar contiene el directorio con el basename ORIGINAL del backup
# (uploads_source_dir). El destino puede tener CUALQUIER basename (p. ej.
# /tmp/restored-media): se extrae a un staging temporal, se verifica la
# estructura esperada y SÓLO ENTONCES se reemplaza el destino exacto
# $UPLOADS_DIR. Nada se extrae directo junto al destino.
UPLOADS_PARENT="$(dirname "$UPLOADS_DIR")"

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/compusum-restore.XXXXXX")"
cleanup_staging() { if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi; }
trap cleanup_staging EXIT INT TERM

echo "[$(date -u +%H:%M:%S)] extrayendo $UP_ARCH a staging temporal"
if ! tar -xzf "$BACKUP_DIR/$UP_ARCH" -C "$STAGING"; then
  echo "ERROR: la extracción de uploads falló. Backup inservible; el destino NO fue tocado." >&2
  exit 1
fi

# Estructura esperada: EXACTAMENTE un directorio raíz llamado uploads_source_dir.
EXTRACTED="$STAGING/$UPLOADS_BASE"
if [ ! -d "$EXTRACTED" ]; then
  echo "ERROR: el backup no contiene el directorio raíz '$UPLOADS_BASE'. ABORTANDO sin tocar el destino." >&2
  exit 1
fi
UNEXPECTED="$(ls -A "$STAGING" | grep -v -x "$UPLOADS_BASE" || true)"
if [ -n "$UNEXPECTED" ]; then
  echo "ERROR: contenido inesperado en el backup ([$(printf '%s' "$UNEXPECTED" | tr '\n' ' ')]). ABORTANDO sin tocar el destino." >&2
  exit 1
fi

echo "[$(date -u +%H:%M:%S)] reemplazando uploads: $UPLOADS_DIR"
mkdir -p "$UPLOADS_PARENT"
rm -rf "$UPLOADS_DIR"
# mv puede fallar entre dispositivos distintos (staging vs destino): cae a copia.
if ! mv "$EXTRACTED" "$UPLOADS_DIR" 2>/dev/null; then
  if ! cp -a "$EXTRACTED" "$UPLOADS_DIR"; then
    echo "ERROR: no se pudo colocar el contenido en $UPLOADS_DIR. El staging se conserva en $STAGING para inspección." >&2
    STAGING=""
    exit 1
  fi
fi

# --- 3. Verificación ----------------------------------------------------------
if [ ! -d "$UPLOADS_DIR" ]; then
  echo "ERROR: el destino $UPLOADS_DIR no existe tras el restore." >&2
  exit 1
fi
RESTORED_FILES="$(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ')"
ARCHIVE_FILES="$(tar -tzf "$BACKUP_DIR/$UP_ARCH" | grep -v -c '/$' || true)"
if [ "$RESTORED_FILES" != "$ARCHIVE_FILES" ]; then
  echo "ERROR: el destino tiene $RESTORED_FILES archivos pero el backup contiene $ARCHIVE_FILES. VERIFICAR MANUALMENTE." >&2
  exit 1
fi
echo "[$(date -u +%H:%M:%S)] OK"
echo "   DB restaurada (verifique además: prisma migrate status / bun run db:validate)."
echo "   Uploads restaurados: $RESTORED_FILES archivos en $UPLOADS_DIR"
