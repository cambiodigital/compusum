"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, ClipboardList, FileText } from "lucide-react";

/**
 * Listado compartido de pedidos del cliente (Fase 3).
 * Usado por /mis-pedidos y /mi-cuenta — una sola implementación.
 */

export interface MyOrderItem {
  id: string;
  productId?: string;
  variantId?: string | null;
  productName: string;
  productSku: string | null;
  variantName?: string | null;
  quantity: number;
  unitPrice: number | null;
}

export interface MyOrder {
  id: string;
  orderNumber: string;
  status: string;
  requestType?: string;
  subtotal: number | null;
  sentVia?: string | null;
  createdAt: string;
  agent?: { name: string } | null;
  items: MyOrderItem[];
}

export const ORDER_STATUS_STYLES: Record<string, string> = {
  solicitado: "bg-yellow-100 text-yellow-800",
  compartido: "bg-blue-100 text-blue-800",
  recibido: "bg-green-100 text-green-800",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  solicitado: "En proceso",
  compartido: "Enviado",
  recibido: "Confirmado",
};

export function OrderStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        ORDER_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {ORDER_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function RequestTypeBadge({ requestType }: { requestType?: string }) {
  if (requestType === "cotizacion") {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-orange-100 text-orange-700">
        Cotización
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-600">
      Pedido
    </span>
  );
}

export function formatCop(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 0,
  });
}

export function useMyOrders(enabled: boolean) {
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    fetch("/api/orders/mine")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setOrders(data.data ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [enabled]);

  return { orders, loading };
}

export function MyOrdersList({
  orders,
  loading,
  linkToDetail = true,
}: {
  orders: MyOrder[];
  loading: boolean;
  linkToDetail?: boolean;
}) {
  if (loading) {
    return <div className="text-muted-foreground text-sm">Cargando pedidos…</div>;
  }

  if (orders.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center text-muted-foreground">
        <ClipboardList className="h-10 w-10 mx-auto mb-3 text-slate-300" />
        <p className="mb-2 font-medium">No tenés pedidos registrados aún.</p>
        <p className="text-sm">
          Los pedidos y cotizaciones aparecen aquí después de confirmar en el checkout.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {orders.map((order) => (
        <Link
          key={order.id}
          href={linkToDetail ? `/mis-pedidos/${order.id}` : "#"}
          className={`block border rounded-lg p-4 bg-card transition-colors ${
            linkToDetail ? "hover:border-blue-300 hover:bg-blue-50/30" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{order.orderNumber}</span>
                <RequestTypeBadge requestType={order.requestType} />
                <OrderStatusBadge status={order.status} />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {new Date(order.createdAt).toLocaleDateString("es-CO", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
                {order.agent?.name ? ` · Asesor: ${order.agent.name}` : ""}
              </p>
            </div>
            {linkToDetail && (
              <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0 mt-1" />
            )}
          </div>

          {/* Productos */}
          <ul className="text-sm space-y-0.5 mb-3">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between text-muted-foreground">
                <span>
                  {item.productName}
                  {item.variantName ? (
                    <span className="text-xs ml-1">[{item.variantName}]</span>
                  ) : null}
                  {item.productSku ? (
                    <span className="text-xs ml-1">({item.productSku})</span>
                  ) : null}
                </span>
                <span>×{item.quantity}</span>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between">
            {order.requestType === "cotizacion" ? (
              <span className="text-xs text-orange-600 flex items-center gap-1">
                <FileText className="h-3 w-3" />
                Cotización
              </span>
            ) : (
              <span />
            )}
            {order.subtotal != null && (
              <p className="text-sm font-medium text-right">
                Total: {formatCop(order.subtotal)}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
