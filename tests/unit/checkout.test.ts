import { describe, it, expect, vi } from 'vitest';
import { normalizePhone, normalizeEmail, upsertCheckoutCustomer } from '@/lib/checkout';
import { getNextRouteDeparture, buildRouteMessage } from '@/lib/route-schedule';

describe('Checkout and Customer Logic', () => {
  describe('normalizePhone (canonicalización colombiana)', () => {
    it('canonicaliza las 3 formas de la misma línea al MISMO valor', () => {
      expect(normalizePhone('3001234567')).toBe('573001234567');
      expect(normalizePhone('+57 300 123 4567')).toBe('573001234567');
      expect(normalizePhone('573001234567')).toBe('573001234567');
      expect(normalizePhone('(300) 123-4567')).toBe('573001234567');
    });

    it('acepta fijo moderno 60XXXXXXX', () => {
      expect(normalizePhone('6063335206')).toBe('576063335206');
      expect(normalizePhone('+576063335206')).toBe('576063335206');
    });

    it('returns null for short, foreign or invalid phone numbers', () => {
      expect(normalizePhone('123456')).toBeNull();
      expect(normalizePhone('abc')).toBeNull();
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
      // Formato no colombiano (histórico extranjero): se rechaza, no se manglea
      expect(normalizePhone('+593 99 123 4567')).toBeNull();
      expect(normalizePhone('099-876-5432')).toBeNull();
    });
  });

  describe('normalizeEmail', () => {
    it('lowercases and trims email addresses', () => {
      expect(normalizeEmail('  USER@Domain.Com  ')).toBe('user@domain.com');
    });

    it('returns null for empty strings or invalid inputs', () => {
      expect(normalizeEmail('   ')).toBeNull();
      expect(normalizeEmail(null)).toBeNull();
      expect(normalizeEmail(undefined)).toBeNull();
    });
  });

  describe('upsertCheckoutCustomer', () => {
    it('returns empty result if neither phone nor email provided', async () => {
      const result = await upsertCheckoutCustomer({});
      expect(result.customer).toBeNull();
      expect(result.isNewCustomer).toBe(false);
    });

    it('links existing customer by canonical phone (busca en ambas formas almacenadas)', async () => {
      const mockTx = {
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'cust-1',
            name: 'Juan Perez',
            phone: '573001234567',
            email: 'juan@test.com',
            assignedAgentId: 'agent-99',
          }),
          update: vi.fn().mockImplementation(({ data }) =>
            Promise.resolve({ id: 'cust-1', phone: '573001234567', ...data })
          ),
        },
      };

      const result = await upsertCheckoutCustomer(
        { phone: '+57 300 123 4567' },
        mockTx
      );

      expect(result.customer.id).toBe('cust-1');
      expect(result.assignedAgentId).toBe('agent-99');
      expect(result.isNewCustomer).toBe(false);
      // Búsqueda determinista por variantes (canónico + legado local)
      expect(mockTx.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ phone: '573001234567' }, { phone: '3001234567' }],
          }),
        })
      );
    });

    it('canonicaliza el teléfono legado de la cuenta al completar datos', async () => {
      const mockTx = {
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'cust-1',
            name: 'Juan Perez',
            phone: '3001234567',
            email: 'juan@test.com',
            assignedAgentId: 'agent-99',
          }),
          update: vi.fn().mockImplementation(({ data }) =>
            Promise.resolve({ id: 'cust-1', ...data })
          ),
        },
      };

      const result = await upsertCheckoutCustomer({ phone: '3001234567' }, mockTx);

      expect(result.isNewCustomer).toBe(false);
      expect(mockTx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { phone: '573001234567' } })
      );
    });

    it('creates new customer record when not found (teléfono canónico)', async () => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-cust-1', ...data })),
        },
      };

      const result = await upsertCheckoutCustomer(
        { name: 'Maria Gomez', phone: '3009876543', email: 'maria@test.com' },
        mockTx
      );

      expect(result.customer.id).toBe('new-cust-1');
      expect(result.customer.phone).toBe('573009876543');
      expect(result.customer.role).toBe('CUSTOMER');
      expect(result.isNewCustomer).toBe(true);
      // Alta concurrentemente segura: advisory de contacto antes del create
      // (claves canónicas email + teléfono, orden fijo email→teléfono)
      expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
      const lockKeys = mockTx.$queryRaw.mock.calls.map((c: any[]) => String(c[0]));
      expect(lockKeys[0]).toContain('compusum:contact-email:');
      expect(lockKeys[1]).toContain('compusum:contact-phone:');
      expect(mockTx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '573009876543', role: 'CUSTOMER' }),
      });
    });
  });

  describe('Shipping Route Calculations', () => {
    it('calculates days until next departure correctly', () => {
      // 2026-07-27 is a Monday (day 1)
      const mockNow = new Date('2026-07-26T10:00:00Z'); // Sunday
      const departureDays = [1, 4]; // Monday and Thursday

      const { daysUntilDeparture, dayName } = getNextRouteDeparture(mockNow, departureDays);
      expect(daysUntilDeparture).toBe(1); // Monday is tomorrow
      expect(dayName.toLowerCase()).toBe('lunes');
    });

    it('builds clear shipping estimation message', () => {
      const msg = buildRouteMessage(1, 'Lunes', 1, 2);
      expect(msg).toContain('Lunes');
      expect(msg).toContain('entre 1 y 2 días desde la salida');
    });
  });
});
