import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { sendEmail } from './email-provider';

/**
 * OTP SELF-MANAGED POR EMAIL (6 dígitos).
 *
 * Propiedades de seguridad (contrato):
 *  - El código NUNCA se persiste en texto plano: se guarda HMAC-SHA256 con el
 *    secreto server-side `OTP_HMAC_SECRET`. Sin el secreto, un dump de la
 *    tabla no permite fuerza bruta offline sobre los 10^6 códigos posibles.
 *  - Expiración corta: 10 minutos.
 *  - Single-use: `consumedAt` al verificar con éxito; un código usado no se
 *    acepta de nuevo.
 *  - Límite de intentos: 5 verificaciones por desafío; al agotarse el desafío
 *    se destruye (hay que reemitir, respetando cooldown).
 *  - Cooldown de reenvío: 60 s por identidad+propósito.
 *  - Comparación en tiempo constante; el código jamás se registra en logs.
 *
 * Unicidad: un desafío ACTIVO por (purpose, identityType='email', identity).
 * Reemitir reemplaza el desafío previo (nuevo código, intentos en cero).
 */

export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutos
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
export const EMAIL_OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 segundos

export type EmailOtpPurpose = 'login' | 'password_reset';

export type EmailOtpErrorCode =
  | 'NOT_CONFIGURED'
  | 'COOLDOWN'
  | 'INVALID'
  | 'EXPIRED'
  | 'MAX_ATTEMPTS'
  | 'PROVIDER_ERROR';

/** Mensaje EXTERNO único para todo fallo de verificación (anti-enumeración). */
export const EMAIL_OTP_GENERIC_FAILURE = 'Código inválido o expirado';

export class EmailOtpError extends Error {
  code: EmailOtpErrorCode;
  retryAfterSeconds?: number;

  constructor(
    code: EmailOtpErrorCode,
    options: { message?: string; retryAfterSeconds?: number } = {}
  ) {
    super(options.message ?? EMAIL_OTP_GENERIC_FAILURE);
    this.name = 'EmailOtpError';
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Secreto server-side para HMAC. Sin él, el canal email queda deshabilitado. */
function getOtpHmacSecret(): string | null {
  const secret = process.env.OTP_HMAC_SECRET?.trim() || '';
  // Mínimo 16 caracteres: por debajo, la entropía no resiste un ataque offline
  // contra la tabla de hashes si el secreto fuese débil/adivinable.
  return secret.length >= 16 ? secret : null;
}

/** true si el canal de OTP por email está operativo. */
export function isEmailOtpConfigured(): boolean {
  return Boolean(getOtpHmacSecret()) && requireEmailProviderConfigured();
}

function requireEmailProviderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
}

/** Normalización única de identidad email (minúsculas, sin espacios). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashOtpCode(purpose: EmailOtpPurpose, identity: string, code: string): string {
  const secret = getOtpHmacSecret();
  if (!secret) throw new EmailOtpError('NOT_CONFIGURED');
  return createHmac('sha256', secret).update(`${purpose}|email|${identity}|${code}`).digest('hex');
}

/** Comparación en tiempo constante sobre hex de longitud fija (64 chars). */
function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(EMAIL_OTP_LENGTH, '0');
}

function buildOtpEmail(code: string, purpose: EmailOtpPurpose): { subject: string; html: string; text: string } {
  const intent =
    purpose === 'password_reset'
      ? 'restablecer tu contraseña'
      : 'iniciar sesión en Compusum';
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, '') || 'https://compusum.co';

  const text = [
    'Compusum',
    '',
    `Tu código para ${intent} es: ${code}`,
    '',
    `El código expira en 10 minutos y solo puede usarse una vez.`,
    'Si no solicitaste este código, ignora este mensaje; tu cuenta sigue protegida.',
    '',
    appUrl,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;">
          <tr><td style="text-align:center;padding-bottom:16px;">
            <span style="font-size:20px;font-weight:bold;color:#0f172a;">Compusum</span>
          </td></tr>
          <tr><td style="color:#334155;font-size:14px;line-height:20px;padding-bottom:16px;">
            Usa el siguiente código para ${intent}:
          </td></tr>
          <tr><td align="center" style="padding-bottom:16px;">
            <span style="display:inline-block;font-size:32px;letter-spacing:8px;font-weight:bold;color:#0f172a;">${code}</span>
          </td></tr>
          <tr><td style="color:#64748b;font-size:12px;line-height:18px;">
            El código expira en <strong>10 minutos</strong> y solo puede usarse una vez.
            Si no solicitaste este código, ignora este mensaje; tu cuenta sigue protegida.
          </td></tr>
        </table>
        <p style="color:#94a3b8;font-size:11px;margin-top:16px;">Compusum · Papelería mayorista</p>
      </td></tr>
    </table>
  </body>
</html>`;

  return {
    subject: `Tu código de acceso Compusum: ${code.slice(0, 2)}••••`,
    html,
    text,
  };
}

export interface IssueOtpResult {
  sent: boolean;
  /** Segundos que deben pasar antes del próximo reenvío (cooldown activo). */
  cooldownSeconds?: number;
  /** SOLO desarrollo (NODE_ENV !== 'production' + flag explícito). Jamás se
   *  rellena en producción ni se registra en logs. */
  debugCode?: string;
}

/**
 * Emite (o reemite) un OTP para `email` con el propósito dado. Lanza
 * `EmailOtpError('COOLDOWN')` si se reemite antes del cooldown.
 * El envío usa la capa de proveedor; un fallo del proveedor se propaga como
 * `EmailOtpError('PROVIDER_ERROR'|'NOT_CONFIGURED')` con detalle SOLO en log.
 */
export async function issueEmailOtp(
  email: string,
  purpose: EmailOtpPurpose,
  options: { debug?: boolean } = {}
): Promise<IssueOtpResult> {
  if (!isEmailOtpConfigured()) {
    throw new EmailOtpError('NOT_CONFIGURED');
  }

  const identity = normalizeEmail(email);
  if (!identity) throw new EmailOtpError('INVALID', { message: 'Correo inválido' });

  const now = new Date();

  // Cooldown de reenvío: se mide contra el desafío previo de la misma
  // identidad+propósito (el "createdAt" del último código emitido).
  const previous = await db.authChallenge
    .findUnique({
      where: {
        purpose_identityType_identity: {
          purpose,
          identityType: 'email',
          identity,
        },
      },
    })
    .catch(() => null);

  if (previous) {
    const elapsed = now.getTime() - previous.createdAt.getTime();
    if (elapsed < EMAIL_OTP_RESEND_COOLDOWN_MS) {
      const cooldownSeconds = Math.ceil((EMAIL_OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw new EmailOtpError('COOLDOWN', { retryAfterSeconds: cooldownSeconds });
    }
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(purpose, identity, code);
  const expiresAt = new Date(now.getTime() + EMAIL_OTP_TTL_MS);

  // Reemplaza el desafío activo (nuevo código, intentos en cero, nueva
  // expiración). La casa de limpieza de vencidos es oportunista y acotada.
  await db.authChallenge.upsert({
    where: {
      purpose_identityType_identity: { purpose, identityType: 'email', identity },
    },
    create: {
      purpose,
      identityType: 'email',
      identity,
      codeHash,
      expiresAt,
      // Explícitos (no dependemos de defaults del motor): el desafío nace con
      // intentos en cero y su límite, de modo que la verificación los respete
      // aunque el registro se haya creado fuera de Prisma o con defaults cambiados.
      attempts: 0,
      maxAttempts: EMAIL_OTP_MAX_ATTEMPTS,
    },
    update: { codeHash, expiresAt, attempts: 0, consumedAt: null, maxAttempts: EMAIL_OTP_MAX_ATTEMPTS },
  });

  // Housekeeping: desafíos expirados/consumidos con más de 1 hora (barato,
  // indexado por expiresAt; NO toca desafíos activos).
  const staleBefore = new Date(now.getTime() - EMAIL_OTP_TTL_MS);
  await db.authChallenge
    .deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: staleBefore } },
          { consumedAt: { not: null, lt: staleBefore } },
        ],
      },
    })
    .catch(() => null);

  const { subject, html, text } = buildOtpEmail(code, purpose);
  try {
    await sendEmail({ to: identity, subject, html, text });
  } catch (error) {
    // Detalle técnico solo en log; jamás se propaga el mensaje del proveedor.
    console.error(
      '[EMAIL_OTP] Envío fallido (se conserva el desafío; puede reintentarse tras cooldown):',
      error instanceof Error ? error.message : error
    );
    throw new EmailOtpError('PROVIDER_ERROR');
  }

  // El código SOLO se devuelve fuera de producción (doble guardia: flag del
  // llamador + NODE_ENV). Nunca en logs ni en respuestas de producción.
  const debugCode =
    options.debug && process.env.NODE_ENV !== 'production' ? code : undefined;
  return { sent: true, ...(debugCode ? { debugCode } : {}) };
}

/**
 * Verifica un OTP de email. Lanza `EmailOtpError` (códigos INVALID/EXPIRED/
 * MAX_ATTEMPTS) con el mensaje EXTERNO genérico en todos los fallos.
 * Al verificar con éxito marca `consumedAt` (single-use).
 */
export async function verifyEmailOtp(
  email: string,
  purpose: EmailOtpPurpose,
  code: string
): Promise<void> {
  const identity = normalizeEmail(email);

  const challenge = identity
    ? await db.authChallenge.findUnique({
        where: {
          purpose_identityType_identity: { purpose, identityType: 'email', identity },
        },
      })
    : null;

  const now = new Date();

  if (!challenge || challenge.consumedAt) {
    throw new EmailOtpError('INVALID');
  }

  if (challenge.expiresAt < now) {
    // Expirado: destruido inmediatamente (no reutilizable).
    await db.authChallenge.delete({ where: { id: challenge.id } }).catch(() => null);
    throw new EmailOtpError('EXPIRED');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await db.authChallenge.delete({ where: { id: challenge.id } }).catch(() => null);
    throw new EmailOtpError('MAX_ATTEMPTS');
  }

  const normalizedCode = String(code ?? '').replace(/\D/g, '');
  if (normalizedCode.length !== EMAIL_OTP_LENGTH) {
    throw new EmailOtpError('INVALID');
  }

  let expectedHash: string;
  try {
    expectedHash = hashOtpCode(purpose, identity, normalizedCode);
  } catch {
    // Secreto ausente => canal no operativo => no hay nada que verificar.
    throw new EmailOtpError('NOT_CONFIGURED');
  }

  if (!constantTimeHexEqual(expectedHash, challenge.codeHash)) {
    const attempts = challenge.attempts + 1;
    if (attempts >= challenge.maxAttempts) {
      // Agotado el límite: el desafío muere; hay que reemitir (con cooldown).
      await db.authChallenge.delete({ where: { id: challenge.id } }).catch(() => null);
    } else {
      await db.authChallenge
        .update({ where: { id: challenge.id }, data: { attempts } })
        .catch(() => null);
    }
    throw new EmailOtpError('INVALID');
  }

  await db.authChallenge
    .update({ where: { id: challenge.id }, data: { consumedAt: now } })
    .catch(() => null);
}
