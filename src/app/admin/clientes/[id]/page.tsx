import { redirect } from "next/navigation";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBackofficeUser, isAgentRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { listActiveAgents, listActivePriceProfiles } from "@/lib/customers-admin";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/format";
import {
  Mail,
  Phone,
  Building2,
  MapPin,
  UserCheck,
  Tag,
  ArrowLeft,
  ShoppingBag,
  ClipboardList,
} from "lucide-react";
import { CustomerFormDialog } from "@/components/admin/customer-form-dialog";
import { CustomerStateActions } from "@/components/admin/customer-state-actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Detalle del cliente del MAESTRO (User CUSTOMER) con edición y actividad.
 * El AGENT comercial SOLO accede a SUS clientes (assignedAgentId = self);
 * además, su query NUNCA trae el hash de contraseña.
 */
export default async function AdminCustomerDetailPage({ params }: Props) {
  const user = await requireBackofficeUser();
  if (!user) redirect("/admin/login");

  const isAgent = isAgentRole(user.role);
  const { id } = await params;

  const customer = await db.user.findFirst({
    where: {
      id,
      role: "CUSTOMER",
      ...(isAgent ? { assignedAgentId: user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      taxId: true,
      address: true,
      city: true,
      notes: true,
      isActive: true,
      createdAt: true,
      assignedAgentId: true,
      priceProfileId: true,
      assignedAgent: { select: { id: true, name: true, email: true } },
      priceProfile: { select: { id: true, name: true, code: true } },
      _count: { select: { orders: true } },
    },
  });

  if (!customer) notFound();

  const [agents, profiles, orders, stats] = await Promise.all([
    // Capacidad global-admin: el AGENT no necesita roster de asesores ni
    // perfiles de precio (su formulario los oculta).
    isAgent ? Promise.resolve([]) : listActiveAgents(),
    isAgent ? Promise.resolve([]) : listActivePriceProfiles(),
    db.order.findMany({
      where: { customerId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, orderNumber: true, status: true, subtotal: true, createdAt: true },
    }),
    db.order.aggregate({
      where: { customerId: id },
      _count: { _all: true },
      _sum: { subtotal: true },
    }),
  ]);

  return (
    <div>
      <Header title={customer.name} subtitle={`Cliente del maestro · ${customer.isActive ? "Activo" : "Inactivo"}`} />

      <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/clientes">
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver al maestro
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          {!isAgent && (
            <CustomerStateActions
              customerId={customer.id}
              isActive={customer.isActive}
              hasOrders={customer._count.orders > 0}
            />
          )}
          <CustomerFormDialog
            mode="edit"
            customerId={customer.id}
            agents={agents}
            profiles={profiles}
            agentView={isAgent}
            initialValues={{
              name: customer.name,
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              company: customer.company ?? "",
              taxId: customer.taxId ?? "",
              address: customer.address ?? "",
              city: customer.city ?? "",
              notes: customer.notes ?? "",
              isActive: customer.isActive,
              assignedAgentId: customer.assignedAgentId ?? "",
              priceProfileId: customer.priceProfileId ?? "",
            }}
            trigger={
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                Editar cliente
              </Button>
            }
          />
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Datos del cliente */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Datos del cliente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {customer.email && (
              <p className="flex items-center gap-2 text-slate-600">
                <Mail className="h-4 w-4 text-slate-400" /> {customer.email}
              </p>
            )}
            {customer.phone && (
              <p className="flex items-center gap-2 text-slate-600">
                <Phone className="h-4 w-4 text-slate-400" /> {customer.phone}
              </p>
            )}
            {customer.company && (
              <p className="flex items-center gap-2 text-slate-600">
                <Building2 className="h-4 w-4 text-slate-400" /> {customer.company}
              </p>
            )}
            {customer.taxId && (
              <p className="text-slate-600 text-xs">NIT: {customer.taxId}</p>
            )}
            {(customer.address || customer.city) && (
              <p className="flex items-center gap-2 text-slate-600">
                <MapPin className="h-4 w-4 text-slate-400" />
                {[customer.address, customer.city].filter(Boolean).join(", ")}
              </p>
            )}
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <p className="flex items-center gap-2 text-slate-700">
                <UserCheck className="h-4 w-4 text-slate-400" />
                Asesor:{" "}
                {customer.assignedAgent ? (
                  <span className="font-medium">{customer.assignedAgent.name}</span>
                ) : (
                  <span className="text-slate-400">Sin asesor</span>
                )}
              </p>
              <p className="flex items-center gap-2 text-slate-700">
                <Tag className="h-4 w-4 text-slate-400" />
                Perfil de precio:{" "}
                {customer.priceProfile ? (
                  <Badge variant="outline" className="text-xs">
                    {customer.priceProfile.name} ({customer.priceProfile.code})
                  </Badge>
                ) : (
                  <span className="text-slate-400">Precio base</span>
                )}
              </p>
              <p className="text-xs text-slate-400">
                Registro: {customer.createdAt.toLocaleDateString("es-CO")}
              </p>
              {customer.notes && (
                <p className="text-xs text-slate-500 whitespace-pre-wrap border-l-2 border-slate-200 pl-2">
                  {customer.notes}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Actividad */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-slate-400" /> Actividad
              </CardTitle>
              <div className="flex gap-4 text-sm text-slate-600">
                <span className="flex items-center gap-1">
                  <ShoppingBag className="h-4 w-4 text-green-500" />
                  {stats._count._all} pedidos
                </span>
                <span className="font-medium text-blue-600">
                  {formatPrice(stats._sum.subtotal ?? 0)}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">
                Este cliente aún no tiene pedidos asociados en el maestro.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {orders.map((order) => (
                  <Link
                    key={order.id}
                    href={`/admin/pedidos/${order.id}`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50 rounded px-2 transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">{order.orderNumber}</p>
                      <p className="text-xs text-slate-500">
                        {order.createdAt.toLocaleDateString("es-CO")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-blue-600">
                        {formatPrice(order.subtotal)}
                      </p>
                      <Badge variant="outline" className="text-xs">
                        {order.status}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
