import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TEST_PASSWORD,
  TEST_WEAK_PASSWORD,
  TEST_LOGIN_PASSWORD,
  TEST_WRONG_PASSWORD,
  TEST_CURRENT_PASSWORD,
  TEST_WRONG_CURRENT_PASSWORD,
  TEST_NEW_PASSWORD,
  TEST_ANY_PASSWORD,
  TEST_HASH_MARKER,
  TEST_BCRYPT_PLACEHOLDER,
} from '../helpers/credentials';

/**
 * AUTH DE CLIENTES: registro, login, cambio y reset de contraseña.
 * Se mockea `@/lib/db` y la verificación OTP (Twilio/mock).
 */

const store = {
  users: new Map<string, any>(),
  sessions: [] as any[],
};

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
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth-dual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-dual')>('@/lib/auth-dual');
  return {
    ...actual,
    // Mock OTP: código fijo 1234 (simula proveedor Twilio/mock de desarrollo)
    verifyPhoneOtp: vi.fn().mockImplementation(async (_phone: string, code: string) => {
      if (code !== '1234') throw new Error('Código inválido o expirado');
    }),
    sendPhoneOtp: vi.fn().mockResolvedValue({ provider: 'mock', debugCode: '1234' }),
    isPhoneOtpLoginEnabled: vi.fn().mockReturnValue(true),
  };
});

vi.mock('@/lib/email-otp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email-otp')>('@/lib/email-otp');
  return {
    ...actual,
    issueEmailOtp: vi.fn().mockResolvedValue({ sent: true }),
    verifyEmailOtp: vi.fn().mockImplementation(async (_email: string, _p: string, code: string) => {
      if (code !== '123456') throw new Error('Código inválido o expirado');
    }),
    isEmailOtpConfigured: vi.fn().mockReturnValue(true),
  };
});

import {
  registerCustomer,
  changePassword,
  resetPasswordWithOtp,
  requestPasswordReset,
  CustomerAuthError,
} from '@/lib/customer-auth';
import { loginWithPassword } from '@/lib/auth-dual';

const createdUsers: any[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  createdUsers.length = 0;
  mockDb.user.create.mockImplementation(({ data }: any) => {
    const user = { id: `user-${createdUsers.length + 1}`, role: 'CUSTOMER', isActive: true, ...data };
    createdUsers.push(user);
    return Promise.resolve(user);
  });
  mockDb.session.create.mockResolvedValue({});
  mockDb.session.deleteMany.mockResolvedValue({});
  mockDb.user.update.mockImplementation(({ data, where }: any) =>
    Promise.resolve({ id: where.id, password: data.password ?? 'hashed', ...data })
  );
  mockDb.user.findFirst.mockResolvedValue(null);
});

describe('Auth: registro de clientes', () => {
  it('registra un CUSTOMER con contraseña hasheada, teléfono CANÓNICO y crea sesión', async () => {
    const result = await registerCustomer({
      name: 'Papelería Nueva',
      email: 'nueva@test.com',
      phone: '3001234567',
      password: TEST_PASSWORD,
    });

    expect(result.user.role).toBe('CUSTOMER');
    expect(result.user.phone).toBe('573001234567');
    expect(result.token).toBeDefined();
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'CUSTOMER', email: 'nueva@test.com', phone: '573001234567' }),
      })
    );
    // Contraseña NUNCA se guarda en claro
    const savedPassword = mockDb.user.create.mock.calls[0][0].data.password;
    expect(savedPassword).not.toBe(TEST_PASSWORD);
    expect(savedPassword.startsWith('$2')).toBe(true); // bcrypt
  });

  it('rechaza registro SIN teléfono (política: única vía de recuperación autónoma)', async () => {
    await expect(
      registerCustomer({ name: 'Solo Email', email: 'solo@test.com', phone: null, password: TEST_PASSWORD })
    ).rejects.toThrow('teléfono');
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it('rechaza contraseñas débiles', async () => {
    await expect(
      registerCustomer({ name: 'X', email: 'x@test.com', phone: '3001234567', password: TEST_WEAK_PASSWORD })
    ).rejects.toThrow(CustomerAuthError);
  });

  it('rechaza cuentas duplicadas (email/teléfono en CUALQUIER forma equivalente)', async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(
      registerCustomer({ name: 'Dup', email: 'existe@test.com', phone: '3001234567', password: TEST_PASSWORD })
    ).rejects.toThrow('Ya existe una cuenta');
    // La búsqueda incluye las variantes canónicas del teléfono
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { email: 'existe@test.com' },
            { phone: '573001234567' },
            { phone: '3001234567' },
          ]),
        }),
      })
    );
  });

  it('exige un teléfono colombiano válido (10 dígitos)', async () => {
    await expect(
      registerCustomer({ name: 'Sin contacto', phone: null, password: TEST_PASSWORD })
    ).rejects.toThrow('número de teléfono');
    await expect(
      registerCustomer({ name: 'Teléfono inválido', phone: '12345', password: TEST_PASSWORD })
    ).rejects.toThrow('número de teléfono');
  });

  it('IDENTIDAD: 3001234567, +573001234567 y 573001234567 son LA MISMA cuenta', async () => {
    // Registro inicial con formato local
    await registerCustomer({ name: 'Unica Cuenta', phone: '3001234567', password: TEST_PASSWORD });
    expect(mockDb.user.create).toHaveBeenCalledTimes(1);
    expect(mockDb.user.create.mock.calls[0][0].data.phone).toBe('573001234567');

    // Un registro equivalente en cualquier otro formato encuentra la MISMA cuenta
    mockDb.user.findFirst.mockResolvedValue({ id: 'user-1' });
    for (const equivalent of ['+573001234567', '573001234567', '(300) 123 4567']) {
      await expect(
        registerCustomer({ name: 'Duplicado', phone: equivalent, password: TEST_WRONG_PASSWORD })
      ).rejects.toThrow('Ya existe una cuenta');
    }
    // NO se creó un segundo User
    expect(mockDb.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('Auth: login por contraseña', () => {
  it('credenciales correctas => sesión creada', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(TEST_LOGIN_PASSWORD, 10);
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@test.com',
      password: hash,
      isActive: true,
      role: 'CUSTOMER',
    });

    const result = await loginWithPassword('a@test.com', TEST_LOGIN_PASSWORD);
    expect(result.token).toBeDefined();
    expect(mockDb.session.create).toHaveBeenCalled();
  });

  it('credenciales incorrectas => error', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(TEST_LOGIN_PASSWORD, 10);
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      email: 'a@test.com',
      password: hash,
      isActive: true,
    });

    await expect(loginWithPassword('a@test.com', TEST_WRONG_PASSWORD)).rejects.toThrow(
      'Credenciales inválidas'
    );
  });

  it('usuario inactivo => rechazado', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      password: TEST_BCRYPT_PLACEHOLDER,
      isActive: false,
    });
    await expect(loginWithPassword('a@test.com', TEST_ANY_PASSWORD)).rejects.toThrow(
      'desactivada'
    );
  });

  it('usuario sin contraseña => guía a usar teléfono', async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: 'u1', password: null, isActive: true });
    await expect(loginWithPassword('a@test.com', TEST_ANY_PASSWORD)).rejects.toThrow(
      'número de teléfono'
    );
  });

  it('IDENTIDAD: login con las 3 formas del teléfono busca la MISMA cuenta', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(TEST_LOGIN_PASSWORD, 10);
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '573001234567',
      password: hash,
      isActive: true,
      role: 'CUSTOMER',
    });

    for (const forma of ['3001234567', '+573001234567', '573001234567']) {
      const result = await loginWithPassword(forma, TEST_LOGIN_PASSWORD);
      expect(result.token).toBeDefined();
      expect(mockDb.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // SOLO cuentas CUSTOMER
            role: expect.objectContaining({ equals: 'CUSTOMER' }),
            OR: expect.arrayContaining([
              { phone: '573001234567' },
              { phone: '3001234567' },
              { email: forma.toLowerCase() },
            ]),
          }),
        })
      );
    }
  });

  it('SOLO autentica role=CUSTOMER: la búsqueda filtra el rol explícitamente', async () => {
    mockDb.user.findFirst.mockResolvedValue(null); // un ADMIN nunca es devuelto por la query
    await expect(loginWithPassword('admin@tienda.com', TEST_LOGIN_PASSWORD)).rejects.toThrow();
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: expect.objectContaining({ equals: 'CUSTOMER' }),
        }),
      })
    );
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });
});

describe('Auth: login por OTP (sin duplicados)', () => {
  // loginWithPhone usa el verifyPhoneOtp REAL (referencia interna del módulo);
  // se habilita el proveedor mock de desarrollo vía env (código 1234).
  beforeEach(() => {
    process.env.ENABLE_MOCK_PHONE_OTP = 'true';
    process.env.MOCK_PHONE_OTP = '1234';
  });
  afterEach(() => {
    delete process.env.ENABLE_MOCK_PHONE_OTP;
    delete process.env.MOCK_PHONE_OTP;
  });

  it('OTP sobre una cuenta creada por registro/password NO crea otro User', async () => {
    // La cuenta YA existe: fue creada por registro con contraseña (formato
    // canónico) y el cliente ingresa después por OTP con otro formato.
    mockDb.user.findFirst.mockResolvedValue({
      id: 'user-1',
      phone: '573001234567',
      isActive: true,
      role: 'CUSTOMER',
      password: TEST_BCRYPT_PLACEHOLDER,
      name: 'Unica Cuenta',
      email: null,
      company: null,
      taxId: null,
      city: null,
    });

    const { loginWithPhone } = await import('@/lib/auth-dual');
    const result = await loginWithPhone('+57 300 123 4567', '1234');

    // Misma cuenta, sin creación de segundo User
    expect(result.user.id).toBe('user-1');
    expect(result.user.phone).toBe('573001234567');
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.session.create).toHaveBeenCalled();
  });

  it('OTP para un teléfono NUEVO NO crea cuenta (LOGIN = solo cuentas existentes)', async () => {
    mockDb.user.findFirst.mockResolvedValue(null);

    const { loginWithPhone } = await import('@/lib/auth-dual');
    // El OTP es válido (mock 1234), pero el teléfono no tiene cuenta: la
    // respuesta es genérica y NO se registra nada (registro explícito en
    // /registrarse).
    await expect(loginWithPhone('3105551234', '1234')).rejects.toThrow(
      'Código inválido o expirado'
    );
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.session.create).not.toHaveBeenCalled();
  });

  it('la respuesta de login OTP es el DTO público (sin password)', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'user-1',
      phone: '573001234567',
      isActive: true,
      role: 'CUSTOMER',
      password: TEST_HASH_MARKER,
      passwordChangedAt: new Date(),
      sessions: [],
    });

    const { loginWithPhone } = await import('@/lib/auth-dual');
    const result = await loginWithPhone('3001234567', '1234');

    expect(JSON.stringify(result.user)).not.toContain(TEST_HASH_MARKER);
    expect(result.user).not.toHaveProperty('password');
    expect(result.user).not.toHaveProperty('passwordChangedAt');
    expect(result.user).not.toHaveProperty('sessions');
  });
});

describe('Auth: cambio de contraseña', () => {
  it('contraseña actual incorrecta => rechazado', async () => {
    const bcrypt = await import('bcryptjs');
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      isActive: true,
      password: await bcrypt.hash(TEST_CURRENT_PASSWORD, 10),
    });

    await expect(changePassword('u1', TEST_WRONG_CURRENT_PASSWORD, TEST_NEW_PASSWORD, 'tok')).rejects.toThrow(
      'contraseña actual es incorrecta'
    );
  });

  it('cambio válido => actualiza passwordChangedAt y cierra las OTRAS sesiones', async () => {
    const bcrypt = await import('bcryptjs');
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      isActive: true,
      password: await bcrypt.hash(TEST_CURRENT_PASSWORD, 10),
    });

    await changePassword('u1', TEST_CURRENT_PASSWORD, TEST_NEW_PASSWORD, 'token-actual');

    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ passwordChangedAt: expect.any(Date) }),
      })
    );
    // Se conservó la sesión actual (token excluido) y se cerraron las demás
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', token: { not: 'token-actual' } },
    });
  });

  it('sin sesión actual => cierra TODAS las sesiones', async () => {
    const bcrypt = await import('bcryptjs');
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      isActive: true,
      password: await bcrypt.hash(TEST_CURRENT_PASSWORD, 10),
    });

    await changePassword('u1', TEST_CURRENT_PASSWORD, TEST_NEW_PASSWORD, null);
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });
});

describe('Auth: restablecimiento por OTP (anti-enumeración)', () => {
  it('OTP inválido o expirado => error GENÉRICO y sin cambiar contraseña', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '573001234567',
      isActive: true,
    });

    await expect(
      resetPasswordWithOtp('3001234567', '9999', TEST_NEW_PASSWORD)
    ).rejects.toThrow(CustomerAuthError);

    expect(mockDb.user.update).not.toHaveBeenCalled();
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    // El OTP sí se verificó contra el teléfono CANÓNICO de la cuenta
    const { verifyPhoneOtp } = await import('@/lib/auth-dual');
    expect(verifyPhoneOtp).toHaveBeenCalledWith('573001234567', '9999');
  });

  it('cuenta inexistente => error genérico y NUNCA verifica el identificador contra proveedores', async () => {
    mockDb.user.findFirst.mockResolvedValue(null);

    await expect(
      resetPasswordWithOtp('nadie@test.com', '1234', TEST_NEW_PASSWORD)
    ).rejects.toThrow(CustomerAuthError);

    // El identificador crudo (email) NO llegó a ningún proveedor: hacerlo
    // produciría un error de formato que filtra la existencia de la cuenta.
    const { verifyPhoneOtp } = await import('@/lib/auth-dual');
    const { verifyEmailOtp } = await import('@/lib/email-otp');
    expect(verifyPhoneOtp).not.toHaveBeenCalled();
    expect(verifyEmailOtp).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it('fallo del proveedor (Twilio caído) => mismo error genérico, sin propagar el mensaje', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '573001234567',
      isActive: true,
    });
    const { verifyPhoneOtp } = await import('@/lib/auth-dual');
    (verifyPhoneOtp as any).mockRejectedValueOnce(
      new Error('Twilio: unable to create record (bobcat)')
    );

    await expect(
      resetPasswordWithOtp('3001234567', '1234', TEST_NEW_PASSWORD)
    ).rejects.toThrow(/No fue posible restablecer/);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it('OTP válido => cambia contraseña y cierra TODAS las sesiones', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '3001234567',
      isActive: true,
    });

    await resetPasswordWithOtp('3001234567', '1234', TEST_NEW_PASSWORD);

    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ passwordChangedAt: expect.any(Date) }),
      })
    );
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('no crea usuarios inexistentes (respuesta controlada, sin crear)', async () => {
    mockDb.user.findFirst.mockResolvedValue(null);

    await expect(
      resetPasswordWithOtp('nadie@test.com', '1234', TEST_NEW_PASSWORD)
    ).rejects.toThrow(CustomerAuthError);

    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it('solicitud de reset con OTP desconfigurado => informe sin filtrar existencia', async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '3001234567',
      isActive: true,
    });
    const { sendPhoneOtp } = await import('@/lib/auth-dual');
    (sendPhoneOtp as any).mockRejectedValueOnce(new Error('OTP no configurado'));

    const result = await requestPasswordReset('3001234567');
    expect(result.otpSent).toBe(false);
    expect(result.otpNotConfigured).toBe(true);
  });
});

describe('Auth: restablecimiento por EMAIL (canal preferido)', () => {
  it('solicitud con email => emite OTP de email (no SMS) para la cuenta que lo tenga', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@test.com',
      phone: '573001234567',
      emailVerifiedAt: null,
      isActive: true,
    });

    const result = await requestPasswordReset('a@test.com');
    expect(result.otpSent).toBe(true);
    const { issueEmailOtp } = await import('@/lib/email-otp');
    const { sendPhoneOtp } = await import('@/lib/auth-dual');
    expect(issueEmailOtp).toHaveBeenCalledWith('a@test.com', 'password_reset');
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });

  it('reset por email exitoso => cambia contraseña, VERIFICA el correo y cierra TODAS las sesiones', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@test.com',
      phone: '573001234567',
      emailVerifiedAt: null,
      isActive: true,
    });

    await resetPasswordWithOtp('a@test.com', '123456', TEST_NEW_PASSWORD);

    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          passwordChangedAt: expect.any(Date),
          emailVerifiedAt: expect.any(Date),
        }),
      })
    );
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('OTP de email incorrecto => error GENÉRICO sin cambiar nada', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@test.com',
      phone: null,
      emailVerifiedAt: new Date(),
      isActive: true,
    });

    await expect(
      resetPasswordWithOtp('a@test.com', '000000', TEST_NEW_PASSWORD)
    ).rejects.toThrow(/No fue posible restablecer/);

    expect(mockDb.user.update).not.toHaveBeenCalled();
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
  });

  it('cuenta sin email usable para el canal => genérico sin llamar al proveedor', async () => {
    // Identificador email que no existe => sin cuenta => genérico
    mockDb.user.findUnique.mockResolvedValue(null);
    await expect(
      resetPasswordWithOtp('fantasma@test.com', '123456', TEST_NEW_PASSWORD)
    ).rejects.toThrow(/No fue posible restablecer/);
    const { verifyEmailOtp } = await import('@/lib/email-otp');
    expect(verifyEmailOtp).not.toHaveBeenCalled();
  });

  it('usuarios de backoffice también pueden recuperar por email (maestro User)', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@compusum.co',
      phone: null,
      emailVerifiedAt: new Date('2026-01-01'),
      isActive: true,
    });

    await resetPasswordWithOtp('admin@compusum.co', '123456', TEST_NEW_PASSWORD);

    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'admin-1' } })
    );
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1' } });
  });
});
