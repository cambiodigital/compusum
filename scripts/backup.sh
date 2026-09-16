#!/bin/sh
# ============================================================================
# Compusum — BACKUP completo (PostgreSQL + uploads) — Fase 7
#
# Uso:
#   scripts/backup.sh <directorio_destino> [--uploads-dir DIR]
#
# Entorno:
#   DATABASE_URL   (obligatoria) cadena de conexion de la base a respaldar.
#   UPLOADS_DIR    (opcional)   default: ./public/uploads (o /app/public/uploads).
#   PG_DUMP_CMD    (opcional)   comando pg_dump alterno, p. ej. para usar un
#                  cliente docker sin instalar postgres-client localmente:
#                    PG_DUMP_CMD="docker run --rm -i postgres:16-alpine pg_dump"
#
# Genera en <destino>/<timestamp>/:
#   db.dump            pg_dump formato custom (para pg_restore)
#   uploads.tar.gz     contenido integro del directorio de uploads
#   manifest.txt       metadatos + checksums sha256 de cada artefacto
#
# Politica: si la DB o los uploads NO pueden respaldarse, el script FALLA
# (exit != 0). Nunca produce un backup "parcial silencioso".
#
# NOTA: no guardar backups dentro del contenedor efimero; el destino debe ser
# un volumen/punto de montaje externo o una ruta del host.
# ============================================================================
set -eu

usage() {
  echo "Uso: $0 <directorio_destino> [--uploads-dir DIR]" >&2
  echo "  DATABASE_URL es obligatoria (env)." >&2
  exit 2
}

[ $# -ge 1 ] || usage
DEST_ROOT="$1"
shift

UPLOADS_DIR="${UPLOADS_DIR:-}"
PG_DUMP_CMD="${PG_DUMP_CMD:-pg_dump}"

while [ $# -gt 0 ]; do
  case "$1" in
    --uploads-dir)
      [ $# -ge 2 ] || usage
      UPLOADS_DIR="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -n "${DATABASE_URL:-}" ] || { echo "ERROR: DATABASE_URL no definida." >&2; exit 2; }

if [ -z "$UPLOADS_DIR" ]; then
  if [ -d "./public/uploads" ]; then
    UPLOADS_DIR="./public/uploads"
  elif [ -d "/app/public/uploads" ]; then
    UPLOADS_DIR="/app/public/uploads"
  else
    echo "ERROR: no se encontro el directorio de uploads; pase --uploads-dir." >&2
    exit 2
  fi
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "ERROR: sha256sum no disponible en PATH." >&2
  exit 2
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DIR="${DEST_ROOT%/}/backup-$TIMESTAMP"

echo "== Backup Compusum =="
echo "   destino:   $DEST_DIR"
echo "   uploads:   $UPLOADS_DIR"

mkdir -p "$DEST_DIR"

# --- 1. Base de datos -------------------------------------------------------
DB_OUT="$DEST_DIR/db.dump"
# pg_dump/libpq no aceptan el parámetro Prisma `schema=` en la URI; se
# elimina sólo ese parámetro (el resto, p. ej. sslmode, se conserva).
PG_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/g; s/\?$//')"
echo "[$(date -u +%H:%M:%S)] pg_dump -> $DB_OUT"
# Sin comillas: PG_DUMP_CMD puede ser un comando multi-palabra (p. ej. docker run).
if ! $PG_DUMP_CMD -Fc "$PG_URL" > "$DB_OUT"; then
  echo "ERROR: pg_dump fallo. ABORTANDO (no se deja un backup parcial como valido)." >&2
  rm -f "$DB_OUT"
  exit 1
fi
# pg_dump puede "succeed" vaciando stdout en algunos errores de conexion;
# validar que el archivo exista y tenga contenido y firma de formato custom.
if [ ! -s "$DB_OUT" ] || [ "$(head -c 5 "$DB_OUT")" != "PGDMP" ]; then
  echo "ERROR: db.dump vacio o sin formato custom PGDMP. ABORTANDO." >&2
  exit 1
fi

# --- 2. Uploads --------------------------------------------------------------
if [ ! -d "$UPLOADS_DIR" ]; then
  echo "ERROR: el directorio de uploads '$UPLOADS_DIR' no existe. ABORTANDO." >&2
  exit 1
fi
UPLOADS_PARENT="$(dirname "$UPLOADS_DIR")"
UPLOADS_BASE="$(basename "$UPLOADS_DIR")"
UPLOADS_OUT="$DEST_DIR/uploads.tar.gz"
echo "[$(date -u +%H:%M:%S)] tar uploads -> $UPLOADS_OUT"
tar -czf "$UPLOADS_OUT" -C "$UPLOADS_PARENT" "$UPLOADS_BASE"

# --- 3. Manifest + checksums -------------------------------------------------
DB_SHA="$(sha256sum "$DB_OUT" | cut -d' ' -f1)"
UP_SHA="$(sha256sum "$UPLOADS_OUT" | cut -d' ' -f1)"

cat > "$DEST_DIR/manifest.txt" <<EOF
backup_tool=scripts/backup.sh (Compusum fase 7)
created_at_utc=$TIMESTAMP
db_format=pg_dump-custom
db_dump=db.dump
db_dump_sha256=$DB_SHA
uploads_archive=uploads.tar.gz
uploads_archive_sha256=$UP_SHA
uploads_source_dir=$UPLOADS_BASE
EOF

# Checksums con nombres RELATIVOS: validar una copia del backup debe verificar
# los archivos de ESA copia, nunca los originales por ruta absoluta.
( cd "$DEST_DIR" && sha256sum "db.dump" "uploads.tar.gz" > SHA256SUMS )

# Verificacion final del manifest: el backup debe autenticarse a si mismo.
( cd "$DEST_DIR" && sha256sum -c SHA256SUMS >/dev/null )

DB_SIZE="$(du -h "$DB_OUT" | cut -f1)"
UP_SIZE="$(du -h "$UPLOADS_OUT" | cut -f1)"
echo "[$(date -u +%H:%M:%S)] OK"
echo "   db.dump         $DB_SIZE  sha256=$DB_SHA"
echo "   uploads.tar.gz  $UP_SIZE  sha256=$UP_SHA"
echo "Backup completo en: $DEST_DIR"
