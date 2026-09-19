-- Autenticación unificada: OTP self-managed de email y verificación de correo.
-- Idempotente (regla del repositorio: ADD COLUMN/INDEX IF NOT EXISTS).

-- Verificación de posesión del correo (se marca al autenticar vía OTP de email
-- o al restablecer contraseña por email). Nullables: no afecta filas exists.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- Desafíos OTP self-managed (solo canal EMAIL; el SMS sigue en Twilio Verify).
-- El código nunca se persiste en texto plano: solo su HMAC-SHA256 con el
-- secreto server-side OTP_HMAC_SECRET.
CREATE TABLE IF NOT EXISTS "AuthChallenge" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "identityType" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- Un desafío ACTIVO por identidad y propósito; reemitir lo reemplaza.
CREATE UNIQUE INDEX IF NOT EXISTS "AuthChallenge_purpose_identityType_identity_key"
    ON "AuthChallenge"("purpose", "identityType", "identity");

-- Limpieza oportunista de desafíos expirados.
CREATE INDEX IF NOT EXISTS "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");
