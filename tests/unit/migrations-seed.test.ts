import { describe, it, expect } from 'vitest';

describe('Prisma Migrations and Operational Alignment Validation', () => {
  // Regex pattern rules used in prisma/validate-operational-alignment.ts
  const allowedDbNativeDropIndexPatterns = [
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Product_searchVector_idx";?/i,
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"CartItem_cartId_productId_base_unique";?/i,
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"CartItem_cartId_productId_variant_unique";?/i,
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Order_sessionId_status_unique_idx";?/i,
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Order_customerId_status_unique_idx";?/i,
    /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Cart_sessionId_status_unique_idx";?/i,
  ];

  it('validates allowed DB-native partial and GIN index drop patterns', () => {
    const validStatements = [
      'DROP INDEX "Product_searchVector_idx";',
      'DROP INDEX IF EXISTS "public"."CartItem_cartId_productId_base_unique";',
      'DROP INDEX "public"."Order_sessionId_status_unique_idx";',
      'DROP INDEX "Cart_sessionId_status_unique_idx"',
    ];

    for (const stmt of validStatements) {
      const isMatch = allowedDbNativeDropIndexPatterns.some((pattern) => pattern.test(stmt));
      expect(isMatch).toBe(true);
    }
  });

  it('flags unauthorized DB schema drift statements', () => {
    const invalidStatements = [
      'DROP TABLE "User";',
      'ALTER TABLE "Product" DROP COLUMN "price";',
      'DROP INDEX "User_email_key";',
    ];

    for (const stmt of invalidStatements) {
      const isMatch = allowedDbNativeDropIndexPatterns.some((pattern) => pattern.test(stmt));
      expect(isMatch).toBe(false);
    }
  });
});
