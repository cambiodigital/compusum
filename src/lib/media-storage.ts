import { join } from "node:path";

/**
 * F6A — Contrato de almacenamiento multimedia durable.
 *
 * Única fuente de verdad del par (path físico, URL pública) de los uploads:
 *
 *   URL pública:  /uploads/<filename>
 *   Path runtime: <cwd>/public/uploads/<filename>  (en el contenedor Docker: /app/public/uploads)
 *
 * La durabilidad en producción NO proviene de este módulo sino de montar un
 * volumen persistente exactamente en /app/public/uploads (ver
 * docs/media-storage.md para el runbook de activación, backup y rollback).
 *
 * Deliberadamente NO configurable por entorno: desviar el path rompería el
 * serving de /uploads/* que hace Next desde public/, y no existe capa de
 * serving alternativa. Si F6B+ introduce object storage, el cambio se hará
 * aquí y en la capa de serving, nunca vía env en silencio.
 */

/** Directorio físico de uploads: siempre `<cwd>/public/uploads`. */
export function getUploadsDirectory(): string {
  return join(process.cwd(), "public", "uploads");
}

/** URL pública canónica de un archivo subido: siempre `/uploads/<filename>`. */
export function getUploadPublicUrl(filename: string): string {
  return `/uploads/${filename}`;
}
