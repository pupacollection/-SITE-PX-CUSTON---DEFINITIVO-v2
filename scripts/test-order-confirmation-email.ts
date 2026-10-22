/**
 * PX CUSTON — Suíte de Testes de Confirmação de Compra por E-mail (Idempotência, SMTP e Resiliência)
 *
 * Valida:
 * 1. Pagamento aprovado + ingressos emitidos -> envia 1 e-mail com códigos PX-XXXXXXXX, dados do evento e comprador.
 * 2. Webhook repetido para pedido já aprovado -> idempotência impede envio duplicado (already_sent = true).
 * 3. Falha de SMTP -> NÃO desfaz pagamento aprovado ('approved'), NÃO invalida ingressos ('paid'),
 *    registra estado 'failed' e sanitiza segredos/senhas dos logs e retornos ([REDACTED]).
 * 4. Retentativa automática em webhook subsequente após falha de SMTP -> reenvia com sucesso ('sent')
 *    e bloqueia envios posteriores por idempotência.
 * 5. Pedido ainda pendente/cancelado ou sem ingressos emitidos -> bloqueia envio prematuro ('skipped_not_ready').
 */

import {
  sendOrderConfirmationEmailIfNeeded,
  resetOrderEmailMemoryStateForTests,
  sanitizeSmtpError,
  resolveSmtpConfig,
} from '../src/lib/orderConfirmationMailer';

function createMockOrderSupabase(params: {
  orderId: string;
  paymentStatus: 'pending' | 'approved' | 'cancelled';
  tickets: Array<{
    id: string;
    code: string;
    batch_id: string;
    holder_name: string;
    price: number;
    status: string;
    qr_payload: string;
  }>;
  buyerEmail?: string;
  buyerName?: string;
  disableNotificationsTable?: boolean;
}) {
  const notificationsDb = new Map<
    string,
    {
      id: string;
      order_id: string;
      notification_type: string;
      recipient_email: string;
      status: 'pending' | 'sending' | 'sent' | 'failed';
      attempts: number;
      message_id?: string | null;
      last_error?: string | null;
      sent_at?: string | null;
      updated_at: string;
    }
  >();

  const auditLogs: Array<{
    id: string;
    actor_id: string | null;
    action: string;
    entity: string;
    entity_id: string;
    details: any;
    created_at: string;
  }> = [];

  const orderState = {
    id: params.orderId,
    user_id: 'aaaa1111-2222-4333-8444-555566667777',
    event_id: 'bbbb1111-2222-4333-8444-555566667777',
    total: 138.0,
    payment_method: 'pix',
    payment_status: params.paymentStatus,
    created_at: new Date().toISOString(),
  };

  let logSeq = 1;

  const client = {
    orderState,
    ticketsState: params.tickets,
    notificationsDb,
    auditLogs,
    rpc: async (fnName: string, args: any) => {
      if (params.disableNotificationsTable) {
        return { data: null, error: { message: 'function public.claim_order_confirmation_email does not exist' } };
      }
      if (fnName === 'claim_order_confirmation_email') {
        const key = `${args.p_order_id}:${args.p_notification_type || 'order_confirmation'}`;
        const existing = notificationsDb.get(key);
        if (existing?.status === 'sent') {
          return {
            data: {
              claimed: false,
              already_sent: true,
              status: 'sent',
              sent_at: existing.sent_at,
              attempts: existing.attempts,
              message_id: existing.message_id,
            },
            error: null,
          };
        }
        if (
          existing?.status === 'sending' &&
          Date.now() - new Date(existing.updated_at).getTime() < 120_000
        ) {
          return {
            data: {
              claimed: false,
              already_sent: false,
              in_progress: true,
              status: 'sending',
              attempts: existing.attempts,
            },
            error: null,
          };
        }
        const nextAttempts = (existing?.attempts || 0) + 1;
        const record = {
          id: existing?.id || 'notif-uuid-1',
          order_id: args.p_order_id,
          notification_type: args.p_notification_type || 'order_confirmation',
          recipient_email: args.p_recipient_email,
          status: 'sending' as const,
          attempts: nextAttempts,
          message_id: existing?.message_id || null,
          last_error: existing?.last_error || null,
          sent_at: existing?.sent_at || null,
          updated_at: new Date().toISOString(),
        };
        notificationsDb.set(key, record);
        return {
          data: {
            claimed: true,
            already_sent: false,
            notification_id: record.id,
            status: 'sending',
            attempts: nextAttempts,
          },
          error: null,
        };
      }
      return { data: null, error: { message: 'RPC desconhecida' } };
    },
    from: (table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ...orderState }, error: null }),
            }),
          }),
        };
      }
      if (table === 'tickets') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: params.tickets.filter((t) => t.status === 'paid' || t.status === 'used'),
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'ticket_batches') {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { id: 'batch-pista-1', name: 'Lote Pista Oficial' },
                { id: 'batch-vip-1', name: 'Camarote VIP PX' },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: orderState.user_id,
                  email: params.buyerEmail ?? 'comprador.oficial@pxcuston.com.br',
                  full_name: params.buyerName ?? 'Piloto Oficial PX',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'events') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  title: 'ENCONTRO NACIONAL PX CUSTON 2026',
                  formatted_date: '22 OUT 2026',
                  location: 'Autódromo Internacional',
                  city: 'Manhuaçu',
                  state: 'MG',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'order_email_notifications') {
        if (params.disableNotificationsTable) {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: null,
                    error: { message: 'relation "public.order_email_notifications" does not exist' },
                  }),
                }),
              }),
            }),
            upsert: async () => ({
              error: { message: 'relation "public.order_email_notifications" does not exist' },
            }),
          };
        }
        return {
          select: () => ({
            eq: (col1: string, val1: any) => ({
              eq: (col2: string, val2: any) => ({
                maybeSingle: async () => {
                  const key = `${val1}:${val2}`;
                  return { data: notificationsDb.get(key) || null, error: null };
                },
              }),
            }),
          }),
          upsert: async (payload: any) => {
            const key = `${payload.order_id}:${payload.notification_type || 'order_confirmation'}`;
            const prev = notificationsDb.get(key);
            notificationsDb.set(key, {
              id: prev?.id || 'notif-uuid-1',
              order_id: payload.order_id,
              notification_type: payload.notification_type || 'order_confirmation',
              recipient_email: payload.recipient_email,
              status: payload.status,
              attempts: payload.attempts,
              message_id: payload.message_id,
              last_error: payload.last_error,
              sent_at: payload.sent_at,
              updated_at: payload.updated_at,
            });
            return { error: null };
          },
        };
      }
      if (table === 'audit_logs') {
        return {
          insert: async (payload: any) => {
            auditLogs.push({
              id: `audit-${String(logSeq++).padStart(4, '0')}`,
              actor_id: payload.actor_id ?? null,
              action: payload.action,
              entity: payload.entity,
              entity_id: payload.entity_id,
              details: payload.details || {},
              created_at: new Date().toISOString(),
            });
            return { error: null };
          },
          select: () => ({
            eq: (_col1: string, entityVal: string) => ({
              eq: (_col2: string, entityIdVal: string) => {
                const matched = auditLogs.filter(
                  (r) => r.entity === entityVal && r.entity_id === entityIdVal
                );
                return {
                  order: async () => ({ data: [...matched], error: null }),
                  data: [...matched],
                  error: null,
                };
              },
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    },
  };

  return client;
}

export async function runOrderConfirmationEmailTests(): Promise<{
  passed: number;
  total: number;
  allPassed: boolean;
}> {
  console.log('==============================================================================');
  console.log('📧 PX CUSTON — SUÍTE DE TESTES DE E-MAIL DE CONFIRMAÇÃO DE COMPRA (SMTP & WEBHOOK)');
  console.log('==============================================================================\n');

  resetOrderEmailMemoryStateForTests();
  let passed = 0;
  let total = 0;

  function assertScenario(name: string, condition: boolean, details?: string) {
    total++;
    if (condition) {
      passed++;
      console.log(`✅ [PASSOU] ${name}`);
    } else {
      console.error(`❌ [FALHOU] ${name}${details ? ` — ${details}` : ''}`);
    }
  }

  // --------------------------------------------------------------------------
  // Cenário 1: Pagamento aprovado + ingressos emitidos -> envia 1 e-mail completo
  // --------------------------------------------------------------------------
  const orderId1 = '11111111-aaaa-4bbb-8ccc-111111111111';
  const mockDb1 = createMockOrderSupabase({
    orderId: orderId1,
    paymentStatus: 'approved',
    tickets: [
      {
        id: 'tkt-1',
        code: 'PX-9A8B7C6D',
        batch_id: 'batch-pista-1',
        holder_name: 'Piloto Oficial PX',
        price: 69.0,
        status: 'paid',
        qr_payload: `PX:PX-9A8B7C6D:bbbb1111-2222-4333-8444-555566667777`,
      },
      {
        id: 'tkt-2',
        code: 'PX-1F2E3D4C',
        batch_id: 'batch-vip-1',
        holder_name: 'Piloto Oficial PX',
        price: 69.0,
        status: 'paid',
        qr_payload: `PX:PX-1F2E3D4C:bbbb1111-2222-4333-8444-555566667777`,
      },
    ],
  });

  const sentEmails1: Array<{ from: string; to: string; subject: string; text: string; html: string }> = [];
  const transport1 = {
    sendMail: async (opts: any) => {
      sentEmails1.push(opts);
      return { messageId: '<msg-order-1@pxcuston.com.br>' };
    },
  };

  const res1 = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderId1,
    paymentId: 'mp-pay-1001',
    supabaseAdmin: mockDb1,
    customTransport: transport1,
  });

  assertScenario(
    '1. Pagamento aprovado e ingressos emitidos disparam e-mail de confirmação com códigos PX',
    res1.sent === true &&
      res1.status === 'sent' &&
      res1.already_sent === false &&
      sentEmails1.length === 1 &&
      sentEmails1[0].to === 'comprador.oficial@pxcuston.com.br' &&
      sentEmails1[0].html.includes('PX-9A8B7C6D') &&
      sentEmails1[0].html.includes('PX-1F2E3D4C') &&
      sentEmails1[0].html.includes('ENCONTRO NACIONAL PX CUSTON 2026')
  );

  // --------------------------------------------------------------------------
  // Cenário 2: Webhook repetido para o mesmo pedido aprovado -> Idempotência impede duplicidade
  // --------------------------------------------------------------------------
  const res1Repeat = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderId1,
    paymentId: 'mp-pay-1001',
    supabaseAdmin: mockDb1,
    customTransport: transport1,
  });

  assertScenario(
    '2. Webhook repetido para pedido aprovado é idempotente e NÃO envia segundo e-mail',
    res1Repeat.sent === false &&
      res1Repeat.already_sent === true &&
      res1Repeat.status === 'already_sent' &&
      sentEmails1.length === 1
  );

  // --------------------------------------------------------------------------
  // Cenário 3: Falha de SMTP NÃO desfaz pagamento aprovado nem invalida ingressos,
  //            sanitiza credenciais nos logs e permite retentativa em novo webhook
  // --------------------------------------------------------------------------
  const orderId2 = '22222222-aaaa-4bbb-8ccc-222222222222';
  const mockDb2 = createMockOrderSupabase({
    orderId: orderId2,
    paymentStatus: 'approved',
    tickets: [
      {
        id: 'tkt-3',
        code: 'PX-778899AA',
        batch_id: 'batch-pista-1',
        holder_name: 'Cliente Resiliência',
        price: 138.0,
        status: 'paid',
        qr_payload: `PX:PX-778899AA:bbbb1111-2222-4333-8444-555566667777`,
      },
    ],
  });

  let shouldFailSmtp = true;
  let sendAttemptsCount2 = 0;
  const fakeSmtpSecret = 'SuperSecretSmtpPass_998877!';

  const transportFlaky = {
    sendMail: async () => {
      sendAttemptsCount2++;
      if (shouldFailSmtp) {
        throw new Error(`EAUTH: Invalid login for smtp://user:${fakeSmtpSecret}@smtp.hostinger.com pass=${fakeSmtpSecret}`);
      }
      return { messageId: '<msg-order-2-recovered@pxcuston.com.br>' };
    },
  };

  const resFail = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderId2,
    paymentId: 'mp-pay-2002',
    supabaseAdmin: mockDb2,
    customTransport: transportFlaky,
    envOverride: {
      SMTP_HOST: 'smtp.hostinger.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'contato@pxcuston.com.br',
      SMTP_PASS: fakeSmtpSecret,
      SMTP_FROM: 'PX CUSTON <contato@pxcuston.com.br>',
    },
  });

  const notifRecordAfterFail = mockDb2.notificationsDb.get(`${orderId2}:order_confirmation`);
  const secretNotExposed =
    !(resFail.error || '').includes(fakeSmtpSecret) &&
    !(notifRecordAfterFail?.last_error || '').includes(fakeSmtpSecret);

  assertScenario(
    '3. Falha de SMTP preserva pagamento aprovado e ingressos válidos, registra falha e oculta senha SMTP nos logs',
    resFail.sent === false &&
      resFail.status === 'failed' &&
      mockDb2.orderState.payment_status === 'approved' &&
      mockDb2.ticketsState[0].status === 'paid' &&
      notifRecordAfterFail?.status === 'failed' &&
      notifRecordAfterFail?.attempts === 1 &&
      secretNotExposed
  );

  // --------------------------------------------------------------------------
  // Cenário 4: Retentativa automática em webhook subsequente após falha de SMTP
  // --------------------------------------------------------------------------
  shouldFailSmtp = false;
  const resRetrySuccess = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderId2,
    paymentId: 'mp-pay-2002',
    supabaseAdmin: mockDb2,
    customTransport: transportFlaky,
  });

  const resPostRetryDuplicateCheck = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderId2,
    paymentId: 'mp-pay-2002',
    supabaseAdmin: mockDb2,
    customTransport: transportFlaky,
  });

  const notifRecordAfterRetry = mockDb2.notificationsDb.get(`${orderId2}:order_confirmation`);

  assertScenario(
    '4. Retentativa em webhook subsequente envia o e-mail com sucesso (attempts=2) e bloqueia 3ª chamada por idempotência',
    resRetrySuccess.sent === true &&
      resRetrySuccess.status === 'sent' &&
      resRetrySuccess.attempts === 2 &&
      notifRecordAfterRetry?.status === 'sent' &&
      resPostRetryDuplicateCheck.already_sent === true &&
      sendAttemptsCount2 === 2
  );

  // --------------------------------------------------------------------------
  // Cenário 5: Pedido pendente ou sem ingressos emitidos NÃO envia e-mail
  // --------------------------------------------------------------------------
  const orderIdPending = '33333333-aaaa-4bbb-8ccc-333333333333';
  const mockDbPending = createMockOrderSupabase({
    orderId: orderIdPending,
    paymentStatus: 'pending',
    tickets: [],
  });

  let pendingSendCalled = false;
  const resPending = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderIdPending,
    paymentId: 'mp-pay-3003',
    supabaseAdmin: mockDbPending,
    customTransport: {
      sendMail: async () => {
        pendingSendCalled = true;
        return { messageId: 'never' };
      },
    },
  });

  const orderIdNoTickets = '44444444-aaaa-4bbb-8ccc-444444444444';
  const mockDbNoTickets = createMockOrderSupabase({
    orderId: orderIdNoTickets,
    paymentStatus: 'approved',
    tickets: [],
  });

  const resNoTickets = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderIdNoTickets,
    paymentId: 'mp-pay-4004',
    supabaseAdmin: mockDbNoTickets,
    customTransport: {
      sendMail: async () => {
        pendingSendCalled = true;
        return { messageId: 'never' };
      },
    },
  });

  assertScenario(
    '5. Pedido não aprovado ou sem ingressos emitidos recusa envio prematuro (skipped_not_ready)',
    resPending.status === 'skipped_not_ready' &&
      resNoTickets.status === 'skipped_not_ready' &&
      pendingSendCalled === false
  );

  // --------------------------------------------------------------------------
  // Cenário 6: Validação de placeholders e sanitização de credenciais SMTP
  // --------------------------------------------------------------------------
  const placeholderConfig = resolveSmtpConfig({
    SMTP_HOST: 'smtp.your-provider.example',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'no-reply@your-domain.example',
    SMTP_PASS: 'your-smtp-secret-password-placeholder',
    SMTP_FROM: 'PX CUSTON <no-reply@your-domain.example>',
  });

  const scrubbedText = sanitizeSmtpError(
    'Erro de login em smtp://admin:SenhaRealSecreta123@smtp.pxcuston.com.br password=SenhaRealSecreta123',
    ['SenhaRealSecreta123']
  );

  assertScenario(
    '6. Placeholders de .env.example são detectados como não configurados e sanitizador remove senhas',
    placeholderConfig.configured === false &&
      !scrubbedText.includes('SenhaRealSecreta123') &&
      scrubbedText.includes('[REDACTED]')
  );

  // --------------------------------------------------------------------------
  // Cenário 7: Fallback persistente em public.audit_logs (sem tabela order_email_notifications)
  //            previne duplicatas após reinicialização do processo e suporta retentativa após falha
  // --------------------------------------------------------------------------
  const orderIdAuditFallback = '77777777-aaaa-4bbb-8ccc-777777777777';
  const mockDbAuditOnly = createMockOrderSupabase({
    orderId: orderIdAuditFallback,
    paymentStatus: 'approved',
    disableNotificationsTable: true,
    tickets: [
      {
        id: 'tkt-audit-1',
        code: 'PX-AUDIT777',
        batch_id: 'batch-pista-1',
        holder_name: 'Piloto Audit Fallback',
        price: 138.0,
        status: 'paid',
        qr_payload: `PX:PX-AUDIT777:bbbb1111-2222-4333-8444-555566667777`,
      },
    ],
  });

  let auditSendCount = 0;
  let failAuditFirstAttempt = true;
  const auditTransport = {
    sendMail: async () => {
      auditSendCount++;
      if (failAuditFirstAttempt) {
        throw new Error('ETIMEDOUT: SMTP timeout temporário');
      }
      return { messageId: '<msg-audit-fallback@pxcuston.com.br>' };
    },
  };

  // 7.1 Primeira tentativa falha -> grava CLAIM e FAILED em public.audit_logs
  const resAuditFail = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderIdAuditFallback,
    paymentId: 'mp-pay-7007',
    supabaseAdmin: mockDbAuditOnly,
    customTransport: auditTransport,
  });

  // Simular reinicialização do processo Node.js (limpando locks e memória RAM)
  resetOrderEmailMemoryStateForTests();

  // 7.2 Segunda tentativa (em novo processo após falha) -> recupera histórico de public.audit_logs e envia com sucesso (attempts = 2)
  failAuditFirstAttempt = false;
  const resAuditRetrySent = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderIdAuditFallback,
    paymentId: 'mp-pay-7007',
    supabaseAdmin: mockDbAuditOnly,
    customTransport: auditTransport,
  });

  // Simular outra reinicialização do servidor ou segundo worker recebendo webhook repetido
  resetOrderEmailMemoryStateForTests();

  // 7.3 Terceira chamada (em novo processo após envio concluído) -> bloqueia via public.audit_logs sem depender de memória RAM
  const resAuditAfterRestart = await sendOrderConfirmationEmailIfNeeded({
    orderId: orderIdAuditFallback,
    paymentId: 'mp-pay-7007',
    supabaseAdmin: mockDbAuditOnly,
    customTransport: auditTransport,
  });

  const hasClaimLog = mockDbAuditOnly.auditLogs.some((l) => l.action === 'ORDER_CONFIRMATION_EMAIL_CLAIM');
  const hasFailedLog = mockDbAuditOnly.auditLogs.some((l) => l.action === 'ORDER_CONFIRMATION_EMAIL_FAILED');
  const hasSentLog = mockDbAuditOnly.auditLogs.some((l) => l.action === 'ORDER_CONFIRMATION_EMAIL_SENT');

  assertScenario(
    '7. Fallback em public.audit_logs garante retentativa após falha e bloqueia envio duplicado entre processos/reinicializações',
    resAuditFail.status === 'failed' &&
      resAuditRetrySent.sent === true &&
      resAuditRetrySent.status === 'sent' &&
      resAuditRetrySent.attempts === 2 &&
      resAuditAfterRestart.sent === false &&
      resAuditAfterRestart.already_sent === true &&
      resAuditAfterRestart.status === 'already_sent' &&
      auditSendCount === 2 &&
      hasClaimLog &&
      hasFailedLog &&
      hasSentLog
  );

  console.log('\n==============================================================================');
  console.log(`RESULTADO DOS TESTES DE E-MAIL DE CONFIRMAÇÃO: ${passed}/${total} APROVADOS`);
  console.log('==============================================================================\n');

  return {
    passed,
    total,
    allPassed: passed === total,
  };
}

if (process.argv[1] && process.argv[1].endsWith('test-order-confirmation-email.ts')) {
  runOrderConfirmationEmailTests()
    .then((res) => {
      if (!res.allPassed) process.exit(1);
    })
    .catch((err) => {
      console.error('Erro fatal nos testes de e-mail:', err);
      process.exit(1);
    });
}
