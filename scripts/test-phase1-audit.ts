import { validateBatchInput } from '../src/services/batchesService';

async function runAuditTests() {
  console.log('🔍 [AUDITORIA FASE 1] Executando testes automatizados de validação de lotes e regras de integridade...\n');

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`✅ [PASSOU] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FALHOU] ${name} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // 1. Testes de Validação de Lote (batchesService.validateBatchInput)
  const validBatch = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: '1º Lote — Promocional',
    description: 'Acesso completo ao evento',
    price: 45.0,
    total_quantity: 300,
    available_quantity: 300,
    start_date: '2026-10-01T10:00:00Z',
    end_date: '2026-10-31T22:00:00Z',
  });
  assert('Lote válido aceito', validBatch.valid === true);

  // 2. Rejeição de nome muito curto (< 2 caracteres)
  const shortName = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: 'A',
    price: 50.0,
    total_quantity: 100,
  });
  assert('Rejeição de nome com menos de 2 caracteres', shortName.valid === false && Boolean(shortName.error?.includes('2 caracteres')));

  // 3. Rejeição de preço negativo
  const negativePrice = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: 'Lote Teste',
    price: -10.0,
    total_quantity: 100,
  });
  assert('Rejeição de preço unitário negativo', negativePrice.valid === false && Boolean(negativePrice.error?.includes('maior ou igual a zero')));

  // 4. Rejeição de quantidade total zero ou negativa
  const zeroQty = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: 'Lote Teste',
    price: 50.0,
    total_quantity: 0,
  });
  assert('Rejeição de quantidade total zero', zeroQty.valid === false && Boolean(zeroQty.error?.includes('maior que zero')));

  // 5. Rejeição de quantidade disponível superior ao total
  const excessiveAvailable = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: 'Lote Teste',
    price: 50.0,
    total_quantity: 100,
    available_quantity: 150,
  });
  assert('Rejeição de estoque disponível maior que a capacidade total', excessiveAvailable.valid === false && Boolean(excessiveAvailable.error?.includes('não pode ser maior')));

  // 6. Rejeição de período onde data de início é posterior à data de término
  const invalidPeriod = validateBatchInput({
    event_id: '11111111-1111-1111-1111-111111111111',
    name: 'Lote Teste',
    price: 50.0,
    total_quantity: 100,
    start_date: '2026-11-10T10:00:00Z',
    end_date: '2026-11-05T10:00:00Z',
  });
  assert('Rejeição de período de vendas inconsistente (início > término)', invalidPeriod.valid === false && Boolean(invalidPeriod.error?.includes('anterior')));

  // 7. Edição sem campos obrigatórios ausentes (modo isEdit)
  const partialEdit = validateBatchInput({
    price: 60.0,
  }, true);
  assert('Edição parcial de lote aceita', partialEdit.valid === true);

  console.log(`\n📊 Resultado dos Testes de Validação: ${passed} passaram, ${failed} falharam.\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAuditTests().catch((err) => {
  console.error('Falha na execução dos testes de auditoria:', err);
  process.exit(1);
});
