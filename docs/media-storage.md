# Almacenamiento multimedia (F6A) — contrato y operación

Este documento es el runbook del contrato de almacenamiento de uploads
establecido en Fase 6A. El código fuente de verdad del par (path, URL) es
`src/lib/media-storage.ts`.

## Contrato

```text
URL pública:  /uploads/<filename>
Path runtime: /app/public/uploads/<filename>   (desarrollo: <repo>/public/uploads/<filename>)
Mount persistente requerido en producción: /app/public/uploads
```

Propiedades del contrato:

- Las referencias guardadas en PostgreSQL (`ProductImage.imagePath`,
  `Category.image`, `Brand.logo`, ...) son **solo URLs** `/uploads/<archivo>`.
  PostgreSQL **NO contiene los binarios**.
- El path físico es fijo y deliberadamente **NO configurable por entorno**.
  Next.js sirve `/uploads/*` desde `public/`; mover los archivos fuera de esa
  ruta sin añadir una capa de serving alternativa rompería el contrato.
- La durabilidad **no la da el código sino el volumen**: sin un mount
  persistente en `/app/public/uploads`, cualquier recreación de contenedor
  (redeploy, rebuild, migración de host) pierde todos los archivos, mientras
  las referencias DB sobreviven → imágenes rotas.
- El entrypoint (`docker-entrypoint.sh`) garantiza `mkdir -p /app/public/uploads`
  en cada arranque; el mkdir crea el punto de montaje si aún no existe volumen.

## Estado por entorno

| Entorno | Path | Persistencia |
| --- | --- | --- |
| Desarrollo | `<repo>/public/uploads` (gitignored) | Disco local |
| Producción (Docker) | `/app/public/uploads` | **Requiere volumen montado** (ver abajo) |

## Primera activación del volumen en producción (procedimiento)

> Este procedimiento NO se ha ejecutado. F6A no autoriza ni ejecuta cambios en
> producción: queda documentado para la ventana de activación que el
> Orquestador apruebe. Los nombres concretos de recursos (volúmenes,
> servicios) dependen de la plataforma de deploy, cuya configuración no está
> versionada en este repo; no se inventan aquí.

1. Identificar el contenedor actual de la app y su `workdir` real
   (esperado: `/app`).
2. Establecer una ventana controlada: sin uploads ni edición de media durante
   los pasos 3–9 (el storefront sigue sirviendo; solo se bloquea escritura).
3. Inventariar el contenido actual: nombre, tamaño y SHA-256 de cada archivo
   de `/app/public/uploads` (ej. `find . -type f -exec sha256sum {} \; > /tmp/uploads-inventory.txt`
   dentro del contenedor, copiando el inventario fuera del contenedor).
4. Backup previo 1:1 del directorio completo (tar) guardado FUERA del
   contenedor y del host de la plataforma si es posible.
5. Crear/configurar el volumen persistente en la plataforma de deploy
   (capacidad acorde al inventario + margen de crecimiento).
6. Copiar los archivos existentes 1:1 al volumen (mismos nombres, sin
   renombrar ni re-codificar: las referencias DB dependen de los nombres).
7. Configurar el mount del volumen en `/app/public/uploads` para el servicio
   de la app.
8. Redeploy controlado (la imagen no cambia; solo el mount).
9. Verificar: conteo de archivos y checksums del volumen == inventario del
   paso 3.
10. Verificar varias URLs reales tomadas de la DB (ej. `ProductImage.imagePath`
    de productos con imagen) → HTTP 200 y contenido correcto.
11. Subir una imagen nueva desde el panel admin (cualquier rol admin/editor)
    y verificar su URL.
12. Redeploy de prueba (sin tocar nada más).
13. Verificar que la imagen del paso 11 sigue presente y servible tras el
    redeploy. Ese es el criterio de cierre de la activación.

## Rollback de la activación

- **Conservar el backup del paso 4** hasta dar la migración por cerrada.
- **No borrar el origen** durante la primera migración: copiar, nunca mover.
- Si tras el redeploy algo falla (rutas, permisos, volumen vacío):
  desmontar/corregir el volumen y volver a desplegar la configuración
  anterior; restaurar desde el backup si el directorio del contenedor viejo
  ya no existe.
- Las referencias DB **no cambian** en ningún punto del procedimiento: el
  rollback no requiere tocar PostgreSQL.
- No existe migración Prisma asociada a F6A.

## Backup / restore

Un backup completo de Compusum debe contemplar **dos almacenes separados**:

1. **PostgreSQL** — datos estructurales y **referencias** de media
   (`ProductImage.imagePath`, `Category.image`, `Brand.logo`, ...), pero
   **nunca los binarios**.
2. **`/app/public/uploads`** (el volumen) — los binarios.

Restaurar solo la DB produce imágenes rotas; restaurar solo el volumen
produce archivos huérfanos. Ambos backups deben ser coherentes entre sí.

La automatización definitiva de backups (agenda, retención, verificación)
no forma parte de F6A: pertenece a la operación/Fase 7.

## Escalado

- El volumen local montado en `/app/public/uploads` es válido para un
  despliegue de **una réplica** del servicio.
- Con **varias réplicas**, cada contenedor necesitaría ver el mismo
  almacenamiento: se requiere un storage realmente compartido (volumen de
  red) o pasar a object storage. Un volumen local por réplica reparte los
  uploads aleatoriamente y produce 404 intermitentes.
- La evolución natural si se requiere scale-out es un object storage
  S3-compatible (F6B+/Fase posterior), cambiando `src/lib/media-storage.ts`
  y la capa de serving; las referencias DB migrarían con un backfill
  explícito.
- No está confirmado cuántas réplicas usa producción actualmente: verificarlo
  antes de cualquier cambio de topología.
