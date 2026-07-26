import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status");
    const search = searchParams.get("search");

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        { customerCompany: { contains: search, mode: "insensitive" } },
        { uuid: { contains: search } },
      ];
    }

    const [carts, total] = await Promise.all([
      db.cart.findMany({
        where,
        include: {
          items: { include: { product: { select: { name: true } } } },
          city: { include: { department: true } },
          _count: { select: { items: true, orders: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.cart.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: carts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error fetching carts:", error);
    return NextResponse.json({ success: false, error: "Error al obtener carritos" }, { status: 500 });
  }
}
