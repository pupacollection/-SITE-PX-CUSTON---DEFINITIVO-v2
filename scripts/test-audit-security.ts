import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  evaluateUserRoleChangePolicy,
  getRoleManagementPermissions,
  mergeAuthUserMetadata,
} from '../src/lib/userRoleValidator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSecurityAuditTests() {
  console.log('🧪 Iniciando Bateria de Testes de Segurança e Integridade da Fase 2...\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✅ [PASS] ${testName}`);
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      if (detail) console.error(`     ↳ Detalhe: ${detail}`);
    }
  }

  // TESTE 1: Integridade Estrutural das Migrações e Ordem de Dependências
  console.log('1️⃣ Testando Integridade dos Arquivos SQL de Migração...');
  const combinedPath = path.resolve(__dirname, '../supabase/migrations/combined_migration.sql');
  const combinedSql = fs.readFileSync(combinedPath, 'utf8');

  assert(combinedSql.includes('BEGIN;') && combinedSql.includes('COMMIT;'), 'combined_migration.sql encapsulado em transação atômica BEGIN...COMMIT');
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.profiles') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.vehicles'), 'Tabela profiles criada antes de vehicles (dependência FK)');
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.events') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.ticket_batches'), 'Tabela events criada antes de ticket_batches (dependência FK)');
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.orders') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.order_items'), 'Tabela orders criada antes de order_items (dependência FK)');
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.ticket_batches') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.tickets'), 'Tabela ticket_batches criada antes de tickets (dependência FK)');
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.tickets') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.checkins'), 'Tabela tickets criada antes de checkins (dependência FK)');

  // TESTE 2: Habilitação de RLS em 100% das Tabelas
  console.log('\n2️⃣ Testando Cobertura de Row Level Security (RLS)...');
  const tables = [
    'profiles', 'vehicles', 'events', 'ticket_batches',
    'orders', 'order_items', 'payments', 'tickets',
    'checkins', 'checkin_devices', 'audit_logs'
  ];

  for (const t of tables) {
    const hasRLS = combinedSql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    assert(hasRLS, `RLS explicitamente habilitado em public.${t}`);
  }

  // TESTE 3: Política de checkin_devices presente
  assert(combinedSql.includes('checkin_devices_operator_all'), 'Política RLS para public.checkin_devices presente');

  // TESTE 4: Proteção de Auto-Elevação de Papel em INSERT e UPDATE
  console.log('\n3️⃣ Testando Proteção contra Elevação de Privilégios (Triggers)...');
  assert(
    combinedSql.includes('BEFORE INSERT OR UPDATE ON public.profiles'),
    'Trigger de proteção de papel vinculado a INSERT OR UPDATE em public.profiles'
  );
  assert(
    combinedSql.includes("TG_OP = 'INSERT'") && combinedSql.includes("NEW.role := 'USER'"),
    'Trigger força NEW.role := USER para inserções originadas por clientes normais'
  );

  // TESTE 5: Concorrência e Bloqueio Atômico de Check-in
  console.log('\n4️⃣ Testando Concorrência e Bloqueio Atômico de Check-in...');
  assert(
    combinedSql.includes('FOR UPDATE OF t;'),
    'Procedimento validate_and_checkin_ticket utiliza FOR UPDATE OF t (bloqueio exclusivo no ingresso, sem travar tabelas inteiras de eventos/lotes)'
  );

  // TESTE 6: Idempotência do Seed de Lotes
  console.log('\n5️⃣ Testando Idempotência do Seed...');
  assert(
    combinedSql.includes('CONSTRAINT uq_event_batch_name UNIQUE (event_id, name)'),
    'Restrição de unicidade (event_id, name) presente em ticket_batches para impedir lotes duplicados'
  );
  assert(
    combinedSql.includes('ON CONFLICT (event_id, name) DO NOTHING'),
    'Seed utiliza ON CONFLICT (event_id, name) DO NOTHING explícito'
  );

  // TESTE 7: Verificação de Segredos em Arquivos Versionados
  console.log('\n6️⃣ Testando Higiene de Segredos em Arquivos Públicos...');
  const envExamplePath = path.resolve(__dirname, '../.env.example');
  const envExample = fs.readFileSync(envExamplePath, 'utf8');
  assert(!envExample.includes('sb_secret_p2TgOU'), '.env.example não contém chaves secretas reais (sb_secret_...)');
  assert(envExample.includes('PX_SUPER_ADMIN_INIT_TOKEN'), '.env.example documenta a variável segura PX_SUPER_ADMIN_INIT_TOKEN');

  const serverPath = path.resolve(__dirname, '../server.ts');
  const serverCode = fs.readFileSync(serverPath, 'utf8');
  assert(!serverCode.includes('sb_secret_p2TgOU'), 'server.ts não contém fallback de chave secreta gravado em código');
  assert(serverCode.includes('req.userRole = profile?.role || \'USER\''), 'server.ts não aceita user_metadata do cliente como papel administrativo');
  assert(serverCode.includes('crypto.timingSafeEqual'), 'server.ts utiliza crypto.timingSafeEqual para comparação segura de tokens');

  // TESTE 8: Gestão de Usuários & Hierarquia RBAC (PX CONTROL)
  console.log('\n7️⃣ Testando Gestão de Usuários, Hierarquia RBAC e Preservação de Metadados...');
  const adminDashboardPath = path.resolve(__dirname, '../src/views/AdminDashboardView.tsx');
  const adminDashboardCode = fs.readFileSync(adminDashboardPath, 'utf8');
  assert(!adminDashboardCode.includes('Módulo em implementação'), 'AdminDashboardView.tsx não exibe mais placeholder "Módulo em implementação"');
  assert(!adminDashboardCode.includes('CHECKIN_OPERATOR, CLIENT'), 'AdminDashboardView.tsx não referencia o papel inexistente CLIENT');
  assert(adminDashboardCode.includes('AdminUsersManager'), 'AdminDashboardView.tsx renderiza o componente real AdminUsersManager');
  assert(serverCode.includes("'/api/admin/users'") && serverCode.includes("'/api/admin/users/:id/role'"), 'server.ts expõe rotas autenticadas /api/admin/users e /api/admin/users/:id/role');
  assert(serverCode.includes('mergeAuthUserMetadata'), 'server.ts preserva user_metadata existente ao sincronizar role no Supabase Auth');

  const actorSuperId = '11111111-1111-4111-8111-111111111111';
  const actorAdminId = '22222222-2222-4222-8222-222222222222';
  const targetUserId = '33333333-3333-4333-8333-333333333333';
  const targetAdminId = '44444444-4444-4444-8444-444444444444';

  // 8.1 Rejeição do papel inválido CLIENT (400)
  const resInvalidClientRole = evaluateUserRoleChangePolicy({
    actorUserId: actorSuperId,
    actorRole: 'SUPER_ADMIN',
    targetUserId,
    targetCurrentRole: 'USER',
    newRole: 'CLIENT',
  });
  assert(!resInvalidClientRole.allowed && resInvalidClientRole.statusCode === 400, 'Rejeita papel inexistente CLIENT com HTTP 400');

  // 8.2 Bloqueio de auto-alteração de papel (403)
  const resSelfChange = evaluateUserRoleChangePolicy({
    actorUserId: actorSuperId,
    actorRole: 'SUPER_ADMIN',
    targetUserId: actorSuperId,
    targetCurrentRole: 'SUPER_ADMIN',
    newRole: 'ADMIN',
    otherSuperAdminsCount: 2,
  });
  assert(!resSelfChange.allowed && resSelfChange.statusCode === 403, 'Bloqueia auto-alteração de papel pelo próprio administrador (HTTP 403)');

  // 8.3 ADMIN pode promover USER para CHECKIN_OPERATOR (200)
  const resAdminToOperator = evaluateUserRoleChangePolicy({
    actorUserId: actorAdminId,
    actorRole: 'ADMIN',
    targetUserId,
    targetCurrentRole: 'USER',
    newRole: 'CHECKIN_OPERATOR',
  });
  assert(resAdminToOperator.allowed && resAdminToOperator.statusCode === 200, 'ADMIN pode atribuir CHECKIN_OPERATOR a um USER (HTTP 200)');

  // 8.4 ADMIN NÃO pode promover ninguém para ADMIN ou SUPER_ADMIN (403)
  const resAdminPromoteAdmin = evaluateUserRoleChangePolicy({
    actorUserId: actorAdminId,
    actorRole: 'ADMIN',
    targetUserId,
    targetCurrentRole: 'USER',
    newRole: 'ADMIN',
  });
  const resAdminPromoteSuper = evaluateUserRoleChangePolicy({
    actorUserId: actorAdminId,
    actorRole: 'ADMIN',
    targetUserId,
    targetCurrentRole: 'USER',
    newRole: 'SUPER_ADMIN',
  });
  assert(
    !resAdminPromoteAdmin.allowed && resAdminPromoteAdmin.statusCode === 403 &&
    !resAdminPromoteSuper.allowed && resAdminPromoteSuper.statusCode === 403,
    'ADMIN é bloqueado ao tentar conceder ADMIN ou SUPER_ADMIN (HTTP 403)'
  );

  // 8.5 ADMIN NÃO pode modificar outro ADMIN ou SUPER_ADMIN (403)
  const resAdminModifyOtherAdmin = evaluateUserRoleChangePolicy({
    actorUserId: actorAdminId,
    actorRole: 'ADMIN',
    targetUserId: targetAdminId,
    targetCurrentRole: 'ADMIN',
    newRole: 'USER',
  });
  assert(!resAdminModifyOtherAdmin.allowed && resAdminModifyOtherAdmin.statusCode === 403, 'ADMIN é bloqueado ao tentar alterar outro ADMIN ou SUPER_ADMIN (HTTP 403)');

  // 8.6 Proteção do último SUPER_ADMIN ativo (403 quando otherSuperAdminsCount = 0; 200 quando >= 1)
  const resLastSuperDemote = evaluateUserRoleChangePolicy({
    actorUserId: actorSuperId,
    actorRole: 'SUPER_ADMIN',
    targetUserId: targetAdminId,
    targetCurrentRole: 'SUPER_ADMIN',
    newRole: 'ADMIN',
    otherSuperAdminsCount: 0,
  });
  const resMultipleSuperDemote = evaluateUserRoleChangePolicy({
    actorUserId: actorSuperId,
    actorRole: 'SUPER_ADMIN',
    targetUserId: targetAdminId,
    targetCurrentRole: 'SUPER_ADMIN',
    newRole: 'ADMIN',
    otherSuperAdminsCount: 1,
  });
  assert(
    !resLastSuperDemote.allowed && resLastSuperDemote.statusCode === 403 &&
    resMultipleSuperDemote.allowed && resMultipleSuperDemote.statusCode === 200,
    'Protege o último SUPER_ADMIN contra rebaixamento (HTTP 403) e permite quando há outro SUPER_ADMIN ativo (HTTP 200)'
  );

  // 8.7 Preservação de user_metadata existente
  const mergedMeta = mergeAuthUserMetadata(
    { full_name: 'Piloto PX', phone: '33999999999', cpf: '12345678901', role: 'USER' },
    'CHECKIN_OPERATOR'
  );
  assert(
    mergedMeta.full_name === 'Piloto PX' &&
    mergedMeta.phone === '33999999999' &&
    mergedMeta.cpf === '12345678901' &&
    mergedMeta.role === 'CHECKIN_OPERATOR',
    'mergeAuthUserMetadata preserva full_name, phone e cpf intactos ao atualizar role'
  );

  // 8.8 Permissões de UI consistentes com o backend
  const uiPermsAdminOnUser = getRoleManagementPermissions({
    callerId: actorAdminId,
    callerRole: 'ADMIN',
    targetId: targetUserId,
    targetRole: 'USER',
    superAdminCount: 1,
  });
  assert(
    uiPermsAdminOnUser.canEdit &&
    uiPermsAdminOnUser.allowedRoles.length === 2 &&
    uiPermsAdminOnUser.allowedRoles.includes('USER') &&
    uiPermsAdminOnUser.allowedRoles.includes('CHECKIN_OPERATOR'),
    'UI restringe seletor de ADMIN apenas a USER e CHECKIN_OPERATOR'
  );

  console.log(`\n========================================`);
  console.log(`📊 Resultado dos Testes: ${passedTests}/${totalTests} aprovados!`);
  console.log(`========================================\n`);

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runSecurityAuditTests().catch((err) => {
  console.error('Falha no executor de auditoria:', err);
  process.exit(1);
});
