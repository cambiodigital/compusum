import { isAdminRole, isBackofficeRole, ADMIN_ROLES, BACKOFFICE_ROLES } from '../src/lib/auth';

async function runRoleAccessTests() {
  console.log('=== PRUEBAS DE CONTROL DE ACCESO POR ROL (RBAC Fase 4A) ===\n');

  // 1. Verificar definición de roles
  console.log('1. Verificando constantes ADMIN_ROLES y BACKOFFICE_ROLES...');
  if (!ADMIN_ROLES.includes('admin') || !ADMIN_ROLES.includes('editor')) {
    throw new Error('Fallo: ADMIN_ROLES debe incluir admin y editor.');
  }
  if (ADMIN_ROLES.includes('AGENT' as (typeof ADMIN_ROLES)[number])) {
    throw new Error('Fallo: AGENT ya NO es rol de administración global.');
  }
  if (
    !BACKOFFICE_ROLES.includes('admin') ||
    !BACKOFFICE_ROLES.includes('editor') ||
    !BACKOFFICE_ROLES.includes('AGENT')
  ) {
    throw new Error('Fallo: BACKOFFICE_ROLES debe incluir admin, editor y AGENT.');
  }
  console.log('✓ ADMIN_ROLES = [admin, editor]; BACKOFFICE_ROLES = [admin, editor, AGENT].');

  // 2. Verificar predicados isAdminRole / isBackofficeRole por rol
  console.log('\n2. Evaluando isAdminRole e isBackofficeRole por tipo de rol...');

  const testCases: Array<{
    role: string | null | undefined;
    adminExpected: boolean;
    backofficeExpected: boolean;
    desc: string;
  }> = [
    { role: 'admin', adminExpected: true, backofficeExpected: true, desc: 'Rol "admin"' },
    { role: 'ADMIN', adminExpected: true, backofficeExpected: true, desc: 'Rol "ADMIN" (mayúsculas)' },
    { role: 'editor', adminExpected: true, backofficeExpected: true, desc: 'Rol "editor"' },
    { role: 'AGENT', adminExpected: false, backofficeExpected: true, desc: 'Rol "AGENT"' },
    { role: 'agent', adminExpected: false, backofficeExpected: true, desc: 'Rol "agent" (minúsculas)' },
    { role: 'CUSTOMER', adminExpected: false, backofficeExpected: false, desc: 'Rol "CUSTOMER"' },
    { role: 'customer', adminExpected: false, backofficeExpected: false, desc: 'Rol "customer"' },
    { role: 'guest', adminExpected: false, backofficeExpected: false, desc: 'Rol "guest"' },
    { role: null, adminExpected: false, backofficeExpected: false, desc: 'Rol nulo' },
    { role: undefined, adminExpected: false, backofficeExpected: false, desc: 'Rol indefinido' },
  ];

  for (const tc of testCases) {
    const adminResult = isAdminRole(tc.role);
    const backofficeResult = isBackofficeRole(tc.role);
    if (adminResult !== tc.adminExpected || backofficeResult !== tc.backofficeExpected) {
      throw new Error(
        `Fallo en prueba ${tc.desc}: se esperaba isAdminRole=${tc.adminExpected}, isBackofficeRole=${tc.backofficeExpected}, pero se obtuvo ${adminResult}/${backofficeResult}`
      );
    }
    console.log(
      `✓ ${tc.desc}: isAdminRole = ${adminResult}, isBackofficeRole = ${backofficeResult}`
    );
  }

  // 3. Simulación de respuestas HTTP de autorización por rol
  //    - Superficies globales (requireAdminApi): 403 para AGENT.
  //    - Superficies de backoffice (requireBackofficeApi): 200 para AGENT,
  //      con alcance por asesor aplicado aguas abajo.
  console.log('\n3. Simulando autorización de API por rol...');

  function simulateApiAuthCheck(
    user: { id: string; role: string } | null,
    checker: (role: string | null | undefined) => boolean
  ) {
    if (!user) {
      return { status: 401, error: 'No autorizado' };
    }
    if (!checker(user.role)) {
      return { status: 403, error: 'Acceso denegado: se requiere rol administrativo' };
    }
    return { status: 200, user } as const;
  }

  const unauthenticatedRes = simulateApiAuthCheck(null, isBackofficeRole);
  if (unauthenticatedRes.status !== 401) {
    throw new Error('Fallo: Solicitud sin autenticar debe retornar 401.');
  }
  console.log('✓ Usuario sin autenticar -> 401 Unauthorized');

  const customerGlobalRes = simulateApiAuthCheck({ id: 'user-cust-1', role: 'CUSTOMER' }, isBackofficeRole);
  if (customerGlobalRes.status !== 403) {
    throw new Error('Fallo: Usuario CUSTOMER debe ser rechazado con 403 Forbidden.');
  }
  console.log('✓ Usuario CUSTOMER -> 403 Forbidden (sin acceso al backoffice)');

  const agentGlobalRes = simulateApiAuthCheck({ id: 'user-agent-1', role: 'AGENT' }, isAdminRole);
  if (agentGlobalRes.status !== 403) {
    throw new Error('Fallo: Usuario AGENT debe ser rechazado con 403 en superficies globales.');
  }
  console.log('✓ Usuario AGENT -> 403 Forbidden en superficies globales (solo admin/editor)');

  const agentBackofficeRes = simulateApiAuthCheck({ id: 'user-agent-1', role: 'AGENT' }, isBackofficeRole);
  if (agentBackofficeRes.status !== 200) {
    throw new Error('Fallo: Usuario AGENT debe tener acceso 200 a superficies de backoffice propias.');
  }
  console.log('✓ Usuario AGENT -> 200 OK en backoffice (clientes/pedidos propios)');

  const adminRes = simulateApiAuthCheck({ id: 'user-admin-1', role: 'admin' }, isAdminRole);
  if (adminRes.status !== 200) {
    throw new Error('Fallo: Usuario admin debe tener acceso con 200 OK.');
  }
  console.log('✓ Usuario admin -> 200 OK (acceso global)');

  console.log('\n=============================================================');
  console.log('¡TODAS LAS PRUEBAS DE CONTROL DE ACCESO POR ROL PASARON!');
  console.log('=============================================================\n');
}

runRoleAccessTests().catch((err) => {
  console.error('Error durante las pruebas de rol:', err);
  process.exit(1);
});
