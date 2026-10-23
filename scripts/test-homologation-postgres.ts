/**
 * PX CUSTON — Suíte de Testes Automatizados de Homologação em PostgreSQL Real
 * 
 * Executa testes reais de concorrência, atomicidade, idempotência, integridade
 * financeira e corrida entre confirmação e expiração em banco de dados isolado.
 * 
 * REGRAS DE SEGURANÇA E GATE DE EXECUÇÃO:
 * 1. Exige STAGING_SUPABASE_URL e STAGING_SUPABASE_KEY no ambiente.
 * 2. Rejeita conexões que apontem para a URL do projeto principal de produção.
 * 3. Encerra com código não-zero (exit 2) se o ambiente de homologação não estiver configurado.
 * 4. Encerra com código não-zero (exit 1) se QUALQUER cenário ou asserção falhar.
 * 5. Nunca emite mensagem de sucesso a menos que todos os testes passem com 100% de evidência.
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Identificador do projeto principal de produção para bloqueio estrito de segurança
const KNOWN_PRODUCTION_HOST = 'jivviwvpjxzhbpbmqmxm.supabase.co';

export interface TestResult {
  id: number;
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

export interface HomologationSuiteSummary {
  status: 'PASSED' | 'FAILED' | 'BLOCKED_NO_STAGING';
  total: number;
  passed: number;
  failed: number;
  results: TestResult[];
  reason?: string;
}

/**
 * Validador estrito de segurança do ambiente antes de qualquer tentativa de conexão.
 * Exige confirmação positiva de isolamento (PX_CONFIRM_ISOLATED_STAGING=true) e
 * bloqueia qualquer coincidência com URLs ou chaves de produção.
 */
export function validateStagingEnvironment(): {
  safe: boolean;
  reason?: string;
  stagingUrl?: string;
  stagingKey?: string;
  stagingAnonKey?: string;
} {
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim();
  const stagingKey = process.env.STAGING_SUPABASE_KEY?.trim();
  const stagingAnonKey = process.env.STAGING_SUPABASE_ANON_KEY?.trim();
  const confirmIsolated =
    process.env.PX_CONFIRM_ISOLATED_STAGING?.trim() === 'true' ||
    process.env.STAGING_ENVIRONMENT_CONFIRMED?.trim() === 'true';

  if (!stagingUrl || !stagingKey) {
    return {
      safe: false,
      reason: 'Credenciais de homologação ausentes (STAGING_SUPABASE_URL ou STAGING_SUPABASE_KEY não configuradas).',
    };
  }

  // 1. Rejeitar expressamente o projeto de produção principal ou coincidência com variáveis de produção
  const prodUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').toLowerCase().trim();
  const prodServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const prodAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();

  if (
    stagingUrl.toLowerCase().includes(KNOWN_PRODUCTION_HOST.toLowerCase()) ||
    (prodUrl !== '' && stagingUrl.toLowerCase() === prodUrl) ||
    (prodServiceKey !== '' && stagingKey === prodServiceKey) ||
    (prodAnonKey !== '' && stagingAnonKey === prodAnonKey)
  ) {
    return {
      safe: false,
      reason: `BLOQUEIO DE SEGURANÇA: A URL ou chave de homologação informada aponta para a instância de PRODUÇÃO (${KNOWN_PRODUCTION_HOST}). Acesso rejeitado para proteção dos dados reais.`,
    };
  }

  // 2. Rejeitar placeholders
  if (
    stagingKey.includes('placeholder') ||
    stagingKey.includes('your-staging') ||
    stagingKey.includes('your-supabase') ||
    (stagingAnonKey &&
      (stagingAnonKey.includes('placeholder') ||
        stagingAnonKey.includes('your-staging') ||
        stagingAnonKey.includes('your-supabase')))
  ) {
    return {
      safe: false,
      reason: 'Credenciais de homologação contêm valores placeholder inválidos.',
    };
  }

  // 3. Exigir STAGING_SUPABASE_ANON_KEY real para o Cenário 8 (testes RBAC anon/authenticated)
  if (!stagingAnonKey) {
    return {
      safe: false,
      reason:
        'STAGING_SUPABASE_ANON_KEY ausente. É obrigatório fornecer a chave anônima real do banco de homologação para validar as restrições RBAC de anon e authenticated.',
    };
  }

  // 4. Exigir confirmação positiva explícita de que o projeto alvo é um ambiente isolado de homologação
  if (!confirmIsolated) {
    return {
      safe: false,
      reason:
        'Confirmação positiva de isolamento ausente: defina PX_CONFIRM_ISOLATED_STAGING=true somente após verificar que STAGING_SUPABASE_URL aponta para um banco de homologação dedicado e isolado.',
    };
  }

  return { safe: true, stagingUrl, stagingKey, stagingAnonKey };
}

/**
 * Executa a suíte completa de testes no PostgreSQL de homologação isolado.
 */
export async function runPostgresHomologationTests(
  injectedClient?: SupabaseClient
): Promise<HomologationSuiteSummary> {
  console.log('==============================================================================');
  console.log('🧪 PX CUSTON — SUÍTE DE TESTES EM POSTGRESQL REAL (HOMOLOGAÇÃO ISOLADA)');
  console.log('==============================================================================\n');

  let supabase: SupabaseClient;
  let targetUrl = 'https://mock.supabase.co';
  let targetAnonKey = '';

  if (injectedClient) {
    supabase = injectedClient;
  } else {
    const envCheck = validateStagingEnvironment();
    if (!envCheck.safe) {
      console.warn('⚠️ [GATE DE SEGURANÇA ATIVO]');
      console.warn(`🛑 ${envCheck.reason}`);
      console.warn('\nℹ️ Para executar os testes no PostgreSQL real:');
      console.warn('   1. Provisione um projeto Supabase novo e exclusivo para Homologação.');
      console.warn('   2. Aplique supabase/migrations/combined_migration.sql nesse banco novo.');
      console.warn('   3. Configure STAGING_SUPABASE_URL, STAGING_SUPABASE_KEY, STAGING_SUPABASE_ANON_KEY e PX_CONFIRM_ISOLATED_STAGING=true no .env.');
      console.warn('   4. Execute novamente: npm run test:homolog\n');
      console.log('STATUS FINAL: NÃO TESTADO (Bloqueio seguro por ausência de ambiente isolado).');

      return {
        status: 'BLOCKED_NO_STAGING',
        total: 8,
        passed: 0,
        failed: 0,
        results: [],
        reason: envCheck.reason,
      };
    }

    targetUrl = envCheck.stagingUrl!;
    targetAnonKey = envCheck.stagingAnonKey!;
    supabase = createClient(envCheck.stagingUrl!, envCheck.stagingKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    console.log('🔌 Conexão segura estabelecida com o Supabase de Homologação.');
  }

  const results: TestResult[] = [];
  let passedCount = 0;
  let failedCount = 0;

  const runToken = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const testEventId = crypto.randomUUID();
  const testBatchId = crypto.randomUUID();
  const testUserId = crypto.randomUUID();
  const invalidBatchId = crypto.randomUUID();
  const testEventSlug = `evento-homologacao-concorrente-${runToken}`;
  const testUserEmail = `homologacao.isolada.${runToken}@pxcuston.local`;
  const testUserPassword = `PxHomolog#${runToken}!9Aa`;

  const order1Id = crypto.randomUUID();
  const order2Id = crypto.randomUUID();
  const rollbackOrderId = crypto.randomUUID();
  const idempotentOrderId = crypto.randomUUID();
  const raceOrderId = crypto.randomUUID();
  const inProcessOrderId = crypto.randomUUID();
  const unauthOrderId = crypto.randomUUID();
  const allTestOrderIds = [
    order1Id,
    order2Id,
    rollbackOrderId,
    idempotentOrderId,
    raceOrderId,
    inProcessOrderId,
    unauthOrderId,
  ];

  let createdAuthUserByTest = false;
  let createdProfileByTest = false;
  let createdEventByTest = false;
  let createdBatchByTest = false;

  const insertNewRecord = async (table: string, payload: Record<string, unknown>) => {
    const tableRef = supabase.from(table) as any;
    if (typeof tableRef.insert === 'function') {
      return await tableRef.insert(payload);
    }
    return await tableRef.upsert(payload);
  };

  // --------------------------------------------------------------------------
  // Setup de Dados Descartáveis (Respeitando FKs, colunas NOT NULL e preservação estrita de registros existentes)
  // --------------------------------------------------------------------------
  console.log('📦 Configurando dados descartáveis isolados para testes...');
  try {
    // 0. Verificar existência prévia ANTES de qualquer criação ou disparo de trigger (on_auth_user_created)
    const adminAuth = (supabase as any).auth?.admin;
    if (adminAuth && typeof adminAuth.getUserById === 'function') {
      const existingAuth = await adminAuth.getUserById(testUserId);
      if (existingAuth?.data?.user) {
        throw new Error(
          `ABORTADO POR SEGURANÇA: O usuário de teste (${testUserId}) já existe em auth.users antes da execução.`
        );
      }
    }

    const { data: preExistingProf, error: preProfErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', testUserId)
      .maybeSingle();
    if (preProfErr) {
      throw new Error(`Falha ao verificar pré-existência em public.profiles: ${preProfErr.message}`);
    }
    if (preExistingProf) {
      throw new Error(
        `ABORTADO POR SEGURANÇA: O perfil de teste (${testUserId}) já existe em public.profiles antes da execução.`
      );
    }

    const { data: preExistingEvt, error: preEvtErr } = await supabase
      .from('events')
      .select('id')
      .eq('id', testEventId)
      .maybeSingle();
    if (preEvtErr) {
      throw new Error(`Falha ao verificar pré-existência em public.events: ${preEvtErr.message}`);
    }
    if (preExistingEvt) {
      throw new Error(
        `ABORTADO POR SEGURANÇA: O evento de teste (${testEventId}) já existe em public.events antes da execução.`
      );
    }

    const { data: preExistingBatch, error: preBatchErr } = await supabase
      .from('ticket_batches')
      .select('id')
      .eq('id', testBatchId)
      .maybeSingle();
    if (preBatchErr) {
      throw new Error(`Falha ao verificar pré-existência em public.ticket_batches: ${preBatchErr.message}`);
    }
    if (preExistingBatch) {
      throw new Error(
        `ABORTADO POR SEGURANÇA: O lote de teste (${testBatchId}) já existe em public.ticket_batches antes da execução.`
      );
    }

    // 1. Criar usuário exclusivo em auth.users via Admin API quando disponível (respeita FK profiles.id -> auth.users.id)
    if (adminAuth && typeof adminAuth.createUser === 'function') {
      const { error: authErr } = await adminAuth.createUser({
        id: testUserId,
        email: testUserEmail,
        password: testUserPassword,
        email_confirm: true,
        user_metadata: {
          full_name: 'Usuário Homologação Isolada',
          role: 'USER',
        },
      });
      if (authErr) {
        throw new Error(`Falha ao criar usuário de teste em auth.users: ${authErr.message}`);
      }
      createdAuthUserByTest = true;
    }

    // 2. Garantir perfil em public.profiles com todos os campos NOT NULL (id, email, full_name, role).
    // Se auth.users acabou de ser criado nesta execução, a trigger on_auth_user_created (handle_new_user)
    // pode ter inserido automaticamente a linha correspondente em public.profiles para este novo testUserId.
    const profilePayload = {
      id: testUserId,
      email: testUserEmail,
      full_name: 'Usuário Homologação Isolada',
      role: 'USER',
    };

    if (createdAuthUserByTest) {
      const { data: triggerCreatedProf, error: trigCheckErr } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', testUserId)
        .maybeSingle();
      if (trigCheckErr) {
        throw new Error(`Falha ao verificar perfil criado pela trigger de auth.users: ${trigCheckErr.message}`);
      }

      if (triggerCreatedProf) {
        createdProfileByTest = true;
        const { error: profUpdErr } = await supabase
          .from('profiles')
          .update({
            email: testUserEmail,
            full_name: 'Usuário Homologação Isolada',
            role: 'USER',
          })
          .eq('id', testUserId);
        if (profUpdErr) throw new Error(`Falha ao complementar perfil criado pela trigger: ${profUpdErr.message}`);
      } else {
        const { error: profInsErr } = await insertNewRecord('profiles', profilePayload);
        if (profInsErr) throw new Error(`Falha ao inserir perfil de teste: ${profInsErr.message}`);
        createdProfileByTest = true;
      }
    } else {
      const { error: profInsErr } = await insertNewRecord('profiles', profilePayload);
      if (profInsErr) throw new Error(`Falha ao preparar perfil de teste: ${profInsErr.message}`);
      createdProfileByTest = true;
    }

    // 3. Criar evento comercial de teste exclusivo com todas as colunas NOT NULL do schema inicial
    const { error: evtErr } = await insertNewRecord('events', {
      id: testEventId,
      title: 'Evento Homologação Concorrente',
      slug: testEventSlug,
      subtitle: 'Ambiente Isolado de Homologação Técnica',
      date: new Date(Date.now() + 86400000).toISOString(),
      formatted_date: 'HOMOLOGAÇÃO OFICIAL',
      location: 'Autódromo de Homologação PX',
      city: 'Manhuaçu',
      state: 'MG',
      min_price: 100.0,
      cover_image: 'https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80',
      description: 'Evento técnico descartável exclusivo para bateria de homologação em banco isolado.',
      classification: 'Livre',
      is_official: true,
      is_demo: false,
      status: 'published',
    });
    if (evtErr) throw new Error(`Falha ao preparar evento de teste: ${evtErr.message}`);
    createdEventByTest = true;

    // 4. Criar lote de ingresso de teste exclusivo
    const { error: batchErr } = await insertNewRecord('ticket_batches', {
      id: testBatchId,
      event_id: testEventId,
      name: 'Lote Teste Concorrência',
      price: 100.0,
      total_quantity: 1,
      available_quantity: 1,
      is_active: true,
    });
    if (batchErr) throw new Error(`Falha ao preparar lote de teste: ${batchErr.message}`);
    createdBatchByTest = true;
  } catch (setupError: any) {
    console.error('❌ Falha crítica no setup dos testes de banco:', setupError.message);
    // Limpar parcialmente apenas o que o setup comprovadamente criou nesta execução antes de abortar
    try {
      if (createdBatchByTest) await supabase.from('ticket_batches').delete().eq('id', testBatchId);
      if (createdEventByTest) await supabase.from('events').delete().eq('id', testEventId);
      if (createdProfileByTest) await supabase.from('profiles').delete().eq('id', testUserId);
      const adminAuth = (supabase as any).auth?.admin;
      if (createdAuthUserByTest && adminAuth && typeof adminAuth.deleteUser === 'function') {
        await adminAuth.deleteUser(testUserId);
      }
    } catch {
      // Silenciar erro secundário de rollback parcial de setup para preservar o erro raiz
    }
    return {
      status: 'FAILED',
      total: 8,
      passed: 0,
      failed: 8,
      results: [{ id: 0, name: 'Setup de Dados de Homologação', passed: false, error: setupError.message }],
      reason: `Falha no setup de dados: ${setupError.message}`,
    };
  }

  let cleanupFailed = false;
  let cleanupErrorMessage = '';

  try {
    // --------------------------------------------------------------------------
    // CENÁRIO 1: Concorrência com Estoque Limitado (1 ingresso disputado por 2)
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 1: Concorrência de estoque limitado (2 compras pelo último ingresso) ---');

    try {
      const p1 = supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: order1Id,
      });

      const p2 = supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: order2Id,
      });

      const [res1, res2] = await Promise.all([p1, p2]);

      const s1 = Boolean(res1.data && (res1.data as any).success === true);
      const s2 = Boolean(res2.data && (res2.data as any).success === true);
      const exactlyOneWon = (s1 && !s2) || (!s1 && s2);

      const { data: bData, error: bErr } = await supabase
        .from('ticket_batches')
        .select('available_quantity')
        .eq('id', testBatchId)
        .single();

      if (bErr) throw new Error(`Falha de consulta no estoque do lote: ${bErr.message}`);
      if (bData === null || bData === undefined || typeof bData.available_quantity !== 'number') {
        throw new Error('Retorno nulo ou indefinido para available_quantity');
      }

      const stockZero = bData.available_quantity === 0;
      const test1Passed = exactlyOneWon && stockZero;

      if (test1Passed) {
        passedCount++;
        results.push({ id: 1, name: 'Concorrência com Estoque Limitado', passed: true });
        console.log('✅ CENÁRIO 1 APROVADO: Apenas 1 comprador garantiu o último ingresso e estoque final = 0.');
      } else {
        failedCount++;
        const errDetail = `s1=${s1}, s2=${s2}, stock=${bData.available_quantity}`;
        results.push({ id: 1, name: 'Concorrência com Estoque Limitado', passed: false, error: errDetail });
        console.log(`❌ CENÁRIO 1 FALHOU: ${errDetail}`);
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 1, name: 'Concorrência com Estoque Limitado', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 1 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 2: Rollback Atômico em caso de falha durante o checkout
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 2: Atomicidade de Rollback integral ---');

    try {
      const { error: updErr } = await supabase
        .from('ticket_batches')
        .update({ total_quantity: 5, available_quantity: 5 })
        .eq('id', testBatchId);
      if (updErr) throw new Error(`Falha ao resetar estoque para teste 2: ${updErr.message}`);

      const rollbackRes = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [
          { batch_id: testBatchId, quantity: 2 },
          { batch_id: invalidBatchId, quantity: 1 },
        ],
        p_payment_method: 'pix',
        p_order_id: rollbackOrderId,
      });

      const { data: bRoll, error: bRollErr } = await supabase
        .from('ticket_batches')
        .select('available_quantity')
        .eq('id', testBatchId)
        .single();
      if (bRollErr) throw new Error(`Falha ao consultar estoque pós-rollback: ${bRollErr.message}`);
      if (bRoll === null || bRoll === undefined || typeof bRoll.available_quantity !== 'number') {
        throw new Error('Retorno inválido de estoque no teste de rollback');
      }

      const { data: oRoll, error: oRollErr } = await supabase
        .from('orders')
        .select('id')
        .eq('id', rollbackOrderId)
        .maybeSingle();
      if (oRollErr) throw new Error(`Falha ao consultar pedidos pós-rollback: ${oRollErr.message}`);

      const rpcFailedAsExpected = Boolean(rollbackRes.error);
      const stockUnchanged = bRoll.available_quantity === 5;
      const noOrderPersisted = oRoll === null;

      const test2Passed = rpcFailedAsExpected && stockUnchanged && noOrderPersisted;

      if (test2Passed) {
        passedCount++;
        results.push({ id: 2, name: 'Rollback Atômico', passed: true });
        console.log('✅ CENÁRIO 2 APROVADO: Falha provocou rollback total (estoque preservado em 5 e nenhum pedido gravado).');
      } else {
        failedCount++;
        results.push({ id: 2, name: 'Rollback Atômico', passed: false, error: 'Dados parciais persistidos ou estoque corrompido' });
        console.log('❌ CENÁRIO 2 FALHOU: Estado inconsistente após falha transacional.');
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 2, name: 'Rollback Atômico', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 2 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 3: Idempotência de Pedido com Chave Persistida (Retry Legítimo vs Colisão)
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 3: Idempotência com chave persistida e bloqueio de colisão ---');

    try {
      const firstCall = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: idempotentOrderId,
      });
      if (firstCall.error) throw new Error(`Primeira chamada de checkout falhou: ${firstCall.error.message}`);

      const secondCall = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: idempotentOrderId,
      });
      if (secondCall.error) throw new Error(`Segunda chamada de checkout legítima falhou: ${secondCall.error.message}`);

      // Tentar reutilizar o mesmo p_order_id com quantidade diferente (deve falhar com conflito de idempotência)
      const collisionCall = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 2 }],
        p_payment_method: 'pix',
        p_order_id: idempotentOrderId,
      });

      const { data: bIdem, error: bIdemErr } = await supabase
        .from('ticket_batches')
        .select('available_quantity')
        .eq('id', testBatchId)
        .single();
      if (bIdemErr) throw new Error(`Falha ao consultar lote pós-idempotência: ${bIdemErr.message}`);
      if (bIdem === null || bIdem === undefined || typeof bIdem.available_quantity !== 'number') {
        throw new Error('Retorno inválido de estoque no teste de idempotência');
      }

      const firstOk = Boolean((firstCall.data as any)?.success === true);
      const secondOk = Boolean((secondCall.data as any)?.already_processed === true);
      const collisionRejected = Boolean(collisionCall.error);
      const stockExact = bIdem.available_quantity === 4;

      const test3Passed = firstOk && secondOk && collisionRejected && stockExact;

      if (test3Passed) {
        passedCount++;
        results.push({ id: 3, name: 'Idempotência de Pedidos', passed: true });
        console.log('✅ CENÁRIO 3 APROVADO: Retry idêntico retornou already_processed, divergência de itens foi bloqueada e estoque = 4.');
      } else {
        failedCount++;
        results.push({
          id: 3,
          name: 'Idempotência de Pedidos',
          passed: false,
          error: 'Chave de idempotência permitiu duplicação ou não rejeitou payload divergente',
        });
        console.log('❌ CENÁRIO 3 FALHOU: Falha na validação de idempotência estrita.');
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 3, name: 'Idempotência de Pedidos', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 3 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 4: Cancelamento Duplo Concorrente (Devolução Única)
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 4: Cancelamento duplo concorrente ---');
    try {
      const c1 = supabase.rpc('cancel_order_and_release_stock', { p_order_id: idempotentOrderId });
      const c2 = supabase.rpc('cancel_order_and_release_stock', { p_order_id: idempotentOrderId });

      const [c1Res, c2Res] = await Promise.all([c1, c2]);

      const { data: bCancel, error: bCancelErr } = await supabase
        .from('ticket_batches')
        .select('available_quantity')
        .eq('id', testBatchId)
        .single();
      if (bCancelErr) throw new Error(`Falha ao consultar estoque pós-cancelamento: ${bCancelErr.message}`);
      if (bCancel === null || bCancel === undefined || typeof bCancel.available_quantity !== 'number') {
        throw new Error('Retorno inválido de estoque no teste de cancelamento duplo');
      }

      const c1Success = Boolean((c1Res.data as any)?.success === true);
      const c2Success = Boolean((c2Res.data as any)?.success === true);
      const stockExact = bCancel.available_quantity === 5;

      const test4Passed = c1Success && c2Success && stockExact;

      if (test4Passed) {
        passedCount++;
        results.push({ id: 4, name: 'Cancelamento Duplo Concorrente', passed: true });
        console.log('✅ CENÁRIO 4 APROVADO: Estoque devolvido exatamente uma vez (estoque retornou a 5).');
      } else {
        failedCount++;
        results.push({
          id: 4,
          name: 'Cancelamento Duplo Concorrente',
          passed: false,
          error: `Estoque final incorreto: ${bCancel.available_quantity}`,
        });
        console.log(`❌ CENÁRIO 4 FALHOU: Estoque final: ${bCancel.available_quantity} (esperado: 5)`);
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 4, name: 'Cancelamento Duplo Concorrente', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 4 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 5: Corrida entre Confirmação e Expiração
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 5: Corrida entre Confirmação e Expiração/Cancelamento ---');
    try {
      const checkRes = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: raceOrderId,
      });
      if (checkRes.error) throw new Error(`Falha no checkout de preparação da corrida: ${checkRes.error.message}`);

      // 1. Confirmar pagamento
      const confirmRes = await supabase.rpc('confirm_order_and_issue_tickets', {
        p_order_id: raceOrderId,
        p_mercado_pago_id: 'mp-test-race-001',
      });
      if (confirmRes.error) throw new Error(`Falha na confirmação do pedido: ${confirmRes.error.message}`);

      // 2. Tentar cancelar pedido já aprovado (deve ser rejeitado pelo banco)
      const cancelRes = await supabase.rpc('cancel_order_and_release_stock', { p_order_id: raceOrderId });

      const confirmedOk = (confirmRes.data as any)?.status === 'approved';
      const cancelBlocked = Boolean(cancelRes.error) || (cancelRes.data as any)?.success === false;

      // 3. Confirmar que no banco o status permanece approved e estoque intacto em 4
      const { data: oRace, error: oRaceErr } = await supabase
        .from('orders')
        .select('payment_status')
        .eq('id', raceOrderId)
        .single();
      if (oRaceErr) throw new Error(`Falha ao consultar pedido no banco: ${oRaceErr.message}`);
      if (!oRace || typeof oRace.payment_status !== 'string') throw new Error('Pedido não retornado no banco');

      const { data: bRace, error: bRaceErr } = await supabase
        .from('ticket_batches')
        .select('available_quantity')
        .eq('id', testBatchId)
        .single();
      if (bRaceErr) throw new Error(`Falha ao consultar estoque pós-corrida: ${bRaceErr.message}`);
      if (bRace === null || bRace === undefined || typeof bRace.available_quantity !== 'number') {
        throw new Error('Estoque não retornado');
      }

      const test5Passed = confirmedOk && cancelBlocked && oRace.payment_status === 'approved' && bRace.available_quantity === 4;

      if (test5Passed) {
        passedCount++;
        results.push({ id: 5, name: 'Corrida Confirmação vs Cancelamento', passed: true });
        console.log('✅ CENÁRIO 5 APROVADO: Pedido aprovado bloqueou estritamente o cancelamento e liberação de estoque.');
      } else {
        failedCount++;
        results.push({
          id: 5,
          name: 'Corrida Confirmação vs Cancelamento',
          passed: false,
          error: 'Cancelamento permitiu estornar pedido aprovado',
        });
        console.log('❌ CENÁRIO 5 FALHOU: Pedido aprovado teve seu estoque cancelado indevidamente.');
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 5, name: 'Corrida Confirmação vs Cancelamento', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 5 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 6: Repetição de Confirmação não Duplica Ingressos (usando coluna real tickets.code)
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 6: Confirmação Repetida sem Duplicação de Ingressos ---');
    try {
      const secondConfirm = await supabase.rpc('confirm_order_and_issue_tickets', {
        p_order_id: raceOrderId,
        p_mercado_pago_id: 'mp-test-race-001',
      });
      if (secondConfirm.error) throw new Error(`Segunda confirmação falhou com erro: ${secondConfirm.error.message}`);

      const { data: tickets, error: ticketsErr } = await supabase
        .from('tickets')
        .select('id, code, status')
        .eq('order_id', raceOrderId);
      if (ticketsErr) throw new Error(`Falha ao consultar ingressos: ${ticketsErr.message}`);
      if (!Array.isArray(tickets)) throw new Error('Retorno de ingressos não é um array válido');

      const alreadyApprovedOk = Boolean((secondConfirm.data as any)?.already_approved === true);
      const exactlyOneTicket =
        tickets.length === 1 && typeof tickets[0].id === 'string' && typeof tickets[0].code === 'string';

      const test6Passed = alreadyApprovedOk && exactlyOneTicket;

      if (test6Passed) {
        passedCount++;
        results.push({ id: 6, name: 'Anti-Duplicação de Ingressos', passed: true });
        console.log('✅ CENÁRIO 6 APROVADO: Segunda confirmação retornou already_approved e manteve exatamente 1 ingresso.');
      } else {
        failedCount++;
        results.push({
          id: 6,
          name: 'Anti-Duplicação de Ingressos',
          passed: false,
          error: `Ingressos encontrados: ${tickets.length}`,
        });
        console.log(`❌ CENÁRIO 6 FALHOU: Total de ingressos emitidos: ${tickets.length} (esperado: 1).`);
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 6, name: 'Anti-Duplicação de Ingressos', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 6 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 7: Proteção de Pedidos em Análise (in_process / refunded) em Escopo Controlado
    // Limitação documentada: A função public.expire_pending_orders(p_timeout_minutes INT)
    // opera globalmente sobre public.orders WHERE payment_status = 'pending' e não aceita
    // filtro por order_id/event_id. Por segurança, NÃO executamos expire_pending_orders
    // globalmente por padrão para jamais cancelar pedidos pendentes alheios.
    // O teste opera exclusivamente sobre o ID de teste controlado (inProcessOrderId) via
    // cancel_order_and_release_stock(inProcessOrderId, 'expired_timeout') — que é a função
    // invocada internamente por expire_pending_orders — e só executa expire_pending_orders(15)
    // se PX_ALLOW_GLOBAL_EXPIRE_TEST=true (banco 100% descartável sem pedidos pendentes externos).
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 7: Proteção de pedidos em análise (in_process) sobre dados controlados ---');
    try {
      const checkInProc = await supabase.rpc('process_order_checkout', {
        p_event_id: testEventId,
        p_user_id: testUserId,
        p_items: [{ batch_id: testBatchId, quantity: 1 }],
        p_payment_method: 'pix',
        p_order_id: inProcessOrderId,
      });
      if (checkInProc.error) throw new Error(`Falha no checkout do pedido in_process: ${checkInProc.error.message}`);

      // Colocar exclusivamente o pedido controlado em status in_process com created_at retroativo (30 min atrás)
      const backdatedCreatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { error: updProcErr } = await supabase
        .from('orders')
        .update({ payment_status: 'in_process', created_at: backdatedCreatedAt })
        .eq('id', inProcessOrderId);
      if (updProcErr) throw new Error(`Falha ao atualizar pedido para in_process: ${updProcErr.message}`);

      // 1. Tentar cancelar diretamente o pedido in_process via cancel_order_and_release_stock (escopo 100% restrito ao ID de teste)
      const directCancelInProc = await supabase.rpc('cancel_order_and_release_stock', {
        p_order_id: inProcessOrderId,
        p_reason: 'expired_timeout',
      });
      const directCancelRefused =
        Boolean(directCancelInProc.error) || (directCancelInProc.data as any)?.success === false;

      // 2. Opcionalmente (apenas em banco descartável vazio com PX_ALLOW_GLOBAL_EXPIRE_TEST=true),
      // validar também a chamada de varredura expire_pending_orders(15) sem nunca usar timeout = 0.
      if (process.env.PX_ALLOW_GLOBAL_EXPIRE_TEST?.trim() === 'true') {
        const expRes = await supabase.rpc('expire_pending_orders', { p_timeout_minutes: 15 });
        if (expRes.error) throw new Error(`Falha ao executar expire_pending_orders(15): ${expRes.error.message}`);
      } else {
        console.log(
          'ℹ️ [Cenário 7] Varredura global expire_pending_orders omitida por padrão para não afetar pedidos fora do escopo de teste (defina PX_ALLOW_GLOBAL_EXPIRE_TEST=true apenas em banco descartável vazio).'
        );
      }

      const { data: oInProc, error: oInProcErr } = await supabase
        .from('orders')
        .select('payment_status')
        .eq('id', inProcessOrderId)
        .single();
      if (oInProcErr) throw new Error(`Falha ao consultar pedido in_process: ${oInProcErr.message}`);
      if (!oInProc || typeof oInProc.payment_status !== 'string') throw new Error('Status do pedido não retornado');

      const test7Passed = directCancelRefused && oInProc.payment_status === 'in_process';

      if (test7Passed) {
        passedCount++;
        results.push({ id: 7, name: 'Filtro de Expiração (in_process)', passed: true });
        console.log('✅ CENÁRIO 7 APROVADO: Pedido in_process recusou cancelamento/expiração sobre o ID controlado e manteve estoque seguro.');
      } else {
        failedCount++;
        results.push({
          id: 7,
          name: 'Filtro de Expiração (in_process)',
          passed: false,
          error: `Status final: ${oInProc.payment_status}, directCancelRefused=${directCancelRefused}`,
        });
        console.log('❌ CENÁRIO 7 FALHOU: Pedido in_process foi cancelado indevidamente.');
      }
    } catch (err: any) {
      failedCount++;
      results.push({ id: 7, name: 'Filtro de Expiração (in_process)', passed: false, error: err.message });
      console.log(`❌ CENÁRIO 7 FALHOU COM EXCEÇÃO: ${err.message}`);
    }

    // --------------------------------------------------------------------------
    // CENÁRIO 8: Proteção RBAC contra Acesso Anônimo (anon) e Autenticado Comum (authenticated)
    // Testa por sonda RPC sem efeitos colaterais as 4 RPCs transacionais parametrizadas:
    // - process_order_checkout
    // - cancel_order_and_release_stock
    // - confirm_order_and_issue_tickets
    // - claim_order_confirmation_email
    // Nota de segurança: expire_pending_orders NÃO é invocada diretamente por sonda RPC
    // porque possui janelas de corte fixas para cartão/boleto no corpo SQL e poderia
    // alterar pedidos globais do banco caso REVOKE ainda não estivesse aplicado.
    // Sua proteção REVOKE/GRANT é validada estaticamente em test-audit-security.ts.
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 8: Restrição de Execução RBAC (REVOKE FROM anon e authenticated) ---');
    try {
      const invokeProtectedRpcsWithoutSideEffects = async (client: SupabaseClient) => {
        const calls = await Promise.all([
          // p_items vazio garante que, mesmo se REVOKE não estivesse aplicado, a função abortaria
          // na 1ª linha de validação sem ler nem gravar nenhuma tabela. Se REVOKE estiver aplicado,
          // o PostgREST bloqueia antes da validação de negócio.
          client.rpc('process_order_checkout', {
            p_event_id: invalidBatchId,
            p_user_id: testUserId,
            p_items: [],
            p_payment_method: 'pix',
            p_order_id: unauthOrderId,
          }),
          // unauthOrderId não existe no banco: mesmo sem REVOKE, retorna JSON ORDER_NOT_FOUND (error: null)
          // sem modificar nenhuma linha. Com REVOKE aplicado, retorna erro de permissão (error != null, data == null).
          client.rpc('cancel_order_and_release_stock', {
            p_order_id: unauthOrderId,
            p_reason: 'unauthorized_attempt',
          }),
          client.rpc('confirm_order_and_issue_tickets', {
            p_order_id: unauthOrderId,
            p_mercado_pago_id: 'mp-unauth-attempt',
          }),
          // p_recipient_email vazio: mesmo sem REVOKE, retorna JSON { claimed: false, reason: 'missing_recipient_email' }
          // (error: null) sem tocar em orders. Com REVOKE aplicado, retorna erro de permissão (error != null, data == null).
          client.rpc('claim_order_confirmation_email', {
            p_order_id: unauthOrderId,
            p_recipient_email: '',
            p_notification_type: 'order_confirmation',
          }),
        ]);

        const rpcNames = [
          'process_order_checkout',
          'cancel_order_and_release_stock',
          'confirm_order_and_issue_tickets',
          'claim_order_confirmation_email',
        ];

        const blockedFlags = calls.map((res, idx) => {
          if (!res.error || res.data) return false;
          // Em process_order_checkout, se a mensagem for a validação interna de itens vazios,
          // significa que a função executou sem bloqueio de permissão RBAC.
          if (
            idx === 0 &&
            String(res.error.message || '').includes('O pedido deve conter pelo menos um item')
          ) {
            return false;
          }
          return true;
        });

        const failedNames = rpcNames.filter((_, idx) => !blockedFlags[idx]);
        return {
          allBlocked: blockedFlags.every(Boolean),
          failedNames,
        };
      };

      const expireNotice =
        'expire_pending_orders: NÃO EXECUTADA VIA SONDA RPC DIRETA (evita efeito colateral global caso REVOKE esteja ausente; validada estaticamente em test-audit-security.ts)';

      // 8.1 Testar papel 'anon' usando STAGING_SUPABASE_ANON_KEY real (ou injectedClient em testes unitários de gate)
      const anonClient = injectedClient
        ? injectedClient
        : createClient(targetUrl, targetAnonKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          });

      const anonCheck = await invokeProtectedRpcsWithoutSideEffects(anonClient);

      // 8.2 Testar papel 'authenticated' (usuário comum USER autenticado no banco de homologação)
      let authenticatedAllBlocked = false;
      let authenticatedDetail = '';

      if (injectedClient) {
        const authMockCheck = await invokeProtectedRpcsWithoutSideEffects(injectedClient);
        authenticatedAllBlocked = authMockCheck.allBlocked;
        authenticatedDetail = authMockCheck.allBlocked
          ? 'authenticated(mock): 4/4 sondas RPC bloqueadas'
          : `authenticated(mock) falhou em: ${authMockCheck.failedNames.join(', ')}`;
      } else {
        const userAuthClient = createClient(targetUrl, targetAnonKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const signInRes = await userAuthClient.auth.signInWithPassword({
          email: testUserEmail,
          password: testUserPassword,
        });

        if (signInRes.error || !signInRes.data?.session) {
          throw new Error(
            `Não foi possível autenticar o usuário de teste temporário para validar o papel authenticated: ${signInRes.error?.message || 'Sessão ausente'}`
          );
        }

        const authCheck = await invokeProtectedRpcsWithoutSideEffects(userAuthClient);
        authenticatedAllBlocked = authCheck.allBlocked;
        authenticatedDetail = authCheck.allBlocked
          ? 'authenticated(USER): 4/4 sondas RPC bloqueadas'
          : `authenticated(USER) permitiu indevidamente: ${authCheck.failedNames.join(', ')}`;

        await userAuthClient.auth.signOut();
      }

      const anonDetail = anonCheck.allBlocked
        ? 'anon: 4/4 sondas RPC bloqueadas'
        : `anon permitiu indevidamente: ${anonCheck.failedNames.join(', ')}`;

      const rbacPassed = anonCheck.allBlocked && authenticatedAllBlocked;

      if (rbacPassed) {
        passedCount++;
        results.push({
          id: 8,
          name: 'Restrição RBAC de Funções (anon + authenticated)',
          passed: true,
          details: `${anonDetail} | ${authenticatedDetail} | ${expireNotice}`,
        });
        console.log(`✅ CENÁRIO 8 APROVADO: ${anonDetail} | ${authenticatedDetail} | ${expireNotice}.`);
      } else {
        failedCount++;
        const errSummary = `${anonDetail} | ${authenticatedDetail} | ${expireNotice}`;
        results.push({
          id: 8,
          name: 'Restrição RBAC de Funções (anon + authenticated)',
          passed: false,
          error: errSummary,
        });
        console.log(`❌ CENÁRIO 8 FALHOU: ${errSummary}`);
      }
    } catch (err: any) {
      failedCount++;
      results.push({
        id: 8,
        name: 'Restrição RBAC de Funções (anon + authenticated)',
        passed: false,
        error: err.message,
      });
      console.log(`❌ CENÁRIO 8 FALHOU COM EXCEÇÃO: ${err.message}`);
    }
  } finally {
    // --------------------------------------------------------------------------
    // Limpeza Garantida de Dados Descartáveis (Executada em finally usando apenas IDs exclusivos)
    // --------------------------------------------------------------------------
    console.log('\n🧹 Limpando dados descartáveis de homologação (bloco finally)...');
    try {
      const { error: tErr } = await supabase.from('tickets').delete().in('order_id', allTestOrderIds);
      if (tErr) throw new Error(`Falha ao limpar tickets: ${tErr.message}`);

      const { error: oiErr } = await supabase.from('order_items').delete().in('order_id', allTestOrderIds);
      if (oiErr) throw new Error(`Falha ao limpar order_items: ${oiErr.message}`);

      const { error: oErr } = await supabase.from('orders').delete().in('id', allTestOrderIds);
      if (oErr) throw new Error(`Falha ao limpar orders: ${oErr.message}`);

      if (createdBatchByTest) {
        const { error: bErr } = await supabase.from('ticket_batches').delete().eq('id', testBatchId);
        if (bErr) throw new Error(`Falha ao limpar ticket_batches: ${bErr.message}`);
      }

      if (createdEventByTest) {
        const { error: eErr } = await supabase.from('events').delete().eq('id', testEventId);
        if (eErr) throw new Error(`Falha ao limpar events: ${eErr.message}`);
      }

      if (createdProfileByTest) {
        const { error: pErr } = await supabase.from('profiles').delete().eq('id', testUserId);
        if (pErr) throw new Error(`Falha ao limpar profiles: ${pErr.message}`);
      }

      const adminAuth = (supabase as any).auth?.admin;
      if (createdAuthUserByTest && adminAuth && typeof adminAuth.deleteUser === 'function') {
        const { error: delAuthErr } = await adminAuth.deleteUser(testUserId);
        if (delAuthErr) throw new Error(`Falha ao remover usuário temporário em auth.users: ${delAuthErr.message}`);
      }
    } catch (cleanupErr: any) {
      cleanupFailed = true;
      cleanupErrorMessage = cleanupErr.message;
      console.error('❌ Falha na limpeza final de dados:', cleanupErrorMessage);
      results.push({
        id: 9,
        name: 'Limpeza de Dados Descartáveis',
        passed: false,
        error: cleanupErrorMessage,
      });
      failedCount++;
    }
  }

  // --------------------------------------------------------------------------
  // Resultado Final e Asserção do Gate
  // --------------------------------------------------------------------------
  const expectedTotal = cleanupFailed ? 9 : 8;
  const allPassed = failedCount === 0 && passedCount === 8 && !cleanupFailed;
  console.log('\n==============================================================================');
  if (allPassed) {
    console.log(`🎉 TODOS OS 8 TESTES EM POSTGRESQL REAL FORAM CONCLUÍDOS COM SUCESSO! (${passedCount}/8)`);
    console.log('==============================================================================\n');
    return {
      status: 'PASSED',
      total: 8,
      passed: passedCount,
      failed: 0,
      results,
    };
  } else {
    console.error(`❌ A SUÍTE DE TESTES FALHOU: ${failedCount} falha(s) detectada(s)! (Passaram: ${passedCount}/${expectedTotal})`);
    console.log('==============================================================================\n');
    return {
      status: 'FAILED',
      total: expectedTotal,
      passed: passedCount,
      failed: failedCount,
      results,
      reason: cleanupFailed ? `Falhas de teste ou limpeza detectadas: ${cleanupErrorMessage}` : undefined,
    };
  }
}

// Execução direta via CLI com tratamento rigoroso do código de saída do processo
if (process.argv[1] && process.argv[1].endsWith('test-homologation-postgres.ts')) {
  runPostgresHomologationTests()
    .then((summary) => {
      if (summary.status === 'PASSED') {
        process.exit(0);
      } else if (summary.status === 'BLOCKED_NO_STAGING') {
        // Código de saída 2: Bloqueio seguro por ausência de ambiente (não é aprovação nem erro de código)
        process.exit(2);
      } else {
        // Código de saída 1: Falha real de teste
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('💥 Exceção fatal na execução da suíte:', err);
      process.exit(1);
    });
}
