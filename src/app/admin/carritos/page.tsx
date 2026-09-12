import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CartListDeleteButton } from "@/components/admin/cart-list-delete-button";
import Link from "next/link";
import {
  ShoppingCart,
  User,
  Building2,
  Calendar,
} from "lucide-react";
import { formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ status?: string; page?: string }>;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  activo: { label: "Activo", className: "bg-green-100 text-green-700" },
  compartido: { label: "Compartido", className: "bg-blue-100 text-blue-700" },
  convertido: { label: "Convertido", className: "bg-purple-100 text-purple-700" },
  expirado: { label: "Expirado", className: "bg-slate-100 text-slate-600" },
};

export default async function AdminCarritosPage({ searchParams }: Props) {
  const user = await requireAdminUser();
  if (!user) redirect("/admin/login");

  const params = await searchParams;
  const page = parseInt(params.page || "1");
  const limit = 20;

  const where: Record<string, unknown> = {};
  if (params.status) where.status = params.status;

  const [carts, total] = await Promise.all([
    db.cart.findMany({
      where,
      include: {
        items: { select: { id: true } },
        city: { include: { department: true } },
        _count: { select: { items: true, orders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.cart.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <Header
        title="Carritos"
        subtitle={`${total} carritos guardados`}
      />

      {/* Filters */}
      <div className="px-6 py-4 border-b border-slate-200">
        <div className="flex gap-2 flex-wrap">
          <Link href="/admin/carritos">
            <Badge
              variant={!params.status ? "default" : "outline"}
              className="cursor-pointer"
            >
              Todos
            </Badge>
          </Link>
          {Object.entries(statusConfig).map(([key, config]) => (
            <Link key={key} href={`/admin/carritos?status=${key}`}>
              <Badge
                variant={params.status === key ? "default" : "outline"}
                className="cursor-pointer"
              >
                {config.label}
              </Badge>
            </Link>
          ))}
        </div>
      </div>

      {/* Cart list */}
      <div className="p-6">
        {carts.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ShoppingCart className="h-12 w-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500">No hay carritos guardados</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {carts.map((cart) => {
              const status = statusConfig[cart.status] || statusConfig.activo;
              return (
                <Card
                  key={cart.id}
                  className={`relative transition-colors hover:border-slate-300 ${!cart.isActive ? "opacity-50" : ""}`}
                >
                  <Link
                    href={`/admin/carritos/${cart.id}`}
                    className="absolute inset-0 z-0"
                    aria-label={`Abrir carrito ${cart.customerName || cart.uuid}`}
                  />
                  <CardContent className="p-4">
                    <div className="relative z-10 flex items-center justify-between pointer-events-none">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {cart.customerName ? (
                            <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                              <User className="h-3.5 w-3.5 text-slate-400" />
                              {cart.customerName}
                            </span>
                          ) : (
                            <span className="text-sm text-slate-400">Sin nombre</span>
                          )}
                          {cart.customerCompany && (
                            <span className="flex items-center gap-1 text-xs text-slate-500">
                              <Building2 className="h-3 w-3" />
                              {cart.customerCompany}
                            </span>
                          )}
                          <Badge className={status.className}>{status.label}</Badge>
                          {!cart.isActive && (
                            <Badge variant="outline" className="text-red-600 border-red-200">
                              Desactivado
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                          <span>{cart._count.items} productos</span>
                          <span className="font-medium text-blue-600">
                            {formatPrice(cart.subtotal)}
                          </span>
                          {cart.city && (
                            <span>
                              {cart.city.name}, {cart.city.department.name}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(cart.createdAt).toLocaleDateString("es-CO")}
                          </span>
                          {cart._count.orders > 0 && (
                            <Badge variant="outline" className="text-purple-600">
                              {cart._count.orders} pedido(s)
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="ml-4 pointer-events-auto">
                        <CartListDeleteButton
                          cartId={cart.id}
                          hasOrders={cart._count.orders > 0}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-6">
            {Array.from({ length: totalPages }, (_, i) => (
              <Link
                key={i}
                href={`/admin/carritos?${params.status ? `status=${params.status}&` : ""}page=${i + 1}`}
              >
                <Button
                  variant={page === i + 1 ? "default" : "outline"}
                  size="sm"
                >
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
