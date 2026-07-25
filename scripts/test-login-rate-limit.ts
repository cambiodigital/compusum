import { checkRateLimit, recordFailedAttempt, resetRateLimit, ADMIN_LOGIN_MAX_ATTEMPTS } from '../src/lib/rate-limit';

// Mock DB objects if needed or direct verification
async function runTests() {
  console.log('=== PRUEBAS DE PROTECCIÓN DE FUERZA BRUTA / RATE LIMITING ===\n');

  const testKey = `test-login:ip:192.168.1.100`;

  // 1. Limpiar clave de prueba previa
  await resetRateLimit(testKey);
  console.log('✓ Clave de prueba reiniciada correctamente.');

  // 2. Verificar estado inicial (no bloqueado)
  const initialCheck = await checkRateLimit(testKey);
  if (initialCheck.isBlocked) {
    throw new Error('Fallo: El estado inicial debería no estar bloqueado.');
  }
  console.log(`✓ Estado inicial verificado: No bloqueado. Intentos restantes: ${initialCheck.remainingAttempts}`);

  // 3. Registrar intentos fallidos hasta el límite (5 intentos)
  for (let i = 1; i <= ADMIN_LOGIN_MAX_ATTEMPTS; i++) {
    const result = await recordFailedAttempt(testKey);
    console.log(`- Intento fallido #${i}: Bloqueado = ${result.isBlocked}, Restantes = ${result.remainingAttempts}`);
    
    if (i < ADMIN_LOGIN_MAX_ATTEMPTS && result.isBlocked) {
      throw new Error(`Fallo: Se bloqueó prematuramente en el intento #${i}`);
    }
    if (i === ADMIN_LOGIN_MAX_ATTEMPTS && !result.isBlocked) {
      throw new Error(`Fallo: Debería haberse bloqueado en el intento #${i}`);
    }
  }
  console.log('✓ Límite de 5 intentos fallidos alcanzado y bloqueo activado correctamente.');

  // 4. Verificar que checkRateLimit retorne bloqueado con HTTP 429 Retry-After
  const blockedCheck = await checkRateLimit(testKey);
  if (!blockedCheck.isBlocked) {
    throw new Error('Fallo: checkRateLimit debería retornar isBlocked = true.');
  }
  console.log(`✓ Estado de bloqueo confirmado. Retry-After: ${blockedCheck.retryAfterSeconds}s`);

  // 5. Resetear contador tras éxito de login simulado
  await resetRateLimit(testKey);
  const resetCheck = await checkRateLimit(testKey);
  if (resetCheck.isBlocked) {
    throw new Error('Fallo: El estado debería estar desbloqueado tras reset.');
  }
  console.log('✓ Reseteo tras autenticación exitosa confirmado.');

  console.log('\n=============================================================');
  console.log('¡TODAS LAS PRUEBAS DE PROTECCIÓN CONTRA FUERZA BRUTA PASARON!');
  console.log('=============================================================\n');
}

runTests().catch((err) => {
  console.error('Error durante las pruebas:', err);
  process.exit(1);
});
