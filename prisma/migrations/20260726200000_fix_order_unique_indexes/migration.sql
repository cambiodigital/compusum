-- Drop old full unique indexes that cause P2002 on historical or repeated completed orders
DROP INDEX IF EXISTS "Order_sessionId_status_key";
DROP INDEX IF EXISTS "Order_customerId_status_key";

-- Normalizar/deduplicar pedidos 'solicitado' antes de asegurar restricciones unicas parciales
WITH ranked_order_session AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY "sessionId"
			ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
		) AS rn
	FROM "Order"
	WHERE "sessionId" IS NOT NULL
		AND "status" = 'solicitado'
)
UPDATE "Order" o
SET "status" = 'compartido',
		"updatedAt" = NOW()
FROM ranked_order_session r
WHERE o.id = r.id
	AND r.rn > 1
	AND o."status" = 'solicitado';

WITH ranked_order_customer AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY "customerId"
			ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
		) AS rn
	FROM "Order"
	WHERE "customerId" IS NOT NULL
		AND "status" = 'solicitado'
)
UPDATE "Order" o
SET "status" = 'compartido',
		"updatedAt" = NOW()
FROM ranked_order_customer r
WHERE o.id = r.id
	AND r.rn > 1
	AND o."status" = 'solicitado';

-- Garantizar indices unicos parciales solo para pedidos en estado 'solicitado'
CREATE UNIQUE INDEX IF NOT EXISTS "Order_sessionId_status_unique_idx" ON "Order"("sessionId", "status") WHERE "sessionId" IS NOT NULL AND "status" = 'solicitado';
CREATE UNIQUE INDEX IF NOT EXISTS "Order_customerId_status_unique_idx" ON "Order"("customerId", "status") WHERE "customerId" IS NOT NULL AND "status" = 'solicitado';

-- Crear indices normales no unicos para optimizar busquedas por (sessionId, status) y (customerId, status)
CREATE INDEX IF NOT EXISTS "Order_sessionId_status_idx" ON "Order"("sessionId", "status");
CREATE INDEX IF NOT EXISTS "Order_customerId_status_idx" ON "Order"("customerId", "status");
