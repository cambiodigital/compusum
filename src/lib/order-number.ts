import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "./db";

type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Genera un número de pedido único y formateado: CS-YYYYMMDD-XXXX.
 * Consulta tanto el conteo como el número de secuencia máximo del día
 * para garantizar seguridad ante generaciones simultáneas.
 */
export async function generateOrderNumber(
  tx: TransactionClient | PrismaClient
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `CS-${today}-`;

  const [countToday, lastOrder] = await Promise.all([
    tx.order.count({
      where: { orderNumber: { startsWith: prefix } },
    }),
    tx.order.findFirst({
      where: { orderNumber: { startsWith: prefix } },
      orderBy: { orderNumber: "desc" },
      select: { orderNumber: true },
    }),
  ]);

  let maxSeq = countToday;
  if (lastOrder?.orderNumber) {
    const parts = lastOrder.orderNumber.split("-");
    const lastSeqStr = parts[parts.length - 1];
    const parsed = parseInt(lastSeqStr, 10);
    if (!isNaN(parsed) && parsed > maxSeq) {
      maxSeq = parsed;
    }
  }

  const nextSeq = maxSeq + 1;
  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

/**
 * Ejecuta una transacción de creación de pedido reintentando automáticamente
 * en caso de colisión por restricción única en orderNumber (error P2002).
 */
export async function createOrderTransactionWithRetry<T>(
  action: (tx: TransactionClient) => Promise<T>,
  dbClient: PrismaClient = db,
  maxRetries = 5
): Promise<T> {
  let attempts = 0;
  while (attempts < maxRetries) {
    attempts++;
    try {
      return await dbClient.$transaction(async (tx) => {
        return await action(tx as TransactionClient);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const target = error.meta?.target;
        const targetStr = Array.isArray(target)
          ? target.join(",")
          : String(target || "");
        const isOrderNumberConflict =
          targetStr.includes("orderNumber") ||
          targetStr.includes("Order_orderNumber_key") ||
          targetStr === "";

        if (isOrderNumberConflict && attempts < maxRetries) {
          // Espera breve antes de reintentar para dispersar solicitudes concurrentes
          await new Promise((resolve) => setTimeout(resolve, 30 * attempts));
          continue;
        }
      }
      throw error;
    }
  }
  throw new Error("Se superó el límite de reintentos para generar un número de pedido único.");
}
