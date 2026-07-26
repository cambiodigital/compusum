"use client";

import { useEffect, useRef } from "react";
import { useCartStore } from "@/stores/cart-store";

const DEBOUNCE_MS = 2000;

/**
 * Auto-guarda el carrito en el servidor cada vez que cambian los ítems,
 * con debounce de 2s para no spamear la API en cada keystroke.
 * Se monta una única vez a través de CartProvider.
 */
export function useCartSync() {
  const items = useCartStore((s) => s.items);
  const syncToServer = useCartStore((s) => s.syncToServer);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      syncToServer();
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [items, syncToServer]);
}
