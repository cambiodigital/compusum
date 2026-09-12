/**
 * ROLES DEL BACKOFFICE — predicados puros (sin db ni next/headers).
 *
 * Seguro para importar desde client components. La semántica es:
 * - ADMIN_ROLES: administración GLOBAL (admin, editor). Acceso total al
 *   catálogo, configuración, envíos, importación, etc.
 * - BACKOFFICE_ROLES: acceso al panel /admin (admin, editor y AGENT
 *   comercial). Un AGENT es un rol comercial: solo ve y gestiona SUS
 *   clientes (User.assignedAgentId) y SUS pedidos (Order.agentId).
 * - El role en base de datos es un string libre con casing mixto
 *   ('admin', 'editor', 'AGENT', 'CUSTOMER'): toda comparación normaliza
 *   con trim + toLowerCase.
 */

export const ADMIN_ROLES = ['admin', 'editor'] as const;

export const BACKOFFICE_ROLES = ['admin', 'editor', 'AGENT'] as const;

export function isAdminRole(role?: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return ADMIN_ROLES.some((r) => r.toLowerCase() === normalized);
}

export function isBackofficeRole(role?: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return BACKOFFICE_ROLES.some((r) => r.toLowerCase() === normalized);
}

export function isAgentRole(role?: string | null): boolean {
  if (!role) return false;
  return role.trim().toLowerCase() === 'agent';
}

/** Usuario mínimo necesario para calcular el alcance de un rol. */
export interface RoleScopeUser {
  id: string;
  role: string;
}

/** Filtro Prisma que restringe clientes (User CUSTOMER) al asesor. */
export function agentCustomerScope(agentId: string): { assignedAgentId: string } {
  return { assignedAgentId: agentId };
}

/** Filtro Prisma que restringe pedidos al asesor dueño. */
export function agentOrderScope(agentId: string): { agentId: string } {
  return { agentId };
}

/**
 * Devuelve `where` con el alcance del asesor aplicado si el usuario es
 * AGENT; para admin/editor devuelve `where` sin cambios.
 */
export function scopeCustomersForRole(
  where: Record<string, unknown>,
  user: RoleScopeUser
): Record<string, unknown> {
  return isAgentRole(user.role) ? { ...where, ...agentCustomerScope(user.id) } : where;
}

/**
 * Devuelve `where` con el alcance del asesor aplicado si el usuario es
 * AGENT; para admin/editor devuelve `where` sin cambios.
 */
export function scopeOrdersForRole(
  where: Record<string, unknown>,
  user: RoleScopeUser
): Record<string, unknown> {
  return isAgentRole(user.role) ? { ...where, ...agentOrderScope(user.id) } : where;
}
