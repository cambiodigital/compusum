import { describe, it, expect } from 'vitest';

/**
 * F6B1 — detector de formato real por magic bytes (src/lib/media-validation.ts).
 *
 * El contenido, no `File.type`, es la autoridad del formato. Estos tests
 * fijan las cuatro firmas permitidas (JPEG, PNG, GIF87a/GIF89a, WebP) y los
 * rechazos obligatorios: buffers vacíos/truncados, HTML, SVG y contenido
 * aleatorio disfrazado con cualquier MIME.
 */

import { detectImageFormat, isAllowedImageMime } from '@/lib/media-validation';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_JFIF = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];

function bytesFrom(signature: number[], padding = 16): Uint8Array {
  const bytes = new Uint8Array(signature.length + padding);
  bytes.set(signature, 0);
  return bytes;
}

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

describe('detectImageFormat — firmas válidas (allowlist F6B1)', () => {
  it('JPEG válido (prefijo FF D8 FF, variante JFIF) => image/jpeg + jpg', () => {
    expect(detectImageFormat(bytesFrom(JPEG_JFIF))).toEqual({
      mime: 'image/jpeg',
      extension: 'jpg',
    });
  });

  it('JPEG mínimo de 3 bytes FF D8 FF (Exif/unknown app marker) => image/jpeg', () => {
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8, 0xff]))).toEqual({
      mime: 'image/jpeg',
      extension: 'jpg',
    });
  });

  it('PNG válido (firma completa de 8 bytes) => image/png + png', () => {
    const png = bytesFrom(PNG_SIGNATURE);
    // Ihdr + datos: la detección no depende del payload posterior.
    png.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    expect(detectImageFormat(png)).toEqual({ mime: 'image/png', extension: 'png' });
  });

  it('GIF87a => image/gif + gif', () => {
    expect(detectImageFormat(asciiBytes('GIF87a\x01\x00\x01\x00'))).toEqual({
      mime: 'image/gif',
      extension: 'gif',
    });
  });

  it('GIF89a => image/gif + gif', () => {
    expect(detectImageFormat(asciiBytes('GIF89a\x01\x00\x01\x00'))).toEqual({
      mime: 'image/gif',
      extension: 'gif',
    });
  });

  it('WebP válido (RIFF....WEBP) => image/webp + webp', () => {
    // "RIFF" + tamaño little-endian + "WEBP" + chunk VP8.
    const webp = asciiBytes('RIFF');
    const full = new Uint8Array([...webp, 0x24, 0x00, 0x00, 0x00, ...asciiBytes('WEBP'), ...asciiBytes('VP8 ')]);
    expect(detectImageFormat(full)).toEqual({ mime: 'image/webp', extension: 'webp' });
  });
});

describe('detectImageFormat — rechazos obligatorios', () => {
  it('buffer vacío => null', () => {
    expect(detectImageFormat(new Uint8Array(0))).toBeNull();
  });

  it('buffers demasiado cortos para cada firma => null', () => {
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8]))).toBeNull(); // JPEG truncado
    expect(detectImageFormat(Uint8Array.from(PNG_SIGNATURE.slice(0, 7)))).toBeNull(); // PNG 7/8
    expect(detectImageFormat(asciiBytes('GIF89'))).toBeNull(); // GIF 5/6
    expect(detectImageFormat(asciiBytes('RIFF\x00\x00\x00WEB'))).toBeNull(); // WebP sin bytes 8-11
    expect(detectImageFormat(asciiBytes('RIFF'))).toBeNull(); // solo contenedor
  });

  it('HTML disfrazado => null', () => {
    const html = asciiBytes('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
    expect(detectImageFormat(html)).toBeNull();
  });

  it('SVG disfrazado => null (SVG continúa prohibido)', () => {
    const svg = asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
    expect(detectImageFormat(svg)).toBeNull();
  });

  it('contenido aleatorio => null', () => {
    const random = new Uint8Array(64);
    for (let i = 0; i < random.length; i += 1) {
      random[i] = (i * 37 + 11) % 256;
    }
    expect(detectImageFormat(random)).toBeNull();
  });

  it('ejecutable Windows (MZ) => null', () => {
    expect(detectImageFormat(asciiBytes('MZ\x90\x00\x03\x00\x00\x00'))).toBeNull();
  });

  it('GIF inválido (GIF88a) => null', () => {
    expect(detectImageFormat(asciiBytes('GIF88a\x01\x00'))).toBeNull();
  });
});

describe('isAllowedImageMime — allowlist declarada (sin cambios desde F6A)', () => {
  it('acepta exclusivamente jpeg/png/webp/gif', () => {
    expect(isAllowedImageMime('image/jpeg')).toBe(true);
    expect(isAllowedImageMime('image/png')).toBe(true);
    expect(isAllowedImageMime('image/webp')).toBe(true);
    expect(isAllowedImageMime('image/gif')).toBe(true);
  });

  it('rechaza svg, tipos vacíos y desconocidos', () => {
    expect(isAllowedImageMime('image/svg+xml')).toBe(false);
    expect(isAllowedImageMime('')).toBe(false);
    expect(isAllowedImageMime('application/octet-stream')).toBe(false);
    expect(isAllowedImageMime('text/html')).toBe(false);
    expect(isAllowedImageMime('image/jpg')).toBe(false); // no estándar: fuera de allowlist
  });
});
