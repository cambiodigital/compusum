# Runbook — Recuperación de migraciones Prisma (operación MANUAL)

> **Política (Fase 7, fail-closed):** el arranque del contenedor ejecuta
> `prisma migrate deploy → validación → seed`. Si `migrate deploy` falla, el
> contenedor **falla y no arranca**. El bootstrap **nunca** ejecuta
> `prisma migrate resolve` por su cuenta: alterar `_prisma_migrations`
> automáticamente puede dejar el esquema a medias y ocultar el incidente.
> `prisma migrate resolve` es EXCLUSIVAMENTE una operación manual de
> incidente, ejecutada por un operador tras entender la causa raíz.

## Reglas de oro

1. Nunca "arregles" una migración fallida sin haber leído el error completo.
2. Nunca uses `prisma db push` para "resolver" drift en entornos compartidos.
3. Nunca reintentes a ciegas reiniciando el contenedor: si `migrate deploy`
   falla dos veces por la misma causa, el problema no se resuelve solo.
4. Toda corrección manual se hace con la app APAGADA (el contenedor ya no
   puede arrancar con migraciones en estado failed, y eso es intencional).

## Caso P3009 — migración en estado `failed`

Síntoma en logs de arranque:

```
P3009 ... The migration `X` started at ... failed
```

`_prisma_migrations` contiene una fila con `finished_at IS NULL` (o marcada
como fallida) para la migración `X`. Esto ocurre cuando la migración aplicó
cambios parciales y luego falló.

Procedimiento:

1. **Diagnosticar.** Identifica el error SQL real en los logs del bootstrap
   (el bootstrap imprime stdout/stderr completos antes de salir con código 1).
2. **Decidir el estado real del esquema:**
   - Si la migración dejó cambios parciales aplicados y PUEDE continuarse más
     adelante → resolver como *rolled back* y dejar que un intento posterior
     la reaplique (solo si es idempotente o se corrige antes).
   - Si la migración realmente terminó su trabajo pero falló en un paso
     posterior no crítico → resolver como *applied*.
3. **Ejecutar manualmente** (con la app apagada):

   ```bash
   # Caso "queda como no aplicada" (la migración se reintentará):
   bunx prisma migrate resolve --rolled-back <nombre_migracion>

   # Caso "marcar como aplicada" (solo si verificaste que el esquema quedó completo):
   bunx prisma migrate resolve --applied <nombre_migracion>
   ```

4. **Verificar** antes de reintentar el arranque:

   ```bash
   bunx prisma migrate status
   bun run db:validate   # compara el esquema real con prisma/schema.prisma
   ```

5. Reintentar el deploy del contenedor. Si vuelve a fallar con el mismo error
   SQL, la causa raíz NO era el estado de `_prisma_migrations`: revisar la
   migración y los datos.

## Caso P3005 — base de datos no baselineada

Síntoma:

```
P3005 The database schema is not empty, but there is no migration baseline
```

Ocurre en bases de datos creadas antes del sistema de migraciones (o
restauradas de un dump sin `_prisma_migrations`).

Procedimiento:

1. **Confirmar que el esquema existente corresponde a `0_init`** (o está
   vacío). Inspecciona tablas y compáralas con
   `prisma/migrations/0_init/migration.sql`. Si la base tiene datos
   productivos, NO hagas suposiciones: saca un backup primero
   (`scripts/backup.sh`).
2. Aplicar el baseline **manualmente**:

   ```bash
   bunx prisma migrate resolve --applied 0_init
   bunx prisma migrate deploy
   bun run db:validate
   ```

3. Solo si la base es desechable (desarrollo), es más simple recrearla:

   ```bash
   bunx prisma migrate reset
   ```

## Nota operativa: Prisma auto-crea bases de datos inexistentes

Verificado en Fase 7: si `DATABASE_URL` apunta a una base que NO existe y el
usuario de conexión tiene privilegio `CREATEDB` (p. ej. `postgres`),
`prisma migrate deploy` **crea la base automáticamente** y aplica todas las
migraciones desde cero. Consecuencias:

- Un typo en el nombre de la base en producción no produce un arranque
  fallido: produce una base NUEVA y vacía (con seed) mientras la real queda
  intacta. Verifique SIEMPRE el nombre de la base antes de desplegar.
- Mitigación recomendada: el usuario de la app en producción no debería tener
  `CREATEDB`; use un usuario con permisos sólo sobre la base de la app.

## Referencias

- `prisma/bootstrap.ts` — pipeline de arranque fail-closed.
- `scripts/backup.sh` / `scripts/restore.sh` — saca SIEMPRE un backup antes
  de cualquier operación manual sobre `_prisma_migrations`.
- AGENTS.md — expectativas operativas (P2022/P3005/P3009).
