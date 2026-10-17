/**
 * PX CUSTON — Testes Locais de Confiabilidade do Gate de Homologação
 * 
 * Verifica que:
 * 1. A ausência de credenciais de homologação resulta em 'BLOCKED_NO_STAGING' (código 2) e NUNCA em sucesso.
 * 2. Tentativa de usar a URL de produção (jivviwvpjxzhbpbmqmxm) é bloqueada imediatamente.
 * 3. Falhas simuladas em consultas ou RPCs resultam estritamente em 'FAILED' e NUNCA exibem mensagem de sucesso.
 */

import { validateStagingEnvironment, runPostgresHomologationTests } from './test-homologation-postgres';

async function runGateValidationTests() {
  console.log('==============================================================================');
  console.log('🛡️ PX CUSTON — TESTES LOCAIS DE CONFIABILIDADE DO GATE DE HOMOLOGAÇÃO');
  console.log('==============================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  // --------------------------------------------------------------------------
  // TESTE 1: Ausência de credenciais deve bloquear e NUNCA aprovar
  // --------------------------------------------------------------------------
  totalTests++;
  const originalUrl = process.env.STAGING_SUPABASE_URL;
  const originalKey = process.env.STAGING_SUPABASE_KEY;

  delete process.env.STAGING_SUPABASE_URL;
  delete process.env.STAGING_SUPABASE_KEY;

  const noEnvCheck = validateStagingEnvironment();
  const summaryNoEnv = await runPostgresHomologationTests();

  const test1Ok = !noEnvCheck.safe && summaryNoEnv.status === 'BLOCKED_NO_STAGING' && summaryNoEnv.passed === 0;

  console.log(`Gate Teste 1 (Bloqueio sem credenciais): ${test1Ok ? '✅ APROVADO (status: BLOCKED_NO_STAGING, 0 testes aprovados)' : '❌ FALHOU'}`);
  if (test1Ok) passedTests++;

  // --------------------------------------------------------------------------
  // TESTE 2: Tentativa de apontar para o projeto de PRODUÇÃO deve ser rejeitada
  // --------------------------------------------------------------------------
  totalTests++;
  process.env.STAGING_SUPABASE_URL = 'https://jivviwvpjxzhbpbmqmxm.supabase.co';
  process.env.STAGING_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_key';

  const prodEnvCheck = validateStagingEnvironment();
  const test2Ok = !prodEnvCheck.safe && (prodEnvCheck.reason || '').includes('PRODUÇÃO');

  console.log(`Gate Teste 2 (Bloqueio de URL de produção): ${test2Ok ? '✅ APROVADO (Rejeitado com bloqueio explícito de segurança)' : '❌ FALHOU'}`);
  if (test2Ok) passedTests++;

  // --------------------------------------------------------------------------
  // TESTE 3: Injeção de Falha Simulada deve resultar em 'FAILED' e NUNCA em 'PASSED'
  // --------------------------------------------------------------------------
  totalTests++;
  // Criar cliente simulado que falha nas chamadas RPC
  const mockFailingClient: any = {
    from: () => ({
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { available_quantity: 99 }, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      delete: () => ({
        in: async () => ({ error: null }),
        eq: async () => ({ error: null }),
      }),
    }),
    rpc: async (name: string) => {
      // Simula falha em process_order_checkout (ex: PostgREST schema cache miss ou erro de banco)
      return { data: null, error: { message: `Simulated failure in ${name}` } };
    },
  };

  const summaryFailing = await runPostgresHomologationTests(mockFailingClient);
  const test3Ok = summaryFailing.status === 'FAILED' && summaryFailing.failed > 0 && (summaryFailing as any).status !== 'PASSED';

  console.log(`Gate Teste 3 (Injeção de falha simulada): ${test3Ok ? '✅ APROVADO (Suíte encerrou com status FAILED, nenhuma aprovação indevida)' : '❌ FALHOU'}`);
  if (test3Ok) passedTests++;

  // --------------------------------------------------------------------------
  // TESTE 4: Injeção de Falha Simulada no Setup de Dados (deve falhar imediatamente)
  // --------------------------------------------------------------------------
  totalTests++;
  const mockSetupFailingClient: any = {
    from: () => ({
      upsert: async () => ({ error: { message: 'Simulated connection failure during profile/event setup' } }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      delete: () => ({
        in: async () => ({ error: null }),
        eq: async () => ({ error: null }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  };

  const summarySetupFail = await runPostgresHomologationTests(mockSetupFailingClient);
  const test4Ok = summarySetupFail.status === 'FAILED' && summarySetupFail.passed === 0 && (summarySetupFail.results[0]?.name || '').includes('Setup');

  console.log(`Gate Teste 4 (Falha simulada no setup de dados): ${test4Ok ? '✅ APROVADO (Abortou com status FAILED, 0 aprovados, falha explícita no setup)' : '❌ FALHOU'}`);
  if (test4Ok) passedTests++;

  // --------------------------------------------------------------------------
  // TESTE 5: Falha na Limpeza Final (deve ser contabilizada e não ocultar falha de teste)
  // --------------------------------------------------------------------------
  totalTests++;
  const mockCleanupFailingClient: any = {
    from: (table: string) => ({
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { available_quantity: 99 }, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      delete: () => ({
        in: async () => ({ error: { message: `Simulated deletion failure in table ${table}` } }),
        eq: async () => ({ error: { message: `Simulated deletion failure in table ${table}` } }),
      }),
    }),
    rpc: async (name: string) => ({ data: null, error: { message: `Simulated RPC failure in ${name}` } }),
  };

  const summaryCleanupFail = await runPostgresHomologationTests(mockCleanupFailingClient);
  const cleanupRecorded = summaryCleanupFail.results.some((r) => r.name.includes('Limpeza') && !r.passed);
  const test5Ok = summaryCleanupFail.status === 'FAILED' && cleanupRecorded;

  console.log(`Gate Teste 5 (Falha simulada na limpeza final): ${test5Ok ? '✅ APROVADO (Falha de limpeza registrada explicitamente sem ocultar erros)' : '❌ FALHOU'}`);
  if (test5Ok) passedTests++;

  // Restaurar ambiente original
  if (originalUrl) process.env.STAGING_SUPABASE_URL = originalUrl;
  if (originalKey) process.env.STAGING_SUPABASE_KEY = originalKey;

  console.log('\n==============================================================================');
  console.log(`RESULTADO DOS TESTES DE GATE: ${passedTests}/${totalTests} APROVADOS`);
  console.log('==============================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('test-gate-validation.ts')) {
  runGateValidationTests().catch((err) => {
    console.error('Falha crítica nos testes de gate:', err);
    process.exit(1);
  });
}
