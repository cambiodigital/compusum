import { describe, it, expect } from 'vitest';

import { extractFirstUploadedUrl } from '@/lib/upload-response';

/**
 * Fase 6 — P1: ImageUpload consumía `data.url`, pero el contrato del
 * endpoint (F6A) es `data.uploaded[]`. Este parser es la extracción
 * testeable: fail-closed, jamás devuelve URL vacía, y expone el error del
 * servidor (data.errors[0]) cuando el lote fue rechazado.
 */

const SUCCESS_PAYLOAD = {
  success: true,
  data: {
    uploaded: [
      {
        originalName: 'foto.png',
        fileName: 'foto-5ef7a214-8c3d-4c6a-9d1e-2b6f0d3a7c11.png',
        url: '/uploads/foto-5ef7a214-8c3d-4c6a-9d1e-2b6f0d3a7c11.png',
        autoAssigned: false,
        matchedSku: null,
        productId: null,
      },
    ],
    errors: [],
    total: 1,
    uploadedCount: 1,
    autoAssignedCount: 0,
  },
};

describe('extractFirstUploadedUrl — contrato data.uploaded[]', () => {
  it('respuesta exitosa con uploaded[0].url => ok con esa URL', () => {
    const result = extractFirstUploadedUrl(SUCCESS_PAYLOAD);
    expect(result).toEqual({ ok: true, url: '/uploads/foto-5ef7a214-8c3d-4c6a-9d1e-2b6f0d3a7c11.png' });
  });

  it('uploaded=[] con errors => error que expone la causa del rechazo', () => {
    const result = extractFirstUploadedUrl({
      success: true,
      data: { uploaded: [], errors: ['malo.png: el contenido no es una imagen válida'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No se pudo subir la imagen');
      expect(result.error).toContain('malo.png');
    }
  });

  it('uploaded=[] sin errors => error genérico sin URL', () => {
    const result = extractFirstUploadedUrl({ success: true, data: { uploaded: [], errors: [] } });
    expect(result).toEqual({ ok: false, error: 'El servidor no devolvió la URL de la imagen subida' });
  });

  it('uploaded[0].url vacío/no-string => error (JAMÁS ok con URL vacía)', () => {
    expect(extractFirstUploadedUrl({ success: true, data: { uploaded: [{ url: '' }], errors: [] } }).ok).toBe(false);
    expect(extractFirstUploadedUrl({ success: true, data: { uploaded: [{ url: null }], errors: [] } }).ok).toBe(false);
    expect(extractFirstUploadedUrl({ success: true, data: { uploaded: [{}], errors: [] } }).ok).toBe(false);
  });

  it('success=false con error del servidor => propaga el mensaje', () => {
    const result = extractFirstUploadedUrl({ success: false, error: 'Error al subir archivos' });
    expect(result).toEqual({ ok: false, error: 'Error al subir archivos' });
  });

  it('payload no-objeto / data ausente => error de respuesta inválida', () => {
    expect(extractFirstUploadedUrl(null).ok).toBe(false);
    expect(extractFirstUploadedUrl(undefined).ok).toBe(false);
    expect(extractFirstUploadedUrl('boom').ok).toBe(false);
    expect(extractFirstUploadedUrl({ success: true }).ok).toBe(false);
  });

  it('invariante: nunca existe { ok: true } con url vacía', () => {
    for (const payload of [
      { success: true, data: { uploaded: [{ url: '   ' }] } },
      { success: true, data: {} },
      { success: true, data: { uploaded: 'no-array' } },
    ]) {
      const result = extractFirstUploadedUrl(payload);
      if (result.ok) expect(result.url.length).toBeGreaterThan(0);
      else expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
