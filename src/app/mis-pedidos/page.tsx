"use client";

import Link from "next/link";
import { MyOrdersList, useMyOrders } from "@/components/store/my-orders-list";

export default function MisPedidosPage() {
  const { orders, loading } = useMyOrders(true);

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mis Pedidos</h1>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← Seguir comprando
        </Link>
      </div>

      <MyOrdersList orders={orders} loading={loading} />
    </div>
  );
}
