import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { resolvePostLoginRedirect } from "@/lib/unified-auth";
import { IngresarForm } from "@/components/auth/ingresar-form";

export const dynamic = "force-dynamic";

/**
 * LOGIN UNIFICADO — único punto de entrada de Compusum (/ingresar) para
 * clientes, asesores (AGENT), editores y administradores.
 *
 * Server component:
 *  - Un usuario ya autenticado NO ve el formulario: se le redirige a su
 *    destino autorizado según rol (`next` saneado o home del rol). Esto cierra
 *    el ciclo de redirecciones del proxy: CUSTOMER -> /admin -> proxy ->
 *    /ingresar?next=/admin -> /mi-cuenta (sin bucle).
 *  - El parámetro `next` se pasa al backend, que decide el destino final
 *    autorizado (el frontend nunca calcula el destino por su cuenta).
 */
export default async function IngresarPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;

  const user = await getCurrentUser();
  if (user) {
    redirect(resolvePostLoginRedirect(user.role, rawNext));
  }

  return <IngresarForm next={typeof rawNext === "string" ? rawNext : undefined} />;
}
