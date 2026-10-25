import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  evaluateUserRoleChangePolicy,
  getRoleManagementPermissions,
  mergeAuthUserMetadata,
} from '../src/lib/userRoleValidator';
import {
  executeAuthenticatedTicketValidation,
  evaluateOrderCancellationOutcome,
  verifyOrderIdempotencyMatch,
} from '../src/lib/ticketValidator';
import {
  executeAuthenticatedPaymentSettingsUpdate,
  validatePaymentSettingsPayload,
  buildCanonicalPaymentConfigResponse,
  readPersistedPaymentSettings,
  inspectPersistedPaymentSettings,
  resolveAuthoritativePaymentSettings,
  evaluateCheckoutPaymentMethodGate,
  DEFAULT_PAYMENT_SETTINGS_PATH,
  PROJECT_ROOT_DIR,
  resolveProjectRootDir,
  resolveDefaultPaymentSettingsPath,
  resolveOperationalEnvironment,
} from '../src/lib/paymentSettingsValidator';
import crypto from 'crypto';
import {
  evaluateWebhookSecurityGate,
  isPaymentMethodImplemented,
  createOrRecoverMercadoPagoPixPayment,
  reconcileMercadoPagoPixPaymentByOrder,
  persistMercadoPagoPixChargeLink,
  isValidBrazilianCpf,
  generateDeterministicTestCpf,
} from '../src/lib/mercadoPagoGateway';

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
  assert(combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.orders') < combinedSql.indexOf('CREATE TABLE IF NOT EXISTS public.order_email_notifications'), 'Tabela orders criada antes de order_email_notifications (dependência FK)');

  // TESTE 2: Habilitação de RLS em 100% das Tabelas
  console.log('\n2️⃣ Testando Cobertura de Row Level Security (RLS)...');
  const tables = [
    'profiles', 'vehicles', 'events', 'ticket_batches',
    'orders', 'order_items', 'payments', 'tickets',
    'checkins', 'checkin_devices', 'audit_logs', 'order_email_notifications'
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

  // TESTE 9: Autorização das RPCs Transacionais (ETAPA 1)
  console.log('\n8️⃣ Testando Autorização das RPCs Transacionais (Migration 20261022000002)...');
  const rpcMigrationPath = path.resolve(
    __dirname,
    '../supabase/migrations/20261022000002_rpc_authorization_hardening.sql'
  );
  assert(fs.existsSync(rpcMigrationPath), 'Migration corretiva 20261022000002_rpc_authorization_hardening.sql existe');
  const rpcMigrationSql = fs.readFileSync(rpcMigrationPath, 'utf8');

  const protectedRpcs = [
    { name: 'process_order_checkout', sig: 'UUID, UUID, JSONB, payment_method, JSONB, UUID' },
    { name: 'cancel_order_and_release_stock', sig: 'UUID, TEXT' },
    { name: 'confirm_order_and_issue_tickets', sig: 'UUID, TEXT' },
    { name: 'expire_pending_orders', sig: 'INT' },
    { name: 'claim_order_confirmation_email', sig: 'UUID, TEXT, TEXT' },
  ];

  for (const fn of protectedRpcs) {
    const fullSig = `public.${fn.name}(${fn.sig})`;
    assert(
      rpcMigrationSql.includes(`REVOKE EXECUTE ON FUNCTION ${fullSig} FROM PUBLIC;`) &&
      rpcMigrationSql.includes(`REVOKE EXECUTE ON FUNCTION ${fullSig} FROM anon;`) &&
      rpcMigrationSql.includes(`REVOKE EXECUTE ON FUNCTION ${fullSig} FROM authenticated;`) &&
      rpcMigrationSql.includes(`GRANT EXECUTE ON FUNCTION ${fullSig} TO service_role;`),
      `Migration corretiva revoga PUBLIC, anon e authenticated e concede apenas service_role em ${fullSig}`
    );
    assert(
      combinedSql.includes(`REVOKE EXECUTE ON FUNCTION ${fullSig} FROM authenticated;`) &&
      combinedSql.includes(`GRANT EXECUTE ON FUNCTION ${fullSig} TO service_role;`) &&
      !combinedSql.includes(`GRANT EXECUTE ON FUNCTION public.${fn.name} TO authenticated`),
      `combined_migration.sql sincronizado sem permissão para authenticated em ${fn.name}`
    );
  }

  // Verificar que apenas process_order_checkout e cancel_order_and_release_stock são recriadas na migration corretiva
  assert(
    rpcMigrationSql.includes('CREATE OR REPLACE FUNCTION public.process_order_checkout') &&
    rpcMigrationSql.includes('CREATE OR REPLACE FUNCTION public.cancel_order_and_release_stock') &&
    !rpcMigrationSql.includes('CREATE OR REPLACE FUNCTION public.confirm_order_and_issue_tickets') &&
    !rpcMigrationSql.includes('CREATE OR REPLACE FUNCTION public.expire_pending_orders') &&
    !rpcMigrationSql.includes('CREATE OR REPLACE FUNCTION public.claim_order_confirmation_email'),
    'Migration corretiva recria apenas as 2 funções com ajustes funcionais e aplica apenas REVOKE/GRANT nas 3 funções sem mudança funcional'
  );

  // Verificar checagem explícita de pré-requisitos via to_regprocedure (sem ignorar silenciosamente funções ausentes)
  assert(
    rpcMigrationSql.includes("to_regprocedure('public.process_order_checkout(uuid,uuid,jsonb,payment_method,jsonb,uuid)') IS NULL") &&
    rpcMigrationSql.includes("to_regprocedure('public.cancel_order_and_release_stock(uuid,text)') IS NULL") &&
    rpcMigrationSql.includes("to_regprocedure('public.confirm_order_and_issue_tickets(uuid,text)') IS NULL") &&
    rpcMigrationSql.includes("to_regprocedure('public.expire_pending_orders(integer)') IS NULL") &&
    rpcMigrationSql.includes("to_regprocedure('public.claim_order_confirmation_email(uuid,text,text)') IS NULL"),
    'Migration corretiva valida explicitamente todas as 5 assinaturas via to_regprocedure antes de aplicar alterações'
  );

  // Verificar que process_order_checkout preserva p_buyer_info, normaliza CPF e valida compatibilidade de idempotência em ambos os arquivos
  assert(
    rpcMigrationSql.includes("p_buyer_info->>'name'") &&
    rpcMigrationSql.includes("p_buyer_info->>'cpf'") &&
    rpcMigrationSql.includes('length(v_buyer_cpf) IN (11, 14)') &&
    rpcMigrationSql.includes('Conflito de idempotência: O identificador de pedido (%) já está vinculado a outro comprador, evento, método de pagamento ou conjunto de itens.') &&
    combinedSql.includes('Conflito de idempotência: O identificador de pedido (%) já está vinculado a outro comprador, evento, método de pagamento ou conjunto de itens.'),
    'process_order_checkout alinhado entre 20261022000002 e combined_migration.sql (p_buyer_info, CPF 11/14 dígitos, FOR UPDATE e mensagem de conflito)'
  );

  // Testar verifyOrderIdempotencyMatch (retries legítimos vs conflitos de idempotência)
  const baseExistingOrder = {
    id: 'ord-idem-100',
    user_id: 'usr-100',
    event_id: 'evt-100',
    payment_method: 'pix',
    items: [
      { batch_id: 'batch-b', quantity: 2 },
      { batch_id: 'batch-a', quantity: 1 },
    ],
  };

  const retryLegit = verifyOrderIdempotencyMatch({
    existingOrder: baseExistingOrder,
    requestedUserId: 'usr-100',
    requestedEventId: 'evt-100',
    requestedPaymentMethod: 'pix',
    // Mesmos itens em ordem diferente / fragmentados (1 + 1 = 2)
    requestedItems: [
      { batch_id: 'batch-a', quantity: 1 },
      { batch_id: 'batch-b', quantity: 1 },
      { batch_id: 'batch-b', quantity: 1 },
    ],
  });
  const conflictItems = verifyOrderIdempotencyMatch({
    existingOrder: baseExistingOrder,
    requestedUserId: 'usr-100',
    requestedEventId: 'evt-100',
    requestedPaymentMethod: 'pix',
    requestedItems: [{ batch_id: 'batch-a', quantity: 3 }],
  });
  const conflictUser = verifyOrderIdempotencyMatch({
    existingOrder: baseExistingOrder,
    requestedUserId: 'usr-outro-999',
    requestedEventId: 'evt-100',
    requestedPaymentMethod: 'pix',
    requestedItems: [
      { batch_id: 'batch-a', quantity: 1 },
      { batch_id: 'batch-b', quantity: 2 },
    ],
  });
  assert(
    retryLegit.compatible === true &&
    conflictItems.compatible === false &&
    conflictItems.conflictReason === 'items_mismatch' &&
    conflictUser.compatible === false &&
    conflictUser.conflictReason === 'user_mismatch',
    'verifyOrderIdempotencyMatch aprova retry legítimo consolidado e rejeita reutilização de order_id com itens ou comprador divergentes'
  );

  // TESTE 10: Endpoint de Check-in Autenticado e Autorizado (ETAPA 2)
  console.log('\n9️⃣ Testando Autenticação e Autorização do Endpoint de Check-in (POST /api/tickets/validate)...');
  const demoMap = new Map<string, any>();
  let capturedOperatorId: string | null = null;
  let rpcCalledCount = 0;

  const createMockCheckinSupabase = (options: {
    authValid: boolean;
    userId?: string;
    profileRole?: string | null;
    rpcResult?: any;
  }) => ({
    auth: {
      getUser: async (_token: string) => {
        if (!options.authValid) {
          return { data: { user: null }, error: { message: 'Invalid token' } };
        }
        return { data: { user: { id: options.userId || 'op-real-uuid-999' } }, error: null };
      },
    },
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: options.profileRole ? { id: options.userId || 'op-real-uuid-999', role: options.profileRole } : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (_fn: string, params: any) => {
      rpcCalledCount++;
      capturedOperatorId = params.p_operator_id;
      return {
        data: options.rpcResult || {
          success: true,
          status: 'success',
          code: params.p_code,
          event: 'MEGA ENCONTRO PX CUSTON',
          holder: 'João Piloto',
          batch: 'Pista',
          timestamp: '2026-10-22T20:00:00Z',
        },
        error: null,
      };
    },
  });

  // 10.1 Visitante sem token -> 401 e NÃO chama a RPC
  const unauthRes = await executeAuthenticatedTicketValidation({
    authHeader: undefined,
    code: 'PX-12345678',
    clientOperatorId: 'spoofed-id',
    supabaseClient: createMockCheckinSupabase({ authValid: false }),
    isProduction: true,
    demoUsedMap: demoMap,
  });
  assert(
    unauthRes.statusCode === 401 && unauthRes.payload.valid === false && rpcCalledCount === 0,
    'Visitante não autenticado recebe HTTP 401 e não consome ingresso'
  );

  // 10.2 Usuário comum autenticado (USER) -> 403 e NÃO chama a RPC
  const regularUserRes = await executeAuthenticatedTicketValidation({
    authHeader: 'Bearer valid_user_jwt',
    code: 'PX-12345678',
    clientOperatorId: 'spoofed-id',
    supabaseClient: createMockCheckinSupabase({ authValid: true, userId: 'usr-comum-1', profileRole: 'USER' }),
    isProduction: true,
    demoUsedMap: demoMap,
  });
  assert(
    regularUserRes.statusCode === 403 && regularUserRes.payload.valid === false && rpcCalledCount === 0,
    'Usuário comum autenticado (USER) recebe HTTP 403 e não consome ingresso'
  );

  // 10.3 Operador autorizado (CHECKIN_OPERATOR) -> 200 e ignora operator_id enviado pelo cliente
  const operatorRes = await executeAuthenticatedTicketValidation({
    authHeader: 'Bearer valid_operator_jwt',
    code: 'PX:PX-12345678:evt-1',
    clientOperatorId: 'hacker-spoofed-operator-id',
    deviceId: 'scanner-portaria-1',
    supabaseClient: createMockCheckinSupabase({
      authValid: true,
      userId: 'verified-operator-uuid-777',
      profileRole: 'CHECKIN_OPERATOR',
    }),
    isProduction: true,
    demoUsedMap: demoMap,
  });
  assert(
    operatorRes.statusCode === 200 &&
    operatorRes.payload.valid === true &&
    rpcCalledCount === 1 &&
    capturedOperatorId === 'verified-operator-uuid-777',
    'Operador autorizado (CHECKIN_OPERATOR) valida ingresso com HTTP 200 e servidor ignora operator_id do cliente'
  );

  // TESTE 11: Cancelamento de Pedido e Proteção de Estoque (ETAPA 3)
  console.log('\n🔟 Testando Cancelamento Transacional e Proteção contra Liberação Falsa de Estoque...');
  assert(
    !serverCode.includes(".update({ payment_status: 'cancelled'"),
    'server.ts não possui mais fallback direto que marca orders.payment_status = cancelled quando a RPC falha'
  );

  // 11.1 Falha na RPC de cancelamento -> 503, status permanece pending, stock_released = false
  const cancelRpcFail = evaluateOrderCancellationOutcome({
    rpcResult: null,
    rpcError: { message: 'Database connection timeout' },
    orderId: 'ord-pending-1',
    currentStatus: 'pending',
    total: 99.0,
  });
  assert(
    cancelRpcFail.statusCode === 503 &&
    cancelRpcFail.cancelled === false &&
    cancelRpcFail.stockReleased === false &&
    cancelRpcFail.payload.status === 'pending' &&
    cancelRpcFail.payload.expired === false,
    'Falha na RPC de cancelamento não altera pedido para cancelled nem informa liberação de estoque (HTTP 503)'
  );

  // 11.2 Pedido já aprovado concorrentemente -> 200, status = approved, cancelled = false, stock_released = false
  const cancelAlreadyApproved = evaluateOrderCancellationOutcome({
    rpcResult: {
      success: false,
      status: 'approved',
      error: 'Operação bloqueada: Pedidos com pagamento aprovado não podem ter o estoque liberado.',
    },
    rpcError: null,
    orderId: 'ord-approved-1',
    currentStatus: 'pending',
    total: 99.0,
  });
  assert(
    cancelAlreadyApproved.statusCode === 200 &&
    cancelAlreadyApproved.outcome === 'already_approved' &&
    cancelAlreadyApproved.cancelled === false &&
    cancelAlreadyApproved.stockReleased === false &&
    cancelAlreadyApproved.payload.status === 'approved' &&
    cancelAlreadyApproved.payload.expired === false,
    'Pedido aprovado concorrentemente é protegido e jamais cancelado (status=approved, stock_released=false)'
  );

  // 11.3 Recusa da operação pela RPC -> 409, cancelled = false, stock_released = false
  const cancelRefused = evaluateOrderCancellationOutcome({
    rpcResult: {
      success: false,
      status: 'in_process',
      error: 'Operação bloqueada: Pedido em análise antifraude.',
    },
    rpcError: null,
    orderId: 'ord-inprocess-1',
    currentStatus: 'in_process',
    total: 99.0,
  });
  assert(
    cancelRefused.statusCode === 409 &&
    cancelRefused.outcome === 'operation_refused' &&
    cancelRefused.cancelled === false &&
    cancelRefused.stockReleased === false,
    'Recusa da operação pela RPC retorna HTTP 409 sem cancelar pedido e sem declarar liberação de estoque'
  );

  // 11.4 Sucesso confirmado pela RPC -> 200, status = cancelled, stock_released = true
  const cancelConfirmed = evaluateOrderCancellationOutcome({
    rpcResult: {
      success: true,
      order_id: 'ord-expired-1',
      status: 'cancelled',
      released_items_count: 2,
      reason: 'expired_timeout',
    },
    rpcError: null,
    orderId: 'ord-expired-1',
    currentStatus: 'pending',
    total: 99.0,
  });
  assert(
    cancelConfirmed.statusCode === 200 &&
    cancelConfirmed.outcome === 'cancelled' &&
    cancelConfirmed.cancelled === true &&
    cancelConfirmed.stockReleased === true &&
    cancelConfirmed.payload.status === 'cancelled' &&
    cancelConfirmed.payload.stock_released === true,
    'Cancelamento confirmado pela RPC informa status=cancelled e stock_released=true apenas com comprovação da RPC'
  );

  // TESTE 12: Persistência Real e Segurança das Configurações Administrativas do Mercado Pago
  console.log('\n1️⃣1️⃣ Testando Persistência Real e Segurança das Configurações do Mercado Pago...');
  const paymentSettingsViewPath = path.resolve(__dirname, '../src/views/PaymentSettingsView.tsx');
  const paymentSettingsViewCode = fs.readFileSync(paymentSettingsViewPath, 'utf8');

  assert(
    paymentSettingsViewCode.includes('await savePaymentSettings(') &&
      paymentSettingsViewCode.includes('setSavingNotice(true)'),
    'PaymentSettingsView.tsx aguarda confirmação real de savePaymentSettings no backend antes de ativar savingNotice'
  );
  assert(
    serverCode.includes("'/api/admin/payments/config'") &&
      serverCode.includes("requireRole(['ADMIN', 'SUPER_ADMIN'])"),
    'server.ts protege /api/admin/payments/config com requireAuth e requireRole([ADMIN, SUPER_ADMIN])'
  );

  const tempAuditPayFile = path.resolve(__dirname, `../data/payment-settings.audit-test.${process.pid}.json`);
  try {
    const unauthPay = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: undefined,
      payload: {
        environment: 'sandbox',
        public_key: 'TEST-12345678-abcd',
        pix_enabled: true,
        credit_card_enabled: true,
        boleto_enabled: false,
      },
      supabaseClient: {},
      filePath: tempAuditPayFile,
    });
    assert(unauthPay.statusCode === 401, 'Rejeita gravação de configurações de pagamento sem autenticação (HTTP 401)');

    const secretPay = validatePaymentSettingsPayload({
      environment: 'production',
      public_key: 'APP_USR-12345678-abcd',
      access_token: 'APP_USR-SECRET-TOKEN',
      pix_enabled: true,
      credit_card_enabled: true,
      boleto_enabled: false,
    });
    assert(
      !secretPay.valid && secretPay.statusCode === 400 && secretPay.code === 'SECRET_IN_PAYLOAD_FORBIDDEN',
      'Rejeita tentativa de enviar access_token ou webhook_secret no payload de configurações (HTTP 400)'
    );

    const mockSuperAdminClient = {
      auth: {
        getUser: async () => ({ data: { user: { id: actorSuperId } }, error: null }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: actorSuperId, role: 'SUPER_ADMIN' }, error: null }),
          }),
        }),
        insert: async () => ({ error: null }),
      }),
    };

    const rejectCardEnableAttempt = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'production',
        public_key: 'APP_USR-87654321-abcd-9999',
        pix_enabled: true,
        credit_card_enabled: true,
        boleto_enabled: false,
      },
      supabaseClient: mockSuperAdminClient,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
    });

    const rejectBoletoEnableAttempt = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'production',
        public_key: 'APP_USR-87654321-abcd-9999',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: true,
      },
      supabaseClient: mockSuperAdminClient,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
    });

    assert(
      rejectCardEnableAttempt.statusCode === 400 &&
        rejectCardEnableAttempt.payload.code === 'PAYMENT_METHOD_NOT_IMPLEMENTED' &&
        rejectBoletoEnableAttempt.statusCode === 400 &&
        rejectBoletoEnableAttempt.payload.code === 'PAYMENT_METHOD_NOT_IMPLEMENTED',
      'Bloqueia tentativa de ativar credit_card_enabled ou boleto_enabled via /api/admin/payments/config com HTTP 400 (PAYMENT_METHOD_NOT_IMPLEMENTED)'
    );

    const superSave = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'production',
        public_key: 'APP_USR-87654321-abcd-9999',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: false,
      },
      supabaseClient: mockSuperAdminClient,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
    });

    const persistedOnDisk = readPersistedPaymentSettings(tempAuditPayFile, { NODE_ENV: 'development' } as any);
    const canonicalResp = buildCanonicalPaymentConfigResponse(persistedOnDisk, {
      NODE_ENV: 'development',
      MP_ACCESS_TOKEN: '',
    } as any);

    assert(
      superSave.statusCode === 200 &&
        persistedOnDisk.public_key === 'APP_USR-87654321-abcd-9999' &&
        persistedOnDisk.credit_card_enabled === false &&
        persistedOnDisk.boleto_enabled === false &&
        canonicalResp.environment === 'production' &&
        canonicalResp.effective_environment === 'sandbox' &&
        Boolean(canonicalResp.environment_warning) &&
        (canonicalResp as any).access_token === undefined &&
        (canonicalResp as any).webhook_secret === undefined,
      'Persiste configurações não sensíveis em disco (com cartão e boleto bloqueados), preserva segredos fora da resposta e sinaliza divergência de ambiente quando MP_ACCESS_TOKEN está ausente'
    );

    // 13.7 Token Bearer vazio deve retornar HTTP 401 (e nunca 411)
    const emptyTokenRes = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer    ',
      payload: {
        environment: 'sandbox',
        public_key: 'TEST-12345678-abcd',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: false,
      },
      supabaseClient: mockSuperAdminClient,
      filePath: tempAuditPayFile,
    });
    assert(
      emptyTokenRes.statusCode === 401 && emptyTokenRes.payload.code === 'UNAUTHORIZED',
      'Token Bearer vazio retorna estritamente HTTP 401 UNAUTHORIZED'
    );

    // 13.8 Falha em audit_logs com rollback bem-sucedido reverte o arquivo para o estado anterior e retorna HTTP 503 (AUDIT_LOG_FAILED)
    const mockFailingAuditSupabase = {
      auth: {
        getUser: async () => ({ data: { user: { id: actorSuperId } }, error: null }),
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: actorSuperId, role: 'SUPER_ADMIN' }, error: null }),
          }),
        }),
        insert: async () => {
          if (table === 'audit_logs') {
            return { error: { message: 'Simulated database error on audit_logs insert' } };
          }
          return { error: null };
        },
      }),
    };

    const failedAuditSave = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'sandbox',
        public_key: 'TEST-11112222-3333-4444',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: false,
      },
      supabaseClient: mockFailingAuditSupabase,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
    });

    const afterFailedAuditOnDisk = readPersistedPaymentSettings(tempAuditPayFile, {
      NODE_ENV: 'development',
    } as any);

    assert(
      failedAuditSave.statusCode === 503 &&
        failedAuditSave.payload.success === false &&
        failedAuditSave.payload.rolledBack === true &&
        failedAuditSave.payload.code === 'AUDIT_LOG_FAILED' &&
        afterFailedAuditOnDisk.environment === 'production' &&
        afterFailedAuditOnDisk.public_key === 'APP_USR-87654321-abcd-9999' &&
        afterFailedAuditOnDisk.pix_enabled === true &&
        afterFailedAuditOnDisk.credit_card_enabled === false &&
        afterFailedAuditOnDisk.boleto_enabled === false,
      'Falha ao gravar em audit_logs não reporta sucesso (HTTP 503 AUDIT_LOG_FAILED, rolledBack=true) e reverte o arquivo para o estado anterior íntegro'
    );

    // 13.8b Falha simultânea em audit_logs E no rollback retorna HTTP 500 (AUDIT_LOG_AND_ROLLBACK_FAILED, rolledBack: false) sem afirmar que foi revertido
    const failedAuditAndRollbackSave = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'sandbox',
        public_key: 'TEST-55556666-7777-8888',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: false,
      },
      supabaseClient: mockFailingAuditSupabase,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
      rollbackOverride: () => {
        throw new Error('Simulated filesystem failure during rollback');
      },
    });

    assert(
      failedAuditAndRollbackSave.statusCode === 500 &&
        failedAuditAndRollbackSave.payload.success === false &&
        failedAuditAndRollbackSave.payload.rolledBack === false &&
        failedAuditAndRollbackSave.payload.code === 'AUDIT_LOG_AND_ROLLBACK_FAILED' &&
        typeof failedAuditAndRollbackSave.payload.error === 'string' &&
        failedAuditAndRollbackSave.payload.error.includes('reversão automática do arquivo de configuração também falhou') &&
        !failedAuditAndRollbackSave.payload.error.includes('foi revertida'),
      'Falha simultânea de audit_logs e rollback retorna HTTP 500 (AUDIT_LOG_AND_ROLLBACK_FAILED, rolledBack=false) e nunca afirma reversão concluída'
    );

    // 13.9 Arquivo corrompido ou inválido em disco ativa fail-closed (HTTP 503) em vez de retornar defaults
    fs.writeFileSync(tempAuditPayFile, '{ "environment": "production", CORRUPTED_JSON ', 'utf-8');
    const corruptedInspection = inspectPersistedPaymentSettings(tempAuditPayFile, {
      NODE_ENV: 'development',
    } as any);
    let readThrewOnCorrupted = false;
    try {
      readPersistedPaymentSettings(tempAuditPayFile, { NODE_ENV: 'development' } as any);
    } catch (readErr: any) {
      readThrewOnCorrupted = readErr?.statusCode === 503 && readErr?.code === 'PAYMENT_SETTINGS_CORRUPTED';
    }

    const checkoutBlockedOnCorrupted = await evaluateCheckoutPaymentMethodGate({
      paymentMethod: 'pix',
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development' } as any,
    });

    assert(
      corruptedInspection.ok === false &&
        corruptedInspection.statusCode === 503 &&
        corruptedInspection.settings === null &&
        corruptedInspection.code === 'PAYMENT_SETTINGS_CORRUPTED' &&
        readThrewOnCorrupted === true &&
        checkoutBlockedOnCorrupted.allowed === false &&
        checkoutBlockedOnCorrupted.statusCode === 503 &&
        checkoutBlockedOnCorrupted.code === 'PAYMENT_SETTINGS_CORRUPTED',
      'Arquivo existente corrompido/inválido aciona bloqueio fail-closed (HTTP 503) na leitura e no checkout sem reativar métodos padrão'
    );

    // 13.9b Administrador consegue corrigir arquivo corrompido via PUT/POST /api/admin/payments/config (HTTP 200) e restaurar leitura válida
    const durableAuditStore: any[] = [];
    const mockDurableAdminClient = {
      auth: {
        getUser: async () => ({ data: { user: { id: actorSuperId } }, error: null }),
      },
      from: (table: string) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: actorSuperId, role: 'SUPER_ADMIN' }, error: null }),
              }),
            }),
          };
        }
        return {
          insert: async (row: any) => {
            durableAuditStore.unshift({
              id: `audit-${durableAuditStore.length + 1}`,
              ...row,
              created_at: new Date().toISOString(),
            });
            return { error: null };
          },
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: async (n: number) => ({
                      data: durableAuditStore.slice(0, n),
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      },
    };

    const repairCorruptedSave = await executeAuthenticatedPaymentSettingsUpdate({
      authHeader: 'Bearer valid_super_admin_jwt',
      payload: {
        environment: 'production',
        public_key: 'APP_USR-44445555-6666-7777',
        pix_enabled: true,
        credit_card_enabled: false,
        boleto_enabled: false,
      },
      supabaseClient: mockDurableAdminClient,
      filePath: tempAuditPayFile,
      env: { NODE_ENV: 'development', MP_ACCESS_TOKEN: '' } as any,
    });

    const inspectionAfterRepair = inspectPersistedPaymentSettings(tempAuditPayFile, {
      NODE_ENV: 'development',
    } as any);

    assert(
      repairCorruptedSave.statusCode === 200 &&
        repairCorruptedSave.payload.success === true &&
        inspectionAfterRepair.ok === true &&
        inspectionAfterRepair.statusCode === 200 &&
        inspectionAfterRepair.settings?.public_key === 'APP_USR-44445555-6666-7777' &&
        inspectionAfterRepair.settings?.pix_enabled === true &&
        inspectionAfterRepair.settings?.credit_card_enabled === false &&
        durableAuditStore.length === 1 &&
        durableAuditStore[0].details?.previous_state_source === 'corrupted_or_unreadable',
      'Rota administrativa PUT/POST corrige arquivo corrompido sem depender de leitura válida anterior (HTTP 200) e restaura operação normal'
    );

    // 13.9c Persistência durável após novo deploy na Hostinger (arquivo local removido é re-hidratado a partir de public.audit_logs e mantém métodos desativados bloqueados)
    fs.unlinkSync(tempAuditPayFile);
    const rehydratedAfterDeploy = await resolveAuthoritativePaymentSettings({
      filePath: tempAuditPayFile,
      supabaseClient: mockDurableAdminClient,
      env: { NODE_ENV: 'production', MP_ACCESS_TOKEN: 'APP_USR-PROD-TOKEN-123' } as any,
      requireDurableSync: true,
    });

    const cardBlockedAfterDeploy = await evaluateCheckoutPaymentMethodGate({
      paymentMethod: 'credit_card',
      filePath: tempAuditPayFile,
      supabaseClient: mockDurableAdminClient,
      env: { NODE_ENV: 'production', MP_ACCESS_TOKEN: 'APP_USR-PROD-TOKEN-123' } as any,
      requireDurableSync: true,
    });

    const pixAllowedAfterDeploy = await evaluateCheckoutPaymentMethodGate({
      paymentMethod: 'pix',
      filePath: tempAuditPayFile,
      supabaseClient: mockDurableAdminClient,
      env: { NODE_ENV: 'production', MP_ACCESS_TOKEN: 'APP_USR-PROD-TOKEN-123' } as any,
      requireDurableSync: true,
    });

    assert(
      rehydratedAfterDeploy.ok === true &&
        rehydratedAfterDeploy.source === 'supabase_audit_rehydrated' &&
        rehydratedAfterDeploy.settings?.credit_card_enabled === false &&
        rehydratedAfterDeploy.settings?.pix_enabled === true &&
        fs.existsSync(tempAuditPayFile) &&
        cardBlockedAfterDeploy.allowed === false &&
        cardBlockedAfterDeploy.statusCode === 400 &&
        cardBlockedAfterDeploy.code === 'PAYMENT_METHOD_DISABLED' &&
        pixAllowedAfterDeploy.allowed === true &&
        pixAllowedAfterDeploy.statusCode === 200,
      'Persistência durável via public.audit_logs recupera configurações após limpeza de pasta em deploy na Hostinger, re-hidrata cache local e bloqueia método desativado em /api/orders/create (HTTP 400)'
    );

    // 13.9d Indisponibilidade do Supabase na leitura autoritativa bloqueia pedidos com HTTP 503 fail-closed
    const mockUnreachableSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: null,
                    error: { message: 'Supabase connection timeout' },
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const failClosedOnDbOutage = await evaluateCheckoutPaymentMethodGate({
      paymentMethod: 'pix',
      filePath: tempAuditPayFile,
      supabaseClient: mockUnreachableSupabase,
      env: { NODE_ENV: 'production' } as any,
      requireDurableSync: true,
    });

    assert(
      failClosedOnDbOutage.allowed === false &&
        failClosedOnDbOutage.statusCode === 503 &&
        failClosedOnDbOutage.code === 'PAYMENT_SETTINGS_UNAVAILABLE',
      'Indisponibilidade do Supabase ao validar configurações duráveis bloqueia pedidos com HTTP 503 (fail-closed)'
    );

    // 13.10 Quando o arquivo ainda não existe (ENOENT) e não há registro prévio em audit_logs, retorna padrões iniciais normalmente (HTTP 200)
    if (fs.existsSync(tempAuditPayFile)) fs.unlinkSync(tempAuditPayFile);
    durableAuditStore.length = 0;
    const missingInspection = await resolveAuthoritativePaymentSettings({
      filePath: tempAuditPayFile,
      supabaseClient: mockDurableAdminClient,
      env: { NODE_ENV: 'development' } as any,
      requireDurableSync: true,
    });
    assert(
      missingInspection.ok === true &&
        missingInspection.source === 'default_initial_state' &&
        missingInspection.statusCode === 200 &&
        missingInspection.settings !== null &&
        missingInspection.settings.pix_enabled === true,
      'Ausência inicial de configuração (sem registro em audit_logs e sem arquivo em disco) utiliza configuração inicial padrão com segurança (HTTP 200)'
    );

    // 13.11 CheckoutView aplica fail-closed quando não consegue carregar configurações do servidor
    const checkoutViewPath = path.resolve(__dirname, '../src/views/CheckoutView.tsx');
    const checkoutViewCode = fs.readFileSync(checkoutViewPath, 'utf8');
    assert(
      checkoutViewCode.includes('isPaymentConfigVerified') &&
        checkoutViewCode.includes('const pixEnabled = isPaymentConfigVerified ? Boolean(verifiedPaymentConfig.pix_enabled) : false;') &&
        checkoutViewCode.includes('disabled={processing || subtotal === 0 || event.is_demo || !isPaymentConfigVerified}'),
      'CheckoutView.tsx oculta métodos de pagamento e bloqueia finalização quando a configuração do servidor não pôde ser verificada'
    );

    // 13.12 PaymentSettingsView.tsx limpa loadError após salvamento administrativo bem-sucedido e DEFAULT_PAYMENT_SETTINGS_PATH independe de process.cwd() (tanto em tsx quanto empacotado em server.js)
    const gitignorePath = path.resolve(__dirname, '../.gitignore');
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    const simulatedRoot = path.resolve(__dirname, '..');
    const simulatedUnbundledDir = path.join(simulatedRoot, 'src', 'lib');
    assert(
      paymentSettingsViewCode.includes('setLoadError(null);') &&
        paymentSettingsViewCode.indexOf('const result = await savePaymentSettings(') <
          paymentSettingsViewCode.lastIndexOf('setLoadError(null);') &&
        DEFAULT_PAYMENT_SETTINGS_PATH === path.resolve(PROJECT_ROOT_DIR, 'data', 'payment-settings.json') &&
        resolveProjectRootDir(simulatedUnbundledDir) === simulatedRoot &&
        resolveProjectRootDir(simulatedRoot) === simulatedRoot &&
        resolveDefaultPaymentSettingsPath({} as any, simulatedRoot) ===
          path.resolve(simulatedRoot, 'data', 'payment-settings.json') &&
        gitignoreContent.includes('data/payment-settings*.json'),
      'PaymentSettingsView.tsx limpa loadError após salvamento bem-sucedido, DEFAULT_PAYMENT_SETTINGS_PATH resolve para <root>/data/payment-settings.json em tsx e em server.js empacotado, e .gitignore protege o arquivo de estado'
    );
    // 13.13 Segurança do Webhook em Produção (MP_WEBHOOK_SECRET obrigatório fail-closed 503; assinatura inválida 401; HMAC válido 200)
    const prodWithoutSecret = evaluateWebhookSecurityGate({
      headers: {},
      body: { data: { id: '99887766' } },
      webhookSecret: '',
      isProduction: true,
    });

    const prodWithPlaceholderSecret = evaluateWebhookSecurityGate({
      headers: {},
      body: { data: { id: '99887766' } },
      webhookSecret: 'your-webhook-secret',
      isProduction: true,
    });

    const testWebhookSecret = 'whsec_test_px_custon_hmac_2026';
    const fixedNowMs = 1704067200 * 1000;
    const validTs = '1704067200';
    const validManifest = `id:99887766;request-id:req-abc-123;ts:${validTs};`;
    const validHmac = crypto
      .createHmac('sha256', testWebhookSecret)
      .update(validManifest)
      .digest('hex');

    const prodInvalidSig = evaluateWebhookSecurityGate({
      headers: {
        'x-signature': `ts=${validTs},v1=deadbeef0000`,
        'x-request-id': 'req-abc-123',
      },
      body: { data: { id: '99887766' } },
      webhookSecret: testWebhookSecret,
      isProduction: true,
      nowMs: fixedNowMs,
    });

    const prodValidSig = evaluateWebhookSecurityGate({
      headers: {
        'x-signature': `ts=${validTs},v1=${validHmac}`,
        'x-request-id': 'req-abc-123',
      },
      body: { data: { id: '99887766' } },
      webhookSecret: testWebhookSecret,
      isProduction: true,
      nowMs: fixedNowMs,
    });

    assert(
      prodWithoutSecret.allowed === false &&
        prodWithoutSecret.statusCode === 503 &&
        prodWithoutSecret.code === 'WEBHOOK_SECRET_NOT_CONFIGURED' &&
        prodWithPlaceholderSecret.allowed === false &&
        prodWithPlaceholderSecret.statusCode === 503 &&
        prodInvalidSig.allowed === false &&
        prodInvalidSig.statusCode === 401 &&
        prodInvalidSig.code === 'INVALID_WEBHOOK_SIGNATURE' &&
        prodValidSig.allowed === true &&
        prodValidSig.statusCode === 200 &&
        prodValidSig.signatureValid === true,
      'Webhook bloqueia processamento em produção quando MP_WEBHOOK_SECRET está ausente/placeholder (HTTP 503), rejeita HMAC inválido (HTTP 401) e aprova assinatura HMAC-SHA256 válida (HTTP 200)'
    );

    // 13.14 Remoção de Pix estático e preference_id sintético + Integração Real com /v1/payments do Mercado Pago
    assert(
      !serverCode.includes('00020126580014BR.GOV.BCB.PIX0136') &&
        !serverCode.includes('preference_id: `pref_${') &&
        serverCode.includes('SYNTHETIC_PREFERENCE_DISABLED'),
      'server.ts não contém mais Pix Copia e Cola estático nem preference_id sintético no checkout'
    );

    let capturedMpHeaders: any = null;
    let capturedMpBody: any = null;
    const deterministicTestCpf = generateDeterministicTestCpf(2026);
    const mockOrderInput = {
      id: '11111111-2222-4333-8444-555555555555',
      user_id: actorSuperId,
      event_id: 'evt-real-uuid-1',
      event_title: 'ENCONTRO OFICIAL PX CUSTON',
      total: 99.0,
      payment_method: 'pix',
      buyer: {
        name: 'Piloto Teste Sandbox',
        email: 'piloto@pxcuston.com.br',
        cpf: deterministicTestCpf,
      },
    };

    const realPixSuccess = await createOrRecoverMercadoPagoPixPayment({
      order: mockOrderInput,
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      appUrl: 'https://pxcuston.com.br',
      fetchImpl: (async (_url: any, init: any) => {
        capturedMpHeaders = init?.headers;
        capturedMpBody = JSON.parse(init?.body || '{}');
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 8877665544,
              status: 'pending',
              currency_id: 'BRL',
              transaction_amount: 99.0,
              external_reference: mockOrderInput.id,
              date_of_expiration: '2026-10-24T20:15:00.000Z',
              point_of_interaction: {
                transaction_data: {
                  qr_code: '00020126580014br.gov.bcb.pix0136real-mp-sandbox-emv-payload',
                  qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                  ticket_url: 'https://www.mercadopago.com.br/payments/8877665544/ticket',
                },
              },
            }),
        } as any;
      }) as any,
    });

    const realPixAmountMismatch = await createOrRecoverMercadoPagoPixPayment({
      order: mockOrderInput,
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      fetchImpl: (async () => ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 8877665545,
            status: 'pending',
            currency_id: 'BRL',
            transaction_amount: 10.0, // Divergente de 99.0
            external_reference: mockOrderInput.id,
            point_of_interaction: {
              transaction_data: {
                qr_code: '00020126580014br.gov.bcb.pix0136real-mp-sandbox-emv-payload',
              },
            },
          }),
      })) as any,
    });

    assert(
      realPixSuccess.ok === true &&
        realPixSuccess.statusCode === 200 &&
        realPixSuccess.payment?.id === '8877665544' &&
        realPixSuccess.payment?.external_reference === mockOrderInput.id &&
        realPixSuccess.payment?.pix_copy_paste ===
          '00020126580014br.gov.bcb.pix0136real-mp-sandbox-emv-payload' &&
        Boolean(realPixSuccess.payment?.pix_qr_code_base64) &&
        capturedMpHeaders?.['X-Idempotency-Key'] === `px-order-${mockOrderInput.id}` &&
        capturedMpBody?.external_reference === mockOrderInput.id &&
        capturedMpBody?.payment_method_id === 'pix' &&
        capturedMpBody?.transaction_amount === 99.0 &&
        realPixAmountMismatch.ok === false &&
        realPixAmountMismatch.statusCode === 502 &&
        realPixAmountMismatch.code === 'MP_AMOUNT_MISMATCH',
      'Integração Pix Mercado Pago envia X-Idempotency-Key e external_reference=order.id, retorna qr_code e qr_code_base64 oficiais e rejeita divergência financeira (HTTP 502)'
    );

    // 13.15 Bloqueio de métodos não implementados (Cartão e Boleto) no backend e na interface
    const checkPixMethod = isPaymentMethodImplemented('pix');
    const checkCardMethod = isPaymentMethodImplemented('credit_card');
    const checkBoletoMethod = isPaymentMethodImplemented('boleto');

    assert(
      checkPixMethod.implemented === true &&
        checkCardMethod.implemented === false &&
        checkCardMethod.code === 'PAYMENT_METHOD_NOT_IMPLEMENTED' &&
        checkBoletoMethod.implemented === false &&
        checkBoletoMethod.code === 'PAYMENT_METHOD_NOT_IMPLEMENTED' &&
        checkoutViewCode.includes('const creditCardEnabled = false;') &&
        checkoutViewCode.includes('const boletoEnabled = false;') &&
        paymentSettingsViewCode.includes('credit_card_enabled: false,') &&
        paymentSettingsViewCode.includes('boleto_enabled: false,'),
      'Cartão de Crédito e Boleto Bancário permanecem bloqueados no backend (PAYMENT_METHOD_NOT_IMPLEMENTED) e na interface (CheckoutView e PaymentSettingsView)'
    );

    // 13.16 Alinhamento dos logs de auditoria do PWA com public.audit_logs e documentação completa no .env.example
    assert(
      !serverCode.includes("resource_type: 'site_settings'") &&
        !serverCode.includes("resource_id: 'pwa_branding'") &&
        serverCode.includes("entity: 'site_settings'") &&
        serverCode.includes("entity_id: 'pwa_branding'") &&
        envExample.includes('NODE_ENV=') &&
        envExample.includes('PX_ENVIRONMENT=') &&
        envExample.includes('VITE_SUPABASE_URL=') &&
        envExample.includes('VITE_SUPABASE_ANON_KEY=') &&
        envExample.includes('SUPABASE_SERVICE_ROLE_KEY=') &&
        envExample.includes('PX_PAYMENT_SETTINGS_PATH='),
      'Logs de auditoria do PWA utilizam colunas oficiais de public.audit_logs (entity, entity_id, details) e .env.example documenta todas as variáveis de ambiente do código'
    );

    // 13.17 RECONCILIAÇÃO PIX (Cenários 1 e 2):
    // - Timeout ou HTTP 5xx na criação do Pix com cobrança existente no Mercado Pago -> recupera cobrança e não libera estoque (shouldReleaseStock=false).
    // - Timeout ou HTTP 5xx na criação do Pix sem cobrança existente (search not_found) -> libera estoque com segurança (shouldReleaseStock=true).
    // - Timeout ou HTTP 5xx tanto na criação quanto na reconciliação -> mantém pedido em estado seguro (inconclusive=true, shouldReleaseStock=false, HTTP 503).
    const mockPersistenceStore: { orders: Record<string, any>; payments: any[] } = {
      orders: {},
      payments: [],
    };
    const mockReconcileSupabase = {
      from: (table: string) => {
        if (table === 'orders') {
          return {
            update: (vals: any) => ({
              eq: async (_col: string, id: string) => {
                mockPersistenceStore.orders[id] = { ...(mockPersistenceStore.orders[id] || {}), ...vals };
                return { error: null };
              },
            }),
          };
        }
        return {
          select: () => ({
            eq: (_col: string, orderId: string) => ({
              order: () => ({
                limit: async () => ({
                  data: mockPersistenceStore.payments.filter((p) => p.order_id === orderId).slice(0, 1),
                  error: null,
                }),
              }),
            }),
          }),
          update: (vals: any) => ({
            eq: async (_col: string, id: string) => {
              const idx = mockPersistenceStore.payments.findIndex((p) => p.id === id);
              if (idx >= 0) mockPersistenceStore.payments[idx] = { ...mockPersistenceStore.payments[idx], ...vals };
              return { error: null };
            },
          }),
          insert: async (row: any) => {
            mockPersistenceStore.payments.push({ id: `pay-${mockPersistenceStore.payments.length + 1}`, ...row });
            return { error: null };
          },
        };
      },
    };

    // Caso A: POST /v1/payments retorna HTTP 504 (timeout/gateway), mas GET /v1/payments/search encontra a cobrança criada
    const pixRecoveredAfter504 = await createOrRecoverMercadoPagoPixPayment({
      order: mockOrderInput,
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      supabaseClient: mockReconcileSupabase,
      fetchImpl: (async (url: any, init: any) => {
        const urlStr = String(url);
        if (init?.method === 'POST') {
          return {
            ok: false,
            status: 504,
            text: async () => JSON.stringify({ message: 'Gateway Timeout' }),
          } as any;
        }
        if (urlStr.includes('/v1/payments/search')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                results: [
                  {
                    id: 9911223344,
                    status: 'pending',
                    currency_id: 'BRL',
                    transaction_amount: 99.0,
                    external_reference: mockOrderInput.id,
                    date_of_expiration: '2026-10-24T20:15:00.000Z',
                    point_of_interaction: {
                      transaction_data: {
                        qr_code: '00020126580014br.gov.bcb.pix0136recovered-after-504',
                        qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                      },
                    },
                  },
                ],
              }),
          } as any;
        }
        return { ok: false, status: 404, text: async () => '{}' } as any;
      }) as any,
    });

    // Caso B: POST /v1/payments sofre falha de rede e GET /v1/payments/search confirma results=[] (nenhuma cobrança criada) -> shouldReleaseStock=true
    const pixConfirmedAbsentAfterTimeout = await createOrRecoverMercadoPagoPixPayment({
      order: { ...mockOrderInput, id: '22222222-3333-4444-8555-666666666666' },
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      supabaseClient: mockReconcileSupabase,
      fetchImpl: (async (url: any, init: any) => {
        if (init?.method === 'POST') {
          throw new Error('AbortError: The operation was aborted due to timeout');
        }
        if (String(url).includes('/v1/payments/search')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
          } as any;
        }
        return { ok: false, status: 404, text: async () => '{}' } as any;
      }) as any,
    });

    // Caso C: POST /v1/payments dá timeout E GET /v1/payments/search também dá HTTP 503 -> inconclusive=true, shouldReleaseStock=false, HTTP 503
    const pixInconclusiveAfterDouble5xx = await createOrRecoverMercadoPagoPixPayment({
      order: { ...mockOrderInput, id: '33333333-4444-4555-8666-777777777777' },
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      supabaseClient: mockReconcileSupabase,
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'Service Unavailable' }),
      })) as any,
    });

    assert(
      pixRecoveredAfter504.ok === true &&
        pixRecoveredAfter504.reconciled === true &&
        pixRecoveredAfter504.shouldReleaseStock === false &&
        pixRecoveredAfter504.payment?.id === '9911223344' &&
        pixRecoveredAfter504.payment?.pix_copy_paste === '00020126580014br.gov.bcb.pix0136recovered-after-504' &&
        mockPersistenceStore.orders[mockOrderInput.id]?.mercado_pago_id === '9911223344' &&
        mockPersistenceStore.payments.length === 1 &&
        pixConfirmedAbsentAfterTimeout.ok === false &&
        pixConfirmedAbsentAfterTimeout.shouldReleaseStock === true &&
        pixConfirmedAbsentAfterTimeout.inconclusive === false &&
        pixInconclusiveAfterDouble5xx.ok === false &&
        pixInconclusiveAfterDouble5xx.statusCode === 503 &&
        pixInconclusiveAfterDouble5xx.inconclusive === true &&
        pixInconclusiveAfterDouble5xx.shouldReleaseStock === false,
      'Reconciliação Pix recupera cobrança criada após HTTP 504 sem liberar estoque, libera estoque quando search confirma ausência e preserva pedido pendente (HTTP 503, shouldReleaseStock=false) quando inconclusivo'
    );

    // 13.18 Duplo clique / Retry do mesmo pedido (already_processed = true) recupera o mesmo payment_id sem emitir nova cobrança POST
    let postCallsOnRetry = 0;
    const retryExistingPix = await createOrRecoverMercadoPagoPixPayment({
      order: {
        ...mockOrderInput,
        already_processed: true,
        mercado_pago_id: '9911223344',
      },
      mpAccessToken: 'TEST-1234567890-sandbox-token',
      supabaseClient: mockReconcileSupabase,
      fetchImpl: (async (url: any, init: any) => {
        if (init?.method === 'POST') {
          postCallsOnRetry++;
        }
        if (String(url).includes('/v1/payments/9911223344')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                id: 9911223344,
                status: 'pending',
                currency_id: 'BRL',
                transaction_amount: 99.0,
                external_reference: mockOrderInput.id,
                date_of_expiration: '2026-10-24T20:15:00.000Z',
                point_of_interaction: {
                  transaction_data: {
                    qr_code: '00020126580014br.gov.bcb.pix0136recovered-after-504',
                  },
                },
              }),
          } as any;
        }
        return { ok: false, status: 404, text: async () => '{}' } as any;
      }) as any,
    });

    assert(
      retryExistingPix.ok === true &&
        retryExistingPix.reconciled === true &&
        retryExistingPix.payment?.id === '9911223344' &&
        postCallsOnRetry === 0 &&
        mockPersistenceStore.payments.length === 1,
      'Retry / duplo clique do mesmo pedido recupera o mesmo payment_id via reconciliação sem disparar novo POST /v1/payments nem duplicar linha em public.payments'
    );

    // 13.19 Persistência verificada (sem catch silencioso) e validação de CPF (Mod 11) + remoção de dados fictícios no CheckoutView
    const failingPersistenceRes = await persistMercadoPagoPixChargeLink({
      supabaseClient: {
        from: () => ({
          update: () => ({
            eq: async () => ({ error: { message: 'DB write error on orders' } }),
          }),
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: null, error: { message: 'DB read error on payments' } }),
              }),
            }),
          }),
        }),
      },
      order: { id: mockOrderInput.id, user_id: actorSuperId, total: 99.0 },
      mpPaymentId: '9911223344',
      status: 'pending',
      pixCopyPaste: '000201...',
      pixQrCodeBase64: null,
      ticketUrl: null,
      expiresAt: '2026-10-24T20:15:00.000Z',
    });

    assert(
      failingPersistenceRes.ok === false &&
        Boolean(failingPersistenceRes.error) &&
        isValidBrazilianCpf(deterministicTestCpf) === true &&
        isValidBrazilianCpf('123.456.789-00') === false &&
        isValidBrazilianCpf('111.111.111-11') === false &&
        !checkoutViewCode.includes("useState('123.456.789-00')") &&
        !checkoutViewCode.includes("useState(user?.full_name || 'Deivid J. Silva')") &&
        !checkoutViewCode.includes("useState(user?.email || 'deivid@gmail.com')"),
      'Persistência da cobrança verifica { error } explicitamente (sem catch silencioso), valida dígitos verificadores do CPF (Mod 11) e remove dados fictícios fixos de CheckoutView.tsx'
    );

    // 13.20 Separação clara de NODE_ENV e PX_ENVIRONMENT + Atualização automática de ingressos pós-aprovação
    const appTsxCode = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
    const envSandboxBuild = resolveOperationalEnvironment({
      NODE_ENV: 'production',
      PX_ENVIRONMENT: 'sandbox',
    } as any);
    const envProdBuild = resolveOperationalEnvironment({
      NODE_ENV: 'production',
      PX_ENVIRONMENT: 'production',
    } as any);

    assert(
      envSandboxBuild.isCompiledBuild === true &&
        envSandboxBuild.isProductionSecurity === true &&
        envSandboxBuild.paymentStage === 'sandbox' &&
        envProdBuild.isCompiledBuild === true &&
        envProdBuild.isProductionSecurity === true &&
        envProdBuild.paymentStage === 'production' &&
        checkoutViewCode.includes('onPaymentApproved') &&
        appTsxCode.includes('fetchUserTicketsFromDatabase(user.id, user.full_name)'),
      'Diferencia corretamente build compilado (NODE_ENV=production), segurança pública e estágio Sandbox (PX_ENVIRONMENT=sandbox), e atualiza ingressos automaticamente após aprovação no CheckoutView'
    );
  } finally {
    try {
      if (fs.existsSync(tempAuditPayFile)) fs.unlinkSync(tempAuditPayFile);
    } catch {}
  }

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
