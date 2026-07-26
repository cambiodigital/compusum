import { describe, it, expect } from 'vitest';
import {
  resolveCatalogMode,
  isProductCatalogMode,
  sanitizeProductForCatalog,
  sanitizeProductsForCatalog,
} from '@/lib/catalog-mode';

describe('Catalog Mode and Price Rules', () => {
  describe('resolveCatalogMode', () => {
    it('returns true if product catalog mode is enabled', () => {
      expect(resolveCatalogMode(true, false, false, false)).toBe(true);
    });

    it('returns true if category catalog mode is enabled', () => {
      expect(resolveCatalogMode(false, true, false, false)).toBe(true);
    });

    it('returns true if brand catalog mode is enabled', () => {
      expect(resolveCatalogMode(false, false, true, false)).toBe(true);
    });

    it('returns true if global store catalog mode is enabled', () => {
      expect(resolveCatalogMode(false, false, false, true)).toBe(true);
    });

    it('returns false if no catalog mode flags are active', () => {
      expect(resolveCatalogMode(false, false, false, false)).toBe(false);
    });

    it('handles null or undefined brand values safely', () => {
      expect(resolveCatalogMode(false, false, null, false)).toBe(false);
      expect(resolveCatalogMode(false, false, undefined, false)).toBe(false);
    });
  });

  describe('isProductCatalogMode', () => {
    it('evaluates product, category, and brand catalog mode correctly', () => {
      const productWithCategory = {
        catalogMode: false,
        category: { catalogMode: true },
        brand: { catalogMode: false },
      };
      expect(isProductCatalogMode(productWithCategory, false)).toBe(true);
    });

    it('falls back to global mode if product parameters are false', () => {
      const normalProduct = {
        catalogMode: false,
        category: { catalogMode: false },
        brand: { catalogMode: false },
      };
      expect(isProductCatalogMode(normalProduct, true)).toBe(true);
      expect(isProductCatalogMode(normalProduct, false)).toBe(false);
    });
  });

  describe('sanitizeProductForCatalog', () => {
    it('removes price and wholesalePrice when catalog mode is active', () => {
      const product = {
        id: 'prod-1',
        name: 'Laptop Gamer',
        price: 1500,
        wholesalePrice: 1200,
        catalogMode: true,
        variants: [
          { id: 'v-1', name: '16GB RAM', price: 1500, wholesalePrice: 1200 },
        ],
      };

      const sanitized = sanitizeProductForCatalog(product, false);
      expect(sanitized.price).toBeNull();
      expect(sanitized.wholesalePrice).toBeNull();
      expect(sanitized.variants[0].price).toBeNull();
      expect(sanitized.variants[0].wholesalePrice).toBeNull();
    });

    it('keeps prices intact when catalog mode is inactive', () => {
      const product = {
        id: 'prod-2',
        name: 'Mouse Optico',
        price: 25,
        wholesalePrice: 20,
        catalogMode: false,
        variants: [],
      };

      const sanitized = sanitizeProductForCatalog(product, false);
      expect(sanitized.price).toBe(25);
      expect(sanitized.wholesalePrice).toBe(20);
    });
  });

  describe('sanitizeProductsForCatalog', () => {
    it('sanitizes a list of products according to catalog mode settings', () => {
      const products = [
        { id: 'p1', name: 'Item 1', price: 100, catalogMode: true },
        { id: 'p2', name: 'Item 2', price: 200, catalogMode: false },
      ];

      const sanitized = sanitizeProductsForCatalog(products, false);
      expect(sanitized[0].price).toBeNull();
      expect(sanitized[1].price).toBe(200);
    });
  });
});
