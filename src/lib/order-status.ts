/**
 * Estados válidos del ciclo de pedido (Fase 3 conserva el conjunto funcional
 * existente; estados logísticos completos se revisan en fases posteriores).
 *
 * Toda escritura de `Order.status` debe pasar por aquí para impedir que un
 * PATCH escriba un string arbitrario.
 */

export const ORDER_STATUSES = ["solicitado", "compartido", "recibido"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const REQUEST_TYPES = ["pedido", "cotizacion"] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

export function isValidOrderStatus(status: unknown): status is OrderStatus {
  return (
    typeof status === "string" &&
    (ORDER_STATUSES as readonly string[]).includes(status)
  );
}

export function isValidRequestType(value: unknown): value is RequestType {
  return (
    typeof value === "string" &&
    (REQUEST_TYPES as readonly string[]).includes(value)
  );
}

/** Normaliza y valida; devuelve null si el valor no es un estado permitido. */
export function parseOrderStatus(value: unknown): OrderStatus | null {
  return isValidOrderStatus(value) ? value : null;
}

/** Solo un pedido explícitamente 'solicitado' admite edición de líneas desde el portal cliente. */
export function isCustomerEditableStatus(status: string): boolean {
  return status === "solicitado";
}

/** "Volver a pedir" está permitido desde cualquier estado conservado. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  solicitado: "En proceso",
  compartido: "Enviado",
  recibido: "Confirmado",
};
