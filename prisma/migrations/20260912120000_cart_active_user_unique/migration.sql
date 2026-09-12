-- Identidad canónica: garantía de UN único carrito activo por usuario.
-- 1) Dedup histórico SIN borrar filas: conservar el carrito activo más reciente
--    por userId (updatedAt DESC, createdAt DESC, id DESC); los demás pasan a
--    'expirado' + isActive=false (filas históricas preservadas, igual que el
--    precedent de sessionId de 20260312090000).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "userId"
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
  ) AS rn
  FROM "Cart"
  WHERE "userId" IS NOT NULL AND "status" = 'activo'
)
UPDATE "Cart" c
SET "status" = 'expirado', "isActive" = false, "updatedAt" = NOW()
FROM ranked r
WHERE c.id = r.id AND r.rn > 1 AND c."status" = 'activo';

-- 2) Exclusión a nivel BD (índice único parcial no representable en
--    schema.prisma; vive solo en SQL como PriceProfile_isDefault_one_row).
CREATE UNIQUE INDEX IF NOT EXISTS "Cart_userId_status_activo_unique_idx"
  ON "Cart"("userId")
  WHERE "userId" IS NOT NULL AND "status" = 'activo';
