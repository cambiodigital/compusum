import { NextRequest, NextResponse } from 'next/server';
import { processCheckout } from '@/lib/checkout';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { CartValidationError } from '@/lib/cart-validation';

export async function POST(req: NextRequest) {
  try {
    const checkoutData = await req.json();

    if (!checkoutData.items || checkoutData.items.length === 0) {
      return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
    }

    if (!checkoutData.cityId || !checkoutData.cartId) {
      return NextResponse.json({ error: 'cityId and cartId are required' }, { status: 400 });
    }

    // Validar propiedad del carrito y estado activo
    const sessionId = req.headers.get("x-session-id");
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;
    const userRole = currentUser?.role ?? null;
    const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";

    const cart = await db.cart.findUnique({
      where: { id: checkoutData.cartId }
    });

    if (!cart) {
      return NextResponse.json({ error: 'Cart not found' }, { status: 404 });
    }

    const isOwner = (cart.sessionId && cart.sessionId === sessionId) || (userId && cart.userId === userId);

    if (!isAdminOrAgent && !isOwner) {
      return NextResponse.json({ error: 'Unauthorized to checkout this cart' }, { status: 403 });
    }

    if (cart.status !== "activo") {
      return NextResponse.json({ error: 'Cart is not active' }, { status: 400 });
    }

    const result = await processCheckout(checkoutData);

    return NextResponse.json({
        message: 'Checkout successful',
        orderNumber: result.order.orderNumber,
        route: result.route
    });
  } catch (error: any) {
    console.error("Checkout error:", error);
    if (error instanceof CartValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: error.message || 'An error occurred during checkout' }, { status: 500 });
  }
}
