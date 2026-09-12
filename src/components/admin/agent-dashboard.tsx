import Link from "next/link";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/admin/order-status-badge";
import {
  Users,
  ClipboardList,
  Calendar,
  User,
  ShoppingBag,
} from "lucide-react";
import { formatPrice } from "@/lib/format";

export interface AgentDashboardRecentOrder {
  id: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  subtotal: number;
  createdAt: Date;
}

interface AgentDashboardProps {
  userName: string;
  customersCount: number;
  ordersCount: number;
  ordersByStatus: Record<string, number>;
  recentOrders: AgentDashboardRecentOrder[];
}

/**
 * Vista comercial mínima del AGENT: SOLO métricas de sus clientes y sus
 * pedidos (las consultas ya llegan con alcance aplicado desde la página).
 * Sin métricas de catálogo ni accesos a superficies globales.
 */
export function AgentDashboard({
  userName,
  customersCount,
  ordersCount,
  ordersByStatus,
  recentOrders,
}: AgentDashboardProps) {
  const stats = [
    {
      title: "Mis clientes",
      value: customersCount,
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Mis pedidos",
      value: ordersCount,
      icon: ClipboardList,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Solicitados",
      value: ordersByStatus.solicitado ?? 0,
      icon: ShoppingBag,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      title: "Compartidos",
      value: ordersByStatus.compartido ?? 0,
      icon: ClipboardList,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      title: "Recibidos",
      value: ordersByStatus.recibido ?? 0,
      icon: ShoppingBag,
      color: "text-cyan-600",
      bgColor: "bg-cyan-50",
    },
  ];

  return (
    <>
      <Header title={`Hola, ${userName}`} subtitle="Panel comercial" />

      <div className="p-4 sm:p-6 lg:ml-0">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
          {stats.map((stat) => (
            <Card key={stat.title} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className={`w-10 h-10 ${stat.bgColor} rounded-lg flex items-center justify-center mb-3`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
                <p className="text-xs text-slate-500 mt-0.5">{stat.title}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Accesos directos comerciales */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Accesos directos</h2>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/admin/clientes">
                <Users className="h-4 w-4 mr-2" />
                Mis clientes
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/pedidos">
                <ClipboardList className="h-4 w-4 mr-2" />
                Mis pedidos
              </Link>
            </Button>
          </div>
        </div>

        {/* Últimos pedidos propios */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Últimos pedidos</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/pedidos">
                Ver todos
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                <ClipboardList className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                <p>Aún no tienes pedidos</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentOrders.map((order) => (
                  <Link
                    key={order.id}
                    href={`/admin/pedidos/${order.id}`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50 rounded px-2 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono font-bold text-slate-900">
                          {order.orderNumber}
                        </p>
                        <OrderStatusBadge status={order.status} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500 mt-1">
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {order.customerName || "Sin nombre"}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(order.createdAt).toLocaleDateString("es-CO")}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-sm font-semibold text-blue-600">
                        {formatPrice(order.subtotal)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
