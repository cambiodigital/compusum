# Runbook — Backup y Restore (PostgreSQL + uploads)

> **Regla de oro (Fase 6/7):** el sistema tiene **dos almacenes de datos
> independientes**: la base PostgreSQL y el volumen de archivos
> `/app/public/uploads` (URLs públicas `/uploads/*`). Un backup de sólo DB
> **no es suficiente**: los productos quedan con imágenes rotas.

## Qué respalda `scripts/backup.sh`

| Artefacto        | Contenido                                            | Formato                     |
| ---------------- | ---------------------------------------------------- | --------------------------- |
| `db.dump`        | Base completa (esquema + datos + `_prisma_migrations`) | `pg_dump` custom (`-Fc`)   |
| `uploads.tar.gz` | Todo el directorio de uploads                         | tar+gzip                    |
| `manifest.txt`   | Timestamp, nombres y checksums SHA-256                | texto                       |
| `SHA256SUMS`     | Checksums verificables con `sha256sum -c`             | texto                       |

Si la DB o los uploads no pueden respaldarse, el script **falla** (no produce
backups parciales "válidos").

## Requisitos

- Un cliente de PostgreSQL **de la misma versión mayor que el servidor o
  superior** (producción usa PostgreSQL 16 → `pg_dump`/`pg_restore` 16+).
- `sha256sum` y `tar` (presentes en cualquier Git Bash/WSL/Linux).
- Sin instalar nada: se puede usar el cliente dockerizado (ver abajo).

## Backup

```bash
# Desde el host / máquina de operaciones (destino SIEMPRE externo al
# contenedor efímero: disco del host, volumen dedicado, NAS, etc.).
# <CADENA_CONEXION> = la DATABASE_URL del entorno (formato en .env.example;
# los ejemplos se escriben sin credenciales para no disparar escáneres):
DATABASE_URL="<CADENA_CONEXION>" \
  scripts/backup.sh /ruta/segura/de/backups

# Con cliente dockerizado (sin instalar postgres-client):
DATABASE_URL="<CADENA_CONEXION>" \
  PG_DUMP_CMD="docker run --rm -i postgres:16-alpine pg_dump" \
  scripts/backup.sh /ruta/segura/de/backups
# (si la DB corre en el host, use host.docker.internal como HOST)
```

El destino se pasa SIEMPRE explícito (argumento): por diseño no hay default
que escriba dentro del contenedor.

### Frecuencia recomendada

- Backup diario programado + backup previo a **cualquier** operación riesgosa
  (migraciones manuales, `migrate resolve`, restores, imports masivos CSV).
- Retención: mínimo 7 días; conservar al menos un backup previo a cada
  release/deploy.

## Restore (destructivo y explícito)

`scripts/restore.sh` **reemplaza** la DB destino (`--clean --if-exists`) y
**borra** el directorio de uploads destino. Exige `--yes`. Nunca corre en el
startup del contenedor: es una operación manual de incidente.

```bash
scripts/restore.sh /ruta/segura/de/backups/backup-20260916T120000Z \
  --yes \
  --database-url "<CADENA_CONEXION>" \
  --uploads-dir /app/public/uploads

# Con cliente dockerizado:
PG_RESTORE_CMD="docker run --rm -i postgres:16-alpine pg_restore" \
  scripts/restore.sh <backup_dir> --yes --database-url "<url>"
```

El script valida manifest + checksums **antes** de tocar nada: un backup
corrupto aborta sin restaurar. Los uploads se colocan **SIEMPRE exactamente**
en el directorio indicado con `--uploads-dir`, independientemente del basename
original contenido en el backup (extracción vía staging temporal con
verificación de estructura); cualquier basename destino es válido.

> Nota: desde el microfix de Fase 7, `SHA256SUMS` usa rutas relativas; los
> backups previos siguen siendo válidos en la máquina donde se crearon.

Prueba reproducible del ciclo (levanta su propio PostgreSQL efímero en
Docker, no toca otros entornos):

```bash
sh scripts/test-restore-uploads.sh
```

### Después de un restore

```bash
bunx prisma migrate status    # debe mostrar la base al día (el dump incluye _prisma_migrations)
bun run db:validate           # esquema real == prisma/schema.prisma
```

Luego arrancar la app y verificar `GET /api/ready` → 200, y que una imagen de
producto sirva correctamente (`/uploads/<archivo>`).

## Rollback de release (app, no datos)

1. Redesplegar la imagen/tag anterior de la aplicación.
2. Si el release anterior exigía migraciones ya aplicadas, **no** se hace
   `migrate` hacia atrás: el esquema permanece y la app anterior sigue
   funcionando (las migraciones del repo son aditivas/compatibles).
3. Sólo si el release introdujo corrupción de datos → restaurar el backup
   tomado **antes** del deploy con `scripts/restore.sh`.

## Enlaces

- `docs/ops/migraciones-recuperacion.md` — runbook de P3005/P3009 (manual).
- `docs/media-storage.md` — contrato del volumen de uploads (Fase 6A).
