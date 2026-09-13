"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ShoppingBag,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { OrderStatusBadge } from "@/components/admin/order-status-badge";
import { formatPrice } from "@/lib/format";
import type {
  CommercialLineComputation,
  CommercialLinesPreview,
  CommercialPreview,
  CommercialPreviewLine,
} from "@/lib/commercial-order";

/**
 * COMMERCIAL CALCULATION PANEL (Fase 4B) — client tooling for the backoffice
 * order detail. The browser NEVER computes a displayed price: every monetary
 * value shown as truth comes from the commercial API (`action: "preview"`),
 * and writes are delegated to save/recalculate/convert, where the server
 * re-resolves prices, re-authorizes and re-checks editability.
 */

interface CommercialOrderPanelProps {
  orderId: string;
  initialPreview: CommercialPreview;
  /**
   * Agent (commercial) view: identical commercial capabilities (RBAC is
   * enforced server-side); the customer price-profile NAME is displayed
   * read-only, exactly like for admins.
   */
  agentView: boolean;
}

/** One editable draft line. Prices are kept as raw input strings. */
interface EditorLine {
  key: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  variantCode: string | null;
  productSku: string | null;
  quantity: string;
  quotedUnitPrice: string;
  minQuantity: number;
}

interface PickerProduct {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  stockStatus: string;
  minWholesaleQty: number | null;
  variantCount: number;
}

interface PickerVariant {
  id: string;
  name: string;
  code: string | null;
  stockQuantity: number | null;
  stockStatus: string;
}

interface CommercialActionResponse {
  success: boolean;
  data?: unknown;
  message?: string;
  error?: string;
}

const PREVIEW_DEBOUNCE_MS = 400;
const SEARCH_DEBOUNCE_MS = 350;
const CHANGED_PRICE_HIGHLIGHT_MS = 8000;

const STATUS_LABELS: Record<string, string> = {
  solicitado: "Solicitado",
  compartido: "Compartido",
  recibido: "Recibido",
};

function lineKeyOf(productId: string, variantId: string | null): string {
  return `${productId}::${variantId ?? ""}`;
}

/** null => not provided; "invalid" => non-empty but not a positive finite number. */
function parseQuotedInput(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}

function hasInvalidQuantity(line: EditorLine): boolean {
  const qty = Number(line.quantity);
  return !Number.isInteger(qty) || qty <= 0;
}

function hasInvalidQuote(line: EditorLine): boolean {
  return parseQuotedInput(line.quotedUnitPrice) === "invalid";
}

/**
 * Draft -> API payload. Only INTENT is sent: productId, variantId, quantity
 * and a manual quote price (cotizacion mode only). No prices are ever
 * computed or decided here.
 */
function buildPayloadLines(
  lines: EditorLine[],
  requestType: string
): { productId: string; variantId: string | null; quantity: number; quotedUnitPrice?: number }[] {
  return lines.map((line) => {
    const payload: {
      productId: string;
      variantId: string | null;
      quantity: number;
      quotedUnitPrice?: number;
    } = {
      productId: line.productId,
      variantId: line.variantId,
      quantity: Number(line.quantity),
    };
    if (requestType === "cotizacion") {
      const quoted = parseQuotedInput(line.quotedUnitPrice);
      if (typeof quoted === "number") payload.quotedUnitPrice = quoted;
    }
    return payload;
  });
}

/** Rebuilds the editable draft from an authoritative preview. */
function buildEditorLines(preview: CommercialPreview): EditorLine[] {
  return preview.lines.map((line) => ({
    key: lineKeyOf(line.productId, line.variantId),
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    variantName: line.variantName,
    variantCode: line.variantCode,
    productSku: line.productSku,
    quantity: String(line.quantity),
    // A stored price on a line the engine cannot price IS the negotiated
    // quote: prefill it so an edit + save never silently drops it.
    quotedUnitPrice:
      preview.requestType === "cotizacion" &&
      line.engineRequiresQuote &&
      line.snapshotUnitPrice != null
        ? String(line.snapshotUnitPrice)
        : "",
    minQuantity: line.minQuantity,
  }));
}

interface StockMetaLike {
  currentStockQuantity: number | null;
  minQuantity: number;
  availability: "available" | "unavailable";
}

function StockMeta({ line }: { line: StockMetaLike }) {
  return (
    <div className="text-xs text-slate-500 space-y-0.5">
      <p>
        Stock: {line.currentStockQuantity != null ? line.currentStockQuantity : "—"} · Mín:{" "}
        {line.minQuantity}
      </p>
      <p className={line.availability === "available" ? "text-green-600" : "text-red-600"}>
        {line.availability === "available" ? "Disponible" : "Agotado / no disponible"}
      </p>
    </div>
  );
}

/** Snapshot vs current engine price difference (order-detail conventions). */
function PriceDifferenceBadge({ line }: { line: CommercialPreviewLine }) {
  if (line.priceStatus === "unchanged") return null;
  if (line.priceStatus === "increased" && line.priceDifference != null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-600">
        <TrendingUp className="h-3 w-3" />
        +{formatPrice(line.priceDifference)}
      </span>
    );
  }
  if (line.priceStatus === "decreased" && line.priceDifference != null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600">
        <TrendingDown className="h-3 w-3" />
        {formatPrice(line.priceDifference)}
      </span>
    );
  }
  if (line.priceStatus === "requires_quote") {
    return <span className="text-xs text-orange-600">Requiere cotización</span>;
  }
  if (line.priceStatus === "unavailable") {
    return <span className="text-xs text-slate-400">Ya no disponible</span>;
  }
  return null;
}

export function CommercialOrderPanel({
  orderId,
  initialPreview,
  agentView,
}: CommercialOrderPanelProps) {
  const router = useRouter();

  const [preview, setPreview] = useState<CommercialPreview>(initialPreview);
  const [lines, setLines] = useState<EditorLine[]>(() => buildEditorLines(initialPreview));
  const [livePreview, setLivePreview] = useState<CommercialLinesPreview | null>(null);
  const [computing, setComputing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [converting, setConverting] = useState(false);
  const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());

  // Product picker state.
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerResults, setPickerResults] = useState<PickerProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [variantOptions, setVariantOptions] = useState<{
    product: PickerProduct;
    variants: PickerVariant[];
  } | null>(null);
  const [loadingVariants, setLoadingVariants] = useState(false);

  const previewSeq = useRef(0);
  const searchSeq = useRef(0);

  const canEdit = preview.canEdit;
  const isCotizacion = preview.requestType === "cotizacion";

  const metaByKey = useMemo(
    () => new Map(preview.lines.map((line) => [lineKeyOf(line.productId, line.variantId), line])),
    [preview]
  );
  const liveByKey = useMemo(
    () =>
      livePreview
        ? new Map(livePreview.lines.map((line) => [lineKeyOf(line.productId, line.variantId), line]))
        : null,
    [livePreview]
  );

  const payloadSignature = useMemo(
    () => JSON.stringify(buildPayloadLines(lines, preview.requestType)),
    [lines, preview.requestType]
  );

  // Live server-side computation of the draft: the ONLY source of displayed
  // proposed prices. Debounced; on error the last good preview is kept.
  useEffect(() => {
    if (!canEdit) {
      setLivePreview(null);
      setComputing(false);
      return;
    }
    if (lines.length === 0 || lines.some(hasInvalidQuantity)) {
      setLivePreview(null);
      setComputing(false);
      return;
    }

    const seq = ++previewSeq.current;
    const payload = JSON.parse(payloadSignature) as ReturnType<
      typeof buildPayloadLines
    >;

    setComputing(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/orders/${orderId}/commercial`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", lines: payload }),
        });
        const body = await res.json();
        if (seq !== previewSeq.current) return;
        if (body?.success) {
          setLivePreview(body.data as CommercialLinesPreview);
        } else {
          toast.error(body?.error || "Error al calcular la vista previa");
        }
      } catch {
        if (seq === previewSeq.current) toast.error("Error de conexión");
      } finally {
        if (seq === previewSeq.current) setComputing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [canEdit, orderId, payloadSignature, lines]);

  // Clear the "price changed" highlight after a while.
  useEffect(() => {
    if (changedKeys.size === 0) return;
    const timer = setTimeout(
      () => setChangedKeys(new Set()),
      CHANGED_PRICE_HIGHLIGHT_MS
    );
    return () => clearTimeout(timer);
  }, [changedKeys]);

  // Debounced product search against the existing public products endpoint
  // (works for AGENT and ADMIN alike; the admin-only products API does not).
  useEffect(() => {
    const query = pickerQuery.trim();
    if (!canEdit || query.length < 2) {
      setPickerResults([]);
      setSearching(false);
      return;
    }

    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/products?search=${encodeURIComponent(query)}&limit=8`
        );
        const body = await res.json();
        if (seq !== searchSeq.current) return;
        setPickerResults((body?.data?.products ?? []) as PickerProduct[]);
      } catch {
        if (seq === searchSeq.current) setPickerResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [canEdit, pickerQuery]);

  const addLine = (product: PickerProduct, variant: PickerVariant | null) => {
    const key = lineKeyOf(product.id, variant?.id ?? null);
    if (lines.some((line) => line.key === key)) {
      toast.error("El producto ya está en el cálculo");
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        key,
        productId: product.id,
        variantId: variant?.id ?? null,
        productName: product.name,
        variantName: variant?.name ?? null,
        variantCode: variant?.code ?? null,
        productSku: product.sku,
        quantity: String(product.minWholesaleQty || 1),
        quotedUnitPrice: "",
        minQuantity: product.minWholesaleQty || 1,
      },
    ]);
    setPickerQuery("");
    setPickerResults([]);
    setVariantOptions(null);
  };

  const handlePickProduct = async (product: PickerProduct) => {
    setVariantOptions(null);
    setLoadingVariants(true);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(product.slug)}`);
      const body = await res.json();
      if (!body?.success) {
        toast.error("No se pudo cargar el producto");
        return;
      }
      const variants = ((body?.data?.variants ?? []) as PickerVariant[]).filter(
        (variant) => variant && variant.id
      );
      if (variants.length > 0) {
        setVariantOptions({ product, variants });
      } else {
        addLine(product, null);
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setLoadingVariants(false);
    }
  };

  const setQuantity = (key: string, value: string) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, quantity: value } : line))
    );
  };

  const setQuotedPrice = (key: string, value: string) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, quotedUnitPrice: value } : line))
    );
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((line) => line.key !== key));
  };

  /** Applies a fresh authoritative preview and resets the draft from it. */
  const applyNewPreview = (next: CommercialPreview) => {
    setPreview(next);
    setLines(buildEditorLines(next));
    setLivePreview(null);
  };

  const runCommercialAction = async (
    action: "save" | "recalculate" | "convert",
    setBusy: (value: boolean) => void,
    extraBody?: Record<string, unknown>
  ): Promise<CommercialPreview | null> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/commercial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extraBody }),
      });
      const body = (await res.json()) as CommercialActionResponse;
      if (!body.success) {
        toast.error(body.error || "Error en la operación comercial");
        return null;
      }
      toast.success(body.message || "Operación exitosa");
      return body.data as CommercialPreview;
    } catch {
      toast.error("Error de conexión");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (lines.length === 0) {
      toast.error("Debe incluir al menos una línea.");
      return;
    }
    if (lines.some(hasInvalidQuantity)) {
      toast.error("Revise las cantidades: deben ser enteros mayores a cero.");
      return;
    }
    if (lines.some(hasInvalidQuote)) {
      toast.error("Revise los precios de cotización: deben ser números positivos.");
      return;
    }
    const next = await runCommercialAction("save", setSaving, {
      lines: buildPayloadLines(lines, preview.requestType),
    });
    if (next) {
      applyNewPreview(next);
      router.refresh();
    }
  };

  const handleRecalculate = async () => {
    const before = preview;
    const next = await runCommercialAction("recalculate", setRecalculating);
    if (!next) return;

    // Surface which stored prices the recalculation actually changed.
    const changed = new Set<string>();
    for (const line of next.lines) {
      const key = lineKeyOf(line.productId, line.variantId);
      const previous = before.lines.find(
        (candidate) => lineKeyOf(candidate.productId, candidate.variantId) === key
      );
      if (previous && previous.snapshotUnitPrice !== line.snapshotUnitPrice) {
        changed.add(key);
      }
    }
    applyNewPreview(next);
    if (changed.size > 0) setChangedKeys(changed);
    router.refresh();
  };

  const handleConvert = async () => {
    const next = await runCommercialAction("convert", setConverting);
    if (next) {
      applyNewPreview(next);
      router.refresh();
    }
  };

  // Proposed subtotal: ONLY from the server preview response.
  const proposedSubtotal = canEdit
    ? livePreview
      ? livePreview.subtotal
      : preview.engineSubtotal
    : null;
  const effectiveIsComplete =
    canEdit && livePreview ? livePreview.isComplete : preview.isComplete;
  const canConvert = preview.canConvert;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            Cálculo comercial
            <Badge
              variant="outline"
              className={
                isCotizacion
                  ? "text-orange-600 border-orange-200 bg-orange-50"
                  : "text-blue-600 border-blue-200"
              }
            >
              {isCotizacion ? "Cotización" : "Pedido"}
            </Badge>
            <OrderStatusBadge status={preview.status} />
          </CardTitle>
          <span className="text-xs text-slate-400">#{preview.orderNumber}</span>
        </div>
        <p className="text-xs text-slate-500 mt-1">
          Perfil: {preview.customerProfileName || "—"}
          {agentView && preview.customerProfileName ? " (solo lectura)" : ""}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Commercially closed: historical snapshot only. */}
        {!canEdit && (
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            <AlertTriangle className="h-4 w-4 text-slate-400 mt-0.5 flex-shrink-0" />
            <p>
              Este {isCotizacion ? "cotización" : "pedido"} ya no es editable
              comercialmente (estado:{" "}
              {STATUS_LABELS[preview.status] || preview.status}). Las líneas y
              precios se muestran como snapshot histórico.
            </p>
          </div>
        )}

        {/* Incomplete quote: cannot be shared or received until priced. */}
        {isCotizacion && !effectiveIsComplete && (
          <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-600">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <p>
              Cotización incompleta: hay líneas sin precio. No puede compartirse
              ni recibirse hasta completar los precios.
            </p>
          </div>
        )}

        {/* Lines */}
        {lines.length === 0 && (
          <p className="text-sm text-slate-500">
            Sin líneas.{" "}
            {canEdit
              ? "Agregue productos para comenzar el cálculo."
              : "El pedido no tiene productos."}
          </p>
        )}

        <div className="divide-y divide-slate-100">
          {lines.map((line, index) => {
            const meta = metaByKey.get(line.key);
            const live = liveByKey?.get(line.key);
            const highlighted = changedKeys.has(line.key);
            const requiresQuote = live
              ? live.engineRequiresQuote
              : meta?.engineRequiresQuote ?? false;
            const enginePrice = live
              ? live.engineUnitPrice
              : meta?.engineUnitPrice ?? null;
            const lineTotal = live ? live.lineTotal : meta?.snapshotLineTotal ?? null;

            return (
              <div
                key={line.key}
                className={
                  highlighted
                    ? "py-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 my-1"
                    : "py-3"
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">
                      {line.productName}
                    </p>
                    {line.variantName && (
                      <p className="text-xs text-slate-500">
                        Variante: {line.variantName}
                        {line.variantCode ? ` (${line.variantCode})` : ""}
                      </p>
                    )}
                    {line.productSku && (
                      <p className="text-xs text-slate-400 font-mono">
                        Ref: {line.productSku}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-semibold text-blue-600">
                        {lineTotal != null ? formatPrice(lineTotal) : "—"}
                      </p>
                      <p className="text-xs text-slate-400">Total línea</p>
                      {!canEdit && meta && meta.engineLineTotal !== meta.snapshotLineTotal && (
                        <p className="text-xs text-slate-400">
                          Con precio actual: {formatPrice(meta.engineLineTotal)}
                        </p>
                      )}
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeLine(line.key)}
                        aria-label={`Quitar ${line.productName}`}
                        className="h-8 w-8 p-0"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
                  {/* Quantity */}
                  <div>
                    {canEdit ? (
                      <>
                        <Label
                          htmlFor={`qty-input-${index}`}
                          className="text-xs text-slate-500 mb-1 block"
                        >
                          Cantidad (mín. {line.minQuantity})
                        </Label>
                        <Input
                          id={`qty-input-${index}`}
                          type="number"
                          min={line.minQuantity}
                          step={1}
                          inputMode="numeric"
                          value={line.quantity}
                          onChange={(e) => setQuantity(line.key, e.target.value)}
                          className="h-8 text-sm"
                        />
                        {hasInvalidQuantity(line) && (
                          <p className="text-xs text-red-600 mt-1">
                            Cantidad inválida
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-slate-500">
                        Cantidad: <span className="text-slate-700">{line.quantity}</span>
                      </p>
                    )}
                  </div>

                  {/* Stored snapshot price + difference */}
                  <div className="text-xs text-slate-500 space-y-0.5">
                    <p>Precio guardado</p>
                    <p className="text-sm text-slate-700">
                      {meta?.snapshotUnitPrice != null
                        ? formatPrice(meta.snapshotUnitPrice)
                        : "Sin precio"}
                    </p>
                    {meta && <PriceDifferenceBadge line={meta} />}
                    {highlighted && (
                      <p className="text-xs text-amber-700">Precio actualizado</p>
                    )}
                  </div>

                  {/* Current price: engine OR manual quote input */}
                  <div className="text-xs text-slate-500 space-y-1">
                    <p>Precio actual (motor)</p>
                    {requiresQuote ? (
                      isCotizacion && canEdit ? (
                        <>
                          <Label
                            htmlFor={`quote-input-${index}`}
                            className="text-xs text-orange-600 mb-1 block"
                          >
                            Precio cotizado (COP)
                          </Label>
                          <Input
                            id={`quote-input-${index}`}
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={line.quotedUnitPrice}
                            onChange={(e) => setQuotedPrice(line.key, e.target.value)}
                            placeholder="Ej: 12500"
                            className="h-8 text-sm"
                          />
                          {hasInvalidQuote(line) && (
                            <p className="text-xs text-red-600">Precio inválido</p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-orange-600">
                          Requiere cotización
                          {!isCotizacion && canEdit
                            ? " — no calculable como pedido"
                            : ""}
                        </p>
                      )
                    ) : (
                      <p className="text-sm text-slate-700">
                        {enginePrice != null ? formatPrice(enginePrice) : "—"}
                      </p>
                    )}
                    {requiresQuote && (
                      <Badge
                        variant="outline"
                        className="text-orange-600 border-orange-200"
                      >
                        Requiere cotización
                      </Badge>
                    )}
                  </div>

                  {/* Stock / availability */}
                  <div>
                    {(live ?? meta) && <StockMeta line={(live ?? meta)!} />}
                    {live?.validationError && (
                      <p className="text-xs text-red-600 mt-1">{live.validationError}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Add-line picker (edit mode only) */}
        {canEdit && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <Label htmlFor="product-search" className="text-sm text-slate-600">
              Agregar producto
            </Label>
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                id="product-search"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Buscar producto por nombre o SKU..."
                className="pl-9 text-sm"
                autoComplete="off"
              />
            </div>
            {searching && (
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Buscando...
              </p>
            )}
            {pickerResults.length > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-md border border-slate-100 divide-y divide-slate-100">
                {pickerResults.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => handlePickProduct(product)}
                    disabled={loadingVariants}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-800 truncate">
                        {product.name}
                      </span>
                      {product.sku && (
                        <span className="block text-xs text-slate-400 font-mono">
                          Ref: {product.sku}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {product.variantCount > 0
                        ? `${product.variantCount} variante${product.variantCount > 1 ? "s" : ""}`
                        : product.stockStatus}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!searching && pickerQuery.trim().length >= 2 && pickerResults.length === 0 && (
              <p className="text-xs text-slate-400">Sin resultados.</p>
            )}
            {variantOptions && (
              <div className="rounded-md bg-slate-50 p-2 space-y-1">
                <p className="text-xs text-slate-500">
                  Variantes de &quot;{variantOptions.product.name}&quot;:
                </p>
                <div className="flex flex-wrap gap-2">
                  {variantOptions.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => addLine(variantOptions.product, variant)}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:border-slate-300"
                    >
                      {variant.name}
                      {variant.stockQuantity != null ? ` (${variant.stockQuantity})` : ""}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {loadingVariants && (
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Cargando variantes...
              </p>
            )}
          </div>
        )}

        {/* Totals */}
        <Separator />
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <span className="text-sm text-slate-600">Subtotal guardado</span>
            <span className="text-sm font-medium text-slate-900">
              {formatPrice(preview.storedSubtotal)}
            </span>
          </div>
          {canEdit && (
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-600">
                Subtotal {livePreview ? "propuesto" : "calculado"}
              </span>
              <span className="flex items-center gap-2">
                {computing && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                )}
                <span className="text-sm font-medium text-slate-900">
                  {formatPrice(proposedSubtotal)}
                </span>
              </span>
            </div>
          )}
          {proposedSubtotal != null && proposedSubtotal !== preview.storedSubtotal && (
            <p className="text-xs text-right text-slate-500">
              Diferencia:{" "}
              {proposedSubtotal - preview.storedSubtotal > 0 ? "+" : ""}
              {formatPrice(proposedSubtotal - preview.storedSubtotal)}
            </p>
          )}
          {livePreview?.validationError && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {livePreview.validationError}
            </p>
          )}
          {isCotizacion && (
            <p
              className={`text-xs flex items-center gap-1 ${
                effectiveIsComplete ? "text-green-600" : "text-orange-600"
              }`}
            >
              {effectiveIsComplete
                ? "Cotización completa: puede compartirse o convertirse en pedido."
                : "Cotización incompleta: faltan precios de cotización."}
            </p>
          )}
        </div>

        {/* Commercial actions (edit mode only; the server re-checks all of this) */}
        {canEdit && (
          <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-slate-100">
            <Button
              variant="outline"
              className="gap-2 flex-1"
              onClick={handleRecalculate}
              disabled={recalculating || saving || converting}
            >
              <RefreshCw className={`h-4 w-4 ${recalculating ? "animate-spin" : ""}`} />
              {recalculating ? "Recalculando..." : "Recalcular precios actuales"}
            </Button>
            <Button
              className="gap-2 flex-1"
              onClick={handleSave}
              disabled={saving || recalculating || converting || lines.length === 0}
            >
              <Save className={`h-4 w-4 ${saving ? "animate-spin" : ""}`} />
              {saving ? "Guardando..." : "Guardar cálculo"}
            </Button>
            {isCotizacion && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="gap-2 flex-1 text-orange-600 border-orange-200 hover:bg-orange-50"
                    disabled={!canConvert || converting || saving || recalculating}
                  >
                    <ShoppingBag className={`h-4 w-4 ${converting ? "animate-spin" : ""}`} />
                    {converting ? "Convirtiendo..." : "Convertir en pedido"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Convertir la cotización en pedido?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Se preservarán los precios cotizados y el subtotal actual. La
                      cotización pasará a ser un pedido y esta acción no se puede
                      deshacer.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={handleConvert} disabled={converting}>
                      {converting ? "Convirtiendo..." : "Convertir"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
        {canEdit && isCotizacion && !canConvert && (
          <p className="text-xs text-slate-500">
            Complete los precios de cotización para convertir.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
