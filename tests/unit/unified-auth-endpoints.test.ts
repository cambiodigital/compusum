import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_API_PASSWORD, TEST_WRONG_PASSWORD, TEST_BCRYPT_PLACEHOLDER } from '../helpers/credentials';

/**
 * ENDPOINTS DE LA AUTH UNIFICADA:
 *   POST /api/auth/login        (contraseña, cualquier rol, redirectTo server-side)
 *   POST /api/auth/otp/send     (código temporal: email->correo, teléfono->SMS)
 *   POST /api/auth/otp/verify   (verificación + sesión)
 *   POST /api/auth/phone/send-otp (LEGACY deprecado, delega en el envío unificado)
 *
 * Garantías probadas a nivel HTTP: anti-enumeración (respuestas idénticas),
 * redirect autorizado por rol (el cliente NO decide), `next` externo
 * rechazado, códigos OTP jamás en la respuesta (producción), handoff-first,
 * y degradación 503 cuando Resend/Twilio no están configurados.
 */

process.env.OTP_HMAC_SECRET = 'test-secret-otp-hmac-0123456789abcdef';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.EMAIL_FROM = 'Compusum <no-reply@test.local>';

const emailUsers = new Map<string, any>();
const phoneUsers = new Map<string, any>();
const challenges = new Map<string, any>();

const mockDb = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  session: {
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  authChallenge: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    // Solo se sustituyen las piezas que tocan cookies() fuera de request scope;
    // verifyPassword/hashPassword quedan REALES (bcrypt) para la matriz.
    setSessionCookie: vi.fn().mockResolvedValue(undefined),
    clearSessionCookie: vi.fn(),
    rotateGuestSessionCookie: vi.fn().mockResolvedValue('new-guest-session'),
    createSession: vi.fn().mockResolvedValue('session-token-opaco'),
    getCurrentUser: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ isBlocked: false, remainingAttempts: 10 }),
  recordFailedAttempt: vi.fn().mockResolvedValue({ isBlocked: false, remainingAttempts: 9 }),
  resetRateLimit: vi.fn().mockResolvedValue(undefined),
  getClientIp: vi.fn().mockReturnValue('10.99.0.1'),
  OTP_SEND_IP_MAX_ATTEMPTS: 10,
  OTP_SEND_ID_MAX_ATTEMPTS: 5,
  OTP_SEND_WINDOW_MS: 900000,
  OTP_SEND_LOCKOUT_MS: 1800000,
  OTP_VERIFY_IP_MAX_ATTEMPTS: 10,
  OTP_VERIFY_ID_MAX_ATTEMPTS: 10,
  OTP_VERIFY_WINDOW_MS: 900000,
  OTP_VERIFY_LOCKOUT_MS: 900000,
}));

vi.mock('@/lib/checkout', () => ({
  transferSessionDataToUser: vi.fn().mockResolvedValue({ cart: null, orders: null }),
}));

vi.mock('@/lib/email-provider', () => ({
  sendEmail: vi.fn().mockImplementation(async (input: any) => {
    sentEmails.push(input);
  }),
  isEmailProviderConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/auth-dual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-dual')>('@/lib/auth-dual');
  return {
    ...actual,
    sendPhoneOtp: vi.fn().mockResolvedValue({ provider: 'mock' }),
    verifyPhoneOtp: vi.fn().mockImplementation(async (_phone: string, code: string) => {
      if (code !== '654321') throw new Error('Código inválido o expirado');
    }),
    isPhoneOtpLoginEnabled: vi.fn().mockReturnValue(true),
  };
});

import bcrypt from 'bcryptjs';
import { POST as unifiedLoginPOST } from '@/app/api/auth/login/route';
import { POST as otpSendPOST } from '@/app/api/auth/otp/send/route';
import { POST as otpVerifyPOST } from '@/app/api/auth/otp/verify/route';
import { POST as legacySendOtpPOST } from '@/app/api/auth/phone/send-otp/route';
import { setSessionCookie, rotateGuestSessionCookie } from '@/lib/auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import { sendPhoneOtp, isPhoneOtpLoginEnabled } from '@/lib/auth-dual';
import { sendEmail } from '@/lib/email-provider';

const sentEmails: Array<{ to: string; subject: string; text: string; html: string }> = [];

let userSeq = 0;

async function seedUser(opts: {
  email?: string | null;
  phone?: string | null;
  role?: string;
  isActive?: boolean;
  password?: string;
}) {
  const id = `u-${++userSeq}`;
  const user = {
    id,
    name: `Usuario ${id}`,
    email: opts.email ?? null,
    phone: opts.phone ?? null,
    role: opts.role ?? 'CUSTOMER',
    isActive: opts.isActive ?? true,
    password: opts.password ? await bcrypt.hash(opts.password, 10) : TEST_BCRYPT_PLACEHOLDER,
    emailVerifiedAt: null,
    company: null,
    taxId: null,
    city: null,
  };
  if (user.email) emailUsers.set(user.email, user);
  if (user.phone) phoneUsers.set(user.phone, user);
  return user;
}

function challengeKey(purpose: string, identityType: string, identity: string) {
  return `${purpose}|${identityType}|${identity}`;
}

function jsonReq(url: string, body: unknown): any {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'guest-session-1' },
    body: JSON.stringify(body),
  });
}

function codeFromLastEmail(): string {
  const last = sentEmails[sentEmails.length - 1];
  const match = last.text.match(/es: (\d{6})/);
  if (!match) throw new Error('El email capturado no contiene código');
  return match[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  emailUsers.clear();
  phoneUsers.clear();
  challenges.clear();
  sentEmails.length = 0;
  process.env.OTP_HMAC_SECRET = 'test-secret-otp-hmac-0123456789abcdef';
  process.env.RESEND_API_KEY = 're_test_key_placeholder';
  process.env.EMAIL_FROM = 'Compusum <no-reply@test.local>';

  mockDb.user.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.email !== undefined) return emailUsers.get(where.email) ?? null;
    if (where.phone !== undefined) return phoneUsers.get(where.phone) ?? null;
    return null;
  });
  mockDb.user.findFirst.mockResolvedValue(null);
  mockDb.user.update.mockResolvedValue({});
  mockDb.session.create.mockResolvedValue({});
  mockDb.session.deleteMany.mockResolvedValue({});

  mockDb.authChallenge.findUnique.mockImplementation(async ({ where }: any) => {
    const { purpose, identityType, identity } = where.purpose_identityType_identity;
    return challenges.get(challengeKey(purpose, identityType, identity)) ?? null;
  });
  mockDb.authChallenge.upsert.mockImplementation(async ({ where, create, update }: any) => {
    const { purpose, identityType, identity } = where.purpose_identityType_identity;
    const key = challengeKey(purpose, identityType, identity);
    const prev = challenges.get(key);
    const row = prev
      ? { ...prev, ...update, id: prev.id }
      : {
          // Simula los defaults de Prisma que el mock no ejecuta
          id: `ch-${challenges.size + 1}`,
          createdAt: new Date(),
          maxAttempts: 5,
          ...create,
        };
    challenges.set(key, row);
    return row;
  });
  mockDb.authChallenge.update.mockImplementation(async ({ where, data }: any) => {
    for (const [key, row] of challenges) {
      if (row.id === where.id) {
        challenges.set(key, { ...row, ...data });
        return challenges.get(key);
      }
    }
    throw new Error('not found');
  });
  mockDb.authChallenge.delete.mockImplementation(async ({ where }: any) => {
    for (const [key, row] of challenges) {
      if (row.id === where.id) {
        challenges.delete(key);
        return row;
      }
    }
    throw new Error('not found');
  });
  mockDb.authChallenge.deleteMany.mockResolvedValue({ count: 0 });
  // clearAllMocks() NO restaura implementaciones: re-fijar el default del
  // adapter de teléfono para que un test de "no configurado" no contamine.
  (isPhoneOtpLoginEnabled as any).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OTP_HMAC_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

// ===========================================================================
// POST /api/auth/login — unificado por contraseña
// ===========================================================================
describe('ENDPOINT /api/auth/login (unificado)', () => {
  it('LEGACY compat: {email,password} de admin => 200 con redirectTo /admin', async () => {
    await seedUser({ email: 'admin@compusum.co', role: 'admin', password: TEST_API_PASSWORD });

    const res = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { email: 'admin@compusum.co', password: TEST_API_PASSWORD })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.redirectTo).toBe('/admin');
    expect(json.data.user.role).toBe('admin');
    expect(setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('CUSTOMER con identifier email + next=/mi-cuenta => respeta next interno', async () => {
    await seedUser({ email: 'c@test.com', password: TEST_API_PASSWORD });

    const res = await unifiedLoginPOST(
      jsonReq('/api/auth/login', {
        identifier: 'c@test.com',
        password: TEST_API_PASSWORD,
        next: '/mi-cuenta',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.redirectTo).toBe('/mi-cuenta');
  });

  it('CUSTOMER con next=/admin => el SERVIDOR lo deniega y manda a /mi-cuenta', async () => {
    await seedUser({ email: 'c2@test.com', password: TEST_API_PASSWORD });

    const res = await unifiedLoginPOST(
      jsonReq('/api/auth/login', {
        identifier: 'c2@test.com',
        password: TEST_API_PASSWORD,
        next: '/admin',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.redirectTo).toBe('/mi-cuenta');
  });

  it('next externo (http://evil.com) => rechazado, destino = home del rol', async () => {
    await seedUser({ email: 'admin2@compusum.co', role: 'admin', password: TEST_API_PASSWORD });

    const res = await unifiedLoginPOST(
      jsonReq('/api/auth/login', {
        identifier: 'admin2@compusum.co',
        password: TEST_API_PASSWORD,
        next: 'http://evil.com',
      })
    );

    expect((await res.json()).data.redirectTo).toBe('/admin');
  });

  it('AGENT y editor por contraseña => redirectTo /admin', async () => {
    await seedUser({ email: 'ag@test.com', role: 'AGENT', password: TEST_API_PASSWORD });
    await seedUser({ email: 'ed@test.com', role: 'editor', password: TEST_API_PASSWORD });

    const r1 = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'ag@test.com', password: TEST_API_PASSWORD })
    );
    const r2 = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'ed@test.com', password: TEST_API_PASSWORD })
    );

    expect((await r1.json()).data.redirectTo).toBe('/admin');
    expect((await r2.json()).data.redirectTo).toBe('/admin');
  });

  it('contraseña incorrecta vs cuenta inexistente => EXACTAMENTE el mismo 401', async () => {
    await seedUser({ email: 'real@test.com', password: TEST_API_PASSWORD });

    const resA = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'real@test.com', password: TEST_WRONG_PASSWORD })
    );
    const resB = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'fantasma@test.com', password: TEST_WRONG_PASSWORD })
    );

    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);
    expect(await resA.json()).toEqual(await resB.json());
  });

  it('inactivo => 403 con mensaje de cuenta desactivada (tras demostrar credenciales)', async () => {
    await seedUser({ email: 'off@test.com', password: TEST_API_PASSWORD, isActive: false });

    const res = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'off@test.com', password: TEST_API_PASSWORD })
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toContain('desactivada');
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('rememberMe => cookie de 30 días; sin rememberMe => 24h', async () => {
    await seedUser({ email: 'rm1@test.com', password: TEST_API_PASSWORD });
    await seedUser({ email: 'rm2@test.com', password: TEST_API_PASSWORD });

    await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'rm1@test.com', password: TEST_API_PASSWORD, rememberMe: true })
    );
    expect(setSessionCookie).toHaveBeenLastCalledWith('session-token-opaco', 30 * 24 * 60 * 60);

    await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'rm2@test.com', password: TEST_API_PASSWORD })
    );
    expect(setSessionCookie).toHaveBeenLastCalledWith('session-token-opaco', 24 * 60 * 60);
  });

  it('handoff-first: transferencia guest ANTES de publicar cookie; fallo => 500 sin cookie', async () => {
    await seedUser({ email: 'hf@test.com', password: TEST_API_PASSWORD });

    const ok = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'hf@test.com', password: TEST_API_PASSWORD })
    );
    expect(ok.status).toBe(200);
    const orderOf = (fn: any) => fn.mock.invocationCallOrder[0];
    expect(orderOf(transferSessionDataToUser)).toBeLessThan(orderOf(setSessionCookie));

    (transferSessionDataToUser as any).mockRejectedValueOnce(new Error('handoff down'));
    await seedUser({ email: 'hf2@test.com', password: TEST_API_PASSWORD });
    const fail = await unifiedLoginPOST(
      jsonReq('/api/auth/login', { identifier: 'hf2@test.com', password: TEST_API_PASSWORD })
    );
    const json = await fail.json();

    expect(fail.status).toBe(500);
    expect(json.error).toContain('permanecen intactos');
    expect(setSessionCookie).not.toHaveBeenCalledTimes(2); // solo el login OK la publicó
    expect(rotateGuestSessionCookie).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// POST /api/auth/otp/send — envío de código temporal
// ===========================================================================
describe('ENDPOINT /api/auth/otp/send', () => {
  it('cuenta existente con email => 200 genérico, canal email, código enviado por correo', async () => {
    await seedUser({ email: 'otp@test.com' });

    const res = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'otp@test.com' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendPhoneOtp).not.toHaveBeenCalled();
    // Fuera de producción el debugCode es SOLO la comodidad de pruebas: debe
    // coincidir con el código realmente enviado por correo.
    expect(json.data.channel).toBe('email');
    expect(json.data.debugCode).toBe(codeFromLastEmail());
  });

  it('cuenta inexistente => EXACTAMENTE la misma respuesta (anti-enumeración, sin envío)', async () => {
    const res = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'nadie@test.com' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, message: json.message });
    expect(sendEmail).not.toHaveBeenCalled();

    // Compara contra la respuesta de una cuenta existente
    await seedUser({ email: 'existente@test.com' });
    const res2 = await otpSendPOST(
      jsonReq('/api/auth/otp/send', { identifier: 'existente@test.com' })
    );
    const json2 = await res2.json();
    expect(json.message).toBe(json2.message);
  });

  it('teléfono sin cuenta => 200 genérico SIN gastar Twilio', async () => {
    const res = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: '3155550000' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });

  it('en DESARROLLO expone debugCode solo para pruebas (nunca en producción)', async () => {
    await seedUser({ email: 'devcode@test.com' });
    const resDev = await otpSendPOST(
      jsonReq('/api/auth/otp/send', { identifier: 'devcode@test.com' })
    );
    const jsonDev = await resDev.json();
    // NODE_ENV en vitest es 'test' (no producción) => debug permitido
    expect(jsonDev.data?.debugCode).toMatch(/^\d{6}$/);

    vi.stubEnv('NODE_ENV', 'production');
    await seedUser({ email: 'prodcode@test.com' });
    const resProd = await otpSendPOST(
      jsonReq('/api/auth/otp/send', { identifier: 'prodcode@test.com' })
    );
    const rawProd = JSON.stringify(await resProd.json());
    expect(rawProd).not.toContain('debugCode');
  });

  it('Resend no configurado + identificador email => 503 (sin mirar la cuenta)', async () => {
    delete process.env.RESEND_API_KEY;

    const res = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'x@test.com' }));

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('correo');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('Twilio no configurado + identificador teléfono => 503', async () => {
    (isPhoneOtpLoginEnabled as any).mockReturnValueOnce(false);

    const res = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: '3001234567' }));

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('SMS');
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/auth/otp/verify — verificación + sesión
// ===========================================================================
describe('ENDPOINT /api/auth/otp/verify', () => {
  it('código email correcto => 200, sesión publicada y redirectTo por rol', async () => {
    await seedUser({ email: 'v@test.com' });
    await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'v@test.com' }));
    const code = codeFromLastEmail();

    const res = await otpVerifyPOST(
      jsonReq('/api/auth/otp/verify', { identifier: 'v@test.com', code })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.redirectTo).toBe('/mi-cuenta');
    expect(setSessionCookie).toHaveBeenCalledTimes(1);
    expect(rotateGuestSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('admin por OTP de email => redirectTo /admin', async () => {
    await seedUser({ email: 'va@compusum.co', role: 'admin' });
    await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'va@compusum.co' }));
    const code = codeFromLastEmail();

    const res = await otpVerifyPOST(
      jsonReq('/api/auth/otp/verify', { identifier: 'va@compusum.co', code })
    );

    expect((await res.json()).data.redirectTo).toBe('/admin');
  });

  it('código incorrecto => 401 genérico idéntico para cuenta existente e inexistente', async () => {
    await seedUser({ email: 'w@test.com' });
    await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'w@test.com' }));

    const resA = await otpVerifyPOST(
      jsonReq('/api/auth/otp/verify', { identifier: 'w@test.com', code: '000000' })
    );
    const resB = await otpVerifyPOST(
      jsonReq('/api/auth/otp/verify', { identifier: 'nadie@test.com', code: '000000' })
    );

    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);
    expect(await resA.json()).toEqual(await resB.json());
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('el código correcto NUNCA se refleja en la respuesta', async () => {
    await seedUser({ email: 'z@test.com' });
    await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: 'z@test.com' }));
    const code = codeFromLastEmail();

    const okRaw = JSON.stringify(
      await (
        await otpVerifyPOST(jsonReq('/api/auth/otp/verify', { identifier: 'z@test.com', code }))
      ).json()
    );
    const badRaw = JSON.stringify(
      await (
        await otpVerifyPOST(
          jsonReq('/api/auth/otp/verify', { identifier: 'z@test.com', code: '999999' })
        )
      ).json()
    );

    expect(okRaw).not.toContain(code);
    expect(badRaw).not.toContain('999999');
  });

  it('OTP SMS de CUSTOMER => sesión y redirectTo /mi-cuenta', async () => {
    await seedUser({ phone: '573001234567' });
    const sent = await otpSendPOST(jsonReq('/api/auth/otp/send', { identifier: '3001234567' }));
    expect((await sent.json()).success).toBe(true);

    const res = await otpVerifyPOST(
      jsonReq('/api/auth/otp/verify', { identifier: '3001234567', code: '654321' })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.redirectTo).toBe('/mi-cuenta');
  });
});

// ===========================================================================
// LEGACY /api/auth/phone/send-otp — deprecado, delega en el envío unificado
// ===========================================================================
describe('ENDPOINT legacy /api/auth/phone/send-otp', () => {
  it('teléfono sin cuenta => éxito genérico SIN gastar Twilio (LOGIN nunca crea cuentas)', async () => {
    const res = await legacySendOtpPOST(jsonReq('/api/auth/phone/send-otp', { phone: '+573155550000' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(sendPhoneOtp).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it('teléfono con cuenta => envía SMS (adapter mock) y mantiene forma de respuesta', async () => {
    await seedUser({ phone: '573001234567' });
    vi.stubEnv('ENABLE_MOCK_PHONE_OTP', 'true');

    const res = await legacySendOtpPOST(jsonReq('/api/auth/phone/send-otp', { phone: '+573001234567' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.provider).toBe('mock');
    expect(sendPhoneOtp).toHaveBeenCalledWith('573001234567');
  });
});
