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
