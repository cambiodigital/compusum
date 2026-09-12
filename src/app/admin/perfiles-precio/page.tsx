import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Tag, Users } from "lucide-react";
import { formatPrice } from "@/lib/format";
import { PriceProfileDialog } from "@/components/admin/price-profile-dialog";

export const dynamic = "force-dynamic";

/**
 * Administración de perfiles de precio (listas comerciales).
 * El precio base Siesa nunca se toca: los overrides viven en tablas separadas.
 */
export default async function AdminPerfilesPrecioPage() {
  const user = await requireAdminUser();
  if (!user) redirect("/admin/login");

  const profiles = await db.priceProfile.findMany({
    include: {
      _count: { select: { users: true, productOverrides: true, variantOverrides: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <Header
        title="Perfiles de precio"
        subtitle={`${profiles.length} perfiles comerciales`}
      />

      <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          Jerarquía: override de variante &gt; override de producto &gt; ajuste % del perfil &gt; precio base Siesa.
        </p>
        <div className="flex items-center gap-2">
          <Link href="/admin/clientes" className="text-sm text-blue-600 hover:underline">
            Asignar en Clientes
          </Link>
          <PriceProfileDialog mode="create" />
        </div>
      </div>

      <div className="p-6 space-y-3">
        {profiles.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Tag className="h-10 w-10 mx-auto mb-3 text-slate-300" />
            <p className="font-medium">No hay perfiles de precio</p>
            <p className="text-sm mt-1">
              Sin perfiles, todos los clientes usan el precio base (mayorista de Siesa).
            </p>
          </div>
        ) : (
          profiles.map((profile) => (
            <Card key={profile.id}>
              <CardContent className="p-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-slate-900">{profile.name}</h3>
                    <Badge variant="outline" className="text-xs font-mono">
                      {profile.code}
                    </Badge>
                    {profile.isDefault && (
                      <Badge className="text-xs bg-blue-600">Por defecto</Badge>
                    )}
                    {!profile.isActive && (
                      <Badge variant="destructive" className="text-xs">
                        Inactivo
                      </Badge>
                    )}
                    {profile.percentAdjustment !== null && (
                      <Badge variant="secondary" className="text-xs">
                        {profile.percentAdjustment > 0 ? "+" : ""}
                        {profile.percentAdjustment}% sobre base
                      </Badge>
                    )}
                  </div>
                  {profile.description && (
                    <p className="text-sm text-slate-500 mt-1">{profile.description}</p>
                  )}
                  <div className="flex gap-4 mt-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {profile._count.users} cliente(s)
                    </span>
                    <span>{profile._count.productOverrides} overrides de producto</span>
                    <span>{profile._count.variantOverrides} overrides de variante</span>
                  </div>
                </div>
                <PriceProfileDialog
                  mode="edit"
                  profileId={profile.id}
                  triggerLabel="Editar"
                />
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
