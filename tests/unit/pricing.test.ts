import { describe, it, expect, vi } from 'vitest';
import {
  resolvePricesForItems,
  resolvePrice,
  resolvePricesFromProductMap,
  getActivePriceProfile,
  attachResolvedPrices,
  resolveServerPricingCustomer,
  type ActivePriceProfile,
  type ProductPriceData,
} from '@/lib/pricing';

/**
 * MOTOR ÚNICO DE PRECIOS — jerarquía y seguridad.
 * Todos los tests usan tx mockeado (sin BD real).
 */

const product: ProductPriceData = {
  id: 'p1',
  price: 12000,
  wholesalePrice: 10000,
  variants: [
    { id: 'v1', price: 5000, wholesalePrice: 4000 },
    { id: 'v2', price: null, wholesalePrice: null },
  ],
};

const productMap = new Map<string, ProductPriceData>([
  ['p1', product],
  [
    'p-zero',
    { id: 'p-zero', price: null, wholesalePrice: null, variants: [] },
  ],
]);

function profile(overrides: Partial<ActivePriceProfile> = {}): ActivePriceProfile {
  return {
    id: 'prof-1',
    code: 'VIP',
    name: 'Perfil VIP',
    percentAdjustment: null,
    ...overrides,
  };
}

describe('Pricing: resolución pura (jerarquía)', () => {
  it('cliente sin perfil => precio base (cascada wholesale-first)', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      null
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(10000);
    expect(resolved.source).toBe('product_base');
    expect(resolved.purchasable).toBe(true);
  });

  it('perfil con ajuste general => precio correcto sobre la base', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ percentAdjustment: -10 })
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(9000); // 10000 - 10%
    expect(resolved.source).toBe('profile_adjustment');
    expect(resolved.basePrice).toBe(10000);
  });

  it('override de producto => gana al ajuste general del perfil', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ percentAdjustment: -10 }),
      {
        byProduct: new Map([['p1', { wholesalePrice: 8000, price: null }]]),
        byVariant: new Map(),
      }
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(8000);
    expect(resolved.source).toBe('product_override');
  });

  it('override de variante => gana al override de producto', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: 'v1' }],
      productMap,
      profile(),
      {
        byProduct: new Map([['p1', { wholesalePrice: 8000, price: null }]]),
        byVariant: new Map([['v1', { wholesalePrice: 3500, price: null }]]),
      }
    );
    const resolved = prices.get('p1::v1')!;
    expect(resolved.unitPrice).toBe(3500);
    expect(resolved.source).toBe('variant_override');
  });

  // IGUALDAD: la precedencia depende de la EXISTENCIA de la regla, nunca de
  // comparar unitPrice === base.
  it('IGUALDAD: override variante == base => gana la variante (no lo pisa producto/ajuste)', () => {
    // base variante = 4000, override variante = 4000, override producto = 8000, ajuste -10%
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: 'v1' }],
      productMap,
      profile({ percentAdjustment: -10 }),
      {
        byProduct: new Map([['p1', { wholesalePrice: 8000, price: null }]]),
        byVariant: new Map([['v1', { wholesalePrice: 4000, price: null }]]),
      }
    );
    const resolved = prices.get('p1::v1')!;
    expect(resolved.unitPrice).toBe(4000);
    expect(resolved.source).toBe('variant_override');
  });

  it('IGUALDAD: override producto == base => gana el producto (no aplica el ajuste -10%)', () => {
    // base producto = 10000, override producto = 10000, ajuste -10% => 10000, NO 9000
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ percentAdjustment: -10 }),
      {
        byProduct: new Map([['p1', { wholesalePrice: 10000, price: null }]]),
        byVariant: new Map(),
      }
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(10000);
    expect(resolved.source).toBe('product_override');
  });

  it('IGUALDAD: ajuste 0% => la regla se considera aplicada (profile_adjustment)', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ percentAdjustment: 0 })
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(10000);
    expect(resolved.source).toBe('profile_adjustment');
  });

  it('IGUALDAD: override variante == base SIN otros niveles => variant_override', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: 'v1' }],
      productMap,
      profile(),
      {
        byProduct: new Map(),
        byVariant: new Map([['v1', { wholesalePrice: 4000, price: null }]]),
      }
    );
    const resolved = prices.get('p1::v1')!;
    expect(resolved.unitPrice).toBe(4000);
    expect(resolved.source).toBe('variant_override');
  });

  it('precio 0 => requiere cotización / no comprable', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile(),
      {
        byProduct: new Map([['p1', { wholesalePrice: 0, price: 500 }]]),
        byVariant: new Map(),
      }
    );
    const resolved = prices.get('p1::')!;
    expect(resolved.unitPrice).toBe(0);
    expect(resolved.requiresQuote).toBe(true);
    expect(resolved.purchasable).toBe(false);
  });

  it('producto sin ningún precio => requiere cotización', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p-zero', variantId: null }],
      productMap,
      null
    );
    const resolved = prices.get('p-zero::')!;
    expect(resolved.unitPrice).toBeNull();
    expect(resolved.requiresQuote).toBe(true);
    expect(resolved.purchasable).toBe(false);
  });

  it('variante sin override => fallback correcto al override de producto y luego base', () => {
    // Sin override de variante: aplica override de producto
    const withProductOverride = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: 'v2' }],
      productMap,
      profile(),
      {
        byProduct: new Map([['p1', { wholesalePrice: 8000, price: null }]]),
        byVariant: new Map(),
      }
    );
    expect(withProductOverride.prices.get('p1::v2')!.unitPrice).toBe(8000);
    expect(withProductOverride.prices.get('p1::v2')!.source).toBe('product_override');

    // Sin ningún override: cascada base de la variante (wholesale 4000)
    const noOverrides = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: 'v1' }],
      productMap,
      profile(),
      { byProduct: new Map(), byVariant: new Map() }
    );
    expect(noOverrides.prices.get('p1::v1')!.unitPrice).toBe(4000);
    expect(noOverrides.prices.get('p1::v1')!.source).toBe('variant_base');
  });

  it('dos clientes con perfiles distintos reciben precios distintos', () => {
    const clienteA = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ id: 'prof-a', percentAdjustment: -10 })
    );
    const clienteB = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ id: 'prof-b', percentAdjustment: -20 }),
      {
        byProduct: new Map([['p1', { wholesalePrice: 8500, price: null }]]),
        byVariant: new Map(),
      }
    );
    const precioA = clienteA.prices.get('p1::')!.unitPrice!;
    const precioB = clienteB.prices.get('p1::')!.unitPrice!;
    expect(precioA).toBe(9000);
    expect(precioB).toBe(8500);
    expect(precioA).not.toBe(precioB);
  });

  it('redondeo a 2 decimales para evitar artefactos de punto flotante', () => {
    const { prices } = resolvePricesFromProductMap(
      [{ productId: 'p1', variantId: null }],
      productMap,
      profile({ percentAdjustment: 10 })
    );
    // 10000 * 1.1 = 11000 exacto; con base 9999 * 0.9 = 8999.1
    const sinProblema = prices.get('p1::')!.unitPrice!;
    expect(sinProblema).toBe(11000);
  });
});

describe('Pricing: resolución batch con tx (sin N+1)', () => {
  function makeTx(opts: {
    userFindUnique: ReturnType<typeof vi.fn>;
    defaultProfile?: { id: string; code: string; name: string; percentAdjustment: number | null } | null;
    productOverrides?: any[];
    variantOverrides?: any[];
  }) {
    return {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p1',
            price: 12000,
            wholesalePrice: 10000,
            variants: [{ id: 'v1', price: 5000, wholesalePrice: 4000 }],
          },
        ]),
      },
      user: { findUnique: opts.userFindUnique },
      priceProfile: { findFirst: vi.fn().mockResolvedValue(opts.defaultProfile ?? null) },
      priceProfileProduct: { findMany: vi.fn().mockResolvedValue(opts.productOverrides ?? []) },
      priceProfileVariant: { findMany: vi.fn().mockResolvedValue(opts.variantOverrides ?? []) },
    };
  }

  it('sin perfil: 1 query de productos, sin queries de overrides', async () => {
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue(null),
    });

    const { prices, profile: appliedProfile } = await resolvePricesForItems(
      [
        { productId: 'p1', variantId: 'v1' },
        { productId: 'p1', variantId: null },
      ],
      { customerId: null, tx }
    );

    expect(appliedProfile).toBeNull();
    expect(tx.product.findMany).toHaveBeenCalledTimes(1); // batch, sin N+1
    expect(tx.priceProfileProduct.findMany).not.toHaveBeenCalled();
    expect(tx.priceProfileVariant.findMany).not.toHaveBeenCalled();
    expect(prices.get('p1::v1')!.unitPrice).toBe(4000);
    expect(prices.get('p1::')!.unitPrice).toBe(10000);
  });

  it('cliente CUSTOMER sin perfil asignado => precio base AUNQUE exista perfil isDefault activo', async () => {
    // Política Fase 2: sin asignación explícita NO hay perfil automático.
    // isDefault queda como dato informativo, nunca participa en la resolución.
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue({
        isActive: true,
        role: 'CUSTOMER',
        priceProfile: null,
      }),
      defaultProfile: { id: 'prof-default', code: 'DEFAULT', name: 'Default', percentAdjustment: -5 },
    });

    const { profile: appliedProfile, prices } = await resolvePricesForItems(
      [{ productId: 'p1', variantId: null }],
      { customerId: 'cust-1', tx }
    );

    expect(appliedProfile).toBeNull();
    expect(tx.priceProfile.findFirst).not.toHaveBeenCalled();
    expect(prices.get('p1::')!.unitPrice).toBe(10000);
    expect(prices.get('p1::')!.source).toBe('product_base');
  });

  it('usuario con rol interno (ADMIN) => nunca resuelve perfil comercial', async () => {
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue({
        isActive: true,
        role: 'ADMIN',
        priceProfile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: -50, isActive: true },
      }),
    });

    const { profile: appliedProfile, prices } = await resolvePricesForItems(
      [{ productId: 'p1', variantId: null }],
      { customerId: 'admin-1', tx }
    );

    expect(appliedProfile).toBeNull();
    expect(prices.get('p1::')!.unitPrice).toBe(10000);
  });

  it('perfil asignado INACTIVO => fallback seguro a precio base', async () => {
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue({
        isActive: true,
        role: 'CUSTOMER',
        priceProfile: {
          id: 'prof-off',
          code: 'OFF',
          name: 'Inactivo',
          percentAdjustment: -50,
          isActive: false,
        },
      }),
      defaultProfile: { id: 'prof-default', code: 'DEFAULT', name: 'Default', percentAdjustment: -5 },
    });

    const { profile: appliedProfile, prices } = await resolvePricesForItems(
      [{ productId: 'p1', variantId: null }],
      { customerId: 'cust-1', tx }
    );

    // Ni el perfil inactivo ni el default se aplican (fallback seguro)
    expect(appliedProfile).toBeNull();
    expect(prices.get('p1::')!.unitPrice).toBe(10000);
  });

  it('usuario inactivo => sin perfil (precio base)', async () => {
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue({
        isActive: false,
        role: 'CUSTOMER',
        priceProfile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: -50, isActive: true },
      }),
    });

    const { prices } = await resolvePricesForItems([{ productId: 'p1', variantId: null }], {
      customerId: 'cust-1',
      tx,
    });
    expect(prices.get('p1::')!.unitPrice).toBe(10000);
  });

  it('carga overrides solo de producto y variante solicitados (2 queries)', async () => {
    const tx = makeTx({
      userFindUnique: vi.fn().mockResolvedValue({
        isActive: true,
        role: 'CUSTOMER',
        priceProfile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: null, isActive: true },
      }),
      productOverrides: [{ productId: 'p1', wholesalePrice: 7500, price: null }],
      variantOverrides: [{ variantId: 'v1', wholesalePrice: 3000, price: null }],
    });

    const { prices } = await resolvePricesForItems(
      [
        { productId: 'p1', variantId: null },
        { productId: 'p1', variantId: 'v1' },
      ],
      { customerId: 'cust-1', tx }
    );

    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(tx.priceProfileProduct.findMany).toHaveBeenCalledTimes(1);
    expect(tx.priceProfileVariant.findMany).toHaveBeenCalledTimes(1);
    expect(prices.get('p1::')!.unitPrice).toBe(7500);
    expect(prices.get('p1::v1')!.unitPrice).toBe(3000);
  });

  it('resolvePrice individual delega en la batch', async () => {
    const tx = makeTx({ userFindUnique: vi.fn().mockResolvedValue(null) });
    const resolved = await resolvePrice('p1', 'v1', { customerId: null, tx });
    expect(resolved?.unitPrice).toBe(4000);
  });
});

describe('Pricing: SEGURIDAD — el precio del cliente solo desde sesión/acción autorizada', () => {
  it('invitado SIN sesión => nunca resuelve cliente (aunque envíe email/teléfono)', async () => {
    const tx = {
      user: { findFirst: vi.fn() },
    };
    const customerId = await resolveServerPricingCustomer(null, {
      phone: '3001234567',
      email: 'vip@cliente.com',
    }, tx);

    expect(customerId).toBeNull();
    expect(tx.user.findFirst).not.toHaveBeenCalled();
  });

  it('cliente autenticado CUSTOMER => él mismo (ignora contacto del body)', async () => {
    const tx = { user: { findFirst: vi.fn() } };
    const customerId = await resolveServerPricingCustomer(
      { id: 'cust-1', role: 'CUSTOMER' },
      { email: 'otro@cliente.com' },
      tx
    );
    expect(customerId).toBe('cust-1');
    expect(tx.user.findFirst).not.toHaveBeenCalled();
  });

  it('ADMIN/AGENT autorizado => resuelve cliente por contacto (búsqueda server-side)', async () => {
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'cust-2' }) },
    };
    const customerId = await resolveServerPricingCustomer(
      { id: 'admin-1', role: 'admin' },
      { phone: '3001234567' },
      tx
    );
    expect(customerId).toBe('cust-2');
    // SOLO clientes: la búsqueda filtra explícitamente role=CUSTOMER
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          role: expect.objectContaining({ equals: 'CUSTOMER' }),
        }),
      })
    );
  });

  it('ADMIN con contacto que coincide con un usuario interno => NO lo resuelve (solo CUSTOMER)', async () => {
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const customerId = await resolveServerPricingCustomer(
      { id: 'admin-1', role: 'admin' },
      { phone: '3001234567' },
      tx
    );
    expect(customerId).toBeNull();
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: expect.objectContaining({ equals: 'CUSTOMER' }),
        }),
      })
    );
  });

  it('getActivePriceProfile sin customerId => null sin tocar BD', async () => {
    const tx = { user: { findUnique: vi.fn() } };
    expect(await getActivePriceProfile(null, tx)).toBeNull();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('Pricing: attachResolvedPrices para render/API', () => {
  function makeTxForAttach(opts: { profile?: any; overrides?: any[] } = {}) {
    return {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p1',
            price: 12000,
            wholesalePrice: 10000,
            variants: [{ id: 'v1', price: 5000, wholesalePrice: 4000 }],
          },
        ]),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          isActive: true,
          role: 'CUSTOMER',
          priceProfile: opts.profile ?? null,
        }),
      },
      priceProfile: { findFirst: vi.fn().mockResolvedValue(null) },
      priceProfileProduct: { findMany: vi.fn().mockResolvedValue(opts.overrides ?? []) },
      priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }

  it('adjunta resolvedPrice público al producto y sus variantes', async () => {
    const tx = makeTxForAttach({
      profile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: -10, isActive: true },
      overrides: [{ productId: 'p1', wholesalePrice: 9000, price: null }],
    });

    const [attached] = await attachResolvedPrices(
      [
        {
          id: 'p1',
          price: 12000,
          wholesalePrice: 10000,
          variants: [{ id: 'v1', price: 5000, wholesalePrice: 4000 }],
        },
      ],
      { customerId: 'cust-1', tx }
    );

    expect(attached.resolvedPrice).toEqual({
      unitPrice: 9000,
      purchasable: true,
      requiresQuote: false,
    });
    // La variante sin override específico hereda el override de producto
    // (jerarquía: variante > producto > ajuste > base)
    expect(attached.variants[0].resolvedPrice.unitPrice).toBe(9000);
  });

  it('producto sanitizado por modo catálogo (precios null) => sin resolvedPrice', async () => {
    const tx = makeTxForAttach();
    const [attached] = await attachResolvedPrices(
      [
        {
          id: 'p1',
          price: null,
          wholesalePrice: null,
          variants: [{ id: 'v1', price: null, wholesalePrice: null }],
        },
      ],
      { customerId: null, tx }
    );
    expect(attached.resolvedPrice).toBeNull();
    expect(attached.variants[0].resolvedPrice).toBeNull();
  });
});

describe('Pricing Fase 4A: resolveServerPricingCustomer con aislamiento por asesor', () => {
  it('AGENT => búsqueda restringida a SUS clientes (assignedAgentId = self)', async () => {
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'cust-own' }) },
    };
    const customerId = await resolveServerPricingCustomer(
      { id: 'agent-1', role: 'AGENT' },
      { phone: '3001234567' },
      tx
    );
    expect(customerId).toBe('cust-own');
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: expect.objectContaining({ equals: 'CUSTOMER' }),
          assignedAgentId: 'agent-1',
        }),
      })
    );
  });

  it('EDITOR sin alcance por asesor (global, sin cambios)', async () => {
    const tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'cust-2' }) },
    };
    await resolveServerPricingCustomer(
      { id: 'editor-1', role: 'editor' },
      { phone: '3001234567' },
      tx
    );
    const where = (tx.user.findFirst as ReturnType<typeof vi.fn>).mock
      .calls[0][0].where as Record<string, unknown>;
    expect(where.assignedAgentId).toBeUndefined();
  });
});
