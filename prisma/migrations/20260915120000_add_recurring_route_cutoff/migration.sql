-- Fase 5B1: cutoff recurrente semanal con timezone explícita.
--
-- EXPAND-ONLY: agrega dos columnas nullable, sin default, sin backfill y sin
-- DROP. No toca ninguna otra columna.
--
-- `cutOffTime` (timestamp absoluto legacy) y `departureDate` se conservan
-- intactos: NO se infiere el cutoff recurrente a partir de ellos, porque la
-- hora local intencionada por el administrador no es recuperable del instante
-- almacenado (depende del timezone del servidor que procesó el formulario).
-- Las rutas existentes quedan con "sin cutoff recurrente" (ambas NULL), que es
-- el estado conservador: siguen disponibles según departureDaysOfWeek.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS) porque prisma/bootstrap.ts ejecuta
-- `migrate deploy` en cada arranque del contenedor y un fallo determinista
-- dejaría el arranque en bucle (P3009).

ALTER TABLE "ShippingRoute"
  ADD COLUMN IF NOT EXISTS "cutoffDaysBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "cutoffLocalTime" TEXT;
