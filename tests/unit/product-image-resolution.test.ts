import { describe, it, expect } from 'vitest';

import {
  resolveProductImageList,
  resolveProductImageSrc,
} from '@/lib/product-fallbacks';

/**
 * Fase 6 — RESOLUCIÓN REAL de imágenes de producto en el storefront.
 *
 * Antes: resolveProductImageSrc(slug, size) devolvía SIEMPRE "" y todas las
 * superficies vivían de placeholders aunque ProductImage existiera.
 * Ahora: prioridad primaria => primera por sortOrder => fallback ("").
 * No se inventan imágenes desde el slug; data:/blob:/bloqueadas => fallback.
 */

const IMG_A = '/uploads/producto-a.png';
const IMG_B = '/uploads/producto-b.png';
const IMG_C = '/uploads/producto-c.png';

describe('resolveProductImageSrc — prioridad de imágenes', () => {
  it('producto con imagen PRIMARIA => muestra /uploads/...', () => {
    const src = resolveProductImageSrc({
      images: [
        { imagePath: IMG_B, isPrimary: false, sortOrder: 0 },
        { imagePath: IMG_A, isPrimary: true, sortOrder: 1 },
      ],
    });
    expect(src).toBe(IMG_A);
  });

  it('sin primaria => primera por sortOrder', () => {
    const src = resolveProductImageSrc({
      images: [
        { imagePath: IMG_C, isPrimary: false, sortOrder: 1 },
        { imagePath: IMG_B, isPrimary: false, sortOrder: 0 },
      ],
    });
    expect(src).toBe(IMG_B);
  });

  it('sin sortOrder explícito => conserva el orden de la lista', () => {
    expect(resolveProductImageSrc({ images: [{ imagePath: IMG_C }, { imagePath: IMG_A }] })).toBe(IMG_C);
  });

  it('sin imágenes => fallback existente ("")', () => {
    expect(resolveProductImageSrc({ images: [] })).toBe('');
    expect(resolveProductImageSrc({ images: null })).toBe('');
    expect(resolveProductImageSrc({})).toBe('');
    expect(resolveProductImageSrc(null)).toBe('');
    expect(resolveProductImageSrc(undefined)).toBe('');
  });

  it('URL bloqueada (unsplash) => fallback', () => {
    expect(
      resolveProductImageSrc({ images: [{ imagePath: 'https://images.unsplash.com/foto.jpg', isPrimary: true }] })
    ).toBe('');
  });

  it('URL inválida data:/blob: => fallback', () => {
    expect(resolveProductImageSrc({ images: [{ imagePath: 'data:image/png;base64,AAAA', isPrimary: true }] })).toBe('');
    expect(resolveProductImageSrc({ image: 'blob:https://app/x' })).toBe('');
  });

  it('primaria inválida pero segunda válida => usa la válida (no se rinde con la lista)', () => {
    const src = resolveProductImageSrc({
      images: [
        { imagePath: 'https://images.unsplash.com/x.jpg', isPrimary: true, sortOrder: 0 },
        { imagePath: IMG_B, isPrimary: false, sortOrder: 1 },
      ],
    });
    expect(src).toBe(IMG_B);
  });

  it('forma plana primaryImage (/api/products) => resuelve', () => {
    expect(resolveProductImageSrc({ primaryImage: IMG_A })).toBe(IMG_A);
    expect(resolveProductImageSrc({ primaryImage: null, images: null })).toBe('');
  });

  it('forma mínima image (CartProduct) => resuelve', () => {
    expect(resolveProductImageSrc({ image: IMG_A })).toBe(IMG_A);
    expect(resolveProductImageSrc({ image: '' })).toBe('');
  });

  it('URL externa histórica pasa tal cual (SafeProductImage decide; patrón no permitido => fallback visual)', () => {
    expect(resolveProductImageSrc({ primaryImage: 'https://picsum.photos/foto' })).toBe('https://picsum.photos/foto');
  });

  it('absoluto propio http(s) con path /uploads se normaliza a ruta relativa', () => {
    expect(resolveProductImageSrc({ primaryImage: 'https://app.com/uploads/foto.png' })).toBe('/uploads/foto.png');
  });
});

describe('resolveProductImageList — galería del detalle', () => {
  it('lista ordenada, sin duplicados, limitada', () => {
    const list = resolveProductImageList(
      {
        images: [
          { imagePath: IMG_B, isPrimary: false, sortOrder: 1 },
          { imagePath: IMG_A, isPrimary: true, sortOrder: 0 },
          { imagePath: IMG_B, isPrimary: false, sortOrder: 2 },
          { imagePath: IMG_C, isPrimary: false, sortOrder: 3 },
        ],
      },
      3
    );
    expect(list).toEqual([IMG_A, IMG_B, IMG_C]);
  });

  it('sin imágenes válidas => vacía (no se inventan thumbnails)', () => {
    expect(resolveProductImageList({ images: [{ imagePath: '' }] })).toEqual([]);
    expect(resolveProductImageList(null, 4)).toEqual([]);
  });
});
