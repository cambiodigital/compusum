import { db } from "@/lib/db";
import { Header } from "@/components/store/header";
import { Footer } from "@/components/store/footer";
import { WhatsAppButton } from "@/components/store/whatsapp-button";
import { notFound } from "next/navigation";
import { SharedCartView } from "@/components/store/shared-cart-view";
import { isGlobalCatalogModeEnabled } from "@/lib/catalog-mode";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { uuid } = await params;
  const cart = await db.cart.findUnique({
    where: { uuid },
    include: { _count: { select: { items: true } } },
  });

  if (!cart) return { title: "Carrito no encontrado" };

  return {
    title: `Carrito${cart.customerName ? ` de ${cart.customerName}` : ""} | Compusum`,
    description: `Carrito con ${cart._count.items} productos - Compusum Papelería Mayorista`,
  };
}

export default async function SharedCartPage({ params }: PageProps) {
  const { uuid } = await params;
  const catalogMode = await isGlobalCatalogModeEnabled();

  const cart = await db.cart.findUnique({
    where: { uuid },
    include: {
      items: {
        include: {
          product: {
            include: {
              brand: { select: { name: true, slug: true, catalogMode: true } },
              category: { select: { name: true, slug: true, catalogMode: true } },
            },
          },
        },
      },
      city: {
        include: {
          department: true,
          shippingRoute: true,
        },
      },
    },
  });

  if (!cart || !cart.isActive) {
    notFound();
  }

  // Serialize for client component
  const cartData = {
    uuid: cart.uuid,
    customerName: cart.customerName,
    customerEmail: cart.customerEmail,
    customerPhone: cart.customerPhone,
    customerCompany: cart.customerCompany,
    notes: cart.notes,
    subtotal: cart.subtotal,
    status: cart.status,
    city: cart.city
      ? {
          name: cart.city.name,
          department: cart.city.department.name,
          shippingRoute: cart.city.shippingRoute
            ? {
                name: cart.city.shippingRoute.name,
                estimatedDaysMin: cart.city.shippingRoute.estimatedDaysMin,
                estimatedDaysMax: cart.city.shippingRoute.estimatedDaysMax,
                shippingCompany: cart.city.shippingRoute.shippingCompany,
              }
            : null,
        }
      : null,
    items: cart.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      product: {
        id: item.product.id,
        name: item.product.name,
        slug: item.product.slug,
        sku: item.product.sku,
        variantId: item.variantId,
        variantName: item.variantName,
        variantCode: item.variantCode,
        price: item.product.price,
        wholesalePrice: item.product.wholesalePrice,
        minWholesaleQty: item.product.minWholesaleQty,
        stockStatus: item.product.stockStatus,
        catalogMode: item.product.catalogMode,
        brand: item.product.brand,
        category: item.product.category,
      },
    })),
  };

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Header />
      <main className="flex-1 py-8 md:py-12">
        <div className="container mx-auto px-4">
          <SharedCartView cart={cartData} catalogMode={catalogMode} />
        </div>
      </main>
      <Footer />
      <WhatsAppButton />
    </div>
  );
}
