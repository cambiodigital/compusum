import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import {
  updateCustomerAccount,
  deleteCustomerAccount,
  CustomerAdminError,
} from "@/lib/customers-admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/admin/customers/[id] - detalle del cliente + actividad
// AGENT: solo clientes con assignedAgentId = self (404 idéntico si no es
// propio, sin filtrar existencia).
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;
    const agent = isAgentRole(user!.role);

    const customer = await db.user.findFirst({
      where: {
        id,
        role: "CUSTOMER",
        ...(agent ? { assignedAgentId: user!.id } : {}),
      },
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
      },
    });

    if (!customer) {
      return NextResponse.json(
        { success: false, error: "Cliente no encontrado" },
        { status: 404 }
      );
    }

    const [orders, carts, aggregates] = await Promise.all([
      db.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          subtotal: true,
          createdAt: true,
          items: { select: { id: true, productName: true, quantity: true, unitPrice: true } },
        },
      }),
      db.cart.findMany({
        where: { userId: id, status: "activo" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, uuid: true, subtotal: true, updatedAt: true, _count: { select: { items: true } } },
      }),
      db.order.aggregate({
        where: { customerId: id },
        _count: { _all: true },
        _sum: { subtotal: true },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        customer,
        orders,
        carts,
        stats: { orderCount: aggregates._count._all, totalSpent: aggregates._sum.subtotal ?? 0 },
      },
    });
  } catch (err) {
    console.error("Error fetching customer:", err);
    return NextResponse.json(
      { success: false, error: "Error al obtener el cliente" },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/customers/[id] - editar cliente / asesor / perfil / activo
// AGENT: solo clientes propios (404 si no) y SOLO datos comerciales seguros;
// assignedAgentId, priceProfileId, password, isActive, role, etc. jamás se
// aplican. admin/editor sin cambios.
const AGENT_EDITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "taxId",
  "address",
  "city",
  "notes",
] as const;

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();

    if (isAgentRole(user!.role)) {
      const own = await db.user.findFirst({
        where: { id, role: "CUSTOMER", assignedAgentId: user!.id },
        select: { id: true },
      });
      if (!own) {
        return NextResponse.json(
          { success: false, error: "Cliente no encontrado" },
          { status: 404 }
        );
      }
      const scopedBody: Record<string, unknown> = {};
      for (const field of AGENT_EDITABLE_FIELDS) {
        if (body[field] !== undefined) scopedBody[field] = body[field];
      }
      const customer = await updateCustomerAccount(id, scopedBody);
      return NextResponse.json({
        success: true,
        data: customer,
        message: "Cliente actualizado exitosamente",
      });
    }

    const customer = await updateCustomerAccount(id, body);

    return NextResponse.json({
      success: true,
      data: customer,
      message: "Cliente actualizado exitosamente",
    });
  } catch (err) {
    if (err instanceof CustomerAdminError) {
      const status =
        err.code === "NOT_FOUND" ? 404 : err.code === "ACCOUNT_EXISTS" ? 409 : 400;
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status }
      );
    }
    console.error("Error updating customer:", err);
    return NextResponse.json(
      { success: false, error: "Error al actualizar el cliente" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/customers/[id] - solo clientes sin pedidos
// Capacidad global-admin: el AGENT recibe 403 en clientes propios y 404 en
// los ajenos (sin filtrar existencia). admin/editor sin cambios.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    if (isAgentRole(user!.role)) {
      const own = await db.user.findFirst({
        where: { id, role: "CUSTOMER", assignedAgentId: user!.id },
        select: { id: true },
      });
      if (!own) {
        return NextResponse.json(
          { success: false, error: "Cliente no encontrado" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: "Acceso denegado: se requiere rol administrativo",
          code: "FORBIDDEN",
        },
        { status: 403 }
      );
    }

    await deleteCustomerAccount(id);

    return NextResponse.json({ success: true, message: "Cliente eliminado" });
  } catch (err) {
    if (err instanceof CustomerAdminError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "HAS_ORDERS" ? 409 : 400;
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status }
      );
    }
    console.error("Error deleting customer:", err);
    return NextResponse.json(
      { success: false, error: "Error al eliminar el cliente" },
      { status: 500 }
    );
  }
}
