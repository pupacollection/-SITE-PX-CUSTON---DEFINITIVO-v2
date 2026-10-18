/**
 * PX CUSTON — Suíte de Testes Automatizados de Runtime da API
 * 
 * Executa testes de ponta a ponta contra os endpoints HTTP do servidor local (porta 3000):
 * - Validação e Check-in com regras anti-fraude e anti-dupla-entrada
 * - Proteção de credenciais administrativas
 * - Integridade do Checkout e bloqueio de fallbacks não atômicos
 * - Proteção contra aprovação fraudulenta no webhook do Mercado Pago
 * - Proteção RBAC no endpoint de expiração de pedidos
 * 
 * Regras do Gate:
 * 1. Cada cenário possui asserção estrita do status HTTP esperado e do corpo retornado.
 * 2. Qualquer divergência ou exceção é contabilizada como FALHA.
 * 3. Encerra com código de saída 1 se QUALQUER cenário falhar.
 * 4. Só emite mensagem de sucesso se 100% dos testes passarem.
 * 5. Garante isolamento de estado resetando dados voláteis no setup e teardown.
 */

import http from 'http';

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

  // --------------------------------------------------------------------------
  // Setup: Reset de estado de ingressos demo para isolamento estrito entre execuções
  // --------------------------------------------------------------------------
  try {
    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10', reset_demo: true });

    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-4M29L8X1', reset_demo: true });
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
  // Cenário 1: Ingresso inexistente deve retornar HTTP 404
  // --------------------------------------------------------------------------
  await executeScenario(
    1,
    'Validação de ingresso inexistente',
    404,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'INVALIDO-999' }),
    (data) => data && data.valid === false
  );

  // --------------------------------------------------------------------------
  // Cenário 2: Primeiro check-in de ingresso válido (PX-7AI89C10) deve retornar HTTP 200
  // --------------------------------------------------------------------------
  await executeScenario(
    2,
    'Primeiro Check-in de ingresso válido (PX-7AI89C10)',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10' }),
    (data) => data && data.valid === true && data.status === 'success'
  );

  // --------------------------------------------------------------------------
  // Cenário 3: Segundo check-in do mesmo ingresso deve ser bloqueado com HTTP 409 (Anti-Fraude)
  // --------------------------------------------------------------------------
  await executeScenario(
    3,
    'Anti-Fraude: Segundo Check-in com o mesmo ingresso',
    409,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10' }),
    (data) => data && data.valid === false && data.status === 'already_used'
  );

  // --------------------------------------------------------------------------
  // Cenário 4: Inicialização de Super Admin com senha incorreta deve retornar HTTP 403
  // --------------------------------------------------------------------------
  await executeScenario(
    4,
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
  // Cenário 5: Bloqueio estrito de checkout comercial em evento de demonstração (DEMO)
  // --------------------------------------------------------------------------
  await executeScenario(
    5,
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
  // Cenário 6: Rejeição de pedido com itens vazios ou formato inválido
  // --------------------------------------------------------------------------
  await executeScenario(
    6,
    'Validação de integridade de payload no Checkout',
    400,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      event_id: 'evt-valido-123',
      items: [],
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 7: Consulta de status de pedido não existente deve retornar HTTP 404
  // --------------------------------------------------------------------------
  await executeScenario(
    7,
    'Consulta de status de pedido não existente',
    404,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/ord-inexistente-999/status',
      method: 'GET',
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 8: Notificação de Webhook oficial do Mercado Pago
  // --------------------------------------------------------------------------
  await executeScenario(
    8,
    'Confirmação de recebimento do Webhook oficial',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/payments/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      action: 'payment.updated',
      data: { id: 'mp-test-notification-001' },
    }),
    (data) => Boolean(data && data.received)
  );

  // --------------------------------------------------------------------------
  // Cenário 9: Proteção RBAC no endpoint administrativo de expiração de pedidos
  // --------------------------------------------------------------------------
  await executeScenario(
    9,
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
  // Cenário 10: Erro controlado no checkout e ausência total de fallback não atômico
  // --------------------------------------------------------------------------
  await executeScenario(
    10,
    'Erro controlado no checkout (sem fallback inseguro)',
    503,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/orders/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      event_id: '00000000-0000-0000-0000-000000000001',
      items: [{ batch_id: '00000000-0000-0000-0000-000000000002', quantity: 2 }],
      buyer: { name: 'Comprador Teste Integridade', email: 'integridade@px.com' },
    }),
    (data) => Boolean(data && data.error)
  );

  // --------------------------------------------------------------------------
  // Cenário 11: Leitura de QR code com formato oficial emitido ("PX:PX-4M29L8X1:evento")
  // --------------------------------------------------------------------------
  await executeScenario(
    11,
    'Extração e validação de QR Payload completo',
    200,
    () => requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX:PX-4M29L8X1:evt-mega-encontro-2025' }),
    (data) => data && data.valid === true && data.code === 'PX-4M29L8X1'
  );

  // --------------------------------------------------------------------------
  // Cenário 12: Bloqueio de aprovação direta fraudulenta via body no Webhook
  // --------------------------------------------------------------------------
  await executeScenario(
    12,
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
  // Teardown: Limpeza final de estado volátil
  // --------------------------------------------------------------------------
  try {
    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-7AI89C10', reset_demo: true });

    await requester({
      hostname: 'localhost',
      port: 3000,
      path: '/api/tickets/validate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { code: 'PX-4M29L8X1', reset_demo: true });
  } catch {
    // Teardown silencioso
  }

  // --------------------------------------------------------------------------
  // Avaliação Final do Gate
  // --------------------------------------------------------------------------
  const allPassed = failedCount === 0 && passedCount === 12;
  console.log('\n==============================================================================');
  if (allPassed) {
    console.log(`🎉 TODOS OS 12 CENÁRIOS DE RUNTIME DA API PASSARAM COM SUCESSO! (${passedCount}/12)`);
    console.log('==============================================================================\n');
    return {
      status: 'PASSED',
      total: 12,
      passed: passedCount,
      failed: 0,
      results,
    };
  } else {
    console.error(`❌ A SUÍTE DE RUNTIME FALHOU: ${failedCount} de 12 cenários falharam! (Aprovados: ${passedCount}/12)`);
    console.log('==============================================================================\n');
    return {
      status: 'FAILED',
      total: 12,
      passed: passedCount,
      failed: failedCount,
      results,
    };
  }
}

// Execução direta via CLI com tratamento estrito do código de saída do processo
if (process.argv[1] && process.argv[1].endsWith('test-api-runtime.ts')) {
  runRuntimeTests()
    .then((summary) => {
      if (summary.status === 'PASSED') {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('💥 Exceção fatal na execução da suíte de runtime:', err);
      process.exit(1);
    });
}
