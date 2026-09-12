import { describe, it, expect } from 'vitest';
import {
  ADMIN_ROLES,
  BACKOFFICE_ROLES,
  isAdminRole,
  isBackofficeRole,
  isAgentRole,
  agentCustomerScope,
  agentOrderScope,
  scopeCustomersForRole,
  scopeOrdersForRole,
} from '@/lib/roles';

/**
 * FASE 4A — matriz pura de roles (sin db ni mocks).
 * Datos reales con casing mixto: 'admin', 'editor', 'AGENT', 'CUSTOMER'.
 */

describe('roles.ts: constantes', () => {
  it('ADMIN_ROLES = administración global (admin, editor) SIN AGENT', () => {
    expect([...ADMIN_ROLES].sort()).toEqual(['admin', 'editor']);
  });

  it('BACKOFFICE_ROLES incluye admin, editor y AGENT', () => {
    expect([...BACKOFFICE_ROLES].sort()).toEqual(['AGENT', 'admin', 'editor']);
  });
});

describe('roles.ts: matriz de predicados por rol', () => {
  const matrix: Array<{
    input: string | null | undefined;
    admin: boolean;
    backoffice: boolean;
    agent: boolean;
  }> = [
    { input: 'admin', admin: true, backoffice: true, agent: false },
    { input: 'ADMIN', admin: true, backoffice: true, agent: false },
    { input: ' admin ', admin: true, backoffice: true, agent: false },
    { input: 'editor', admin: true, backoffice: true, agent: false },
    { input: 'Editor', admin: true, backoffice: true, agent: false },
    { input: 'AGENT', admin: false, backoffice: true, agent: true },
    { input: 'agent', admin: false, backoffice: true, agent: true },
    { input: '  Agent  ', admin: false, backoffice: true, agent: true },
    { input: 'CUSTOMER', admin: false, backoffice: false, agent: false },
    { input: 'customer', admin: false, backoffice: false, agent: false },
    { input: 'guest', admin: false, backoffice: false, agent: false },
    { input: 'AdminX', admin: false, backoffice: false, agent: false },
    { input: '', admin: false, backoffice: false, agent: false },
    { input: '   ', admin: false, backoffice: false, agent: false },
    { input: null, admin: false, backoffice: false, agent: false },
    { input: undefined, admin: false, backoffice: false, agent: false },
  ];

  it.each(matrix.map((m) => [String(m.input), m]))(
    '%s',
    (_label, m) => {
      expect(isAdminRole(m.input)).toBe(m.admin);
      expect(isBackofficeRole(m.input)).toBe(m.backoffice);
      expect(isAgentRole(m.input)).toBe(m.agent);
    }
  );
});

describe('roles.ts: scope builders', () => {
  it('agentCustomerScope / agentOrderScope generan los filtros Prisma', () => {
    expect(agentCustomerScope('agent-1')).toEqual({ assignedAgentId: 'agent-1' });
    expect(agentOrderScope('agent-1')).toEqual({ agentId: 'agent-1' });
  });

  it('scopeCustomersForRole: AGENT => where + assignedAgentId', () => {
    const scoped = scopeCustomersForRole(
      { role: 'CUSTOMER', isActive: true },
      { id: 'agent-1', role: 'AGENT' }
    );
    expect(scoped).toEqual({
      role: 'CUSTOMER',
      isActive: true,
      assignedAgentId: 'agent-1',
    });
  });

  it('scopeOrdersForRole: AGENT => where + agentId', () => {
    const scoped = scopeOrdersForRole(
      { status: 'solicitado' },
      { id: 'agent-1', role: 'agent' } // casing mixto de la data real
    );
    expect(scoped).toEqual({ status: 'solicitado', agentId: 'agent-1' });
  });

  it('admin/editor/CUSTOMER: where SIN cambios', () => {
    const where = { role: 'CUSTOMER', isActive: true };
    expect(scopeCustomersForRole(where, { id: 'a1', role: 'admin' })).toBe(where);
    expect(scopeCustomersForRole(where, { id: 'e1', role: 'editor' })).toBe(where);
    expect(scopeOrdersForRole(where, { id: 'c1', role: 'CUSTOMER' })).toBe(where);
    expect(scopeOrdersForRole(where, { id: 'x', role: 'desconocido' })).toBe(where);
  });
});
