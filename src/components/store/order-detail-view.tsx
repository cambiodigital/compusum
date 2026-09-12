"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  MessageCircle,
  Pencil,
  RefreshCw,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  MyOrder,
  OrderStatusBadge,
  RequestTypeBadge,
  formatCop,
} from "@/components/store/my-orders-list";
import { toast } from "sonner";

/**
 * Detalle del pedido del cliente (Fase 3): timeline real de
 * OrderStatusHistory, precio histórico (snapshot) vs precio actual resuelto
 * server-side, edición controlada y "Volver a pedir".
 */

interface DetailItem {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  historicalUnitPrice: number | null;
  historicalLineTotal: number;
  currentUnitPrice: number | null;
  currentRequiresQuote: boolean;
  priceStatus: "unchanged" | "increased" | "decreased" | "requires_quote" | "unavailable";
  priceDifference: number | null;
  priceDifferencePercent: number | null;
  availability: "available" | "unavailable";
  currentStockQuantity: number | null;
}

interface OrderDetail extends Omit<MyOrder, "items" | "subtotal" | "requestType"> {
  requestType: string;
  subtotal: number;
  currentEstimatedSubtotal: number | null;
  advisorNotified: boolean;
  agent: { name: string } | null;
  city: { name: string; department: string } | null;
  items: DetailItem[];
  statusHistory: {
    fromStatus: string | null;
    toStatus: string;
    changedBy: string;
    note: string | null;
    createdAt: string;
  }[];
}

const PRICE_STATUS_META: Record<
  DetailItem["priceStatus"],
  { label: string; className: string; icon?: React.ComponentType<{ className?: string }> }
> = {
  unchanged: { label: "Precio sin cambio", className: "text-slate-500", icon: Check },
  increased: { label: "Subió", className: "text-red-600", icon: TrendingUp },
  decreased: { label: "Bajó", className: "text-green-600", icon: TrendingDown },
  requires_quote: { label: "Requiere cotización", className: "text-orange-600" },
  unavailable: { label: "No disponible", className: "text-slate-400" },
};

function PriceChangeBadge({ item }: { item: DetailItem }) {
  const meta = PRICE_STATUS_META[item.priceStatus];
  const Icon = meta.icon;
  if (item.priceStatus === "unchanged") return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.className}`}>
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {meta.label}
      {item.priceDifference != null && (
        <>
          {" "}
          ({item.priceDifference > 0 ? "+" : ""}
          {formatCop(item.priceDifference)}
          {item.priceDifferencePercent != null
            ? ` / ${item.priceDifference > 0 ? "+" : ""}${item.priceDifferencePercent}%`
            : ""}
          )
        </>
      )}
    </span>
  );
}

interface EditLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export function OrderDetailView({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edición
  const [editing, setEditing] = useState(false);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [saving, setSaving] = useState(false);

  // Reorder
  const [reordering, setReordering] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/orders/${orderId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setDetail(data.data);
          setError(null);
        } else {
          setError(data.error || "No se pudo cargar el pedido");
        }
      })
      .catch(() => setError("No se pudo cargar el pedido"))
      .finally(() => setLoading(false));
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const canEdit = detail?.status === "solicitado";

  const startEditing = () => {
    if (!detail) return;
    setEditLines(
      detail.items
        .filter((i) => i.availability === "available")
        .map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity }))
    );
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/orders/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: editLines }),
      });
      const data = await res.json();
      if (data.success) {
        setDetail(data.data);
        setEditing(false);
        toast.success("Pedido actualizado");
      } else {
        toast.error(data.error || "No se pudo actualizar el pedido");
      }
    } catch {
      toast.error("Error de red al actualizar el pedido");
    } finally {
      setSaving(false);
    }
  };

  const handleReorder = async (mode?: "add" | "replace", allowPartial?: boolean) => {
    if (!detail) return;
    setReordering(true);
    try {
      const res = await fetch(`/api/orders/${detail.id}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, allowPartial }),
      });
      const data = await res.json();
      if (!data.success) {
        toast.error(data.error || "No se pudo cargar el pedido al carrito");
        return;
      }
      const result = data.data;

      // Conflicto controlado: preguntar al cliente.
      if (result.conflict) {
        const replace = window.confirm(
          `Tu carrito ya tiene ${result.conflict.cartItemCount} producto(s). ¿Querés REEMPLAZARLO con este pedido? (Aceptar = reemplazar, Cancelar = agregar)`
        );
        await handleReorder(replace ? "replace" : "add", allowPartial);
        return;
      }

      const blocked = result.items.filter(
        (i: DetailItem & { status: string }) =>
          !["added", "requires_quote"].includes(i.status)
      );
      if (blocked.length > 0) {
        const loadAvailable = window.confirm(
          `${blocked.length} producto(s) no disponible(s):\n` +
            blocked
              .map((b: DetailItem & { status: string }) => `• ${b.productName}`)
              .join("\n") +
            "\n\n¿Cargar solo los disponibles?"
        );
        if (loadAvailable) {
          await handleReorder(mode ?? "replace", true);
          return;
        }
        toast.info("No se modificó tu carrito");
        return;
      }

      const quotes = result.items.filter((i: DetailItem & { status: string }) => i.status === "requires_quote");
      if (quotes.length > 0) {
        toast.success(
          `Carrito actualizado. ${quotes.length} producto(s) quedaron por cotizar.`,
          { action: { label: "Ver carrito", onClick: () => router.push("/carrito") } }
        );
      } else {
        toast.success("Productos cargados en tu carrito con precios actuales", {
          action: { label: "Ver carrito", onClick: () => router.push("/carrito") },
        });
      }
    } catch {
      toast.error("Error de red al cargar el pedido al carrito");
    } finally {
      setReordering(false);
    }
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm py-10 text-center">Cargando pedido…</div>;
  }

  if (error || !detail) {
    return (
      <div className="border rounded-lg p-8 text-center text-muted-foreground">
        <p className="mb-3">{error || "Pedido no encontrado"}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/mis-pedidos">
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver a mis pedidos
          </Link>
        </Button>
      </div>
    );
  }

  const isCotizacion = detail.requestType === "cotizacion";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="gap-1 -ml-2">
          <Link href="/mis-pedidos">
            <ArrowLeft className="h-4 w-4" /> Mis pedidos
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <RequestTypeBadge requestType={detail.requestType} />
          <OrderStatusBadge status={detail.status} />
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold">{detail.orderNumber}</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {new Date(detail.createdAt).toLocaleString("es-CO", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            {detail.agent && (
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
                <User className="h-4 w-4 text-slate-400" />
                Asesor: <span className="font-medium">{detail.agent.name}</span>
              </span>
            )}
          </div>

          {/* Estado de la solicitud respecto al asesor */}
          <p className="text-xs text-muted-foreground mt-2">
            {detail.advisorNotified
              ? isCotizacion
                ? "Tu asesor ya recibió esta solicitud de cotización."
                : "Tu asesor ya recibió este pedido."
              : isCotizacion
              ? "Tu solicitud quedó registrada. Nuestro equipo la recibirá en breve."
              : "Tu pedido quedó registrado. Nuestro equipo lo recibirá en breve."}
          </p>

          {detail.city && (
            <p className="text-xs text-muted-foreground mt-1">
              Ciudad: {detail.city.name}, {detail.city.department}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Seguimiento</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {detail.statusHistory.map((h, idx) => (
              <li key={idx} className="flex gap-3">
                <div className="flex flex-col items-center">
                  {idx === detail.statusHistory.length - 1 ? (
                    <CheckCircle2 className="h-4 w-4 text-blue-600" />
                  ) : (
                    <Circle className="h-4 w-4 text-green-500" />
                  )}
                  {idx < detail.statusHistory.length - 1 && (
                    <div className="w-px flex-1 bg-slate-200 my-0.5" />
                  )}
                </div>
                <div className="pb-1">
                  <p className="text-sm">
                    <span className="font-medium">
                      {h.toStatus === "solicitado"
                        ? "Solicitud registrada"
                        : h.toStatus === "compartido"
                        ? "Enviada a tu asesor"
                        : h.toStatus === "recibido"
                        ? "Confirmada por Compusum"
                        : h.toStatus}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(h.createdAt).toLocaleString("es-CO")}
                    {h.note ? ` · ${h.note}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* Productos: histórico vs actual */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Productos ({detail.items.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {editing ? (
            <div className="p-4 space-y-3">
              {editLines.map((line, idx) => {
                const item = detail.items.find(
                  (i) => i.productId === line.productId && i.variantId === line.variantId
                );
                return (
                  <div key={`${line.productId}-${line.variantId ?? "base"}`} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm truncate">{item?.productName}</p>
                      {item?.variantName && (
                        <p className="text-xs text-muted-foreground">{item.variantName}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        className="w-20 h-8"
                        value={line.quantity}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10);
                          setEditLines((lines) =>
                            lines.map((l, i) =>
                              i === idx ? { ...l, quantity: isNaN(value) ? l.quantity : value } : l
                            )
                          );
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 h-8"
                        onClick={() => setEditLines((lines) => lines.filter((_, i) => i !== idx))}
                      >
                        Quitar
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-2 pt-2">
                <Button onClick={saveEdits} disabled={saving || editLines.length === 0} size="sm">
                  {saving ? "Guardando…" : "Guardar cambios"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {detail.items.map((item) => (
                <div key={item.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{item.productName}</p>
                      {item.variantName && (
                        <p className="text-xs text-slate-500">{item.variantName}</p>
                      )}
                      {item.productSku && (
                        <p className="text-[11px] text-slate-400 font-mono">Ref: {item.productSku}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-blue-600">
                        {item.historicalUnitPrice != null
                          ? formatCop(item.historicalLineTotal)
                          : "Por cotizar"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        ×{item.quantity}
                        {item.historicalUnitPrice != null
                          ? ` · ${formatCop(item.historicalUnitPrice)} c/u`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-1.5 flex-wrap gap-1">
                    <PriceChangeBadge item={item} />
                    {item.priceStatus === "unavailable" ? (
                      <span className="text-xs text-slate-400">Ya no disponible</span>
                    ) : item.priceStatus === "requires_quote" ? (
                      <span className="text-xs text-orange-600">
                        Precio actual: por cotizar
                      </span>
                    ) : item.currentUnitPrice != null ? (
                      <span className="text-xs text-slate-500">
                        Precio actual: {formatCop(item.currentUnitPrice)} c/u
                        {item.currentStockQuantity != null
                          ? ` · ${item.currentStockQuantity} disponibles`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <Separator />
          <div className="px-4 py-3 space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-600">
                Total {isCotizacion ? "de la cotización" : "del pedido"} (histórico)
              </span>
              <span className="text-lg font-bold text-slate-900">{formatCop(detail.subtotal)}</span>
            </div>
            {detail.currentEstimatedSubtotal != null &&
              detail.currentEstimatedSubtotal !== detail.subtotal && (
                <p className="text-xs text-muted-foreground text-right">
                  Con precios actuales sería: {formatCop(detail.currentEstimatedSubtotal)}
                </p>
              )}
            {isCotizacion && (
              <p className="text-xs text-orange-600 flex items-center gap-1">
                <FileText className="h-3 w-3" />
                Cotización: los precios quedan sujetos a confirmación de tu asesor.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Acciones */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Button
          onClick={() => handleReorder()}
          disabled={reordering}
          className="gap-2 h-12 bg-blue-600 hover:bg-blue-700"
        >
          <RefreshCw className={`h-4 w-4 ${reordering ? "animate-spin" : ""}`} />
          Volver a pedir
        </Button>

        {canEdit ? (
          <Button
            variant="outline"
            onClick={editing ? undefined : startEditing}
            disabled={editing}
            className="gap-2 h-12"
          >
            <Pencil className="h-4 w-4" />
            Editar pedido
          </Button>
        ) : (
          <Button variant="outline" disabled className="gap-2 h-12">
            <Clock className="h-4 w-4" />
            No editable ({detail.status})
          </Button>
        )}

        <Button asChild variant="outline" className="gap-2 h-12">
          <Link href="/catalogo">
            <ShoppingCart className="h-4 w-4" />
            Ir al catálogo
          </Link>
        </Button>

        <Button asChild variant="outline" className="gap-2 h-12 border-green-200 text-green-700 hover:bg-green-50">
          <Link href="/carrito">
            <ChevronRight className="h-4 w-4" />
            Ver mi carrito
          </Link>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        "Volver a pedir" crea un carrito nuevo con los precios actuales; el pedido
        original queda intacto. "Editar" solo está disponible mientras el pedido
        está en proceso.
      </p>
    </div>
  );
}
