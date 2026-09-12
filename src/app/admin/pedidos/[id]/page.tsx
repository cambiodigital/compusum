import { redirect, notFound } from "next/navigation";
import { requireBackofficeUser, isAgentRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/admin/order-status-badge";
import { OrderTimeline } from "@/components/admin/order-timeline";
import { OrderAdminActions } from "@/components/admin/order-admin-actions";
import Link from "next/link";
import {
  ArrowLeft,
  User,
  Mail,
  Phone,
  Building2,
  ExternalLink,
  HeadsetIcon,
} from "lucide-react";
import { formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

// DETALLE DE PEDIDO: el AGENT comercial solo accede a SUS pedidos
// (agentId = self); cualquier otro => 404.
export default async function AdminOrderDetailPage({ params }: Props) {
  const user = await requireBackofficeUser();
  if (!user) redirect("/admin/login");

  const { id } = await params;

  const order = await db.order.findFirst({
    where: isAgentRole(user.role) ? { id, agentId: user.id } : { id },
    include: {
      items: true,
      statusHistory: { orderBy: { createdAt: "asc" } },
      cart: { select: { uuid: true } },
      agent: { select: { id: true, name: true } },
    },
  });

  if (!order) notFound();

  const isCotizacion = order.requestType === "cotizacion";

  return (
    <div>
      <Header
        title={`${isCotizacion ? "Cotización" : "Pedido"} ${order.orderNumber}`}
        subtitle={`Creado el ${new Date(order.createdAt).toLocaleString("es-CO")}`}
      />

      <div className="p-6 space-y-6">
        {/* Back + Status */}
        <div className="flex items-center justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link href="/admin/pedidos">
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            {isCotizacion && (
              <Badge variant="outline" className="text-orange-600 border-orange-200 bg-orange-50">
                Cotización
              </Badge>
            )}
            <OrderStatusBadge status={order.status} />
            {order.webhookSent && (
              <Badge variant="outline" className="text-purple-600 border-purple-200">
                Webhook enviado
              </Badge>
            )}
            {order.sentVia && (
              <Badge variant="outline" className="capitalize">
                via {order.sentVia}
              </Badge>
            )}
            {order.cart && (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <a href={`/carrito/${order.cart.uuid}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Ver carrito
                </a>
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Customer Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Cliente</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <User className="h-4 w-4 text-slate-400" />
                {order.customerName}
              </div>
              {order.customerEmail && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Mail className="h-4 w-4 text-slate-400" />
                  {order.customerEmail}
                </div>
              )}
              {order.customerPhone && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone className="h-4 w-4 text-slate-400" />
                  {order.customerPhone}
                </div>
              )}
              {order.customerCompany && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  {order.customerCompany}
                </div>
              )}
              {order.agent && (
                <div className="flex items-center gap-2 text-slate-600 border-t border-slate-100 pt-2 mt-2">
                  <HeadsetIcon className="h-4 w-4 text-slate-400" />
                  <span>
                    Asesor asignado: <span className="font-medium">{order.agent.name}</span>
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Historial</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTimeline history={order.statusHistory} />
            </CardContent>
          </Card>

          {/* Admin Actions */}
          <OrderAdminActions
            orderId={order.id}
            currentStatus={order.status}
            currentNotes={order.notes || ""}
            webhookSent={order.webhookSent}
            customerName={order.customerName}
            customerEmail={order.customerEmail}
            customerPhone={order.customerPhone}
            customerCompany={order.customerCompany}
            agentView={isAgentRole(user.role)}
          />
        </div>

        {/* Products */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Productos ({order.items.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-100">
              {order.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{item.productName}</p>
                    {item.productSku && (
                      <p className="text-xs text-slate-400 font-mono">Ref: {item.productSku}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-slate-600">x{item.quantity}</p>
                    <p className="text-sm font-semibold text-blue-600">
                      {formatPrice((item.unitPrice || 0) * item.quantity)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <Separator />
            <div className="flex justify-between items-center px-4 py-3">
              <span className="font-medium text-slate-700">Subtotal</span>
              <span className="text-lg font-bold text-slate-900">
                {formatPrice(order.subtotal)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Webhook info */}
        {order.webhookResponse && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Respuesta Webhook</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs text-slate-600 bg-slate-50 p-3 rounded-lg overflow-x-auto">
                {order.webhookResponse}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Notes */}
        {order.notes && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notas</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">{order.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
