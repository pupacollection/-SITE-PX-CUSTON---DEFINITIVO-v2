/**
 * PX CUSTON — Suíte de Testes Automatizados de Runtime da API
 * 
 * Executa testes de ponta a ponta contra os endpoints HTTP do servidor local (porta 3000):
 * - Validação e Check-in com regras anti-fraude e anti-dupla-entrada
 * - Bloqueio de redefinição de demonstração em produção e rejeição de bypass público (reset_demo)
 * - Autorização administrativa estrita para redefinição em ambiente de teste
 * - Rejeição incondicional do segredo padrão antigo descartado (px_custom_super_admin_bootstrap_secret_2026_secure)
 * - Validações transacionais de pedidos e webhooks de pagamento
 */

import http from 'http';
import {
  executeAuthenticatedTicketValidation,
  evaluateOrderCancellationOutcome,
} from '../src/lib/ticketValidator';

export interface ApiTestResult {
  id: number;
  name: string;
  expectedStatus: number;
  receivedStatus: number;
  passed: boolean;
  error?: string;
  details?: string;
}

export interface RuntimeSuiteSummary {
  status: 'PASSED' | 'FAILED';
  total: number;
  passed: number;
  failed: number;
  results: ApiTestResult[];
}

export type RequesterFn = (options: http.RequestOptions, postData?: any) => Promise<{ statusCode: number; data: any }>;

export async function defaultHttpRequester(options: http.RequestOptions, postData?: any): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ statusCode: res.statusCode || 0, data: parsed });
        } catch {
          resolve({ statusCode: res.statusCode || 0, data: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

export async function runRuntimeTests(customRequester?: RequesterFn): Promise<RuntimeSuiteSummary> {
  const requester = customRequester || defaultHttpRequester;
  console.log('==============================================================================');
  console.log('🧪 PX CUSTON — SUÍTE DE TESTES DE RUNTIME DA API (CHECK-IN, CHECKOUT & SEGURANÇA)');
  console.log('==============================================================================\n');

  const results: ApiTestResult[] = [];
  let passedCount = 0;
  let failedCount = 0;

  const adminSecret = process.env.PX_SUPER_ADMIN_INIT_TOKEN || process.env.SUPABASE_INIT_SECRET || 'px_test_super_admin_secret_token_secure_2026';

  // --------------------------------------------------------------------------
  // Setup: Reset controlado do estado via rota administrativa autorizada
  // --------------------------------------------------------------------------
  try {
    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
    }, { code: 'PX-7AI89C10' });

    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
    }, { code: 'PX-4M29L8X1' });
  } catch (err: any) {
    console.warn('⚠️ [Setup de Runtime] Aviso ao resetar estado de teste:', err.message);
  }

  // Helper de execução segura de cenário
  async function executeScenario(
    id: number,
    name: string,
    expectedStatus: number,
    action: () => Promise<{ statusCode: number; data: any }>,
    validateBody?: (data: any) => boolean
  ) {
    try {
      const res = await action();
      const statusMatch = res.statusCode === expectedStatus;
      const bodyValid = validateBody ? validateBody(res.data) : true;
      const passed = statusMatch && bodyValid;

      if (passed) {
        passedCount++;
        results.push({
          id,
          name,
          expectedStatus,
          receivedStatus: res.statusCode,
          passed: true,
        });
        console.log(`Cenário ${id}. ${name}: ✅ HTTP ${res.statusCode} (Aprovado)`);
      } else {
        failedCount++;
        const reason = !statusMatch
          ? `Status HTTP esperado ${expectedStatus}, recebido ${res.statusCode}`
          : `Validação do payload de resposta falhou (status=${res.statusCode})`;
        results.push({
          id,
          name,
          expectedStatus,
          receivedStatus: res.statusCode,
          passed: false,
          error: reason,
        });
        console.log(`Cenário ${id}. ${name}: ❌ FALHOU — ${reason}`);
      }
    } catch (err: any) {
      failedCount++;
      results.push({
        id,
        name,
        expectedStatus,
        receivedStatus: 0,
        passed: false,
        error: `Exceção de rede/execução: ${err.message}`,
      });
      console.log(`Cenário ${id}. ${name}: ❌ FALHOU COM EXCEÇÃO — ${err.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Cenário 1: Visitante sem token em /api/tickets/validate deve retornar HTTP 401
  // --------------------------------------------------------------------------
  await executeScenario(
    1,
    'Segurança Check-in: Visitante não autenticado bloqueado em /api/tickets/validate (HTTP 401)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'INVALIDO-999' }),
    (data) => data && data.valid === false && data.status === 'unauthorized'
  );

  // --------------------------------------------------------------------------
  // Cenário 2: Visitante sem token não consegue consumir ingresso válido (PX-7AI89C10) -> HTTP 401
  // --------------------------------------------------------------------------
  await executeScenario(
    2,
    'Segurança Check-in: Visitante sem token não consegue consumir ingresso válido (HTTP 401)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10' }),
    (data) => data && data.valid === false && data.status === 'unauthorized'
  );

  // --------------------------------------------------------------------------
  // Cenário 3: Token inválido ou expirado em /api/tickets/validate é rejeitado com HTTP 401
  // --------------------------------------------------------------------------
  await executeScenario(
    3,
    'Segurança Check-in: Token JWT inválido em /api/tickets/validate é rejeitado (HTTP 401)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token_jwt_invalido_visitante_123',
      },
    }, { code: 'PX-7AI89C10' }),
    (data) => data && data.valid === false && data.status === 'unauthorized'
  );

  // --------------------------------------------------------------------------
  // Cenário 4: SEGURANÇA: Tentativa de injetar operator_id ou reset_demo sem sessão válida retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    4,
    'Segurança Check-in: Spoofing de operator_id e reset_demo sem autenticação é rejeitado (HTTP 401)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      code: 'PX-7AI89C10',
      operator_id: '11111111-1111-4111-8111-111111111111',
      reset_demo: true,
    }),
    (data) => data && data.valid === false && data.status === 'unauthorized'
  );

  // --------------------------------------------------------------------------
  // Cenário 5: SEGURANÇA: Chamada a /api/admin/tickets/reset-demo sem autorização retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    5,
    'Segurança: Chamada a /api/admin/tickets/reset-demo sem autorização retorna HTTP 401',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10' }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 6: SEGURANÇA: Chamada com token incorreto a /api/admin/tickets/reset-demo retorna 403
  // --------------------------------------------------------------------------
  await executeScenario(
    6,
    'Segurança: Chamada com token incorreto a /api/admin/tickets/reset-demo retorna HTTP 403',
    403,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token_invalido_hacker_1234567890',
      },
    }, { code: 'PX-7AI89C10' }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 7: SEGURANÇA: Chamada com o segredo padrão antigo descartado retorna 403
  // --------------------------------------------------------------------------
  await executeScenario(
    7,
    'Segurança: Segredo padrão antigo descartado (px_custom_super_admin_bootstrap_secret_2026_secure) é rejeitado',
    403,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer px_custom_super_admin_bootstrap_secret_2026_secure',
      },
    }, { code: 'PX-7AI89C10' }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 8: Redefinição autorizada via endpoint administrativo com token de servidor válido retorna 200
  // --------------------------------------------------------------------------
  await executeScenario(
    8,
    'Autorização: Redefinição legítima via /api/admin/tickets/reset-demo retorna HTTP 200',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
    }, { code: 'PX-7AI89C10' }),
    (data) => data && data.success === true && data.reset === true
  );

  // --------------------------------------------------------------------------
  // Cenário 9: Operador autorizado (CHECKIN_OPERATOR) valida ingresso (200), bloqueia 2ª leitura (409) e USER comum recebe 403
  // --------------------------------------------------------------------------
  await executeScenario(
    9,
    'Autorização RBAC Check-in: Operador autorizado valida ingresso (200/409) e USER comum é bloqueado (403)',
    200,
    async () => {
      if (customRequester) {
        return requester({
          hostname: 'localhost',
          port: 3000,
          path: '/api/tickets/validate',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer valid_operator_token',
          },
        }, { code: 'PX-7AI89C10' });
      }

      const localDemoMap = new Map<string, any>();
      let usedIds: string[] = [];
      const makeClient = (role: string, userId: string) => ({
        auth: {
          getUser: async () => ({ data: { user: { id: userId } }, error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: userId, role }, error: null }),
            }),
          }),
        }),
        rpc: async (_fn: string, params: any) => {
          usedIds.push(params.p_operator_id);
          return { data: { status: 'not_found' }, error: null };
        },
      });

      // 1) Usuário comum autenticado (USER) tentando validar ingresso -> deve ser bloqueado com 403
      const userAttempt = await executeAuthenticatedTicketValidation({
        authHeader: 'Bearer user_jwt_token',
        code: 'PX-7AI89C10',
        clientOperatorId: 'spoofed-operator-id',
        supabaseClient: makeClient('USER', 'user-common-uuid'),
        isProduction: false,
        demoUsedMap: localDemoMap,
      });

      // 2) Operador autorizado (CHECKIN_OPERATOR) validando ingresso (1ª leitura -> 200)
      const opFirstScan = await executeAuthenticatedTicketValidation({
        authHeader: 'Bearer operator_jwt_token',
        code: 'PX-7AI89C10',
        clientOperatorId: 'spoofed-operator-id',
        supabaseClient: makeClient('CHECKIN_OPERATOR', 'operator-verified-uuid'),
        isProduction: false,
        demoUsedMap: localDemoMap,
      });

      // 3) Operador autorizado (CHECKIN_OPERATOR) tentando 2ª leitura do mesmo ingresso -> 409
      const opSecondScan = await executeAuthenticatedTicketValidation({
        authHeader: 'Bearer operator_jwt_token',
        code: 'PX-7AI89C10',
        clientOperatorId: 'spoofed-operator-id',
        supabaseClient: makeClient('CHECKIN_OPERATOR', 'operator-verified-uuid'),
        isProduction: false,
        demoUsedMap: localDemoMap,
      });

      const allChecksOk =
        userAttempt.statusCode === 403 &&
        opFirstScan.statusCode === 200 &&
        opFirstScan.payload.valid === true &&
        opSecondScan.statusCode === 409 &&
        opSecondScan.payload.status === 'already_used' &&
        usedIds.length === 2 &&
        usedIds.every((id) => id === 'operator-verified-uuid');

      return {
        statusCode: allChecksOk ? 200 : 500,
        data: opFirstScan.payload,
      };
    },
    (data) => data && data.valid === true && data.status === 'success'
  );

  // --------------------------------------------------------------------------
  // Cenário 10: Inicialização de Super Admin com senha incorreta deve retornar HTTP 403
  // --------------------------------------------------------------------------
  await executeScenario(
    10,
    'Tentativa de Init Super Admin com segredo incorreto',
    403,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/init-super-admin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { email: 'hacker@malicioso.com', setup_secret: 'senha_errada_123456789012345678' }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 11: Bloqueio estrito de checkout comercial em evento de demonstração (DEMO)
  // --------------------------------------------------------------------------
  await executeScenario(
    11,
    'Bloqueio de pedido comercial em Evento DEMO',
    400,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      event_id: 'evt-mega-encontro-2025',
      items: [{ batch_id: 'b-1', quantity: 1 }],
      buyer: { name: 'Comprador Teste', email: 'teste@px.com' },
    }),
    (data) => Boolean(data && data.is_demo)
  );

  // --------------------------------------------------------------------------
  // Cenário 12: Rejeição de pedido com itens vazios ou formato inválido
  // --------------------------------------------------------------------------
  await executeScenario(
    12,
    'Validação de integridade de payload no Checkout',
    400,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      event_id: 'evt-carros-antigos-2025',
      items: [],
      buyer: { name: 'Comprador Teste', email: 'teste@px.com' },
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 13: Consulta de status de pedido não existente deve retornar HTTP 404
  // --------------------------------------------------------------------------
  await executeScenario(
    13,
    'Consulta de status de pedido não existente',
    404,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/00000000-0000-0000-0000-000000000000/status',
      method: 'GET',
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 14: Confirmação de recebimento no Webhook do Mercado Pago (ping/teste)
  // --------------------------------------------------------------------------
  await executeScenario(
    14,
    'Confirmação de recebimento do Webhook oficial (ping de verificação)',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/payments/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'payment.created',
      data: { id: 'mp-test-ping-1' },
      type: 'payment',
    }),
    (data) => data && data.received === true
  );

  // --------------------------------------------------------------------------
  // Cenário 15: Tentativa de expirar pedidos sem token administrativo retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    15,
    'Proteção RBAC na expiração de pedidos (sem token)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/orders/expire-pending',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { timeout_minutes: 15 }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 16: Checkout sem fallback perigoso quando RPC não está disponível
  // --------------------------------------------------------------------------
  await executeScenario(
    16,
    'Erro controlado no checkout (sem fallback inseguro)',
    503,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      event_id: '00000000-0000-0000-0000-000000000000',
      items: [{ batch_id: 'batch-test-1', quantity: 1, unit_price: 50.0 }],
      buyer: { name: 'Comprador Fallback', email: 'fallback@px.com' },
      payment_method: 'pix',
    }),
    (data) => Boolean(data && data.error && (data.error.includes('integridade') || data.error.includes('manutenção') || data.error.includes('indisponível') || data.code === 'RPC_NOT_AVAILABLE'))
  );

  // --------------------------------------------------------------------------
  // Cenário 17: Extração de QR Payload completo por operador autorizado e proteção de cancelamento/estoque
  // --------------------------------------------------------------------------
  await executeScenario(
    17,
    'Extração de QR Payload completo por operador autorizado e proteção de cancelamento/estoque',
    200,
    async () => {
      if (customRequester) {
        return requester({
          hostname: 'localhost',
          port: 3000,
          path: '/api/tickets/validate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, { code: 'PX:PX-4M29L8X1:1111-2222-3333' });
      }

      const localDemoMap = new Map<string, any>();
      const adminClient = {
        auth: {
          getUser: async () => ({ data: { user: { id: 'admin-verified-uuid' } }, error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 'admin-verified-uuid', role: 'ADMIN' }, error: null }),
            }),
          }),
        }),
        rpc: async () => ({ data: { status: 'not_found' }, error: null }),
      };

      const qrValidation = await executeAuthenticatedTicketValidation({
        authHeader: 'Bearer admin_jwt_token',
        code: 'PX:PX-4M29L8X1:1111-2222-3333',
        supabaseClient: adminClient,
        isProduction: false,
        demoUsedMap: localDemoMap,
      });

      // Verificar também que falha na RPC de cancelamento não marca cancelled e pedido aprovado não é cancelado
      const rpcFailEval = evaluateOrderCancellationOutcome({
        rpcResult: null,
        rpcError: { message: 'RPC Error' },
        orderId: 'ord-1',
        currentStatus: 'pending',
      });
      const approvedEval = evaluateOrderCancellationOutcome({
        rpcResult: { success: false, status: 'approved', error: 'Already approved' },
        rpcError: null,
        orderId: 'ord-2',
        currentStatus: 'pending',
      });

      const ok =
        qrValidation.statusCode === 200 &&
        qrValidation.payload.code === 'PX-4M29L8X1' &&
        rpcFailEval.statusCode === 503 &&
        rpcFailEval.cancelled === false &&
        rpcFailEval.stockReleased === false &&
        approvedEval.statusCode === 200 &&
        approvedEval.outcome === 'already_approved' &&
        approvedEval.cancelled === false &&
        approvedEval.stockReleased === false;

      return {
        statusCode: ok ? 200 : 500,
        data: qrValidation.payload,
      };
    },
    (data) => data && data.valid === true && data.code === 'PX-4M29L8X1'
  );

  // --------------------------------------------------------------------------
  // Cenário 18: Bloqueio de aprovação fraudulenta por injeção de status no Webhook
  // --------------------------------------------------------------------------
  await executeScenario(
    18,
    'Bloqueio de aprovação fraudulenta via body no Webhook',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/payments/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'payment.created',
      order_id: 'ord-qualquer-123',
      payment_status: 'approved',
    }),
    (data) => data && data.received === true && !data.status
  );

  // --------------------------------------------------------------------------
  // Cenário 19: Proteção RBAC em GET /api/admin/users sem token retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    19,
    'Proteção RBAC na listagem administrativa de usuários (GET /api/admin/users sem token)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/users',
      method: 'GET',
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 20: Proteção RBAC em PATCH /api/admin/users/:id/role sem token retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    20,
    'Proteção RBAC na alteração de papel (PATCH /api/admin/users/:id/role sem token)',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/users/11111111-1111-4111-8111-111111111111/role',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    }, { new_role: 'ADMIN' }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 21: Proteção RBAC em POST /api/admin/promote-user com token inválido retorna 401
  // --------------------------------------------------------------------------
  await executeScenario(
    21,
    'Proteção RBAC em POST /api/admin/promote-user com sessão inválida',
    401,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/promote-user',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token_jwt_invalido_nao_autenticado',
      },
    }, {
      target_user_id: '11111111-1111-4111-8111-111111111111',
      new_role: 'SUPER_ADMIN',
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Teardown: Limpeza final de estado via rota administrativa autorizada
  // --------------------------------------------------------------------------
  try {
    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
    }, { code: 'PX-7AI89C10' });

    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/tickets/reset-demo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
    }, { code: 'PX-4M29L8X1' });
  } catch {
    // Teardown silencioso
  }

  // --------------------------------------------------------------------------
  // Avaliação Final do Gate
  // --------------------------------------------------------------------------
  const totalScenarios = 21;
  const allPassed = failedCount === 0 && passedCount === totalScenarios;
  console.log('\n==============================================================================');
  if (allPassed) {
    console.log(`🎉 TODOS OS ${totalScenarios} CENÁRIOS DE RUNTIME DA API PASSARAM COM SUCESSO! (${passedCount}/${totalScenarios})`);
    console.log('==============================================================================\n');
    return {
      status: 'PASSED',
      total: totalScenarios,
      passed: passedCount,
      failed: failedCount,
      results,
    };
  } else {
    console.error(`💥 SUÍTE DE RUNTIME REPROVADA: ${failedCount} CENÁRIO(S) COM FALHA (${passedCount}/${totalScenarios} aprovados)`);
    console.log('==============================================================================\n');
    return {
      status: 'FAILED',
      total: totalScenarios,
      passed: passedCount,
      failed: failedCount,
      results,
    };
  }
}

// Execução direta via CLI
if (process.argv[1] && process.argv[1].endsWith('test-api-runtime.ts')) {
  runRuntimeTests().then((summary) => {
    if (summary.status !== 'PASSED') {
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Erro fatal ao executar testes de runtime:', err);
    process.exit(1);
  });
}
