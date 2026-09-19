import { redirect } from "next/navigation";

/**
 * COMPATIBILIDAD (deprecado): el login del backoffice se unificó en /ingresar.
 * Esta página solo redirige preservando el destino (/admin) vía el parámetro
 * `next`, que el backend autoriza según el rol tras autenticar.
 *
 * El gating real de /admin/** lo hace src/proxy.ts: una petición no
 * autenticada ahora cae directamente en /ingresar?next=<ruta>, y un CUSTOMER
 * autenticado es devuelto al storefront (sin bucles de redirección).
 */
export default function AdminLoginPage() {
  redirect("/ingresar?next=%2Fadmin");
}
