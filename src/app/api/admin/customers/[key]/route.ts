import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { db } from "@/lib/db";

function buildWhereClause(key: string) {
  if (key.includes("@")) {
    return { customerEmail: { equals: key, mode: "insensitive" as const } };
  }
  if (key.startsWith("+") || /^\d+$/.test(key)) {
    return { customerPhone: key };
  }
  // nocontact-{name} or plain name fallback
  const name = key.startsWith("nocontact-") ? key.slice("nocontact-".length) : key;
  return { customerName: name };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { error } = await requireAdminApi();
  if (error) return error;

  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const where = buildWhereClause(key);

  const [orders, carts] = await Promise.all([
    db.order.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
    db.cart.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (orders.length === 0 && carts.length === 0) {
    return NextResponse.json({ success: false, error: "Cliente no encontrado" }, { status: 404 });
  }

  const latest = orders[0] ?? carts[0];
  const customer = {
    key,
    name: latest?.customerName ?? null,
    email: latest?.customerEmail ?? null,
    phone: latest?.customerPhone ?? null,
    company: latest?.customerCompany ?? null,
  };

  return NextResponse.json({ success: true, data: { customer, orders, carts } });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { error } = await requireAdminApi();
  if (error) return error;

  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const where = buildWhereClause(key);

  const body = await req.json();
  const { customerName, customerEmail, customerPhone, customerCompany } = body;

  const updateData: Record<string, string | null> = {};
  if (customerName !== undefined) updateData.customerName = customerName || null;
  if (customerEmail !== undefined) updateData.customerEmail = customerEmail || null;
  if (customerPhone !== undefined) updateData.customerPhone = customerPhone || null;
  if (customerCompany !== undefined) updateData.customerCompany = customerCompany || null;

  await Promise.all([
    db.order.updateMany({ where, data: updateData }),
    db.cart.updateMany({ where, data: updateData }),
  ]);

  // Calculate new key
  const newKey =
    (customerEmail && customerEmail.toLowerCase()) ||
    customerPhone ||
    `nocontact-${customerName || "unknown"}`;

  return NextResponse.json({ success: true, data: { newKey } });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { error } = await requireAdminApi();
  if (error) return error;

  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const where = buildWhereClause(key);

  const anonymizeData = {
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    customerCompany: null,
  };

  await Promise.all([
    db.order.updateMany({ where, data: anonymizeData }),
    db.cart.updateMany({ where, data: anonymizeData }),
  ]);

  return NextResponse.json({ success: true });
}
