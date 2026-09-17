"use client";

import { useEffect, useMemo, useState } from "react";
import Image, { type ImageProps } from "next/image";
import { isBlockedImageSource } from "@/lib/product-fallbacks";

type SafeProductImageProps = Omit<ImageProps, "src"> & {
  src?: string | null;
  fallbackText?: string;
  /**
   * Preflight HEAD para rutas /uploads: evita disparar `/_next/image` contra
   * archivos inexistentes (400 en consola y requests desperdiciados).
   * Por defecto ACTIVADO: la referencia en DB puede apuntar a un archivo que
   * ya no existe y el fallback debe decidirse antes de renderizar <Image>.
   */
  preventNotFoundLog?: boolean;
};

export function SafeProductImage({
  src,
  alt,
  fill,
  className,
  fallbackText = "próximamente",
  preventNotFoundLog = true,
  onError,
  ...props
}: SafeProductImageProps) {
  const normalizedSrc = useMemo(() => {
    if (typeof src !== "string") return "";
    const trimmedSrc = src.trim();

    if (!trimmedSrc || isBlockedImageSource(trimmedSrc)) {
      return "";
    }

    return trimmedSrc;
  }, [src]);

  // Mientras la disponibilidad de un /uploads no esté resuelta (null) se
  // muestra el fallback. Arrancar en `true` renderizaba <Image> en el primer
  // paint aunque el archivo no existiera: la petición al optimizador ya se
  // habia disparado y el onError llegaba tarde (race del useEffect).
  const [hasError, setHasError] = useState(false);
  const [isCheckingSrc, setIsCheckingSrc] = useState(
    () => preventNotFoundLog && normalizedSrc.startsWith("/uploads/")
  );
  const [isSrcAvailable, setIsSrcAvailable] = useState<boolean | null>(() =>
    preventNotFoundLog && normalizedSrc.startsWith("/uploads/") ? null : true
  );

  useEffect(() => {
    const shouldCheck = preventNotFoundLog && normalizedSrc.startsWith("/uploads/");
    setHasError(false);
    setIsCheckingSrc(shouldCheck);
    setIsSrcAvailable(shouldCheck ? null : true);
  }, [normalizedSrc, preventNotFoundLog]);

  useEffect(() => {
    if (!isCheckingSrc || normalizedSrc.length === 0 || !normalizedSrc.startsWith("/uploads/")) {
      return;
    }

    let active = true;

    fetch(normalizedSrc, { method: "HEAD", cache: "no-store" })
      .then((response) => {
        if (!active) return;
        setIsSrcAvailable(response.ok);
      })
      .catch(() => {
        if (!active) return;
        setIsSrcAvailable(false);
      })
      .finally(() => {
        if (!active) return;
        setIsCheckingSrc(false);
      });

    return () => {
      active = false;
    };
  }, [isCheckingSrc, normalizedSrc]);

  const showFallback =
    normalizedSrc.length === 0
    || hasError
    || isSrcAvailable === null
    || isSrcAvailable === false;

  if (showFallback) {
    return (
      <div
        className={`${fill ? "absolute inset-0" : "h-full w-full"} flex items-center justify-center bg-slate-100 text-slate-500 text-[10px] font-medium uppercase tracking-wide text-center px-2`}
        role="img"
        aria-label={`${alt} sin imagen`}
      >
        {fallbackText}
      </div>
    );
  }

  return (
    <Image
      {...props}
      src={normalizedSrc}
      alt={alt}
      fill={fill}
      className={className}
      onError={(event) => {
        setHasError(true);
        onError?.(event);
      }}
    />
  );
}
