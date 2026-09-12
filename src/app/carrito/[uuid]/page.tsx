import { db } from "@/lib/db";
import { Header } from "@/components/store/header";
import { Footer } from "@/components/store/footer";
import { WhatsAppButton } from "@/components/store/whatsapp-button";
import { notFound } from "next/navigation";
import { SharedCartView } from "@/components/store/shared-cart-view";
import { isGlobalCatalogModeEnabled } from "@/lib/catalog-mode";
import { getSessionPricingContext } from "@/lib/pricing-context";
import { attachResolvedPricesToCartItems } from "@/lib/pricing";
import {
  authorizeCartViewerWithOwner,
  buildSharedCartDTO,
  getCartViewer,
} from "@/lib/shared-cart";

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

/**
 * MISMA política y MISMO DTO que GET /api/carts/[uuid] (capability-link):
 * autorización y serialización centralizadas en src/lib/shared-cart.ts.
 * El visor ve SU precio autorizado; nunca recibe email/teléfono del dueño ni
 * el snapshot/precio privado del propietario.
 */
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

  const viewer = await getCartViewer();
  // MISMA política que la API: el AGENT solo gestiona con lookup del dueño.
  const access = await authorizeCartViewerWithOwner(cart, viewer);

  if (!cart || !access.allowed) {
    notFound();
  }

  // Motor único de precios: resolvedPrice por VISOR (sesión server-side).
  let viewerCart: typeof cart = cart;
  try {
    const pricingCtx = await getSessionPricingContext();
    viewerCart = await attachResolvedPricesToCartItems(cart, pricingCtx);
  } catch (error) {
    console.error("Shared cart price resolution failed", error);
  }

  const dto = buildSharedCartDTO(viewerCart, catalogMode);

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Header />
      <main className="flex-1 py-8 md:py-12">
        <div className="container mx-auto px-4">
          <SharedCartView cart={dto} catalogMode={catalogMode} canManage={access.canManage} />
        </div>
      </main>
      <Footer />
      <WhatsAppButton />
    </div>
  );
}
