import { redirect } from "next/navigation";
import { requireBackofficeUser, isAgentRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/admin/order-status-badge";
import Link from "next/link";
import {
  ClipboardList,
  Eye,
  User,
  Building2,
  Calendar,
  HeadsetIcon,
} from "lucide-react";
import { formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ status?: string; page?: string }>;
}

// PEDIDOS: el AGENT comercial SOLO ve sus pedidos (agentId = self),
// incluidos los contadores por estado.
export default async function AdminPedidosPage({ searchParams }: Props) {
  const user = await requireBackofficeUser();
  if (!user) redirect("/admin/login");

  const isAgent = isAgentRole(user.role);
  const params = await searchParams;
  const page = parseInt(params.page || "1");
  const limit = 20;

  const where: Record<string, unknown> = {};
  if (params.status) where.status = params.status;
  if (isAgent) where.agentId = user.id;

  const [orders, total, stats] = await Promise.all([
    db.order.findMany({
      where,
      include: {
        _count: { select: { items: true } },
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.order.count({ where }),
    db.order.groupBy({
      by: ["status"],
      where: isAgent ? { agentId: user.id } : {},
      _count: { _all: true },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);
  const statusCounts = Object.fromEntries(stats.map((s) => [s.status, s._count._all]));

  return (
    <div>
      <Header title="Pedidos" subtitle={`${total} pedidos`} />

      {/* Stats */}
      <div className="px-6 py-4 border-b border-slate-200">
        <div className="flex gap-4 flex-wrap">
          <Link href="/admin/pedidos">
            <Badge variant={!params.status ? "default" : "outline"} className="cursor-pointer">
              Todos ({total})
            </Badge>
          </Link>
          <Link href="/admin/pedidos?status=solicitado">
            <Badge variant={params.status === "solicitado" ? "default" : "outline"} className="cursor-pointer bg-amber-100 text-amber-700 hover:bg-amber-200">
              Solicitados ({statusCounts.solicitado || 0})
            </Badge>
          </Link>
          <Link href="/admin/pedidos?status=compartido">
            <Badge variant={params.status === "compartido" ? "default" : "outline"} className="cursor-pointer bg-blue-100 text-blue-700 hover:bg-blue-200">
              Compartidos ({statusCounts.compartido || 0})
            </Badge>
          </Link>
          <Link href="/admin/pedidos?status=recibido">
            <Badge variant={params.status === "recibido" ? "default" : "outline"} className="cursor-pointer bg-green-100 text-green-700 hover:bg-green-200">
              Recibidos ({statusCounts.recibido || 0})
            </Badge>
          </Link>
        </div>
      </div>

      {/* Orders list */}
      <div className="p-6">
        {orders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ClipboardList className="h-12 w-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500">No hay pedidos</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {orders.map((order) => (
              <Card key={order.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-mono font-bold text-slate-900">
                          {order.orderNumber}
                        </span>
                        <OrderStatusBadge status={order.status} />
                        {/* Fase 3: distinguir Pedido vs Cotización */}
                        {order.requestType === "cotizacion" && (
                          <Badge variant="outline" className="text-xs text-orange-600 border-orange-200 bg-orange-50">
                            Cotización
                          </Badge>
                        )}
                        {order.webhookSent && (
                          <Badge variant="outline" className="text-xs text-purple-600 border-purple-200">
                            Webhook
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {order.customerName}
                        </span>
                        {order.customerCompany && (
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {order.customerCompany}
                          </span>
                        )}
                        {order.agent?.name && (
                          <span className="flex items-center gap-1">
                            <HeadsetIcon className="h-3 w-3" />
                            {order.agent.name}
                          </span>
                        )}
                        <span>{order._count.items} productos</span>
                        <span className="font-medium text-blue-600">
                          {formatPrice(order.subtotal)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(order.createdAt).toLocaleDateString("es-CO")}
                        </span>
                        {order.sentVia && (
                          <span className="capitalize">via {order.sentVia}</span>
                        )}
                      </div>
                    </div>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/admin/pedidos/${order.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-6">
            {Array.from({ length: totalPages }, (_, i) => (
              <Link
                key={i}
                href={`/admin/pedidos?${params.status ? `status=${params.status}&` : ""}page=${i + 1}`}
              >
                <Button variant={page === i + 1 ? "default" : "outline"} size="sm">
                  {i + 1}
                </Button>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
