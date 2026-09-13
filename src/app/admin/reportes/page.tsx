import { redirect } from "next/navigation";
import Link from "next/link";
import { requireBackofficeUser, isAgentRole } from "@/lib/auth";
import {
  buildCommercialReport,
  resolveReportingQuery,
  REPORTING_PERIOD_PRESETS,
  type ReportingPeriodPreset,
} from "@/lib/commercial-reporting";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/admin/order-status-badge";
import { MonthlyActivityChart } from "@/components/admin/reporting/monthly-activity-chart";
import {
  Users,
  UserCheck,
  ShoppingBag,
  ClipboardList,
  BarChart3,
  Calendar,
  User,
  TrendingUp,
} from "lucide-react";
import { formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PERIOD_LABELS: Record<ReportingPeriodPreset, string> = {
  "30d": "Últimos 30 días",
  "90d": "Últimos 90 días",
  "6m": "Últimos 6 meses",
  all: "Todo el histórico",
};

// REPORTES COMERCIALES: el AGENT sólo ve SU cartera y SU producción; el
// desglose por asesor (y el bucket "Sin asesor") es exclusivo de
// ADMIN/EDITOR. Toda consulta vive scopeada en `commercial-reporting`;
// esta página no accede a la base de datos por su cuenta.
export default async function AdminReportesPage({ searchParams }: Props) {
  const user = await requireBackofficeUser();
  if (!user) redirect("/admin/login");

  const isAgent = isAgentRole(user.role);
  const params = await searchParams;
  const options = resolveReportingQuery(user, params);
  const report = await buildCommercialReport(user, options);

  const reportsHref = (preset: ReportingPeriodPreset) =>
    `/admin/reportes?periodo=${preset}${
      options.asesorId ? `&asesor=${encodeURIComponent(options.asesorId)}` : ""
    }`;

  const stats = [
    {
      title: isAgent ? "Mis clientes" : "Clientes",
      value: report.portfolio.customersCount,
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Clientes activos",
      value: report.portfolio.activeCustomersCount,
      icon: UserCheck,
      color: "text-cyan-600",
      bgColor: "bg-cyan-50",
    },
    {
      title: isAgent ? "Mis pedidos" : "Pedidos",
      value: report.orders.count,
      detail: formatPrice(report.orders.total),
      icon: ShoppingBag,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: isAgent ? "Mis cotizaciones" : "Cotizaciones",
      value: report.quotes.count,
      detail: formatPrice(report.quotes.total),
      icon: ClipboardList,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
  ];

  return (
    <div>
      <Header
        title={isAgent ? "Mis reportes" : "Reportes comerciales"}
        subtitle={`Actividad de pedidos y cotizaciones · ${PERIOD_LABELS[report.preset]}`}
      />

      {/* Filtros de periodo (+ asesor sólo para ADMIN/EDITOR) */}
      <div className="px-6 py-4 border-b border-slate-200 space-y-3">
        <div className="flex gap-2 flex-wrap items-center">
          {REPORTING_PERIOD_PRESETS.map((preset) => (
            <Link key={preset} href={reportsHref(preset)}>
              <Badge
                variant={report.preset === preset ? "default" : "outline"}
                className="cursor-pointer"
              >
                {PERIOD_LABELS[preset]}
              </Badge>
            </Link>
          ))}
        </div>

        {report.agentOptions !== null && (
          <form
            method="GET"
            action="/admin/reportes"
            className="flex items-center gap-2 flex-wrap"
          >
            <input type="hidden" name="periodo" value={report.preset} />
            <label
              htmlFor="asesor-filter"
              className="text-sm text-slate-600"
            >
              Asesor
            </label>
            <select
              id="asesor-filter"
              name="asesor"
              defaultValue={options.asesorId ?? ""}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
            >
              <option value="">Todos los asesores</option>
              {report.agentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline">
              Aplicar
            </Button>
          </form>
        )}
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat) => (
            <Card key={stat.title} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div
                  className={`w-10 h-10 ${stat.bgColor} rounded-lg flex items-center justify-center mb-3`}
                >
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
                {stat.detail && (
                  <p className={`text-sm font-medium ${stat.color}`}>{stat.detail}</p>
                )}
                <p className="text-xs text-slate-500 mt-0.5">{stat.title}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Evolución mensual */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Evolución mensual</CardTitle>
            <BarChart3 className="h-5 w-5 text-slate-400" />
          </CardHeader>
          <CardContent>
            {report.monthly.length === 0 ? (
              <div className="text-center py-10 text-slate-500">
                <BarChart3 className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                <p>No hay actividad en este periodo</p>
              </div>
            ) : (
              <MonthlyActivityChart data={report.monthly} />
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Desglose por estado y tipo */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Por estado</CardTitle>
            </CardHeader>
            <CardContent>
              {report.statusBreakdown.length === 0 ? (
                <p className="text-center py-8 text-slate-500">
                  Sin pedidos ni cotizaciones en este periodo
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {report.statusBreakdown.map((row) => (
                    <div
                      key={`${row.status}-${row.requestType}`}
                      className="flex items-center justify-between py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <OrderStatusBadge status={row.status} />
                        {row.requestType === "cotizacion" && (
                          <Badge
                            variant="outline"
                            className="text-xs text-orange-600 border-orange-200 bg-orange-50"
                          >
                            Cotización
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm font-semibold text-slate-900">
                        {row.count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Actividad reciente */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">Actividad reciente</CardTitle>
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/pedidos">Ver todos</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {report.recent.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <ClipboardList className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                  <p>Aún no hay actividad</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {report.recent.map((order) => (
                    <Link
                      key={order.id}
                      href={`/admin/pedidos/${order.id}`}
                      className="flex items-center justify-between py-2.5 hover:bg-slate-50 rounded px-2 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-mono font-bold text-slate-900">
                            {order.orderNumber}
                          </p>
                          <OrderStatusBadge status={order.status} />
                          {order.requestType === "cotizacion" && (
                            <Badge
                              variant="outline"
                              className="text-xs text-orange-600 border-orange-200 bg-orange-50"
                            >
                              Cotización
                            </Badge>
                          )}
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
                      <span className="text-sm font-semibold text-blue-600 flex-shrink-0">
                        {formatPrice(order.subtotal)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Desglose por asesor: exclusivo ADMIN/EDITOR, visión global */}
        {report.perAgent !== null && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">Desglose por asesor</CardTitle>
              <TrendingUp className="h-5 w-5 text-slate-400" />
            </CardHeader>
            <CardContent>
              {report.perAgent.length === 0 ? (
                <p className="text-center py-8 text-slate-500">
                  Sin actividad en este periodo
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th className="pb-2 pr-4 font-medium">Asesor</th>
                        <th className="pb-2 pr-4 font-medium">Clientes</th>
                        <th className="pb-2 pr-4 font-medium">Pedidos</th>
                        <th className="pb-2 pr-4 font-medium">Importe pedidos</th>
                        <th className="pb-2 pr-4 font-medium">Cotizaciones</th>
                        <th className="pb-2 pr-4 font-medium">Importe cotizaciones</th>
                        <th className="pb-2 font-medium">Total periodo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {report.perAgent.map((row) => (
                        <tr key={row.agentId ?? "(sin-asesor)"}>
                          <td className="py-2.5 pr-4">
                            {row.agentId === null ? (
                              <span className="text-slate-500 italic">
                                Sin asesor
                              </span>
                            ) : (
                              <span className="font-medium text-slate-900">
                                {row.agentName || "Asesor"}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-700">
                            {row.customersCount}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-700">
                            {row.ordersCount}
                          </td>
                          <td className="py-2.5 pr-4 font-medium text-green-700">
                            {formatPrice(row.ordersTotal)}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-700">
                            {row.quotesCount}
                          </td>
                          <td className="py-2.5 pr-4 font-medium text-amber-700">
                            {formatPrice(row.quotesTotal)}
                          </td>
                          <td className="py-2.5 font-semibold text-slate-900">
                            {formatPrice(row.ordersTotal + row.quotesTotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
