import { NextResponse } from "next/server";
import { writeFile, mkdir, readdir, stat } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { requireAdminApi } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeProductImagePath } from "@/lib/product-fallbacks";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
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

function extensionForFile(file: File): string {
  const byType = file.type.split("/")[1]?.replace("jpeg", "jpg") || "";
  if (byType) return byType;

  const original = file.name || "";
  const dotIndex = original.lastIndexOf(".");
  if (dotIndex > 0) return original.slice(dotIndex + 1).toLowerCase();
  return "jpg";
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

    const uploadsDir = join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const files = await readdir(uploadsDir);
    const entries = await Promise.all(
      files.map(async (name) => {
        const fullPath = join(uploadsDir, name);
        const info = await stat(fullPath);
        return {
          name,
          url: `/uploads/${name}`,
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

    const uploadsDir = join(process.cwd(), "public", "uploads");
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
      if (!ALLOWED_TYPES.includes(file.type)) {
        errors.push(`${file.name}: tipo no permitido`);
        continue;
      }
      if (file.size > MAX_SIZE) {
        errors.push(`${file.name}: supera 5MB`);
        continue;
      }

      const ext = extensionForFile(file);
      const base = sanitizeBaseName(file.name);
      const fileName = `${base}-${uuidv4()}.${ext}`;
      const relativeUrl = `/uploads/${fileName}`;

      const bytes = await file.arrayBuffer();
      await writeFile(join(uploadsDir, fileName), Buffer.from(bytes));

      let autoAssigned = false;
      let matchedSku: string | null = null;
      let productId: string | null = null;

      if (autoAssignBySku) {
        const candidates = buildSkuCandidates(file.name);
        const product = await findProductBySkuCandidates(candidates);
        if (product) {
          await assignImageToProduct(product.id, relativeUrl);
          autoAssigned = true;
          matchedSku = product.sku;
          productId = product.id;
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
