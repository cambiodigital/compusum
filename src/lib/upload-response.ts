/**
 * Parser PURO de la respuesta de POST /api/admin/upload (Fase 6).
 *
 * El endpoint devuelve `data.uploaded[]` (contrato F6A); cada item lleva la
 * URL pública `/uploads/<filename>`. Este módulo encapsula la extracción de
 * la primera URL válida para que el consumidor (ImageUpload) no interprete
 * la respuesta inline y la lógica sea testeable sin renderizar el componente.
 *
 * Reglas (fail-closed):
 *  - `success !== true` => error (mensaje del servidor si existe).
 *  - `data.uploaded` ausente o vacío => error, exponiendo `data.errors[0]`
 *    cuando exista para no ocultar la causa del rechazo.
 *  - `uploaded[0].url` ausente, no-string o vacío => error.
 *  - Nunca devuelve `ok: true` sin URL: el llamador jamás debe ejecutar
 *    onChange("")/onChange(undefined) ante una respuesta "exitosa" sin URL.
 */

export type UploadUrlExtraction =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function extractFirstUploadedUrl(payload: unknown): UploadUrlExtraction {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Respuesta inválida del servidor al subir imagen" };
  }

  const body = payload as { success?: unknown; error?: unknown; data?: unknown };

  if (body.success !== true) {
    const message =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : "Error al subir imagen";
    return { ok: false, error: message };
  }

  const data = (body.data ?? {}) as { uploaded?: unknown; errors?: unknown };
  const uploaded = Array.isArray(data.uploaded) ? data.uploaded : [];
  const errors = Array.isArray(data.errors)
    ? data.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  const first = uploaded[0] as { url?: unknown } | undefined;
  const url = typeof first?.url === "string" ? first.url.trim() : "";

  if (!url) {
    if (errors.length > 0) {
      return { ok: false, error: `No se pudo subir la imagen: ${errors[0]}` };
    }
    return { ok: false, error: "El servidor no devolvió la URL de la imagen subida" };
  }

  return { ok: true, url };
}
