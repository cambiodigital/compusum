import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_API_PASSWORD, TEST_BCRYPT_PLACEHOLDER } from '../helpers/credentials';

/**
 * TESTS DE ENDPOINT (respuesta JSON real) para las rutas de autenticación.
 *
 * GARANTÍA P0: NINGUNA respuesta de login/registro/OTP puede contener el hash
 * `password`, `passwordChangedAt`, tokens de sesión ni relaciones internas.
 * Los mocks de lib devuelven ADREDEDMENTE un registro Prisma COMPLETO
 * (con password hash y passwordChangedAt) para probar que el sanitizado del
 * borde lo elimina de la respuesta.
 */

const mockDb = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  session: {
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  rateLimit: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

// Usuario Prisma "crudo" que una capa interna podría devolver por error:
// contiene hash, marcas de auditoría y una relación interna.
const RAW_DB_USER = {
  id: 'user-raw-1',
  name: 'Cliente Crudo',
  email: 'crudo@test.com',
  phone: '573001234567',
  role: 'CUSTOMER',
  isActive: true,
  company: null,
  taxId: null,
  city: null,
  password: TEST_BCRYPT_PLACEHOLDER,
  passwordChangedAt: new Date('2026-01-01T00:00:00Z'),
  sessions: [{ token: 'token-interno' }],
  priceProfileId: null,
  lastLogin: new Date('2026-02-01T00:00:00Z'),
};

vi.mock('@/lib/auth', () => ({
  setSessionCookie: vi.fn().mockResolvedValue(undefined),
  clearSessionCookie: vi.fn(),
  rotateGuestSessionCookie: vi.fn().mockResolvedValue('new-guest-session'),
  createSession: vi.fn().mockResolvedValue('session-token-opaco'),
  getCurrentUser: vi.fn().mockResolvedValue(null),
  requireAdminApi: vi.fn().mockResolvedValue({ error: null, user: { id: 'admin-1', role: 'admin' } }),
  isAdminRole: (role: string | null | undefined) =>
    ['admin', 'editor'].includes(String(role).trim().toLowerCase()),
  verifyPassword: vi.fn().mockResolvedValue(true),
  SESSION_DURATION_HOURS_DEFAULT: 24,
  SESSION_DURATION_DAYS_REMEMBER_ME: 30,
}));

vi.mock('@/lib/auth-dual', () => ({
  isPhoneOtpLoginEnabled: vi.fn().mockReturnValue(true),
  loginWithPhone: vi.fn(),
  loginWithPassword: vi.fn(),
}));

vi.mock('@/lib/customer-auth', () => ({
  registerCustomer: vi.fn(),
  CustomerAuthError: class CustomerAuthError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/checkout', () => ({
  transferSessionDataToUser: vi.fn().mockResolvedValue({ cart: null, orders: null }),
}));

import { POST as phoneRoutePOST } from '@/app/api/auth/phone/route';
import { POST as customerLoginPOST } from '@/app/api/auth/customer/login/route';
import { POST as registerPOST } from '@/app/api/auth/register/route';
import { loginWithPhone, loginWithPassword } from '@/lib/auth-dual';
import { registerCustomer } from '@/lib/customer-auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import { setSessionCookie, rotateGuestSessionCookie } from '@/lib/auth';

const BODY = { phone: '+57 300 123 4567', otpCode: '1234' };

function jsonRequest(url: string, body: unknown): any {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'guest-session-1' },
    body: JSON.stringify(body),
  });
}

const FORBIDDEN_KEYS = ['password', 'passwordChangedAt', 'sessions', 'lastLogin', 'token', 'priceProfileId'];
const FORBIDDEN_VALUES = [TEST_BCRYPT_PLACEHOLDER, 'token-interno'];

function expectSafeUserPayload(payload: any) {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN_KEYS) {
    expect(json).not.toContain(`"${key}"`);
  }
  for (const value of FORBIDDEN_VALUES) {
    expect(json).not.toContain(value);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.rateLimit.findUnique.mockResolvedValue(null);
  mockDb.rateLimit.upsert.mockResolvedValue({});
  mockDb.rateLimit.deleteMany.mockResolvedValue({});
});

describe('ENDPOINT /api/auth/phone (OTP, usado por LoginModal legacy)', () => {
  it('devuelve el usuario SIN password/passwordChangedAt/relaciones internas', async () => {
    (loginWithPhone as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await phoneRoutePOST(jsonRequest('/api/auth/phone', BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.user).toMatchObject({ id: RAW_DB_USER.id, role: 'CUSTOMER' });
    expectSafeUserPayload(json);
  });

  it('la cookie de sesión NUNCA aparece en el body de la respuesta', async () => {
    (loginWithPhone as any).mockResolvedValue({ token: 'tok-secreto', user: RAW_DB_USER });

    const res = await phoneRoutePOST(jsonRequest('/api/auth/phone', BODY));
    const json = await res.json();

    expect(JSON.stringify(json)).not.toContain('tok-secreto');
  });

  it('si la transferencia guest→cuenta FALLA => 500 SIN cookie de sesión ni rotación (handoff-first)', async () => {
    (loginWithPhone as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });
    (transferSessionDataToUser as any).mockRejectedValueOnce(new Error('handoff down'));

    const res = await phoneRoutePOST(jsonRequest('/api/auth/phone', BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toContain('permanecen intactos');
    expect(transferSessionDataToUser).toHaveBeenCalledTimes(1);
    expect(setSessionCookie).not.toHaveBeenCalled();
    expect(rotateGuestSessionCookie).not.toHaveBeenCalled();
  });
});

describe('ENDPOINT /api/auth/customer/login', () => {
  it('login password => usuario sanitizado (sin hash ni datos internos)', async () => {
    (loginWithPassword as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await customerLoginPOST(
      jsonRequest('/api/auth/customer/login', {
        method: 'password',
        phoneOrEmail: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.id).toBe(RAW_DB_USER.id);
    expectSafeUserPayload(json);
  });

  it('login OTP => usuario sanitizado', async () => {
    (loginWithPhone as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await customerLoginPOST(
      jsonRequest('/api/auth/customer/login', { method: 'phone', phone: '3001234567', otpCode: '1234' })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expectSafeUserPayload(json);
  });

  it('login exitoso transfiere la sesión guest UNA vez y rota la cookie de invitado', async () => {
    (loginWithPassword as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await customerLoginPOST(
      jsonRequest('/api/auth/customer/login', {
        method: 'password',
        phoneOrEmail: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );

    expect(res.status).toBe(200);
    expect(transferSessionDataToUser).toHaveBeenCalledTimes(1);
    expect(transferSessionDataToUser).toHaveBeenCalledWith('guest-session-1', RAW_DB_USER.id);
    expect(rotateGuestSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('handoff-first: la transferencia ocurre ANTES de publicar la cookie y rotar la guest', async () => {
    (loginWithPassword as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await customerLoginPOST(
      jsonRequest('/api/auth/customer/login', {
        method: 'password',
        phoneOrEmail: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );

    expect(res.status).toBe(200);
    const orderOf = (fn: any) => fn.mock.invocationCallOrder[0];
    expect(orderOf(transferSessionDataToUser)).toBeLessThan(orderOf(setSessionCookie));
    expect(orderOf(transferSessionDataToUser)).toBeLessThan(orderOf(rotateGuestSessionCookie));
  });

  it('si la transferencia guest→cuenta FALLA => 500 SIN cookie de sesión, sin rotación y sin reset de rate limit', async () => {
    (loginWithPassword as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });
    (transferSessionDataToUser as any).mockRejectedValueOnce(new Error('handoff down'));

    const res = await customerLoginPOST(
      jsonRequest('/api/auth/customer/login', {
        method: 'password',
        phoneOrEmail: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );
    const json = await res.json();

    // Handoff-first: jamás se publica un 200 autenticado con datos guest
    // invisibles; la sesión guest conserva acceso y el cliente reintenta.
    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toContain('permanecen intactos');
    expect(transferSessionDataToUser).toHaveBeenCalledTimes(1);
    expect(setSessionCookie).not.toHaveBeenCalled();
    expect(rotateGuestSessionCookie).not.toHaveBeenCalled();
    expect(mockDb.rateLimit.deleteMany).not.toHaveBeenCalled(); // resetRateLimit NO ejecutado
  });
});

describe('ENDPOINT /api/auth/register', () => {
  it('registro => usuario sanitizado', async () => {
    (registerCustomer as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await registerPOST(
      jsonRequest('/api/auth/register', {
        name: 'Cliente Crudo',
        phone: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.id).toBe(RAW_DB_USER.id);
    expectSafeUserPayload(json);
  });

  it('registro exitoso transfiere la sesión guest y rota la cookie de invitado', async () => {
    (registerCustomer as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });

    const res = await registerPOST(
      jsonRequest('/api/auth/register', {
        name: 'Cliente Crudo',
        phone: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );

    expect(res.status).toBe(200);
    expect(transferSessionDataToUser).toHaveBeenCalledTimes(1);
    expect(transferSessionDataToUser).toHaveBeenCalledWith('guest-session-1', RAW_DB_USER.id);
    expect(rotateGuestSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('si la transferencia guest→cuenta FALLA => 500 (cuenta persistida) SIN cookie, sin rotación ni reset', async () => {
    (registerCustomer as any).mockResolvedValue({ token: 'tok', user: RAW_DB_USER });
    (transferSessionDataToUser as any).mockRejectedValueOnce(new Error('handoff down'));

    const res = await registerPOST(
      jsonRequest('/api/auth/register', {
        name: 'Cliente Crudo',
        phone: '3001234567',
        password: TEST_API_PASSWORD,
      })
    );
    const json = await res.json();

    // La cuenta persiste INTENCIONALMENTE (sin compensación destructiva):
    // la sesión guest conserva acceso y el login posterior completa el
    // handoff. Jamás se publica una sesión autenticada sin handoff.
    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toContain('Tu cuenta fue creada');
    expect(setSessionCookie).not.toHaveBeenCalled();
    expect(rotateGuestSessionCookie).not.toHaveBeenCalled();
    expect(mockDb.rateLimit.deleteMany).not.toHaveBeenCalled(); // resetRateLimit NO ejecutado
  });
});
