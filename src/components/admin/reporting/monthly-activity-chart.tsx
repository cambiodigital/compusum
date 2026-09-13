"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

/**
 * Evolución mensual de actividad comercial (Fase 4C). Serie sobre
 * `Order.createdAt` con pedido/cotización siempre separados. Los datos ya
 * llegan scopeados desde el server; este componente sólo dibuja.
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
  quotesCount: number;
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
        <ChartTooltip content={<ChartTooltipContent />} />
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
