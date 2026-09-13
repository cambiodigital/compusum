"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatPrice } from "@/lib/format";

/**
 * Evolución mensual de actividad comercial (Fase 4C). Serie sobre
 * `Order.createdAt` con pedido/cotización siempre separados. Las barras
 * muestran volumen; el tooltip añade el importe mensual de cada tipo.
 * Los datos ya llegan scopeados y densificados desde el server.
 */

const chartConfig = {
  orders: {
    label: "Pedidos",
    color: "#2563eb",
  },
  quotes: {
    label: "Cotizaciones",
    color: "#ea580c",
  },
} satisfies ChartConfig;

export interface MonthlyActivityChartData {
  month: string;
  ordersCount: number;
  ordersTotal: number;
  quotesCount: number;
  quotesTotal: number;
}

function formatMonthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  return date.toLocaleDateString("es-CO", { month: "short", year: "2-digit" });
}

export function MonthlyActivityChart({
  data,
}: {
  data: MonthlyActivityChartData[];
}) {
  const chartData = data.map((point) => ({
    month: point.month,
    label: formatMonthLabel(point.month),
    orders: point.ordersCount,
    quotes: point.quotesCount,
    ordersTotal: point.ordersTotal,
    quotesTotal: point.quotesTotal,
  }));

  return (
    <ChartContainer config={chartConfig} className="h-[280px] w-full">
      <BarChart accessibilityLayer data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          tickMargin={8}
          axisLine={false}
        />
        <YAxis allowDecimals={false} width={32} axisLine={false} tickLine={false} />
        <ChartTooltip
          cursor={false}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as {
              orders: number;
              quotes: number;
              ordersTotal: number;
              quotesTotal: number;
            };
            return (
              <div className="min-w-[11rem] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
                <p className="mb-1.5 font-medium text-slate-900">{label}</p>
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-slate-600">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: chartConfig.orders.color }}
                    />
                    Pedidos
                  </span>
                  <span className="font-medium text-slate-900">
                    {point.orders} · {formatPrice(point.ordersTotal)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-slate-600">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: chartConfig.quotes.color }}
                    />
                    Cotizaciones
                  </span>
                  <span className="font-medium text-slate-900">
                    {point.quotes} · {formatPrice(point.quotesTotal)}
                  </span>
                </div>
              </div>
            );
          }}
        />
        <Bar
          dataKey="orders"
          stackId="activity"
          fill="var(--color-orders)"
          radius={[0, 0, 4, 4]}
        />
        <Bar
          dataKey="quotes"
          stackId="activity"
          fill="var(--color-quotes)"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
