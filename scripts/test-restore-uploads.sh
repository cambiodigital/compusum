#!/bin/sh
# ============================================================================
# test-restore-uploads.sh — prueba reproducible del microfix Fase 7
#
# Escenario obligatorio:
#   origen backup:   <WORK>/source/uploads
#   destino restore: <WORK>/restored-media   (basename DISTINTO al original)
#
# Demuestra:
#   1) restore exit 0;
#   2) el archivo queda en restored-media/<archivo>;
#   3) checksum del archivo restaurado == checksum del respaldado;
#   4) NO queda restaurado accidentalmente en <WORK>/uploads;
#   5) manifest/checksum corrupto aborta ANTES de tocar el destino;
#   6) regresión: basename destino igual al original también funciona.
#
# Requisitos: docker (levanta un PostgreSQL 16 efímero con auth trust y lo
# destruye al final). No introduce dependencias del proyecto.
#
# Uso:  sh scripts/test-restore-uploads.sh          (PG_PORT para otro puerto)
# ============================================================================
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0

ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "  ✅ $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "  ❌ $*"; }

# check <descripcion> <comando...>
check() {
  desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}
check_not() {
  desc="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$desc"; else ok "$desc (no ocurre)"; fi
}

command -v docker >/dev/null 2>&1 || {
  echo "Este test requiere docker disponible en PATH." >&2
  exit 2
}

PG_CONTAINER="compusum-restore-test-pg"
PG_PORT="${PG_PORT:-55441}"
PG_DB="restoretest"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/compusum-restoretest.XXXXXX")"

cleanup() {
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT INT TERM

# DB_URL sin credenciales: el contenedor efímero usa POSTGRES_HOST_AUTH_METHOD
# = trust (sólo escucha en el puerto local publicado durante el test).
DB_URL="postgresql://postgres@host.docker.internal:${PG_PORT}/${PG_DB}?schema=public"
PG_DUMP_CMD="docker run --rm -i postgres:16-alpine pg_dump"
PG_RESTORE_CMD="docker run --rm -i postgres:16-alpine pg_restore"

echo "== test-restore-uploads (workdir $WORK) =="

docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB="$PG_DB" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "$PG_PORT":5432 postgres:16-alpine >/dev/null

i=0
until docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "PostgreSQL efímero no quedó listo" >&2; exit 1; fi
  sleep 1
done

# ── Fixtures: origen con basename 'uploads' ─────────────────────────────────
mkdir -p "$WORK/source/uploads"
printf 'evidencia-restore-%s\n' "$$" > "$WORK/source/uploads/evidence.txt"
printf 'segundo-archivo\n' > "$WORK/source/uploads/second.bin"
EVIDENCE_SHA="$(sha256sum "$WORK/source/uploads/evidence.txt" | cut -d' ' -f1)"

# ── Backup real del directorio fuente ───────────────────────────────────────
if DATABASE_URL="$DB_URL" PG_DUMP_CMD="$PG_DUMP_CMD" \
     sh "$ROOT/scripts/backup.sh" "$WORK/backups" --uploads-dir "$WORK/source/uploads" \
     > "$WORK/backup.log" 2>&1; then
  ok "backup exit 0"
else
  fail "backup falló"
  cat "$WORK/backup.log" >&2
  exit 1
fi
set -- "$WORK"/backups/backup-*
BACKUP_DIR="$1"
check "db.dump generado en el backup" test -f "$BACKUP_DIR/db.dump"

# ── Caso corrupto: aborta ANTES de tocar destino (que ni siquiera existe) ───
cp -a "$BACKUP_DIR" "$WORK/backups-corrupt"
printf 'X' | dd of="$WORK/backups-corrupt/db.dump" bs=1 seek=20 conv=notrunc status=none 2>/dev/null
DESTINO="$WORK/restored-media"
if PG_RESTORE_CMD="$PG_RESTORE_CMD" sh "$ROOT/scripts/restore.sh" "$WORK/backups-corrupt" --yes \
     --database-url "$DB_URL" --uploads-dir "$DESTINO" \
     > "$WORK/restore-corrupt.log" 2>&1; then
  fail "restore con checksum corrupto DEBE abortar"
else
  ok "restore con checksum corrupto aborta (exit != 0)"
fi
check_not "destino intacto tras abort" test -e "$DESTINO"

# ── Happy path: basename destino DISTINTO al del backup ────────────────────
if PG_RESTORE_CMD="$PG_RESTORE_CMD" sh "$ROOT/scripts/restore.sh" "$BACKUP_DIR" --yes \
     --database-url "$DB_URL" --uploads-dir "$DESTINO" \
     > "$WORK/restore.log" 2>&1; then
  ok "restore exit 0 con destino de basename distinto ($DESTINO)"
else
  fail "restore falló con basename distinto"
  cat "$WORK/restore.log" >&2
  exit 1
fi
check "archivo en restored-media/evidence.txt" test -f "$DESTINO/evidence.txt"
RESTORED_SHA="$(sha256sum "$DESTINO/evidence.txt" | cut -d' ' -f1)"
check "checksum restaurado == checksum respaldado" test "$RESTORED_SHA" = "$EVIDENCE_SHA"
check "segundo archivo también en restored-media" test -f "$DESTINO/second.bin"
check_not "NO hay extracción accidental en <WORK>/uploads" test -e "$WORK/uploads"
LEFTOVER="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'compusum-restore.*' | wc -l | tr -d ' ')"
check "staging temporal limpiado" test "$LEFTOVER" = "0"

# ── Regresión: basename destino IGUAL al original ───────────────────────────
if PG_RESTORE_CMD="$PG_RESTORE_CMD" sh "$ROOT/scripts/restore.sh" "$BACKUP_DIR" --yes \
     --database-url "$DB_URL" --uploads-dir "$WORK/destdir/uploads" \
     > "$WORK/restore-same.log" 2>&1; then
  ok "restore exit 0 con basename destino igual al original"
else
  fail "restore falló con basename destino igual al original"
  cat "$WORK/restore-same.log" >&2
  exit 1
fi
check "archivo en destdir/uploads/evidence.txt" test -f "$WORK/destdir/uploads/evidence.txt"
check_not "basename igual: tampoco deja copia en <WORK>/uploads" test -e "$WORK/uploads"

# ── Resumen ─────────────────────────────────────────────────────────────────
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "== RESULTADO: $PASS_COUNT OK, $FAIL_COUNT FALLOS ==" >&2
  exit 1
fi
echo "== RESULTADO: $PASS_COUNT aserciones OK, 0 fallos =="
