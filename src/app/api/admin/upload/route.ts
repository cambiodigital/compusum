import { NextResponse } from "next/server";
import { writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { requireAdminApi } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectImageFormat, isAllowedImageMime } from "@/lib/media-validation";
import { getUploadPublicUrl, getUploadsDirectory } from "@/lib/media-storage";
import { normalizeProductImagePath } from "@/lib/product-fallbacks";

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function normalizeSkuCandidate(value: string): string {
  return value.trim().toLowerCase();
}

function buildSkuCandidates(fileName: string): string[] {
  const trimmed = fileName.trim();
  if (!trimmed) return [];

  const dotIndex = trimmed.lastIndexOf(".");
  const withoutExt = dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;

  const candidates = new Set<string>();
  candidates.add(normalizeSkuCandidate(trimmed));
  candidates.add(normalizeSkuCandidate(withoutExt));

  return [...candidates].filter(Boolean);
}

function sanitizeBaseName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "img";
}

/**
 * F6B1 — Compensación archivo → DB.
 *
 * Elimina EXCLUSIVAMENTE el archivo que esta iteración acaba de crear.
 * El path se construye únicamente desde `getUploadsDirectory()` + el
 * filename generado internamente (base saneado + UUID + extensión del
 * detector); NUNCA desde datos del navegador, y jamás toca archivos
 * preexistentes ni URLs históricas de otros registros.
 */
async function compensateFailedUpload(fileName: string): Promise<void> {
  const fullPath = join(getUploadsDirectory(), fileName);
  try {
    await unlink(fullPath);
  } catch (cleanupError) {
    // ENOENT: el archivo ya no existe, la compensación ya está satisfecha.
    if ((cleanupError as NodeJS.ErrnoException)?.code === "ENOENT") return;
    // Un fallo de limpieza no oculta el error principal: se registra y el
    // original sigue propagándose.
    console.error(`Upload cleanup falló para ${fileName}:`, cleanupError);
  }
}

async function findProductBySkuCandidates(candidates: string[]) {
  if (candidates.length === 0) return null;

  const or = candidates.map((sku) => ({ sku: { equals: sku, mode: "insensitive" as const } }));
  return db.product.findFirst({
    where: { OR: or },
    select: { id: true, sku: true },
  });
}

async function assignImageToProduct(productId: string, imagePath: string) {
  const normalizedPath = normalizeProductImagePath(imagePath);
  if (!normalizedPath) return;

  const hasAnyImage = await db.productImage.count({ where: { productId } });
  await db.productImage.create({
    data: {
      productId,
      imagePath: normalizedPath,
      isPrimary: hasAnyImage === 0,
      sortOrder: hasAnyImage,
    },
  });
}

export async function GET() {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const uploadsDir = getUploadsDirectory();
    await mkdir(uploadsDir, { recursive: true });

    const files = await readdir(uploadsDir);
    const entries = await Promise.all(
      files.map(async (name) => {
        const fullPath = join(uploadsDir, name);
        const info = await stat(fullPath);
        return {
          name,
          url: getUploadPublicUrl(name),
          modifiedAt: info.mtime.toISOString(),
          size: info.size,
        };
      })
    );

    entries.sort((a, b) => +new Date(b.modifiedAt) - +new Date(a.modifiedAt));

    return NextResponse.json({ success: true, data: { files: entries.slice(0, 500) } });
  } catch (error) {
    console.error("Upload list error:", error);
    return NextResponse.json({ success: false, error: "Error al listar archivos" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const formData = await request.formData();
    const files = formData.getAll("files").filter((f): f is File => f instanceof File);
    const singleFile = formData.get("file");
    if (singleFile instanceof File) {
      files.push(singleFile);
    }

    const autoAssignBySku = formData.get("autoAssignBySku") === "true";

    if (files.length === 0) {
      return NextResponse.json({ success: false, error: "No se recibieron archivos" }, { status: 400 });
    }

    const uploadsDir = getUploadsDirectory();
    await mkdir(uploadsDir, { recursive: true });

    const uploaded: Array<{
      originalName: string;
      fileName: string;
      url: string;
      autoAssigned: boolean;
      matchedSku: string | null;
      productId: string | null;
    }> = [];
    const errors: string[] = [];

    for (const file of files) {
      // F6B1 — política MIME: el MIME declarado sigue siendo el primer filtro
      // de la allowlist (JPEG/PNG/WebP/GIF). Un tipo vacío/desconocido se
      // rechaza aunque el contenido sea una imagen válida: sin declaración
      // no hay coincidencia que verificar, y aceptar por magic bytes a
      // ciegas permitiría contrabandar contenido sin segundo factor.
      if (!isAllowedImageMime(file.type)) {
        errors.push(`${file.name}: tipo no permitido`);
        continue;
      }
      // Tamaño ANTES de leer bytes o escribir nada.
      if (file.size > MAX_SIZE) {
        errors.push(`${file.name}: supera 5MB`);
        continue;
      }

      // F6B1 — autoridad = contenido. El formato real se identifica por
      // magic bytes antes de cualquier write; File.type NO es confianza.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const detected = detectImageFormat(bytes);
      if (!detected) {
        errors.push(`${file.name}: el contenido no es una imagen válida`);
        continue;
      }
      // Mismatch declarado vs detectado se RECHAZA: no se corrige en
      // silencio (ni se renombra ni se acepta "por dentro").
      if (detected.mime !== file.type) {
        errors.push(`${file.name}: el contenido no coincide con el tipo declarado`);
        continue;
      }

      // La extensión persistida proviene del formato DETECTADO, no del MIME
      // declarado ni de la extensión original del filename. El nombre base
      // sigue saneándose y el UUID garantiza unicidad/ausencia de traversal.
      const base = sanitizeBaseName(file.name);
      const fileName = `${base}-${uuidv4()}.${detected.extension}`;
      const relativeUrl = getUploadPublicUrl(fileName);

      // Un fallo de writeFile se propaga tal cual (contrato del endpoint:
      // 500). No se ejecuta DB ni compensación: no hay archivo confirmado
      // que limpiar y unlink ciego podría borrar un path ajeno.
      await writeFile(join(uploadsDir, fileName), Buffer.from(bytes));

      let autoAssigned = false;
      let matchedSku: string | null = null;
      let productId: string | null = null;

      if (autoAssignBySku) {
        try {
          const candidates = buildSkuCandidates(file.name);
          const product = await findProductBySkuCandidates(candidates);
          if (product) {
            await assignImageToProduct(product.id, relativeUrl);
            autoAssigned = true;
            matchedSku = product.sku;
            productId = product.id;
          }
        } catch (dbError) {
          // F6B1 — compensación: el archivo ya está en disco pero la
          // asignación DB falló. Se desvincula únicamente el archivo que
          // esta iteración acaba de crear (nombre generado internamente,
          // aún no expuesto en ninguna respuesta ni registro) para no
          // dejar huérfanos. Los archivos exitosos de iteraciones
          // anteriores permanecen intactos.
          await compensateFailedUpload(fileName);
          throw dbError;
        }
      }

      uploaded.push({
        originalName: file.name,
        fileName,
        url: relativeUrl,
        autoAssigned,
        matchedSku,
        productId,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        uploaded,
        errors,
        total: files.length,
        uploadedCount: uploaded.length,
        autoAssignedCount: uploaded.filter((f) => f.autoAssigned).length,
      },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ success: false, error: "Error al subir archivos" }, { status: 500 });
  }
}
