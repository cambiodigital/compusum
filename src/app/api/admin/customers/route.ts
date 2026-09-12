import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import { createCustomerAccount, CustomerAdminError } from "@/lib/customers-admin";

// GET /api/admin/customers?buscar=&page=&limit=&activos=&asesor=&perfil=
// Maestro de clientes: fuente principal `User where role = CUSTOMER`.
// AGENT comercial: SOLO sus clientes (assignedAgentId forzado); admin/editor
// ven el maestro completo.
export async function GET(request: NextRequest) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const agent = isAgentRole(user!.role);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("buscar")?.trim() || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "20")), 100);
    const activos = searchParams.get("activos");
    const asesorId = searchParams.get("asesor");
    const perfilId = searchParams.get("perfil");

    const where: Record<string, unknown> = { role: "CUSTOMER" };
    if (activos === "true") where.isActive = true;
    if (activos === "false") where.isActive = false;
    if (agent) {
      // El alcance del asesor MANDA: el parámetro `asesor` se ignora.
      where.assignedAgentId = user!.id;
    } else if (asesorId) {
      where.assignedAgentId = asesorId;
    }
    if (perfilId) where.priceProfileId = perfilId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { company: { contains: search, mode: "insensitive" } },
        { taxId: { contains: search } },
      ];
    }

    const [customers, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          company: true,
          taxId: true,
          address: true,
          city: true,
          notes: true,
          isActive: true,
          createdAt: true,
          lastLogin: true,
          assignedAgent: { select: { id: true, name: true, email: true } },
          priceProfile: { select: { id: true, name: true, code: true } },
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.user.count({ where }),
    ]);

    // Métricas complementarias de pedidos (agregado por customerId).
    // AGENT: restringidas además a clientes propios (defensa en profundidad).
    const customerIds = customers.map((c) => c.id);
    const orderAggregates = await db.order.groupBy({
      by: ["customerId"],
      where: {
        customerId: { in: customerIds },
        ...(agent ? { customer: { assignedAgentId: user!.id } } : {}),
      },
      _count: { _all: true },
      _sum: { subtotal: true },
    });
    const lastOrders = await db.order.findMany({
      where: { customerId: { in: customerIds } },
      orderBy: { createdAt: "desc" },
      select: { customerId: true, orderNumber: true, createdAt: true },
      distinct: ["customerId"],
    });

    const aggregateByCustomer = new Map(orderAggregates.map((a) => [a.customerId, a]));
    const lastOrderByCustomer = new Map(lastOrders.map((o) => [o.customerId, o]));

    return NextResponse.json({
      success: true,
      data: {
        customers: customers.map((c) => {
          const aggregate = aggregateByCustomer.get(c.id);
          const lastOrder = lastOrderByCustomer.get(c.id);
          return {
            ...c,
            orderCount: aggregate?._count._all ?? 0,
            totalSpent: aggregate?._sum.subtotal ?? 0,
            lastOrder: lastOrder
              ? { orderNumber: lastOrder.orderNumber, createdAt: lastOrder.createdAt }
              : null,
          };
        }),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error("Error listing customers:", err);
    return NextResponse.json(
      { success: false, error: "Error al listar clientes" },
      { status: 500 }
    );
  }
}

// POST /api/admin/customers - crear cliente en el maestro
// AGENT: puede crear clientes pero SIEMPRE asignados a sí mismo y sin
// perfil de precio (capacidad global-admin); admin/editor sin cambios.
export async function POST(request: NextRequest) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const body = await request.json();
    if (isAgentRole(user!.role)) {
      body.assignedAgentId = user!.id;
      body.priceProfileId = null;
    }
    const customer = await createCustomerAccount(body);

    return NextResponse.json(
      { success: true, data: customer, message: "Cliente creado exitosamente" },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof CustomerAdminError) {
      const status = err.code === "ACCOUNT_EXISTS" ? 409 : 400;
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status }
      );
    }
    console.error("Error creating customer:", err);
    return NextResponse.json(
      { success: false, error: "Error al crear el cliente" },
      { status: 500 }
    );
  }
}
