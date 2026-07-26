import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { generateOrderNumber, createOrderTransactionWithRetry } from "../src/lib/order-number";

async function runMockConcurrencyTest() {
  console.log("--- 1. PRUEBA DE CONCURRENCIA SIMULADA (MOCK CONCURRENCY TEST) ---");

  const existingOrders: string[] = [];
  const lock = { busy: false };

  // Simulated Prisma Transaction Client with atomic conflict detection
  const createMockTx = () => ({
    order: {
      count: async ({ where }: any) => {
        const prefix = where?.orderNumber?.startsWith || "";
        return existingOrders.filter((o) => o.startsWith(prefix)).length;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const prefix = where?.orderNumber?.startsWith || "";
        const matches = existingOrders.filter((o) => o.startsWith(prefix)).sort();
        if (matches.length === 0) return null;
        return { orderNumber: matches[matches.length - 1] };
      },
      create: async ({ data }: any) => {
        const { orderNumber } = data;
        // Simulate race condition collision check
        if (existingOrders.includes(orderNumber)) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on orderNumber",
            {
              code: "P2002",
              clientVersion: "6.0.0",
              meta: { target: ["orderNumber"] },
            }
          );
        }
        existingOrders.push(orderNumber);
        return { id: `mock-${Date.now()}-${Math.random()}`, orderNumber };
      },
    },
  });

  // Simulated dbClient for createOrderTransactionWithRetry
  const mockDbClient = {
    $transaction: async (fn: any) => {
      const tx = createMockTx();
      return await fn(tx);
    },
  } as unknown as PrismaClient;

  const CONCURRENT_REQUESTS = 15;
  console.log(`Lanzando ${CONCURRENT_REQUESTS} solicitudes concurrentes a mockDbClient...`);

  const startTime = Date.now();
  const promises = Array.from({ length: CONCURRENT_REQUESTS }).map((_, i) =>
    createOrderTransactionWithRetry(
      async (tx) => {
        const orderNumber = await generateOrderNumber(tx);
        return await tx.order.create({
          data: { orderNumber },
        });
      },
      mockDbClient,
      10
    )
  );

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  console.log(`✓ Solicitudes finalizadas en ${elapsed}ms.`);
  console.log("Números generados en mock:");
  results.forEach((r) => console.log(`  - ${r.orderNumber}`));

  const generatedNumbers = results.map((r) => r.orderNumber);
  const uniqueSet = new Set(generatedNumbers);

  if (uniqueSet.size !== CONCURRENT_REQUESTS) {
    throw new Error(`¡FALLO MOCK! Se esperaban ${CONCURRENT_REQUESTS} únicos pero hubo ${uniqueSet.size}`);
  }
  console.log(`✓ ÉXITO MOCK: ${CONCURRENT_REQUESTS} números únicos generados correctamente sin colisiones unhandled.\n`);
}

async function runLiveDbConcurrencyTest() {
  console.log("--- 2. PRUEBA DE CONCURRENCIA BASE DE DATOS REAL (SI ESTÁ CONECTADA) ---");

  try {
    // Probar conexión básica
    await db.$connect();
    await db.cart.count();
  } catch (err: any) {
    console.log("ℹ Base de datos local no disponible o credenciales no configuradas. Se omite prueba live.");
    return;
  }

  const CONCURRENT_REQUESTS = 5;
  const createdCartIds: string[] = [];
  const createdOrderIds: string[] = [];

  try {
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      const cart = await db.cart.create({ data: { status: "activo" } });
      createdCartIds.push(cart.id);
    }

    const promises = createdCartIds.map((cartId, idx) =>
      createOrderTransactionWithRetry(async (tx) => {
        const orderNumber = await generateOrderNumber(tx);
        return await tx.order.create({
          data: {
            orderNumber,
            cartId,
            customerName: `Test Live ${idx + 1}`,
            subtotal: 500,
            status: "solicitado",
          },
        });
      })
    );

    const orders = await Promise.all(promises);
    createdOrderIds.push(...orders.map((o) => o.id));

    const nums = orders.map((o) => o.orderNumber);
    const uniqueNums = new Set(nums);
    if (uniqueNums.size !== nums.length) {
      throw new Error("¡FALLO LIVE! Colisión detectada en la base de datos.");
    }
    console.log(`✓ ÉXITO LIVE: ${orders.length} pedidos creados en base de datos sin colisiones.`);
  } finally {
    if (createdOrderIds.length > 0) {
      await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdCartIds.length > 0) {
      await db.cart.deleteMany({ where: { id: { in: createdCartIds } } });
    }
  }
}

async function main() {
  console.log("=============================================================");
  console.log("SUITE DE PRUEBAS DE CONCURRENCIA - GENERACIÓN DE PEDIDOS");
  console.log("=============================================================\n");

  await runMockConcurrencyTest();
  await runLiveDbConcurrencyTest();

  console.log("=============================================================");
  console.log("¡TODAS LAS PRUEBAS DE CONCURRENCIA FINALIZARON EXITOSAMENTE!");
  console.log("=============================================================\n");
}

main().catch((e) => {
  console.error("❌ Error fatal en las pruebas:", e);
  process.exit(1);
});
