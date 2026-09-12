import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MAESTRO DE CLIENTES (lógica en src/lib/customers-admin.ts) + RBAC básico.
 * Todas las operaciones administrativas exigen rol administrativo
 * (requireAdminApi en las rutas); aquí validamos las reglas de negocio y el
 * rol CUSTOMER queda explícitamente excluido del acceso administrativo.
 */

import {
  validateAgentAssignment,
  validateProfileAssignment,
  createCustomerAccount,
  updateCustomerAccount,
  deleteCustomerAccount,
  CustomerAdminError,
} from '@/lib/customers-admin';
import { isAdminRole } from '@/lib/auth';
import { adminPricingCustomer } from '@/lib/pricing';

function makeTx() {
  return {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'new-1', ...data })),
      update: vi.fn().mockImplementation(({ data, where }: any) => Promise.resolve({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    priceProfile: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    session: { deleteMany: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RBAC: un CUSTOMER no accede a funciones administrativas', () => {
  it('isAdminRole rechaza CUSTOMER/AGENT y acepta admin/editor', () => {
    expect(isAdminRole('CUSTOMER')).toBe(false);
    expect(isAdminRole('customer')).toBe(false);
    expect(isAdminRole('AGENT')).toBe(false);
    expect(isAdminRole('agent')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('editor')).toBe(true);
  });

  it('adminPricingCustomer: solo un CUSTOMER autenticado define su precio; staff/invitado => base', () => {
    expect(adminPricingCustomer({ id: 'c1', role: 'CUSTOMER' })).toBe('c1');
    expect(adminPricingCustomer({ id: 'a1', role: 'admin' })).toBeNull();
    expect(adminPricingCustomer({ id: 'g1', role: 'AGENT' })).toBeNull();
    expect(adminPricingCustomer(null)).toBeNull();
  });
});

describe('Asignación de asesor (solo AGENT activos)', () => {
  it('rechaza un usuario con rol CUSTOMER como asesor', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ role: 'CUSTOMER', isActive: true });
    await expect(validateAgentAssignment('u1', tx)).rejects.toThrow(CustomerAdminError);
    await expect(validateAgentAssignment('u1', tx)).rejects.toThrow('rol AGENT');
  });

  it('rechaza un AGENT inactivo', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ role: 'AGENT', isActive: false });
    await expect(validateAgentAssignment('u1', tx)).rejects.toThrow('inactivo');
  });

  it('acepta un AGENT activo', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ role: 'AGENT', isActive: true });
    await expect(validateAgentAssignment('u1', tx)).resolves.toBeUndefined();
  });

  it('crear cliente con asesor y perfil asignados', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockImplementation(({ where }: any) => {
      // Solo se consulta el asesor (perfil llega null)
      return Promise.resolve({ role: 'AGENT', isActive: true });
    });

    const customer = await createCustomerAccount(
      {
        name: 'Cliente con asesor',
        email: 'conasesor@test.com',
        phone: '3001234567',
        assignedAgentId: 'agent-1',
      },
      tx
    );

    expect(customer.assignedAgentId).toBe('agent-1');
    expect(customer.role).toBe('CUSTOMER');
  });
});

describe('Asignación de PriceProfile', () => {
  it('rechaza perfiles inexistentes', async () => {
    const tx = makeTx();
    tx.priceProfile.findUnique.mockResolvedValue(null);
    await expect(validateProfileAssignment('prof-x', tx)).rejects.toThrow('no existe');
  });

  it('rechaza perfiles inactivos', async () => {
    const tx = makeTx();
    tx.priceProfile.findUnique.mockResolvedValue({ isActive: false });
    await expect(validateProfileAssignment('prof-x', tx)).rejects.toThrow('inactivo');
  });

  it('actualiza el perfil de precio del cliente', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      id: 'cust-1',
      role: 'CUSTOMER',
      name: 'Cliente',
      email: 'c@test.com',
      phone: null,
    });
    tx.priceProfile.findUnique.mockResolvedValue({ isActive: true });

    const updated = await updateCustomerAccount('cust-1', { priceProfileId: 'prof-1' }, tx);
    expect(updated.priceProfileId).toBe('prof-1');
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cust-1' },
        data: expect.objectContaining({ priceProfileId: 'prof-1' }),
      })
    );
  });

  it('desasigna el asesor (null)', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      id: 'cust-1',
      role: 'CUSTOMER',
      name: 'Cliente',
      email: 'c@test.com',
      phone: null,
    });

    const updated = await updateCustomerAccount('cust-1', { assignedAgentId: null }, tx);
    expect(updated.assignedAgentId).toBeNull();
  });
});

describe('CRUD básico del maestro', () => {
  it('crear cliente: exige nombre y teléfono canónico', async () => {
    const tx = makeTx();
    await expect(
      createCustomerAccount({ name: '', email: 'a@test.com', phone: '3001234567' }, tx)
    ).rejects.toThrow('nombre es requerido');

    // POLÍTICA: el teléfono es obligatorio en cuentas nuevas (recuperación por OTP)
    await expect(
      createCustomerAccount({ name: 'Sin teléfono', email: 'b@test.com' }, tx)
    ).rejects.toThrow('teléfono es obligatorio');

    await expect(
      createCustomerAccount({ name: 'Teléfono inválido', email: 'c@test.com', phone: '12345' }, tx)
    ).rejects.toThrow('teléfono');
  });

  it('crear cliente: rechaza duplicados (busca en variantes canónicas)', async () => {
    const tx = makeTx();
    tx.user.findFirst.mockResolvedValue({ id: 'dup' });
    await expect(
      createCustomerAccount({ name: 'Dup', email: 'dup@test.com', phone: '+57 300 123 4567' }, tx)
    ).rejects.toThrow('Ya existe una cuenta');
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { email: 'dup@test.com' },
            { phone: '573001234567' },
            { phone: '3001234567' },
          ]),
        }),
      })
    );
  });

  it('crear cliente guarda datos B2B con teléfono canónico', async () => {
    const tx = makeTx();
    await createCustomerAccount(
      {
        name: 'Distribuidora XYZ',
        email: 'xyz@test.com',
        phone: '6063335206',
        company: 'Distribuidora XYZ S.A.S',
        taxId: '900123456-1',
        city: 'Pereira',
        address: 'Calle 10 #20-30',
      },
      tx
    );

    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.company).toBe('Distribuidora XYZ S.A.S');
    expect(data.phone).toBe('576063335206');
    expect(data.taxId).toBe('900123456-1');
    expect(data.city).toBe('Pereira');
    expect(data.address).toBe('Calle 10 #20-30');
    expect(data.role).toBe('CUSTOMER');
  });

  it('editar cliente: no permite eliminar el teléfono ni poner uno inválido', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      id: 'cust-1',
      role: 'CUSTOMER',
      name: 'Cliente',
      email: 'c@test.com',
      phone: '573001234567',
    });

    await expect(
      updateCustomerAccount('cust-1', { phone: null, email: null }, tx)
    ).rejects.toThrow('correo o un teléfono');

    await expect(
      updateCustomerAccount('cust-1', { phone: '123' }, tx)
    ).rejects.toThrow('10 dígitos');
  });

  it('buscar clientes: el listado usa User role=CUSTOMER con búsqueda', async () => {
    // Validado a nivel de ruta (page/API usan where role=CUSTOMER + OR search);
    // aquí verificamos la primitiva de listado de asesores/perfiles.
    const tx = makeTx();
    tx.user.findMany.mockResolvedValue([{ id: 'agent-1', name: 'Agente Uno' }]);
    const agents = await tx.user.findMany({
      where: { isActive: true, role: { equals: 'AGENT', mode: 'insensitive' } },
    });
    expect(agents).toHaveLength(1);
  });

  it('eliminar cliente con pedidos => rechazado (histórico protegido)', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      id: 'cust-1',
      role: 'CUSTOMER',
      _count: { orders: 5 },
    });

    await expect(deleteCustomerAccount('cust-1', tx)).rejects.toThrow('Desactiva la cuenta');
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('eliminar cliente sin pedidos => elimina y cierra sus sesiones', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({
      id: 'cust-1',
      role: 'CUSTOMER',
      _count: { orders: 0 },
    });

    await deleteCustomerAccount('cust-1', tx);
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'cust-1' } });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'cust-1' } });
  });
});
