import { redirect } from "next/navigation";
import { requireBackofficeUser, isAgentRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Users,
  Mail,
  Phone,
  Building2,
  Calendar,
  ShoppingBag,
  UserCheck,
  Tag,
} from "lucide-react";
import { formatPrice } from "@/lib/format";
import { CreateCustomerButton } from "@/components/admin/customer-form-dialog";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ buscar?: string; page?: string; activos?: string }>;
}

/**
 * MAESTRO DE CLIENTES: fuente principal `User where role = CUSTOMER`
 * (no agrupación de pedidos). Los pedidos históricos se usan solo como
 * métricas complementarias. El AGENT comercial SOLO ve sus clientes
 * (assignedAgentId = self).
 */
export default async function AdminClientesPage({ searchParams }: Props) {
  const user = await requireBackofficeUser();
  if (!user) redirect("/admin/login");

  const isAgent = isAgentRole(user.role);
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1"));
  const limit = 20;
  const search = params.buscar?.trim() || "";
  const activos = params.activos;

  const where: Record<string, unknown> = { role: "CUSTOMER" };
  if (isAgent) where.assignedAgentId = user.id;
  if (activos === "true") where.isActive = true;
  if (activos === "false") where.isActive = false;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" as const } },
      { email: { contains: search, mode: "insensitive" as const } },
      { phone: { contains: search } },
      { company: { contains: search, mode: "insensitive" as const } },
      { taxId: { contains: search } },
    ];
  }

  const countWhere: Record<string, unknown> = { role: "CUSTOMER" };
  if (isAgent) countWhere.assignedAgentId = user.id;

  const [customers, total, totalCustomers] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        company: true,
        taxId: true,
        isActive: true,
        createdAt: true,
        assignedAgent: { select: { id: true, name: true } },
        priceProfile: { select: { id: true, name: true, code: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.user.count({ where }),
    db.user.count({ where: countWhere }),
  ]);

  // Métricas complementarias por pedidos (para los clientes de la página
  // actual). AGENT: scoped también al propio maestro de clientes.
  const customerIds = customers.map((c) => c.id);
  const orderAggregates = customerIds.length
    ? await db.order.groupBy({
        by: ["customerId"],
        where: {
          customerId: { in: customerIds },
          ...(isAgent ? { customer: { assignedAgentId: user.id } } : {}),
        },
        _sum: { subtotal: true },
      })
    : [];
  const spentByCustomer = new Map(
    orderAggregates.map((a) => [a.customerId, a._sum.subtotal ?? 0])
  );

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <Header
        title="Clientes"
        subtitle={
          isAgent
            ? `${totalCustomers} clientes asignados`
            : `${totalCustomers} clientes en el maestro`
        }
      />

      {/* Search + actions */}
      <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center gap-2">
        <form method="get" className="flex gap-2 max-w-sm flex-1">
          <input
            type="text"
            name="buscar"
            defaultValue={search}
            placeholder="Buscar por nombre, email, teléfono, NIT..."
            className="flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
          />
          <Button type="submit" size="sm" className="bg-blue-600 hover:bg-blue-700">
            Buscar
          </Button>
          {search && (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/clientes">Limpiar</Link>
            </Button>
          )}
        </form>
        <div className="flex gap-2 ml-auto">
          <Button asChild variant={activos !== "false" ? "outline" : "secondary"} size="sm">
            <Link href="/admin/clientes?activos=true">Activos</Link>
          </Button>
          <Button asChild variant={activos === "false" ? "secondary" : "outline"} size="sm">
            <Link href="/admin/clientes?activos=false">Inactivos</Link>
          </Button>
          {!isAgent && (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/perfiles-precio">
                <Tag className="h-4 w-4 mr-1" /> Perfiles de precio
              </Link>
            </Button>
          )}
          <CreateCustomerButton agentView={isAgent} />
        </div>
      </div>

      {/* Stats */}
      <div className="px-6 py-4 border-b border-slate-200">
        <div className="flex gap-6 text-sm text-slate-600">
          <span className="flex items-center gap-1.5">
            <Users className="h-4 w-4 text-blue-500" />
            <strong>{totalCustomers}</strong> clientes registrados
          </span>
          <span className="flex items-center gap-1.5">
            <ShoppingBag className="h-4 w-4 text-green-500" />
            <strong>{total}</strong> resultados
          </span>
        </div>
      </div>

      {/* Customers List */}
      <div className="p-6">
        {customers.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Users className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="font-medium">No se encontraron clientes</p>
            {search && <p className="text-sm mt-1">Intenta con otro término de búsqueda</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {customers.map((customer) => (
              <Link key={customer.id} href={`/admin/clientes/${customer.id}`} className="block">
                <Card className="hover:border-blue-200 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-slate-900">{customer.name}</h3>
                          {customer.company && (
                            <Badge variant="outline" className="text-xs">
                              <Building2 className="h-3 w-3 mr-1" />
                              {customer.company}
                            </Badge>
                          )}
                          {!customer.isActive && (
                            <Badge variant="destructive" className="text-xs">
                              Inactivo
                            </Badge>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-sm text-slate-500">
                          {customer.email && (
                            <span className="flex items-center gap-1">
                              <Mail className="h-3.5 w-3.5" />
                              {customer.email}
                            </span>
                          )}
                          {customer.phone && (
                            <span className="flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5" />
                              {customer.phone}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            Registro: {customer.createdAt.toLocaleDateString("es-CO")}
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-slate-500">
                          {customer.assignedAgent && (
                            <span className="flex items-center gap-1">
                              <UserCheck className="h-3.5 w-3.5" />
                              Asesor: {customer.assignedAgent.name}
                            </span>
                          )}
                          {customer.priceProfile && (
                            <span className="flex items-center gap-1">
                              <Tag className="h-3.5 w-3.5" />
                              Perfil: {customer.priceProfile.name} ({customer.priceProfile.code})
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-blue-600">
                          {formatPrice(spentByCustomer.get(customer.id) ?? 0)}
                        </p>
                        <p className="text-xs text-slate-500">
                          {customer._count.orders}{" "}
                          {customer._count.orders === 1 ? "pedido" : "pedidos"}
                        </p>
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="mt-1 h-7 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-2"
                        >
                          <span>Ver detalle</span>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6">
            <p className="text-sm text-slate-500">
              Página {page} de {totalPages}
            </p>
            <div className="flex gap-2">
              {page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/admin/clientes?page=${page - 1}${
                      search ? `&buscar=${encodeURIComponent(search)}` : ""
                    }${activos ? `&activos=${activos}` : ""}`}
                  >
                    Anterior
                  </Link>
                </Button>
              )}
              {page < totalPages && (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/admin/clientes?page=${page + 1}${
                      search ? `&buscar=${encodeURIComponent(search)}` : ""
                    }${activos ? `&activos=${activos}` : ""}`}
                  >
                    Siguiente
                  </Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
