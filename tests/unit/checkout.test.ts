import { describe, it, expect, vi } from 'vitest';
import { normalizePhone, normalizeEmail, upsertCheckoutCustomer } from '@/lib/checkout';
import { getNextRouteDeparture, buildRouteMessage } from '@/lib/route-schedule';

describe('Checkout and Customer Logic', () => {
  describe('normalizePhone', () => {
    it('strips non-digit characters and returns valid phone string', () => {
      expect(normalizePhone('+593 99 123 4567')).toBe('593991234567');
      expect(normalizePhone('099-876-5432')).toBe('0998765432');
    });

    it('returns null for short or invalid phone numbers', () => {
      expect(normalizePhone('123456')).toBeNull();
      expect(normalizePhone('abc')).toBeNull();
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
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

    it('links existing customer by normalized phone', async () => {
      const mockTx = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'cust-1',
            name: 'Juan Perez',
            phone: '0991234567',
            email: 'juan@test.com',
            assignedAgentId: 'agent-99',
          }),
        },
      };

      const result = await upsertCheckoutCustomer(
        { phone: '099-123-4567' },
        mockTx
      );

      expect(result.customer.id).toBe('cust-1');
      expect(result.assignedAgentId).toBe('agent-99');
      expect(result.isNewCustomer).toBe(false);
    });

    it('creates new customer record when not found', async () => {
      const mockTx = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-cust-1', ...data })),
        },
      };

      const result = await upsertCheckoutCustomer(
        { name: 'Maria Gomez', phone: '0987654321', email: 'maria@test.com' },
        mockTx
      );

      expect(result.customer.id).toBe('new-cust-1');
      expect(result.customer.role).toBe('CUSTOMER');
      expect(result.isNewCustomer).toBe(true);
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
