-- Align CartItem non-unique indexes with schema.prisma
CREATE INDEX IF NOT EXISTS "CartItem_cartId_productId_idx" ON "CartItem"("cartId", "productId");
CREATE INDEX IF NOT EXISTS "CartItem_cartId_productId_variantId_idx" ON "CartItem"("cartId", "productId", "variantId");
