/**
 * CAPA DE PROVEEDOR DE CORREO TRANSACCIONAL.
 *
 * El dominio de autenticación NUNCA habla directo con Resend (ni con ningún
 * proveedor): consume `sendEmail()`. Cambiar Resend por Brevo/u otro proveedor
 * equivale a añadir una implementación aquí, sin tocar auth.
 *
 * Implementación actual: Resend vía HTTP API (sin SDK: una llamada fetch,
 * cero dependencias nuevas). Fail-closed: sin RESEND_API_KEY + EMAIL_FROM no
 * hay proveedor y `sendEmail()` lanza; las rutas de auth degradan con
 * respuesta genérica (jamás filtran el detalle del proveedor al cliente).
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}

interface ResendConfig {
  apiKey: string;
  from: string;
  replyTo: string | null;
  isConfigured: boolean;
}

function getResendConfig(): ResendConfig {
  const apiKey = process.env.RESEND_API_KEY?.trim() || '';
  const from = process.env.EMAIL_FROM?.trim() || '';
  const replyTo = process.env.EMAIL_REPLY_TO?.trim() || null;

  return {
    apiKey,
    from,
    replyTo,
    // EMAIL_FROM debe incluir dirección con dominio verificado en Resend:
    // p. ej. "Compusum <no-reply@mail.compusum.co>".
    isConfigured: Boolean(apiKey && from),
  };
}

/** true si hay proveedor de email disponible (Resend configurado). */
export function isEmailProviderConfigured(): boolean {
  return getResendConfig().isConfigured;
}

/**
 * Envía un correo con el proveedor configurado. Lanza si no está configurado
 * o si el proveedor rechaza el envío; el mensaje de error es técnico y solo
 * debe llegarse a logs server-side, nunca al cliente.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const config = getResendConfig();

  if (!config.isConfigured) {
    throw new Error(
      'Email no configurado. Define RESEND_API_KEY y EMAIL_FROM (p. ej. "Compusum <no-reply@mail.compusum.co>").'
    );
  }

  const payload: Record<string, unknown> = {
    from: config.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  const replyTo = input.replyTo ?? config.replyTo;
  if (replyTo) payload.reply_to = replyTo;

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch (error) {
    console.error(
      '[EMAIL_PROVIDER] Error de red contactando al proveedor de correo:',
      error instanceof Error ? error.message : error
    );
    throw new Error('No fue posible contactar al proveedor de correo.');
  }

  if (!response.ok) {
    // El detalle del proveedor SOLO va al log server-side.
    const detail = await response.text().catch(() => '');
    console.error(
      `[EMAIL_PROVIDER] Rechazo del proveedor (status ${response.status}): ${detail.slice(0, 500)}`
    );
    throw new Error(`El proveedor de correo rechazó el envío (status ${response.status}).`);
  }
}
