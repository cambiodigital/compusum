-- Fase 3: ciclo de pedidos y portal cliente.
-- 1) requestType distingue persistente pedido | cotizacion (existentes => 'pedido').
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "requestType" TEXT NOT NULL DEFAULT 'pedido';

-- 2) Idempotencia de checkout: dos POST concurrentes del mismo checkout
--    resuelven al mismo Order. Columna nueva => solo NULLs, sin dedup previa.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- 3) Nueva semántica Cart/Order: el checkout SIEMPRE crea un Order nuevo
--    (snapshot histórico) y un cliente puede tener varios 'solicitado'.
--    Los índices únicos parciales "un solicitado por cuenta/sesión" ya no
--    aplican. La protección contra doble submit se traslada a la operación
--    concreta: lock transaccional (SELECT ... FOR UPDATE) del carrito en el
--    checkout + idempotencyKey única por intento de checkout.
DROP INDEX IF EXISTS "Order_sessionId_status_unique_idx";
DROP INDEX IF EXISTS "Order_customerId_status_unique_idx";
