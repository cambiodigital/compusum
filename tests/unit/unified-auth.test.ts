import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TEST_LOGIN_PASSWORD,
  TEST_WRONG_PASSWORD,
  TEST_BCRYPT_PLACEHOLDER,
} from '../helpers/credentials';

/**
 * AUTH UNIFICADA (src/lib/unified-auth.ts + src/lib/email-otp.ts).
 *
 * Matriz principal: los 4 roles (CUSTOMER, admin, editor, AGENT) × contraseña
 * (email/teléfono) y OTP (email vía capa propia; SMS vía adapter simulado),
 * redirect server-side por rol, `next` seguro, anti-enumeración y las
 * garantías del OTP de email (HMAC, expiración, single-use, intentos,
 * cooldown). Se mockea la DB (mapas en memoria), el proveedor de correo y el
 * adapter de teléfono; bcrypt y el HMAC son REALES.
 */

// ---------------------------------------------------------------------------
// Entorno del canal email (leído en tiempo de llamada, no de importación)
// ---------------------------------------------------------------------------
process.env.OTP_HMAC_SECRET = 'test-secret-otp-hmac-0123456789abcdef';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.EMAIL_FROM = 'Compusum <no-reply@test.local>';

// ---------------------------------------------------------------------------
// DB en memoria
// ---------------------------------------------------------------------------
const emailUsers = new Map<string, any>();
const phoneUsers = new Map<string, any>();
const challenges = new Map<string, any>(); // key: purpose|identityType|identity

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

// ---------------------------------------------------------------------------
// Proveedores simulados
// ---------------------------------------------------------------------------
const sentEmails: Array<{ to: string; subject: string; text: string; html: string }> = [];

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
    sendPhoneOtp: vi.fn().mockResolvedValue({ provider: 'mock', debugCode: '123456' }),
    verifyPhoneOtp: vi.fn().mockImplementation(async (_phone: string, code: string) => {
      if (code !== '654321') throw new Error('Código inválido o expirado');
    }),
    isPhoneOtpLoginEnabled: vi.fn().mockReturnValue(true),
  };
});

import bcrypt from 'bcryptjs';
import {
  loginWithPasswordUnified,
  sendOtpForLogin,
  verifyOtpForLogin,
  resolvePostLoginRedirect,
  sanitizeNextPath,
  findUserByIdentifier,
  UnifiedAuthError,
  GENERIC_LOGIN_FAILURE,
  GENERIC_OTP_FAILURE,
} from '@/lib/unified-auth';
import {
  issueEmailOtp,
  verifyEmailOtp,
  EmailOtpError,
  EMAIL_OTP_LENGTH,
} from '@/lib/email-otp';
import { sendPhoneOtp, verifyPhoneOtp } from '@/lib/auth-dual';
import { sendEmail } from '@/lib/email-provider';

let userSeq = 0;

async function seedUser(opts: {
  email?: string | null;
  phone?: string | null;
  role?: string;
  isActive?: boolean;
  password?: string;
  emailVerifiedAt?: Date | null;
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
    emailVerifiedAt: opts.emailVerifiedAt ?? null,
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

beforeEach(() => {
  vi.clearAllMocks();
  emailUsers.clear();
  phoneUsers.clear();
  challenges.clear();
  sentEmails.length = 0;
  process.env.OTP_HMAC_SECRET = 'test-secret-otp-hmac-0123456789abcdef';
  process.env.RESEND_API_KEY = 're_test_key_placeholder';
  process.env.EMAIL_FROM = 'Compusum <no-reply@test.local>';
  delete process.env.ENABLE_MOCK_PHONE_OTP;

  mockDb.user.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.email !== undefined) return emailUsers.get(where.email) ?? null;
    if (where.phone !== undefined) return phoneUsers.get(where.phone) ?? null;
    if (where.id !== undefined) {
      for (const u of [...emailUsers.values(), ...phoneUsers.values()]) {
        if (u.id === where.id) return u;
      }
      return null;
    }
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
});

afterEach(() => {
  delete process.env.OTP_HMAC_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

/** Extrae el código del email capturado (solo tests). */
function codeFromLastEmail(): string {
  const last = sentEmails[sentEmails.length - 1];
  const match = last.text.match(/es: (\d{6})/);
  if (!match) throw new Error('El email capturado no contiene código de 6 dígitos');
  return match[1];
}

// ===========================================================================
// LOGIN POR CONTRASEÑA (los 4 roles)
// ===========================================================================
describe('Login unificado por contraseña', () => {
  it('CUSTOMER: email + contraseña => sesión y redirect a /mi-cuenta', async () => {
    const user = await seedUser({ email: 'cliente@test.com', password: TEST_LOGIN_PASSWORD });
    const result = await loginWithPasswordUnified('cliente@test.com', TEST_LOGIN_PASSWORD);
    expect(result.token).toBeDefined();
    expect(result.user.id).toBe(user.id);
    expect(result.user.role).toBe('CUSTOMER');
    expect(result.redirectTo).toBe('/mi-cuenta');
    expect(mockDb.session.create).toHaveBeenCalled();
  });

  it('CUSTOMER: teléfono + contraseña (cualquier forma equivalente) => sesión', async () => {
    await seedUser({ phone: '573001234567', password: TEST_LOGIN_PASSWORD });
    for (const forma of ['3001234567', '+573001234567', '573001234567']) {
      const result = await loginWithPasswordUnified(forma, TEST_LOGIN_PASSWORD);
      expect(result.redirectTo).toBe('/mi-cuenta');
    }
  });

  it('admin: email + contraseña => redirect a /admin', async () => {
    await seedUser({ email: 'admin@compusum.co', role: 'admin', password: TEST_LOGIN_PASSWORD });
    const result = await loginWithPasswordUnified('admin@compusum.co', TEST_LOGIN_PASSWORD);
    expect(result.redirectTo).toBe('/admin');
  });

  it('editor: email + contraseña => redirect a /admin', async () => {
    await seedUser({ email: 'editor@compusum.co', role: 'editor', password: TEST_LOGIN_PASSWORD });
    const result = await loginWithPasswordUnified('editor@compusum.co', TEST_LOGIN_PASSWORD);
    expect(result.redirectTo).toBe('/admin');
  });

  it('AGENT: email + contraseña => redirect a /admin (sin otorgar permisos extra)', async () => {
    await seedUser({ email: 'agente@compusum.co', role: 'AGENT', password: TEST_LOGIN_PASSWORD });
    const result = await loginWithPasswordUnified('agente@compusum.co', TEST_LOGIN_PASSWORD);
    expect(result.redirectTo).toBe('/admin');
  });

  it('contraseña incorrecta => genérico, sin revelar rol ni existencia', async () => {
    await seedUser({ email: 'c2@test.com', role: 'admin', password: TEST_LOGIN_PASSWORD });
    await expect(
      loginWithPasswordUnified('c2@test.com', TEST_WRONG_PASSWORD)
    ).rejects.toThrow(GENERIC_LOGIN_FAILURE);
  });

  it('cuenta inexistente => EXACTAMENTE el mismo mensaje genérico', async () => {
    let msgExisting = '';
    let msgMissing = '';
    await seedUser({ email: 'real@test.com', password: TEST_LOGIN_PASSWORD });
    try {
      await loginWithPasswordUnified('real@test.com', TEST_WRONG_PASSWORD);
    } catch (e: any) {
      msgExisting = e.message;
    }
    try {
      await loginWithPasswordUnified('fantasma@test.com', TEST_WRONG_PASSWORD);
    } catch (e: any) {
      msgMissing = e.message;
    }
    expect(msgExisting).toBe(msgMissing);
    expect(msgMissing).toBe(GENERIC_LOGIN_FAILURE);
  });

  it('usuario inactivo => rechazado con mensaje de cuenta desactivada', async () => {
    await seedUser({ email: 'off@test.com', password: TEST_LOGIN_PASSWORD, isActive: false });
    await expect(loginWithPasswordUnified('off@test.com', TEST_LOGIN_PASSWORD)).rejects.toThrow(
      'desactivada'
    );
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });

  it('rol desconocido => fail-closed con error genérico (sin sesión)', async () => {
    await seedUser({ email: 'raro@test.com', role: 'SUPERVISOR', password: TEST_LOGIN_PASSWORD });
    await expect(loginWithPasswordUnified('raro@test.com', TEST_LOGIN_PASSWORD)).rejects.toThrow(
      GENERIC_LOGIN_FAILURE
    );
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });

  it('lastLogin se actualiza para todos los roles (antes solo admin)', async () => {
    await seedUser({ email: 'll@test.com', password: TEST_LOGIN_PASSWORD });
    await loginWithPasswordUnified('ll@test.com', TEST_LOGIN_PASSWORD);
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastLogin: expect.any(Date) }),
      })
    );
  });
});

// ===========================================================================
// REDIRECT POR ROL Y `next` SEGURO
// ===========================================================================
describe('Redirect autorizado post-login', () => {
  it('home por rol: CUSTOMER → /mi-cuenta; admin/editor/AGENT → /admin', () => {
    expect(resolvePostLoginRedirect('CUSTOMER')).toBe('/mi-cuenta');
    expect(resolvePostLoginRedirect('admin')).toBe('/admin');
    expect(resolvePostLoginRedirect('editor')).toBe('/admin');
    expect(resolvePostLoginRedirect('AGENT')).toBe('/admin');
  });

  it('`next` interno permitido se respeta', () => {
    expect(sanitizeNextPath('/mis-pedidos', 'CUSTOMER')).toBe('/mis-pedidos');
    expect(sanitizeNextPath('/admin/pedidos/abc', 'admin')).toBe('/admin/pedidos/abc');
    expect(sanitizeNextPath('/admin', 'AGENT')).toBe('/admin');
  });

  it('`next` externo o malicioso se rechaza SIEMPRE', () => {
    const externos = [
      'http://evil.com',
      'https://evil.com/x',
      '//evil.com',
      '/\\evil.com',
      'javascript:alert(1)',
      'https:/\\evil.com',
      ' /ingresar',
      '',
      null,
      undefined,
      42,
    ];
    for (const next of externos) {
      expect(sanitizeNextPath(next as any, 'CUSTOMER')).toBeNull();
      expect(sanitizeNextPath(next as any, 'admin')).toBeNull();
    }
  });

  it('CUSTOMER nunca redirige a /admin vía `next` (y viceversa el backoffice no cae al storefront)', () => {
    expect(sanitizeNextPath('/admin', 'CUSTOMER')).toBeNull();
    expect(sanitizeNextPath('/admin/clientes', 'CUSTOMER')).toBeNull();
    expect(resolvePostLoginRedirect('CUSTOMER', '/admin')).toBe('/mi-cuenta');
    expect(sanitizeNextPath('/mi-cuenta', 'admin')).toBeNull();
    expect(resolvePostLoginRedirect('admin', '/mi-cuenta')).toBe('/admin');
  });
});

// ===========================================================================
// OTP TEMPORAL: EMAIL (canal preferido) Y SMS (fallback)
// ===========================================================================
describe('OTP de login: canal email', () => {
  it('CUSTOMER con email: envía 6 dígitos por correo y verifica => sesión + emailVerifiedAt', async () => {
    await seedUser({ email: 'otp1@test.com', password: TEST_LOGIN_PASSWORD });

    const sent = await sendOtpForLogin('otp1@test.com');
    expect(sent?.channel).toBe('email');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendPhoneOtp).not.toHaveBeenCalled();

    const code = codeFromLastEmail();
    expect(code).toHaveLength(EMAIL_OTP_LENGTH);

    const result = await verifyOtpForLogin('otp1@test.com', code);
    expect(result.token).toBeDefined();
    expect(result.redirectTo).toBe('/mi-cuenta');
    // Posesión del correo demostrada => verificado
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emailVerifiedAt: expect.any(Date) }),
      })
    );
  });

  it('admin y AGENT con email: OTP por correo => redirect a /admin', async () => {
    await seedUser({ email: 'admin-otp@compusum.co', role: 'admin' });
    await sendOtpForLogin('admin-otp@compusum.co');
    const codeAdmin = codeFromLastEmail();
    const r1 = await verifyOtpForLogin('admin-otp@compusum.co', codeAdmin);
    expect(r1.redirectTo).toBe('/admin');

    await seedUser({ email: 'agente-otp@compusum.co', role: 'AGENT' });
    await sendOtpForLogin('agente-otp@compusum.co');
    const codeAgente = codeFromLastEmail();
    const r2 = await verifyOtpForLogin('agente-otp@compusum.co', codeAgente);
    expect(r2.redirectTo).toBe('/admin');
  });

  it('OTP incorrecto => genérico e intentos incrementados; sin sesión', async () => {
    await seedUser({ email: 'otp2@test.com' });
    await sendOtpForLogin('otp2@test.com');
    const code = codeFromLastEmail();

    await expect(verifyOtpForLogin('otp2@test.com', '000000')).rejects.toThrow(
      GENERIC_OTP_FAILURE
    );
    expect(mockDb.session.create).not.toHaveBeenCalled();

    const key = challengeKey('login', 'email', 'otp2@test.com');
    expect(challenges.get(key).attempts).toBe(1);
    expect(code).not.toBe('000000');
  });

  it('OTP expirado => genérico y el desafío se destruye', async () => {
    await seedUser({ email: 'otp3@test.com' });
    await sendOtpForLogin('otp3@test.com');
    const code = codeFromLastEmail();
    const key = challengeKey('login', 'email', 'otp3@test.com');
    challenges.get(key).expiresAt = new Date(Date.now() - 1000);

    await expect(verifyOtpForLogin('otp3@test.com', code)).rejects.toThrow(GENERIC_OTP_FAILURE);
    expect(challenges.has(key)).toBe(false);
  });

  it('OTP reutilizado (single-use) => el segundo uso falla', async () => {
    await seedUser({ email: 'otp4@test.com' });
    await sendOtpForLogin('otp4@test.com');
    const code = codeFromLastEmail();

    await expect(verifyOtpForLogin('otp4@test.com', code)).resolves.toBeTruthy();
    // El primer verify consumió la sesión; un segundo login con el MISMO
    // código no puede salir bien ni re-crear sesión adicional válida.
    const sesionesTrasPrimerUso = mockDb.session.create.mock.calls.length;
    await expect(verifyOtpForLogin('otp4@test.com', code)).rejects.toThrow(GENERIC_OTP_FAILURE);
    expect(mockDb.session.create.mock.calls.length).toBe(sesionesTrasPrimerUso);
  });

  it('límite de intentos: al 5º código incorrecto el desafío muere', async () => {
    await seedUser({ email: 'otp5@test.com' });
    await sendOtpForLogin('otp5@test.com');
    const key = challengeKey('login', 'email', 'otp5@test.com');

    for (let i = 0; i < 5; i++) {
      await expect(verifyOtpForLogin('otp5@test.com', '111111')).rejects.toThrow(
        GENERIC_OTP_FAILURE
      );
    }
    expect(challenges.has(key)).toBe(false);
    // Y aunque el código real llegue después, ya no existe el desafío
    await expect(verifyOtpForLogin('otp5@test.com', codeFromLastEmail())).rejects.toThrow(
      GENERIC_OTP_FAILURE
    );
  });

  it('cooldown de reenvío: la reemisión inmediata se rechaza con retryAfter', async () => {
    await seedUser({ email: 'otp6@test.com' });
    await issueEmailOtp('otp6@test.com', 'login');
    await expect(issueEmailOtp('otp6@test.com', 'login')).rejects.toMatchObject({
      code: 'COOLDOWN',
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('reenvío tras cooldown reemplaza el código (anterior inutilizable)', async () => {
    await seedUser({ email: 'otp7@test.com' });
    await issueEmailOtp('otp7@test.com', 'login');
    const key = challengeKey('login', 'email', 'otp7@test.com');
    // Simula el paso del cooldown retrocediendo createdAt
    challenges.get(key).createdAt = new Date(Date.now() - 61_000);

    await issueEmailOtp('otp7@test.com', 'login');
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const nuevoCodigo = codeFromLastEmail();
    const row = challenges.get(key);
    expect(row.attempts).toBe(0);

    const hash = row.codeHash;
    expect(hash).not.toContain(nuevoCodigo);
    expect(hash).toHaveLength(64);
    await expect(verifyOtpForLogin('otp7@test.com', nuevoCodigo)).resolves.toBeTruthy();
  });

  it('el código NUNCA se persiste en texto plano (solo HMAC)', async () => {
    await seedUser({ email: 'otp8@test.com' });
    await sendOtpForLogin('otp8@test.com');
    const code = codeFromLastEmail();
    const row = challenges.get(challengeKey('login', 'email', 'otp8@test.com'));
    expect(row.codeHash).toHaveLength(64);
    expect(row.codeHash).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('cuenta inexistente / inactiva / teléfono sin cuenta => sin envío (null)', async () => {
    expect(await sendOtpForLogin('nadie@test.com')).toBeNull();
    await seedUser({ email: 'off2@test.com', isActive: false });
    expect(await sendOtpForLogin('off2@test.com')).toBeNull();
    await seedUser({ phone: '573111222333' });
    expect(await sendOtpForLogin('3112223331')).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });

  it('Resend sin configurar => canal email deshabilitado (fail-closed)', async () => {
    delete process.env.RESEND_API_KEY;
    await seedUser({ email: 'sinresend@test.com' });
    await expect(sendOtpForLogin('sinresend@test.com')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('OTP_HMAC_SECRET débil/ausente => canal email deshabilitado', async () => {
    process.env.OTP_HMAC_SECRET = 'corto';
    await seedUser({ email: 'secretobajo@test.com' });
    await expect(sendOtpForLogin('secretobajo@test.com')).rejects.toBeInstanceOf(EmailOtpError);
  });
});

describe('OTP de login: canal SMS (fallback)', () => {
  it('CUSTOMER solo teléfono: envía SMS y verifica => sesión', async () => {
    await seedUser({ phone: '573001234567' });

    const sent = await sendOtpForLogin('3001234567');
    expect(sent?.channel).toBe('sms');
    expect(sendPhoneOtp).toHaveBeenCalledWith('573001234567');
    expect(sendEmail).not.toHaveBeenCalled();
    // El mock de desarrollo propaga su código (nunca en producción)
    expect(sent?.debugCode).toBe('123456');

    const result = await verifyOtpForLogin('3001234567', '654321');
    expect(result.token).toBeDefined();
    expect(result.redirectTo).toBe('/mi-cuenta');
    expect(verifyPhoneOtp).toHaveBeenCalledWith('573001234567', '654321');
  });

  it('OTP SMS incorrecto => genérico, sin sesión', async () => {
    await seedUser({ phone: '573001234567' });
    await sendOtpForLogin('3001234567');
    await expect(verifyOtpForLogin('3001234567', '000000')).rejects.toThrow(GENERIC_OTP_FAILURE);
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });

  it('el OTP por teléfono JAMÁS crea cuentas (LOGIN ≠ registro)', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    await expect(verifyOtpForLogin('3155550000', '654321')).rejects.toThrow(GENERIC_OTP_FAILURE);
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// BÚSQUEDA CENTRALIZADA
// ===========================================================================
describe('findUserByIdentifier (maestro User, cualquier rol)', () => {
  it('resuelve admin por email y AGENT por teléfono — no solo CUSTOMER', async () => {
    await seedUser({ email: 'a1@compusum.co', role: 'admin' });
    await seedUser({ phone: '573200000001', role: 'AGENT' });

    const byEmail = await findUserByIdentifier('a1@compusum.co');
    expect(byEmail?.role).toBe('admin');

    const byPhone = await findUserByIdentifier('3200000001');
    expect(byPhone?.role).toBe('AGENT');
  });

  it('identificador inválido => null (sin lanzar)', async () => {
    expect(await findUserByIdentifier('esto-no-es-nada!!')).toBeNull();
    expect(await findUserByIdentifier('')).toBeNull();
  });
});

// ===========================================================================
// ERRORES TIPADOS
// ===========================================================================
describe('UnifiedAuthError', () => {
  it('expone código y mensaje para mapeo de respuestas HTTP', async () => {
    await seedUser({ email: 'inact3@test.com', isActive: false, password: TEST_LOGIN_PASSWORD });
    try {
      await loginWithPasswordUnified('inact3@test.com', TEST_LOGIN_PASSWORD);
      throw new Error('debió lanzar');
    } catch (e: any) {
      expect(e).toBeInstanceOf(UnifiedAuthError);
      expect(e.code).toBe('INACTIVE');
    }
  });
});
