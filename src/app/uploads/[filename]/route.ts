import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getUploadsDirectory } from "@/lib/media-storage";

/**
 * Fase 7 — serving dinámico de /uploads/<filename>.
 *
 * POR QUÉ EXISTE: Next indexa `public/` sólo al arranque del proceso. Un
 * archivo subido DESPUÉS de iniciar el servidor (el caso normal en
 * producción: volumen /app/public/uploads montado) recibía 404 hasta un
 * reinicio del contenedor. Este handler sirve el archivo directamente desde
 * el directorio canónico de media-storage, sin depender del índice estático.
 *
 * Next sigue sirviendo los archivos que ya conocía al arranque (misma
 * carpeta, mismo contenido), así que no hay conflicto: los archivos
 * preexistentes las resuelve el static handler y los nuevos este handler.
 *
 * Seguridad: sólo nombres planos [A-Za-z0-9._-] (sin traversal, sin
 * subdirectorios), allowlist de extensiones de imagen (misma política MIME
 * que el upload F6B1) y content-type fijo por extensión.
 */

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  if (!FILENAME_PATTERN.test(filename) || filename.includes("..")) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const contentType = EXT_MIME[extension];
  if (!contentType) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const filePath = join(getUploadsDirectory(), filename);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    }
    const data = await readFile(filePath);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(fileStat.size),
        // Los nombres incluyen UUID: el contenido de un nombre dado es inmutable.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
}
