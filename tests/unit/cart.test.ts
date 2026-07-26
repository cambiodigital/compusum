import { describe, it, expect, vi } from 'vitest';
import { validateAndPriceItems, CartValidationError } from '@/lib/cart-validation';

describe('Cart Validation and Pricing Logic', () => {
  it('throws error when items array is empty or null', async () => {
    await expect(validateAndPriceItems([])).rejects.toThrow(CartValidationError);
    await expect(validateAndPriceItems(null as any)).rejects.toThrow(CartValidationError);
  });

  it('throws error when product does not exist or is inactive', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    await expect(
      validateAndPriceItems([{ productId: 'non-existent', quantity: 1 }], mockTx)
    ).rejects.toThrow('El producto "non-existent" no está disponible.');
  });

  it('throws error when product stock status is "agotado"', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'prod-1',
            name: 'Teclado Mecanico',
            isActive: true,
            stockStatus: 'agotado',
            variants: [],
          },
        ]),
      },
    };

    await expect(
      validateAndPriceItems([{ productId: 'prod-1', quantity: 1 }], mockTx)
    ).rejects.toThrow('El producto "Teclado Mecanico" está agotado.');
  });

  it('throws error when quantity is non-integer or <= 0', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'prod-1',
            name: 'Monitor',
            isActive: true,
            stockStatus: 'disponible',
            price: 200,
            variants: [],
          },
        ]),
      },
    };

    await expect(
      validateAndPriceItems([{ productId: 'prod-1', quantity: 0 }], mockTx)
    ).rejects.toThrow(CartValidationError);

    await expect(
      validateAndPriceItems([{ productId: 'prod-1', quantity: 2.5 }], mockTx)
    ).rejects.toThrow(CartValidationError);
  });

  it('enforces minWholesaleQty limit', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'prod-1',
            name: 'Cable HDMI',
            isActive: true,
            stockStatus: 'disponible',
            minWholesaleQty: 5,
            price: 10,
            variants: [],
          },
        ]),
      },
    };

    await expect(
      validateAndPriceItems([{ productId: 'prod-1', quantity: 2 }], mockTx)
    ).rejects.toThrow('La cantidad mínima mayorista para "Cable HDMI" es de 5 unidades.');
  });

  it('calculates unit prices, line totals and subtotal correctly for valid products', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p1',
            name: 'RAM 8GB',
            sku: 'SKU-RAM-8',
            isActive: true,
            stockStatus: 'disponible',
            minWholesaleQty: 1,
            price: 50,
            wholesalePrice: 40,
            variants: [],
          },
        ]),
      },
    };

    const result = await validateAndPriceItems(
      [{ productId: 'p1', quantity: 3 }],
      mockTx
    );

    expect(result.validatedItems).toHaveLength(1);
    expect(result.validatedItems[0]).toEqual({
      productId: 'p1',
      productName: 'RAM 8GB',
      productSku: 'SKU-RAM-8',
      variantId: null,
      variantName: null,
      variantCode: null,
      quantity: 3,
      unitPrice: 40, // Uses wholesalePrice if available
      lineTotal: 120,
    });
    expect(result.subtotal).toBe(120);
  });

  it('validates variant membership and availability', async () => {
    const mockTx = {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p1',
            name: 'Camiseta',
            isActive: true,
            stockStatus: 'disponible',
            price: 20,
            variants: [
              {
                id: 'v1',
                productId: 'p1',
                name: 'Talla L',
                code: 'CAM-L',
                isActive: true,
                stockStatus: 'disponible',
                price: 25,
                wholesalePrice: 22,
              },
            ],
          },
        ]),
      },
    };

    const result = await validateAndPriceItems(
      [{ productId: 'p1', variantId: 'v1', quantity: 2 }],
      mockTx
    );

    expect(result.validatedItems[0].variantId).toBe('v1');
    expect(result.validatedItems[0].unitPrice).toBe(22);
    expect(result.subtotal).toBe(44);
  });
});
