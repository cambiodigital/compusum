"use client";

import { use } from "react";
import { Header } from "@/components/store/header";
import { Footer } from "@/components/store/footer";
import { OrderDetailView } from "@/components/store/order-detail-view";

export default function MisPedidoDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Header />
      <main className="flex-1 py-8 md:py-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <OrderDetailView orderId={id} />
        </div>
      </main>
      <Footer />
    </div>
  );
}
