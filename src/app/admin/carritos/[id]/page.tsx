import { redirect, notFound } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { SafeProductImage } from "@/components/store/safe-product-image";
import {
  User,
  Mail,
  Phone,
  Building2,
  MapPin,
  Truck,
  Clock,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CartAdminActions } from "@/components/admin/cart-admin-actions";
import { formatPrice } from "@/lib/format";
import { resolveProductImageSrc } from "@/lib/product-fallbacks";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  activo: { label: "Activo", className: "bg-green-100 text-green-700" },
  compartido: { label: "Compartido", className: "bg-blue-100 text-blue-700" },
  convertido: { label: "Convertido", className: "bg-purple-100 text-purple-700" },
  expirado: { label: "Expirado", className: "bg-slate-100 text-slate-600" },
};

export default async function AdminCartDetailPage({ params }: Props) {
  const user = await requireAdminUser();
  if (!user) redirect("/admin/login");

  const { id } = await params;

  const cart = await db.cart.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: {
            include: {
              brand: { select: { name: true } },
              category: { select: { name: true } },
            },
          },
        },
      },
      city: { include: { department: true, shippingRoute: true } },
      orders: {
        select: { id: true, orderNumber: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!cart) notFound();

  const status = statusConfig[cart.status] || statusConfig.activo;

  return (
    <div>
      <Header
        title="Detalle del carrito"
        subtitle={`UUID: ${cart.uuid}`}
      />

      <div className="p-6 space-y-6">
        {/* Back + Actions */}
        <div className="flex items-center justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link href="/admin/carritos">
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Badge className={status.className}>{status.label}</Badge>
            {!cart.isActive && (
              <Badge variant="outline" className="text-red-600 border-red-200">
                Desactivado
              </Badge>
            )}
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={`/carrito/${cart.uuid}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                Ver enlace público
              </a>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Customer Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Datos del cliente</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {cart.customerName && (
                <div className="flex items-center gap-2 text-slate-600">
                  <User className="h-4 w-4 text-slate-400" />
                  {cart.customerName}
                </div>
              )}
              {cart.customerEmail && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Mail className="h-4 w-4 text-slate-400" />
                  {cart.customerEmail}
                </div>
              )}
              {cart.customerPhone && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone className="h-4 w-4 text-slate-400" />
                  {cart.customerPhone}
                </div>
              )}
              {cart.customerCompany && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  {cart.customerCompany}
                </div>
              )}
              {!cart.customerName && !cart.customerEmail && !cart.customerPhone && (
                <p className="text-slate-400">Sin datos de cliente</p>
              )}
            </CardContent>
          </Card>

          {/* Shipping */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Envío</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {cart.city ? (
                <>
                  <div className="flex items-center gap-2 text-slate-600">
                    <MapPin className="h-4 w-4 text-slate-400" />
                    {cart.city.name}, {cart.city.department.name}
                  </div>
                  {cart.city.shippingRoute && (
                    <>
                      <div className="flex items-center gap-2 text-slate-600">
                        <Truck className="h-4 w-4 text-slate-400" />
                        {cart.city.shippingRoute.name}
                      </div>
                      <div className="flex items-center gap-2 text-slate-600">
                        <Clock className="h-4 w-4 text-slate-400" />
                        {cart.city.shippingRoute.estimatedDaysMin}-{cart.city.shippingRoute.estimatedDaysMax} días hábiles
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="text-slate-400">Sin ciudad seleccionada</p>
              )}
            </CardContent>
          </Card>

          {/* Admin Actions */}
          <CartAdminActions
            cartId={cart.id}
            isActive={cart.isActive}
            status={cart.status}
            customerName={cart.customerName}
            customerEmail={cart.customerEmail}
            customerPhone={cart.customerPhone}
            customerCompany={cart.customerCompany}
            notes={cart.notes}
            hasOrders={cart.orders.length > 0}
          />
        </div>

        {/* Products */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Productos ({cart.items.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-100">
              {cart.items.map((item) => {
                const price = item.unitPrice || item.product.wholesalePrice || item.product.price || 0;
                return (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="relative w-12 h-12 flex-shrink-0 bg-slate-50 rounded-lg overflow-hidden">
                      <SafeProductImage
                        src={resolveProductImageSrc(item.product.slug, "60/60")}
                        alt={item.product.name}
                        fill
                        className="object-cover"
                        sizes="48px"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {item.product.name}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        {item.product.sku && <span>Ref: {item.product.sku}</span>}
                        {item.product.brand && <span>{item.product.brand.name}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-slate-600">x{item.quantity}</p>
                      <p className="text-sm font-semibold text-blue-600">
                        {formatPrice(price * item.quantity)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <Separator />
            <div className="flex justify-between items-center px-4 py-3">
              <span className="font-medium text-slate-700">Subtotal</span>
              <span className="text-lg font-bold text-slate-900">
                {formatPrice(cart.subtotal)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Orders linked */}
        {cart.orders.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pedidos asociados</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {cart.orders.map((order) => (
                  <Link
                    key={order.id}
                    href={`/admin/pedidos/${order.id}`}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-sm font-mono font-medium">{order.orderNumber}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{order.status}</Badge>
                      <span className="text-xs text-slate-500">
                        {new Date(order.createdAt).toLocaleDateString("es-CO")}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Notes */}
        {cart.notes && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notas</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">{cart.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
