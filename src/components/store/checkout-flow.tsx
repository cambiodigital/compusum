"use client";

import { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  MessageCircle,
  ShoppingCart,
  User,
  MapPin,
  CheckCircle2,
  Save,
  Copy,
  Check,
  ClipboardCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useCartStore, getSubtotal, getItemCount } from "@/stores/cart-store";
import { getCartItemKey } from "@/stores/cart-store";
import { CartItemRow } from "@/components/store/cart-item-row";
import { CitySelector } from "@/components/store/city-selector";
import { ShareCartMenu } from "@/components/store/share-cart-menu";
import { formatPrice } from "@/lib/format";
import { isItemInCatalogMode } from "@/hooks/use-catalog-mode";
import { toast } from "sonner";
import Link from "next/link";

const STEPS = [
  { id: "resumen", label: "Resumen", icon: ShoppingCart },
  { id: "datos", label: "Datos", icon: User },
  { id: "envio", label: "Envío", icon: MapPin },
  { id: "confirmar", label: "Confirmar", icon: CheckCircle2 },
];

export function CheckoutFlow() {
  const [currentStep, setCurrentStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const [cartDialogOpen, setCartDialogOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [whatsappPhone, setWhatsappPhone] = useState("576063335206");
  const [catalogMode, setCatalogMode] = useState(false);
  const items = useCartStore((s) => s.items);
  const customerInfo = useCartStore((s) => s.customerInfo);
  const setCustomerInfo = useCartStore((s) => s.setCustomerInfo);
  const savedCartUuid = useCartStore((s) => s.savedCartUuid);
  const setSavedCartUuid = useCartStore((s) => s.setSavedCartUuid);
  const subtotal = useCartStore(getSubtotal);
  const itemCount = useCartStore(getItemCount);

  const hasCatalogItems = catalogMode || items.some((item) => isItemInCatalogMode(item.product, catalogMode));

  // Fetch settings (WhatsApp phone + catalog mode)
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        const phone = data.data?.contact?.whatsapp_global?.value;
        if (phone) setWhatsappPhone(phone);
      })
      .catch(() => {});

    fetch("/api/catalog-mode")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setCatalogMode(data.data.catalogMode);
      })
      .catch(() => {});
  }, []);

  const next = () => setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  const prev = () => setCurrentStep((s) => Math.max(s - 1, 0));

  const handleSaveCart = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/carts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((item) => ({
            productId: item.product.id,
            variantId: item.product.variantId ?? null,
            variantName: item.product.variantName ?? null,
            variantCode: item.product.variantCode ?? null,
            quantity: item.quantity,
            unitPrice: item.product.wholesalePrice || item.product.price,
          })),
          customerName: customerInfo.name || null,
          customerEmail: customerInfo.email || null,
          customerPhone: customerInfo.phone || null,
          customerCompany: customerInfo.company || null,
          cityId: customerInfo.cityId || null,
          notes: customerInfo.notes || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setSavedCartUuid(data.data.uuid);
        return data.data.uuid as string;
      } else {
        toast.error("Error al guardar el carrito");
        return null;
      }
    } catch {
      toast.error("Error al guardar el carrito");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCartAndShow = async () => {
    const uuid = savedCartUuid || await handleSaveCart();
    if (uuid) setCartDialogOpen(true);
  };

  const cartUrl =
    typeof window !== "undefined" && savedCartUuid
      ? `${window.location.origin}/carrito/${savedCartUuid}`
      : null;

  const handleCopyUrl = async () => {
    if (!cartUrl) return;
    await navigator.clipboard.writeText(cartUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const generateWhatsAppMessage = () => {
    const isCatalogQuote = hasCatalogItems;
    let msg = isCatalogQuote ? "*Cotización CompuSum* 📋\n\n" : "*Pedido CompuSum* 🛒\n\n";
    if (customerInfo.name) msg += `*Cliente:* ${customerInfo.name}\n`;
    if (customerInfo.company) msg += `*Empresa:* ${customerInfo.company}\n`;
    if (customerInfo.phone) msg += `*Tel:* ${customerInfo.phone}\n`;
    if (customerInfo.email) msg += `*Email:* ${customerInfo.email}\n`;
    msg += isCatalogQuote ? "\n*Productos a cotizar:*\n" : "\n*Productos:*\n";

    items.forEach((item, i) => {
      const price = item.product.wholesalePrice || item.product.price || 0;
      const ref = item.product.sku ? ` (Ref: ${item.product.sku})` : "";
      const variant = item.product.variantName
        ? ` [Variacion: ${item.product.variantName}]`
        : "";
      const itemCatalogMode = isItemInCatalogMode(item.product, catalogMode);
      msg += `${i + 1}. ${item.product.name}${ref}${variant} x${item.quantity}`;
      if (!itemCatalogMode && price) msg += ` - ${formatPrice(price)} c/u`;
      msg += "\n";
    });

    if (!isCatalogQuote && subtotal > 0) msg += `\n*Subtotal:* ${formatPrice(subtotal)}`;
    if (customerInfo.notes) msg += `\n\n*Notas:* ${customerInfo.notes}`;
    return msg;
  };

  const whatsappUrl = `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(generateWhatsAppMessage())}`;

  const handleCreateOrder = async (sentVia: string) => {
    setOrderError(null);

    // First save the cart if not already saved
    let cartId = savedCartUuid;
    if (!cartId) {
      cartId = await handleSaveCart();
      if (!cartId) cartId = useCartStore.getState().savedCartUuid;
    }
    if (!cartId) {
      toast.error("Error al guardar el carrito");
      setOrderError("No pudimos guardar el carrito antes de crear el pedido. Intentá nuevamente.");
      return false;
    }

    setCreatingOrder(true);
    try {
      // We need the server cart ID, so fetch it
      const cartRes = await fetch(`/api/carts/${cartId}`);
      const cartData = await cartRes.json();
      if (!cartData.success) {
        toast.error("Error al obtener el carrito guardado");
        setOrderError("No pudimos recuperar el carrito guardado. Intentá nuevamente.");
        return false;
      }

      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cartId: cartData.data.id,
          customerName: customerInfo.name || "Cliente",
          customerEmail: customerInfo.email || null,
          customerPhone: customerInfo.phone || null,
          customerCompany: customerInfo.company || null,
          cityId: customerInfo.cityId || null,
          notes: customerInfo.notes || null,
          sentVia,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setOrderNumber(data.data.orderNumber);
        if (sentVia === "sistema") {
          setOrderDialogOpen(true);
        }
        return true;
      } else {
        toast.error(data.error || "Error al crear pedido");
        setOrderError(data.error || "No pudimos crear el pedido en este momento.");
        return false;
      }
    } catch {
      toast.error("Error al crear el pedido");
      setOrderError("Error interno al crear el pedido. Intentá nuevamente en unos minutos.");
      return false;
    } finally {
      setCreatingOrder(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-between mb-8">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          const isActive = i === currentStep;
          const isCompleted = i < currentStep;
          return (
            <div key={step.id} className="flex items-center">
              <button
                onClick={() => i < currentStep && setCurrentStep(i)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? "bg-blue-100 text-blue-700"
                    : isCompleted
                    ? "text-green-600 cursor-pointer hover:bg-green-50"
                    : "text-slate-400"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <Icon className="h-5 w-5" />
                )}
                <span className="text-sm font-medium hidden sm:inline">{step.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div className={`w-8 h-px mx-1 ${isCompleted ? "bg-green-300" : "bg-slate-200"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <Card>
        <CardContent className="p-6">
          {/* Step 0: Resumen */}
          {currentStep === 0 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">
                {hasCatalogItems ? "Lista de cotización" : "Resumen del pedido"} ({itemCount} productos)
              </h2>
              {hasCatalogItems && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                  <p className="text-sm text-amber-800">
                    📋 Los precios serán cotizados personalmente.
                    Completa tus datos para recibir la cotización.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                {items.map((item) => (
                  <CartItemRow
                    key={getCartItemKey(item.product.id, item.product.variantId)}
                    item={item}
                    hidePrices={isItemInCatalogMode(item.product, catalogMode)}
                  />
                ))}
              </div>
              <Separator className="my-4" />
              {hasCatalogItems ? (
                <p className="text-sm text-slate-500">
                  Precios por cotización.
                </p>
              ) : (
                <>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">Subtotal</span>
                    <span className="text-xl font-bold text-slate-900">{formatPrice(subtotal)}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Precios mayoristas sujetos a confirmación
                  </p>
                </>
              )}
            </div>
          )}

          {/* Step 1: Datos del cliente */}
          {currentStep === 1 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Datos de contacto</h2>
              <p className="text-sm text-slate-500 mb-4">
                Completa tus datos para que podamos contactarte (opcional)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Nombre</Label>
                  <Input
                    id="name"
                    placeholder="Tu nombre"
                    value={customerInfo.name}
                    onChange={(e) => setCustomerInfo({ name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="company">Empresa / Negocio</Label>
                  <Input
                    id="company"
                    placeholder="Nombre del negocio"
                    value={customerInfo.company}
                    onChange={(e) => setCustomerInfo({ company: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Teléfono</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="300 000 0000"
                    value={customerInfo.phone}
                    onChange={(e) => setCustomerInfo({ phone: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="email">Correo electrónico</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="tu@email.com"
                    value={customerInfo.email}
                    onChange={(e) => setCustomerInfo({ email: e.target.value })}
                  />
                </div>
              </div>
              <div className="mt-4">
                <Label htmlFor="notes">Notas adicionales</Label>
                <Textarea
                  id="notes"
                  placeholder="Indicaciones especiales, cantidades personalizadas, etc."
                  value={customerInfo.notes}
                  onChange={(e) => setCustomerInfo({ notes: e.target.value })}
                  rows={3}
                />
              </div>
            </div>
          )}

          {/* Step 2: Envío */}
          {currentStep === 2 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Información de envío</h2>
              <p className="text-sm text-slate-500 mb-4">
                Selecciona tu ciudad para ver las rutas de envío disponibles
              </p>
              <CitySelector />
            </div>
          )}

          {/* Step 3: Confirmar */}
          {currentStep === 3 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-1">
                {hasCatalogItems ? "Confirmar solicitud de cotización" : "Confirmar pedido"}
              </h2>
              <p className="text-sm text-slate-500 mb-5">
                Revisá el resumen y elegí cómo querés proceder
              </p>

              {/* Summary card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 mb-6">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Resumen
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Productos</span>
                  <span className="font-medium">{itemCount} ítems</span>
                </div>
                {customerInfo.name && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Cliente</span>
                    <span className="font-medium">{customerInfo.name}</span>
                  </div>
                )}
                {customerInfo.company && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Empresa</span>
                    <span className="font-medium">{customerInfo.company}</span>
                  </div>
                )}
                {!hasCatalogItems && subtotal > 0 && (
                  <>
                    <Separator />
                    <div className="flex justify-between">
                      <span className="text-slate-600 font-medium">Subtotal</span>
                      <span className="text-lg font-bold text-blue-600">{formatPrice(subtotal)}</span>
                    </div>
                    <p className="text-xs text-slate-400">Precios mayoristas sujetos a confirmación</p>
                  </>
                )}
                {hasCatalogItems && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
                    📋 Los precios serán cotizados de forma personalizada
                  </p>
                )}
              </div>

              {/* Actions */}
              {orderNumber && !orderDialogOpen ? (
                <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto mb-3" />
                  <p className="text-lg font-bold text-green-800">
                    {hasCatalogItems ? "¡Solicitud enviada!" : "¡Pedido registrado!"}
                  </p>
                  <p className="text-sm font-mono text-green-700 mt-1">{orderNumber}</p>
                  <p className="text-xs text-green-600 mt-2">
                    {hasCatalogItems
                      ? "Recibimos tu solicitud. Te enviaremos la cotización pronto."
                      : "Tu pedido está registrado. Pronto nos comunicamos para confirmar los detalles."}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {orderError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                      <p className="text-sm text-red-700">{orderError}</p>
                    </div>
                  )}

                  {/* Primary action */}
                  <Button
                    className="w-full bg-green-600 hover:bg-green-700 gap-2 h-12 text-base font-semibold"
                    disabled={creatingOrder}
                    onClick={async () => {
                      const ok = await handleCreateOrder("whatsapp");
                      if (ok) {
                        window.open(whatsappUrl, "_blank");
                      }
                    }}
                  >
                    <MessageCircle className="h-5 w-5" />
                    {creatingOrder ? "Procesando..." : "Hacer pedido por WhatsApp"}
                  </Button>

                  <div className="flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-xs text-slate-400 whitespace-nowrap">o también</span>
                    <Separator className="flex-1" />
                  </div>

                  {/* Secondary action */}
                  <Button
                    variant="outline"
                    className="w-full gap-2 h-11"
                    onClick={() => handleCreateOrder("sistema")}
                    disabled={creatingOrder || saving}
                  >
                    <ClipboardCheck className="h-4 w-4" />
                    {creatingOrder ? "Registrando..." : "Hacer pedido"}
                  </Button>

                  {/* Tertiary actions */}
                  <div className="flex gap-2 pt-1">
                    <Button
                      variant="ghost"
                      className="flex-1 gap-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 h-10"
                      onClick={handleSaveCartAndShow}
                      disabled={saving}
                    >
                      <Save className="h-4 w-4" />
                      {saving ? "Guardando..." : "Guardar carrito"}
                    </Button>
                    <ShareCartMenu />
                  </div>
                </div>
              )}

              {/* Dialogs */}
              <Dialog open={orderDialogOpen} onOpenChange={setOrderDialogOpen}>
                <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[28rem] sm:max-w-md">
                  <DialogHeader>
                    <div className="flex justify-center mb-2">
                      <div className="bg-green-100 rounded-full p-3">
                        <CheckCircle2 className="h-8 w-8 text-green-600" />
                      </div>
                    </div>
                    <DialogTitle className="text-center text-green-800">
                      {hasCatalogItems ? "¡Solicitud registrada!" : "¡Pedido registrado!"}
                    </DialogTitle>
                    <DialogDescription className="text-center">
                      <span className="block font-mono text-base font-semibold text-slate-800 mt-1 break-all">
                        {orderNumber}
                      </span>
                      <span className="block text-sm mt-3 text-slate-600">
                        {hasCatalogItems
                          ? "Recibimos tu solicitud de cotización. Pronto nos vamos a comunicar con vos para enviarte los precios."
                          : "Tu pedido quedó registrado. Pronto nos vamos a comunicar con vos para confirmar los detalles y coordinar la entrega."}
                      </span>
                    </DialogDescription>
                  </DialogHeader>
                  {cartUrl && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                        Enlace de tu carrito
                      </p>
                      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs text-slate-600 flex-1 min-w-0 font-mono break-all leading-tight">
                          {cartUrl}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 shrink-0"
                          onClick={handleCopyUrl}
                        >
                          {copiedUrl ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-slate-400 mt-1.5">
                        Podés usar este enlace para retomar o compartir tu carrito
                      </p>
                    </div>
                  )}
                  <Button
                    className="w-full mt-2 bg-blue-600 hover:bg-blue-700"
                    onClick={() => setOrderDialogOpen(false)}
                  >
                    Entendido
                  </Button>
                </DialogContent>
              </Dialog>

              <Dialog open={cartDialogOpen} onOpenChange={setCartDialogOpen}>
                <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[28rem] sm:max-w-md">
                  <DialogHeader>
                    <div className="flex justify-center mb-2">
                      <div className="bg-blue-100 rounded-full p-3">
                        <Save className="h-8 w-8 text-blue-600" />
                      </div>
                    </div>
                    <DialogTitle className="text-center text-blue-800">
                      ¡Carrito guardado!
                    </DialogTitle>
                    <DialogDescription className="text-center text-sm text-slate-600 mt-1">
                      Tu carrito fue guardado. Podés retomarlo o compartirlo usando el siguiente enlace:
                    </DialogDescription>
                  </DialogHeader>
                  {cartUrl && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs text-slate-600 flex-1 min-w-0 font-mono break-all leading-tight">
                          {cartUrl}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 shrink-0"
                          onClick={handleCopyUrl}
                        >
                          {copiedUrl ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-slate-400 mt-2">
                        Guardá este enlace para continuar tu pedido desde cualquier dispositivo
                      </p>
                    </div>
                  )}
                  <Button
                    className="w-full mt-2 bg-blue-600 hover:bg-blue-700"
                    onClick={() => setCartDialogOpen(false)}
                  >
                    Listo
                  </Button>
                </DialogContent>
              </Dialog>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation buttons */}
      <div className="flex justify-between mt-6">
        <Button
          variant="outline"
          onClick={prev}
          disabled={currentStep === 0}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Anterior
        </Button>
        {currentStep < STEPS.length - 1 && (
          <Button onClick={next} className="gap-2 bg-blue-600 hover:bg-blue-700">
            Siguiente
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mt-3">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/catalogo">Ver más productos</Link>
        </Button>
      </div>
    </div>
  );
}
