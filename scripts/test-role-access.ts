import { isAdminRole, ADMIN_ROLES } from '../src/lib/auth';

async function runRoleAccessTests() {
  console.log('=== PRUEBAS DE CONTROL DE ACCESO POR ROL (ISSUE #36) ===\n');

  // 1. Verificar definición de roles administrativos
  console.log('1. Verificando constante ADMIN_ROLES...');
  if (!ADMIN_ROLES.includes('admin') || !ADMIN_ROLES.includes('editor') || !ADMIN_ROLES.includes('AGENT')) {
    throw new Error('Fallo: ADMIN_ROLES debe incluir admin, editor y AGENT.');
  }
  console.log('✓ ADMIN_ROLES contiene los roles esperados: admin, editor, AGENT.');

  // 2. Verificar función helper isAdminRole para admin, editor, AGENT, CUSTOMER y valores nulos
  console.log('\n2. Evaluando isAdminRole para cada tipo de rol...');

  const testCases = [
    { role: 'admin', expected: true, desc: 'Rol "admin"' },
    { role: 'ADMIN', expected: true, desc: 'Rol "ADMIN" (mayúsculas)' },
    { role: 'editor', expected: true, desc: 'Rol "editor"' },
    { role: 'AGENT', expected: true, desc: 'Rol "AGENT"' },
    { role: 'agent', expected: true, desc: 'Rol "agent" (minúsculas)' },
    { role: 'CUSTOMER', expected: false, desc: 'Rol "CUSTOMER"' },
    { role: 'customer', expected: false, desc: 'Rol "customer"' },
    { role: 'guest', expected: false, desc: 'Rol "guest"' },
    { role: null, expected: false, desc: 'Rol nulo' },
    { role: undefined, expected: false, desc: 'Rol indefinido' },
  ];

  for (const tc of testCases) {
    const result = isAdminRole(tc.role);
    if (result !== tc.expected) {
      throw new Error(`Fallo en prueba ${tc.desc}: se esperaba ${tc.expected}, pero se obtuvo ${result}`);
    }
    console.log(`✓ ${tc.desc}: isAdminRole = ${result} (Esperado: ${tc.expected})`);
  }

  // 3. Simulación de respuestas HTTP de autorización por rol
  console.log('\n3. Simulando autorización de API por rol (401 sin sesión, 403 CUSTOMER, 200 admin/AGENT)...');

  function simulateApiAuthCheck(user: { id: string; role: string } | null) {
    if (!user) {
      return { status: 401, error: 'No autorizado' };
    }
    if (!isAdminRole(user.role)) {
      return { status: 403, error: 'Acceso denegado: se requiere rol administrativo' };
    }
    return { status: 200, user };
  }

  const unauthenticatedRes = simulateApiAuthCheck(null);
  if (unauthenticatedRes.status !== 401) {
    throw new Error('Fallo: Solicitud sin autenticar debe retornar 401.');
  }
  console.log('✓ Usuario sin autenticar -> 401 Unauthorized');

  const customerRes = simulateApiAuthCheck({ id: 'user-cust-1', role: 'CUSTOMER' });
  if (customerRes.status !== 403) {
    throw new Error('Fallo: Usuario CUSTOMER debe ser rechazado con 403 Forbidden.');
  }
  console.log('✓ Usuario CUSTOMER -> 403 Forbidden (Acceso denegado a rutas administrativas)');

  const agentRes = simulateApiAuthCheck({ id: 'user-agent-1', role: 'AGENT' });
  if (agentRes.status !== 200) {
    throw new Error('Fallo: Usuario AGENT debe tener acceso con 200 OK.');
  }
  console.log('✓ Usuario AGENT -> 200 OK (Acceso permitido)');

  const adminRes = simulateApiAuthCheck({ id: 'user-admin-1', role: 'admin' });
  if (adminRes.status !== 200) {
    throw new Error('Fallo: Usuario admin debe tener acceso con 200 OK.');
  }
  console.log('✓ Usuario admin -> 200 OK (Acceso permitido)');

  console.log('\n=============================================================');
  console.log('¡TODAS LAS PRUEBAS DE CONTROL DE ACCESO POR ROL PASARON!');
  console.log('=============================================================\n');
}

runRoleAccessTests().catch((err) => {
  console.error('Error durante las pruebas de rol:', err);
  process.exit(1);
});
