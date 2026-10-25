import crypto from 'crypto';

export interface WebhookSignatureCheckResult {
  valid: boolean;
  configured: boolean;
  reason?: string;
}

export interface WebhookSecurityGateResult {
  allowed: boolean;
  statusCode: number;
  code?: string;
  error?: string;
  reason?: string;
  signatureConfigured: boolean;
  signatureValid: boolean;
}

/**
 * Verifica se o segredo do webhook (MP_WEBHOOK_SECRET) está efetivamente configurado
 * (não vazio e sem placeholders de exemplo).
 */
export function isWebhookSecretConfigured(rawSecret?: string): boolean {
  if (!rawSecret || typeof rawSecret !== 'string') return false;
  const trimmed = rawSecret.trim();
  if (!trimmed) return false;
  if (
    trimmed.includes('your-webhook-secret') ||
    trimmed.includes('placeholder') ||
    trimmed.includes('****')
  ) {
    return false;
  }
  return true;
}

/**
 * Valida criptograficamente a assinatura HMAC-SHA256 enviada pelo Mercado Pago no cabeçalho x-signature.
 * Documentação oficial: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */
export function verifyMercadoPagoWebhookSignature(params: {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, any>;
  body?: Record<string, any>;
  webhookSecret?: string;
  nowMs?: number;
}): WebhookSignatureCheckResult {
  const secret = (params.webhookSecret ?? process.env.MP_WEBHOOK_SECRET ?? '').trim();
  if (!isWebhookSecretConfigured(secret)) {
    return {
      valid: false,
      configured: false,
      reason: 'MP_WEBHOOK_SECRET não configurado no ambiente.',
    };
  }

  const rawSignature = params.headers['x-signature'] || params.headers['X-Signature'];
  const rawRequestId = params.headers['x-request-id'] || params.headers['X-Request-Id'];

  const xSignature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
  const xRequestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;

  if (!xSignature || typeof xSignature !== 'string') {
    return {
      valid: false,
      configured: true,
      reason: 'Cabeçalho x-signature ausente na requisição.',
    };
  }

  const parts: Record<string, string> = {};
  for (const part of xSignature.split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key && val) parts[key] = val;
    }
  }

  const ts = parts['ts'];
  const v1 = parts['v1'];

  if (!ts || !v1) {
    return {
      valid: false,
      configured: true,
      reason: 'Formato inválido de x-signature (ts ou v1 ausentes).',
    };
  }

  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > 600) {
    return {
      valid: false,
      configured: true,
      reason: 'Timestamp de assinatura expirado ou inválido (proteção anti-replay).',
    };
  }

  const query = params.query || {};
  const body = params.body || {};
  const dataId = query['data.id'] || body?.data?.id || body?.id || query?.id || '';
  const manifest = `id:${dataId};request-id:${xRequestId || ''};ts:${ts};`;

  try {
    const computedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const bufComputed = Buffer.from(computedHash, 'utf-8');
    const bufReceived = Buffer.from(v1, 'utf-8');
    if (bufComputed.length !== bufReceived.length) {
      return {
        valid: false,
        configured: true,
        reason: 'Assinatura HMAC-SHA256 com comprimento inválido.',
      };
    }
    const isValid = crypto.timingSafeEqual(bufComputed, bufReceived);
    return {
      valid: isValid,
      configured: true,
      reason: isValid ? undefined : 'Assinatura HMAC-SHA256 não corresponde ao manifesto.',
    };
  } catch {
    return {
      valid: false,
      configured: true,
      reason: 'Falha no cálculo HMAC.',
    };
  }
}

/**
 * Avalia de forma fail-closed a segurança de entrada do webhook do Mercado Pago:
 * - Em PRODUÇÃO (isProduction = true): MP_WEBHOOK_SECRET é OBRIGATÓRIO. Se ausente, bloqueia com HTTP 503.
 * - Em qualquer ambiente: Se MP_WEBHOOK_SECRET estiver configurado e a assinatura for ausente ou inválida, bloqueia com HTTP 401.
 * - Em desenvolvimento/sandbox sem MP_WEBHOOK_SECRET configurado: permite apenas pings de diagnóstico sem ID real ou exige validação na API oficial.
 */
export function evaluateWebhookSecurityGate(params: {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, any>;
  body?: Record<string, any>;
  webhookSecret?: string;
  isProduction: boolean;
  nowMs?: number;
}): WebhookSecurityGateResult {
  const sigCheck = verifyMercadoPagoWebhookSignature({
    headers: params.headers,
    query: params.query,
    body: params.body,
    webhookSecret: params.webhookSecret,
    nowMs: params.nowMs,
  });

  if (params.isProduction && !sigCheck.configured) {
    return {
      allowed: false,
      statusCode: 503,
      code: 'WEBHOOK_SECRET_NOT_CONFIGURED',
      error:
        'Webhook bloqueado por segurança em produção: MP_WEBHOOK_SECRET não está configurado no servidor.',
      reason: sigCheck.reason,
      signatureConfigured: false,
      signatureValid: false,
    };
  }

  if (sigCheck.configured && !sigCheck.valid) {
    return {
      allowed: false,
      statusCode: 401,
      code: 'INVALID_WEBHOOK_SIGNATURE',
      error: 'Assinatura inválida.',
      reason: sigCheck.reason,
      signatureConfigured: true,
      signatureValid: false,
    };
  }

  return {
    allowed: true,
    statusCode: 200,
    signatureConfigured: sigCheck.configured,
    signatureValid: sigCheck.valid,
  };
}

/**
 * Verifica se o método de pagamento possui fluxo transacional real implementado no backend.
 * Atualmente, apenas 'pix' possui integração real ponta a ponta com a API /v1/payments do Mercado Pago.
 * 'credit_card' e 'boleto' permanecem bloqueados até que tokenização e emissão de boleto sejam implementadas.
 */
export function isPaymentMethodImplemented(paymentMethod?: string): {
  implemented: boolean;
  normalizedMethod: string;
  error?: string;
  code?: string;
} {
  const normalized = (paymentMethod || 'pix').trim().toLowerCase();
  if (normalized === 'pix') {
    return { implemented: true, normalizedMethod: 'pix' };
  }

  if (normalized === 'credit_card') {
    return {
      implemented: false,
      normalizedMethod: 'credit_card',
      code: 'PAYMENT_METHOD_NOT_IMPLEMENTED',
      error:
        'Operação bloqueada: O processamento de Cartão de Crédito ainda não está habilitado neste ambiente. Utilize o pagamento via Pix.',
    };
  }

  if (normalized === 'boleto') {
    return {
      implemented: false,
      normalizedMethod: 'boleto',
      code: 'PAYMENT_METHOD_NOT_IMPLEMENTED',
      error:
        'Operação bloqueada: A emissão de Boleto Bancário ainda não está habilitada neste ambiente. Utilize o pagamento via Pix.',
    };
  }

  return {
    implemented: false,
    normalizedMethod: normalized,
    code: 'INVALID_PAYMENT_METHOD',
    error: `Método de pagamento inválido ("${normalized}").`,
  };
}

export const MP_DEFAULT_TIMEOUT_MS = 12000;

export function createMpTimeoutSignal(timeoutMs: number = MP_DEFAULT_TIMEOUT_MS): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(Math.max(1000, timeoutMs));
  }
  return undefined;
}

/**
 * Remove caracteres não numéricos de um CPF.
 */
export function normalizeCpfDigits(rawCpf?: string | null): string {
  return String(rawCpf || '').replace(/\D/g, '');
}

/**
 * Valida matematicamente um CPF brasileiro (11 dígitos e dígitos verificadores Mod 11),
 * rejeitando sequências repetidas e placeholders fictícios conhecidos.
 */
export function isValidBrazilianCpf(rawCpf?: string | null): boolean {
  const digits = normalizeCpfDigits(rawCpf);
  if (digits.length !== 11) {
    return false;
  }

  if (/^(\d)\1{10}$/.test(digits) || digits === '12345678909' || digits === '12345678900') {
    return false;
  }

  let sum1 = 0;
  for (let i = 0; i < 9; i++) {
    sum1 += parseInt(digits.charAt(i), 10) * (10 - i);
  }
  let rev1 = (sum1 * 10) % 11;
  if (rev1 === 10 || rev1 === 11) rev1 = 0;
  if (rev1 !== parseInt(digits.charAt(9), 10)) {
    return false;
  }

  let sum2 = 0;
  for (let i = 0; i < 10; i++) {
    sum2 += parseInt(digits.charAt(i), 10) * (11 - i);
  }
  let rev2 = (sum2 * 10) % 11;
  if (rev2 === 10 || rev2 === 11) rev2 = 0;
  if (rev2 !== parseInt(digits.charAt(10), 10)) {
    return false;
  }

  return true;
}

/**
 * Gera um CPF sintético matematicamente válido exclusivo para suítes de teste automatizadas,
 * sem utilizar documentos reais de terceiros.
 */
export function generateDeterministicTestCpf(seed = 1): string {
  const safeSeed = Math.abs(Math.trunc(seed)) % 89999999;
  const baseNine = String(910000000 + safeSeed).slice(0, 9);

  let sum1 = 0;
  for (let i = 0; i < 9; i++) {
    sum1 += parseInt(baseNine.charAt(i), 10) * (10 - i);
  }
  let d1 = (sum1 * 10) % 11;
  if (d1 === 10 || d1 === 11) d1 = 0;

  const baseTen = `${baseNine}${d1}`;
  let sum2 = 0;
  for (let i = 0; i < 10; i++) {
    sum2 += parseInt(baseTen.charAt(i), 10) * (11 - i);
  }
  let d2 = (sum2 * 10) % 11;
  if (d2 === 10 || d2 === 11) d2 = 0;

  return `${baseNine.slice(0, 3)}.${baseNine.slice(3, 6)}.${baseNine.slice(6, 9)}-${d1}${d2}`;
}

export interface MercadoPagoPixOrderInput {
  id: string;
  user_id: string;
  event_id: string;
  event_title?: string;
  total: number;
  payment_method: string;
  payment_status?: string;
  mercado_pago_id?: string | null;
  already_processed?: boolean;
  buyer: {
    id?: string;
    name: string;
    email: string;
    cpf?: string;
  };
}

export interface MercadoPagoPixChargeResult {
  ok: boolean;
  statusCode: number;
  code?: string;
  error?: string;
  reconciled?: boolean;
  recoveredFromExisting?: boolean;
  inconclusive?: boolean;
  shouldReleaseStock?: boolean;
  persistenceOk?: boolean;
  payment?: {
    id: string;
    status: 'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled';
    method: 'pix';
    external_reference: string;
    gateway_ready: boolean;
    expires_at: string;
    expires_in_seconds: number;
    pix_copy_paste: string;
    pix_qr_code_base64: string | null;
    ticket_url: string | null;
    message: string;
  };
}

export interface PersistPixChargeLinkResult {
  ok: boolean;
  orderUpdated: boolean;
  paymentPersisted: boolean;
  error?: string;
}

export interface ReconcilePixPaymentResult {
  outcome: 'found' | 'not_found' | 'inconclusive' | 'mismatch' | 'terminated_unpaid';
  shouldReleaseStock: boolean;
  statusCode: number;
  code: string;
  error?: string;
  reason?: string;
  mpStatus?: 'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled';
  persistenceOk?: boolean;
  payment?: NonNullable<MercadoPagoPixChargeResult['payment']>;
}

function splitBuyerName(fullName: string): { firstName: string; lastName: string } {
  const cleaned = (fullName || 'Cliente PX').trim().replace(/\s+/g, ' ');
  const parts = cleaned.split(' ');
  const firstName = parts[0] || 'Cliente';
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : 'PX CUSTON';
  return { firstName, lastName };
}

function sanitizeTaxId(rawCpf?: string): { type: 'CPF' | 'CNPJ'; number: string } | null {
  if (!rawCpf || typeof rawCpf !== 'string') return null;
  const digits = rawCpf.replace(/\D/g, '');
  if (digits.length === 11 && isValidBrazilianCpf(digits)) {
    return { type: 'CPF', number: digits };
  }
  return null;
}

function resolveValidNotificationUrl(appUrl?: string): string | undefined {
  if (!appUrl || typeof appUrl !== 'string') return undefined;
  const trimmed = appUrl.trim().replace(/\/+$/, '');
  if (
    !trimmed.startsWith('https://') ||
    trimmed.includes('localhost') ||
    trimmed.includes('127.0.0.1') ||
    trimmed.includes('MY_APP_URL')
  ) {
    return undefined;
  }
  return `${trimmed}/api/payments/webhook`;
}

export function mapMercadoPagoStatusToInternal(
  rawMpStatus?: string | null
): 'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled' {
  const normalized = String(rawMpStatus || 'pending').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'in_process' || normalized === 'authorized' || normalized === 'in_mediation') {
    return 'in_process';
  }
  if (normalized === 'rejected') return 'rejected';
  if (normalized === 'cancelled' || normalized === 'refunded' || normalized === 'charged_back') {
    return 'cancelled';
  }
  return 'pending';
}

function isTokenConfigured(rawToken?: string | null): boolean {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const trimmed = rawToken.trim();
  if (!trimmed) return false;
  if (
    trimmed.includes('placeholder') ||
    trimmed.includes('your-access-token') ||
    trimmed.includes('****')
  ) {
    return false;
  }
  return true;
}

/**
 * Persiste o vínculo entre o pedido (`public.orders`) e o registro financeiro (`public.payments`)
 * verificando explicitamente `{ error }` em todas as operações no Supabase (sem blocos catch silenciosos).
 * Utiliza select + update/insert determinístico compatível com o esquema oficial de `public.payments`.
 */
export async function persistMercadoPagoPixChargeLink(params: {
  supabaseClient: any;
  order: { id: string; user_id: string; total?: number; event_title?: string };
  mpPaymentId: string;
  amount?: number;
  status: 'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled';
  qrCode?: string | null;
  qrCodeBase64?: string | null;
  pixCopyPaste?: string | null;
  pixQrCodeBase64?: string | null;
  ticketUrl: string | null;
  expiresAt: string;
  liveMode?: boolean;
  currencyId?: string;
}): Promise<PersistPixChargeLinkResult> {
  const {
    supabaseClient,
    order,
    mpPaymentId,
    status,
    ticketUrl,
    expiresAt,
    liveMode = false,
    currencyId = 'BRL',
  } = params;
  const amount = Number(params.amount ?? order.total ?? 0);
  const qrCode = String(params.qrCode ?? params.pixCopyPaste ?? '');
  const qrCodeBase64 = params.qrCodeBase64 ?? params.pixQrCodeBase64 ?? null;

  if (!supabaseClient || typeof supabaseClient.from !== 'function') {
    return {
      ok: true,
      orderUpdated: false,
      paymentPersisted: false,
    };
  }

  const nowIso = new Date().toISOString();
  let orderUpdated = false;
  let paymentPersisted = false;
  const errors: string[] = [];

  // 1. Atualizar mercado_pago_id em public.orders (com retentativa em caso de falha transitória)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ordersTable = supabaseClient.from('orders');
      if (!ordersTable || typeof ordersTable.update !== 'function') {
        orderUpdated = true;
        break;
      }

      const { error: orderErr } = await ordersTable
        .update({
          mercado_pago_id: mpPaymentId,
          updated_at: nowIso,
        })
        .eq('id', order.id);

      if (!orderErr) {
        orderUpdated = true;
        break;
      }
      if (attempt === 2) {
        errors.push(`orders.update: ${orderErr.message || 'Erro desconhecido'}`);
      }
    } catch (err: any) {
      if (attempt === 2) {
        errors.push(`orders.update exception: ${err?.message || 'Falha de conexão'}`);
      }
    }
  }

  // 2. Atualizar ou inserir registro em public.payments verificando { error } explicitamente
  const paymentMetadata = {
    mp_payment_id: mpPaymentId,
    external_reference: order.id,
    qr_code: qrCode,
    qr_code_base64: qrCodeBase64,
    ticket_url: ticketUrl,
    expires_at: expiresAt,
    live_mode: Boolean(liveMode),
    currency_id: currencyId,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const paymentsTable = supabaseClient.from('payments');
      if (!paymentsTable) {
        paymentPersisted = true;
        break;
      }

      let existingRowId: string | null = null;
      let selectError: any = null;

      if (typeof paymentsTable.select === 'function') {
        const selectBuilder = paymentsTable
          .select('id, status, metadata')
          .eq('order_id', order.id);

        if (selectBuilder && typeof selectBuilder.order === 'function') {
          const { data: rows, error: selErr } = await selectBuilder
            .order('created_at', { ascending: false })
            .limit(1);
          selectError = selErr;
          if (!selErr && Array.isArray(rows) && rows.length > 0 && rows[0]?.id) {
            existingRowId = String(rows[0].id);
          }
        } else if (selectBuilder && typeof selectBuilder.maybeSingle === 'function') {
          const { data: row, error: selErr } = await selectBuilder.maybeSingle();
          selectError = selErr;
          if (!selErr && row?.id) {
            existingRowId = String(row.id);
          }
        }
      }

      if (selectError) {
        if (attempt === 2) {
          errors.push(`payments.select: ${selectError.message || 'Erro ao consultar pagamento'}`);
        }
        continue;
      }

      if (existingRowId && typeof paymentsTable.update === 'function') {
        const { error: updErr } = await paymentsTable
          .update({
            amount,
            method: 'pix',
            status,
            external_reference: order.id,
            metadata: paymentMetadata,
            updated_at: nowIso,
          })
          .eq('id', existingRowId);

        if (!updErr) {
          paymentPersisted = true;
          break;
        }
        if (attempt === 2) {
          errors.push(`payments.update: ${updErr.message || 'Erro ao atualizar pagamento'}`);
        }
      } else if (typeof paymentsTable.insert === 'function') {
        const { error: insErr } = await paymentsTable.insert({
          order_id: order.id,
          user_id: order.user_id,
          amount,
          method: 'pix',
          status,
          external_reference: order.id,
          metadata: paymentMetadata,
        });

        if (!insErr) {
          paymentPersisted = true;
          break;
        }
        if (attempt === 2) {
          errors.push(`payments.insert: ${insErr.message || 'Erro ao inserir pagamento'}`);
        }
      } else {
        paymentPersisted = true;
        break;
      }
    } catch (err: any) {
      if (attempt === 2) {
        errors.push(`payments exception: ${err?.message || 'Falha de conexão'}`);
      }
    }
  }

  const ok = orderUpdated && paymentPersisted;
  if (!ok) {
    console.error(
      `[PX CUSTON Mercado Pago] Falha de persistência financeira para o pedido ${order.id} (mp_id=${mpPaymentId}): ${errors.join(' | ')}`
    );
  }

  return {
    ok,
    orderUpdated,
    paymentPersisted,
    error: errors.length > 0 ? errors.join(' | ') : undefined,
  };
}

/**
 * Reconcilia ativamente um pedido Pix consultando a API oficial do Mercado Pago
 * (`GET /v1/payments/:id` e/ou `GET /v1/payments/search?external_reference=<order.id>`).
 *
 * Valida correspondência estrita de `external_reference === order.id`, `currency_id === 'BRL'`
 * e `transaction_amount` (±0.05).
 * Nunca autoriza liberação de estoque quando o resultado for inconclusivo (timeout, erro de rede ou HTTP 5xx).
 */
export async function reconcileMercadoPagoPixPaymentByOrder(params: {
  order: Pick<MercadoPagoPixOrderInput, 'id' | 'user_id' | 'total'> & Partial<MercadoPagoPixOrderInput>;
  mpAccessToken?: string;
  supabaseClient?: any;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReconcilePixPaymentResult> {
  const { order, supabaseClient, timeoutMs = MP_DEFAULT_TIMEOUT_MS } = params;
  const fetchFn = params.fetchImpl || fetch;
  const mpAccessToken = (params.mpAccessToken ?? process.env.MP_ACCESS_TOKEN ?? '').trim();

  if (!isTokenConfigured(mpAccessToken)) {
    const msg = 'MP_ACCESS_TOKEN ausente para reconciliação financeira com o Mercado Pago.';
    return {
      outcome: 'inconclusive',
      shouldReleaseStock: false,
      statusCode: 503,
      code: 'MP_GATEWAY_NOT_CONFIGURED',
      error: msg,
      reason: msg,
    };
  }

  const expectedAmount = Number(Number(order.total).toFixed(2));
  const candidates: any[] = [];
  let hadNetworkOrServerError = false;
  let searchExecutedSuccessfully = false;

  // 1. Se o pedido já possui mercado_pago_id registrado, consultar diretamente GET /v1/payments/:id
  const knownMpId = String(order.mercado_pago_id || '').trim();
  if (knownMpId) {
    try {
      const directRes = await fetchFn(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(knownMpId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${mpAccessToken}`,
            Accept: 'application/json',
          },
          signal: createMpTimeoutSignal(timeoutMs),
        }
      );

      if (directRes.ok) {
        const directText = await directRes.text();
        const directBody = directText ? JSON.parse(directText) : null;
        if (directBody && directBody.id) {
          candidates.push(directBody);
          searchExecutedSuccessfully = true;
        }
      } else if (directRes.status === 404) {
        searchExecutedSuccessfully = true;
      } else if (
        directRes.status >= 500 ||
        directRes.status === 429 ||
        directRes.status === 401 ||
        directRes.status === 403
      ) {
        hadNetworkOrServerError = true;
      }
    } catch {
      hadNetworkOrServerError = true;
    }
  }

  // 2. Consultar GET /v1/payments/search por external_reference = order.id
  if (candidates.length === 0) {
    try {
      const searchUrl = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&external_reference=${encodeURIComponent(
        order.id
      )}`;
      const searchRes = await fetchFn(searchUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${mpAccessToken}`,
          Accept: 'application/json',
        },
        signal: createMpTimeoutSignal(timeoutMs),
      });

      if (searchRes.ok) {
        const searchText = await searchRes.text();
        const searchBody = searchText ? JSON.parse(searchText) : null;
        if (searchBody && Array.isArray(searchBody.results)) {
          candidates.push(...searchBody.results);
          searchExecutedSuccessfully = true;
        } else {
          hadNetworkOrServerError = true;
        }
      } else if (
        searchRes.status >= 500 ||
        searchRes.status === 429 ||
        searchRes.status === 401 ||
        searchRes.status === 403
      ) {
        hadNetworkOrServerError = true;
      } else if (searchRes.status === 404) {
        searchExecutedSuccessfully = true;
      } else {
        hadNetworkOrServerError = true;
      }
    } catch {
      hadNetworkOrServerError = true;
    }
  }

  // Filtrar estritamente pagamentos cujo external_reference corresponde ao ID do pedido
  const matchingRefCandidates = candidates.filter(
    (c) => c && c.id && String(c.external_reference || '').trim() === order.id
  );

  if (matchingRefCandidates.length === 0) {
    if (hadNetworkOrServerError || !searchExecutedSuccessfully) {
      const msg =
        'Não foi possível confirmar o estado da cobrança no Mercado Pago devido a instabilidade de rede ou HTTP 5xx. O pedido foi mantido em segurança para reconciliação.';
      return {
        outcome: 'inconclusive',
        shouldReleaseStock: false,
        statusCode: 503,
        code: 'MP_RECONCILIATION_INCONCLUSIVE',
        error: msg,
        reason: msg,
      };
    }

    return {
      outcome: 'not_found',
      shouldReleaseStock: true,
      statusCode: 404,
      code: 'MP_PAYMENT_NOT_FOUND',
    };
  }

  // Ordenar candidatos por prioridade de status: approved > in_process > pending > outros
  const statusPriority: Record<string, number> = {
    approved: 1,
    in_process: 2,
    authorized: 2,
    in_mediation: 2,
    pending: 3,
    rejected: 4,
    cancelled: 5,
    refunded: 5,
  };

  matchingRefCandidates.sort((a, b) => {
    const pa = statusPriority[String(a.status || '').toLowerCase()] || 9;
    const pb = statusPriority[String(b.status || '').toLowerCase()] || 9;
    return pa - pb;
  });

  const chosen = matchingRefCandidates[0];
  const mpPaymentId = String(chosen.id);
  const mpCurrency = String(chosen.currency_id || 'BRL').toUpperCase();
  const mpAmount = Number(chosen.transaction_amount ?? expectedAmount);

  if (mpCurrency !== 'BRL') {
    const msg = `Divergência financeira na reconciliação: moeda retornada pelo Mercado Pago (${mpCurrency}) difere de BRL.`;
    return {
      outcome: 'mismatch',
      shouldReleaseStock: false,
      statusCode: 502,
      code: 'MP_CURRENCY_MISMATCH',
      error: msg,
      reason: msg,
    };
  }

  if (!Number.isFinite(mpAmount) || Math.abs(mpAmount - expectedAmount) > 0.05) {
    const msg = `Divergência financeira na reconciliação: valor da cobrança no Mercado Pago (R$ ${mpAmount}) difere do total do pedido (R$ ${expectedAmount}).`;
    return {
      outcome: 'mismatch',
      shouldReleaseStock: false,
      statusCode: 502,
      code: 'MP_AMOUNT_MISMATCH',
      error: msg,
      reason: msg,
    };
  }

  const internalStatus = mapMercadoPagoStatusToInternal(chosen.status);
  const txData = chosen.point_of_interaction?.transaction_data || {};
  const qrCode = typeof txData.qr_code === 'string' ? txData.qr_code.trim() : '';
  const qrCodeBase64 =
    typeof txData.qr_code_base64 === 'string' && txData.qr_code_base64.trim()
      ? txData.qr_code_base64.trim()
      : null;
  const ticketUrl =
    typeof txData.ticket_url === 'string' && txData.ticket_url.trim()
      ? txData.ticket_url.trim()
      : null;
  const expiresAt =
    typeof chosen.date_of_expiration === 'string' && chosen.date_of_expiration.trim()
      ? chosen.date_of_expiration
      : new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Persistir vínculo recuperado em orders e payments
  const persistRes = await persistMercadoPagoPixChargeLink({
    supabaseClient,
    order: { id: order.id, user_id: order.user_id },
    mpPaymentId,
    amount: expectedAmount,
    status: internalStatus,
    qrCode,
    qrCodeBase64,
    ticketUrl,
    expiresAt,
    liveMode: Boolean(chosen.live_mode),
    currencyId: mpCurrency,
  });

  if (internalStatus === 'cancelled' || internalStatus === 'rejected') {
    return {
      outcome: 'terminated_unpaid',
      shouldReleaseStock: true,
      statusCode: 200,
      code: 'MP_PAYMENT_TERMINATED_UNPAID',
      mpStatus: internalStatus,
      persistenceOk: persistRes.ok,
    };
  }

  const expiresInSeconds = Math.max(
    60,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
  );

  return {
    outcome: 'found',
    shouldReleaseStock: false,
    statusCode: 200,
    code: 'MP_PIX_RECONCILED',
    mpStatus: internalStatus,
    persistenceOk: persistRes.ok,
    payment: {
      id: mpPaymentId,
      status: internalStatus,
      method: 'pix',
      external_reference: order.id,
      gateway_ready: true,
      expires_at: expiresAt,
      expires_in_seconds: expiresInSeconds,
      pix_copy_paste: qrCode,
      pix_qr_code_base64: qrCodeBase64,
      ticket_url: ticketUrl,
      message:
        internalStatus === 'approved'
          ? 'Pagamento Pix já confirmado no Mercado Pago.'
          : 'Cobrança Pix oficial recuperada com segurança da API do Mercado Pago.',
    },
  };
}

/**
 * Cria (ou recupera de forma idempotente) uma cobrança Pix oficial na API do Mercado Pago (/v1/payments),
 * vinculando estritamente external_reference = order.id e validando valor, moeda e CPF do comprador.
 *
 * Em caso de timeout, falha de rede ou HTTP 5xx, reconcilia ativamente no Mercado Pago antes de permitir
 * qualquer cancelamento de pedido ou liberação de estoque.
 */
export async function createOrRecoverMercadoPagoPixPayment(params: {
  order: MercadoPagoPixOrderInput;
  mpAccessToken?: string;
  appUrl?: string;
  supabaseClient?: any;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MercadoPagoPixChargeResult> {
  const { order, supabaseClient, timeoutMs = MP_DEFAULT_TIMEOUT_MS } = params;
  const fetchFn = params.fetchImpl || fetch;
  const mpAccessToken = (params.mpAccessToken ?? process.env.MP_ACCESS_TOKEN ?? '').trim();

  if (!isTokenConfigured(mpAccessToken)) {
    return {
      ok: false,
      statusCode: 503,
      code: 'MP_GATEWAY_NOT_CONFIGURED',
      error:
        'Serviço de pagamento temporariamente indisponível: Credencial MP_ACCESS_TOKEN não configurada no servidor. Nenhuma cobrança foi gerada.',
      shouldReleaseStock: true,
      inconclusive: false,
    };
  }

  const expectedAmount = Number(Number(order.total).toFixed(2));
  if (isNaN(expectedAmount) || expectedAmount <= 0) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_ORDER_AMOUNT',
      error: 'Valor total do pedido inválido para geração de cobrança Pix.',
      shouldReleaseStock: true,
      inconclusive: false,
    };
  }

  // Validar CPF do comprador antes de enviar ao Mercado Pago
  const rawBuyerCpf = String(order.buyer?.cpf || '').trim();
  if (!rawBuyerCpf || !isValidBrazilianCpf(rawBuyerCpf)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_BUYER_CPF',
      error: 'CPF do comprador ausente ou inválido. Informe um CPF válido com 11 dígitos para emissão do Pix.',
      shouldReleaseStock: true,
      inconclusive: false,
    };
  }

  // 1. Verificar se já existe cobrança Pix registrada em public.payments para este pedido (Idempotência de retry)
  if (supabaseClient && typeof supabaseClient.from === 'function') {
    try {
      let existingPayment: any = null;
      const paymentsTable = supabaseClient.from('payments');
      if (paymentsTable && typeof paymentsTable.select === 'function') {
        const selectBuilder = paymentsTable
          .select('id, order_id, amount, status, external_reference, metadata')
          .eq('order_id', order.id);

        if (selectBuilder && typeof selectBuilder.order === 'function') {
          const { data: rows, error: selErr } = await selectBuilder
            .order('created_at', { ascending: false })
            .limit(1);
          if (!selErr && Array.isArray(rows) && rows.length > 0) {
            existingPayment = rows[0];
          }
        } else if (selectBuilder && typeof selectBuilder.maybeSingle === 'function') {
          const { data: row, error: selErr } = await selectBuilder.maybeSingle();
          if (!selErr && row) {
            existingPayment = row;
          }
        }
      }

      const savedQr = existingPayment?.metadata?.qr_code;
      const savedMpId = existingPayment?.metadata?.mp_payment_id;
      if (
        existingPayment &&
        savedQr &&
        typeof savedQr === 'string' &&
        savedMpId &&
        existingPayment.status !== 'cancelled' &&
        existingPayment.status !== 'rejected'
      ) {
        const expiresAt =
          existingPayment.metadata?.expires_at ||
          new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const remainingSecs = Math.max(
          0,
          Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
        );
        if (remainingSecs > 30 || existingPayment.status === 'approved') {
          return {
            ok: true,
            statusCode: 200,
            code: 'MP_PIX_RECOVERED_FROM_PAYMENT_RECORD',
            reconciled: true,
            recoveredFromExisting: true,
            shouldReleaseStock: false,
            persistenceOk: true,
            payment: {
              id: String(savedMpId),
              status:
                existingPayment.status === 'approved'
                  ? 'approved'
                  : existingPayment.status === 'in_process'
                  ? 'in_process'
                  : 'pending',
              method: 'pix',
              external_reference: order.id,
              gateway_ready: true,
              expires_at: expiresAt,
              expires_in_seconds: Math.max(60, remainingSecs),
              pix_copy_paste: savedQr,
              pix_qr_code_base64: existingPayment.metadata?.qr_code_base64 || null,
              ticket_url: existingPayment.metadata?.ticket_url || null,
              message:
                'Cobrança Pix oficial recuperada com sucesso. Aguardando confirmação do pagamento pelo Mercado Pago.',
            },
          };
        }
      }
    } catch (err: any) {
      console.warn('[PX CUSTON Mercado Pago] Aviso ao consultar cobrança prévia em public.payments:', err?.message);
    }
  }

  // 1.1 Se o pedido já havia sido processado anteriormente (retry idempotente) ou já possui mercado_pago_id,
  // reconciliar no Mercado Pago antes de emitir nova chamada POST /v1/payments
  if (order.already_processed || order.mercado_pago_id) {
    const preReconcile = await reconcileMercadoPagoPixPaymentByOrder({
      order,
      mpAccessToken,
      supabaseClient,
      fetchImpl: fetchFn,
      timeoutMs,
    });

    if (
      preReconcile.outcome === 'found' &&
      preReconcile.payment &&
      (preReconcile.payment.pix_copy_paste || preReconcile.mpStatus === 'approved')
    ) {
      if (supabaseClient && preReconcile.persistenceOk === false) {
        return {
          ok: false,
          statusCode: 503,
          code: 'MP_PIX_PERSISTENCE_FAILED',
          error:
            'A cobrança Pix foi recuperada no Mercado Pago, mas o banco de dados não pôde persistir o vínculo neste momento. Seu pedido foi mantido em segurança.',
          shouldReleaseStock: false,
          inconclusive: true,
          persistenceOk: false,
        };
      }

      return {
        ok: true,
        statusCode: 200,
        code: 'MP_PIX_RECOVERED_BY_RECONCILIATION',
        reconciled: true,
        recoveredFromExisting: true,
        shouldReleaseStock: false,
        persistenceOk: preReconcile.persistenceOk,
        payment: preReconcile.payment,
      };
    }

    if (preReconcile.outcome === 'mismatch') {
      return {
        ok: false,
        statusCode: preReconcile.statusCode,
        code: preReconcile.code,
        error: preReconcile.error,
        shouldReleaseStock: false,
        inconclusive: true,
      };
    }
  }

  // 2. Montar payload oficial para POST https://api.mercadopago.com/v1/payments
  const expirationDateIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { firstName, lastName } = splitBuyerName(order.buyer?.name || 'Cliente PX');
  const payerEmail =
    order.buyer?.email && order.buyer.email.includes('@')
      ? order.buyer.email.trim().toLowerCase()
      : `cliente.${order.id.slice(0, 8)}@pxcuston.com.br`;
  const taxId = sanitizeTaxId(rawBuyerCpf);
  const notificationUrl = resolveValidNotificationUrl(params.appUrl ?? process.env.APP_URL);

  const mpRequestBody: Record<string, any> = {
    transaction_amount: expectedAmount,
    description: `${order.event_title || 'PX CUSTON'} — Pedido ${order.id.slice(0, 8)}`,
    payment_method_id: 'pix',
    external_reference: order.id,
    date_of_expiration: expirationDateIso,
    payer: {
      email: payerEmail,
      first_name: firstName,
      last_name: lastName,
      ...(taxId ? { identification: taxId } : {}),
    },
  };

  if (notificationUrl) {
    mpRequestBody.notification_url = notificationUrl;
  }

  let mpData: any = null;
  try {
    const mpResponse = await fetchFn('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpAccessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `px-order-${order.id}`,
      },
      body: JSON.stringify(mpRequestBody),
      signal: createMpTimeoutSignal(timeoutMs),
    });

    const rawText = await mpResponse.text();
    try {
      mpData = rawText ? JSON.parse(rawText) : null;
    } catch {
      mpData = null;
    }

    if (!mpResponse.ok || !mpData) {
      const mpStatusHttp = mpResponse.status || 502;
      const mpCause =
        mpData?.cause?.[0]?.description ||
        mpData?.message ||
        `HTTP ${mpStatusHttp}`;
      console.error(
        `[PX CUSTON Mercado Pago] Falha ao criar cobrança Pix para o pedido ${order.id}: ${mpCause}`
      );

      // Em caso de HTTP 5xx, 429 ou 409, reconciliar ativamente antes de decidir sobre o estoque!
      if (mpStatusHttp >= 500 || mpStatusHttp === 429 || mpStatusHttp === 409) {
        const reconciledAfter5xx = await reconcileMercadoPagoPixPaymentByOrder({
          order,
          mpAccessToken,
          supabaseClient,
          fetchImpl: fetchFn,
          timeoutMs,
        });

        if (
          reconciledAfter5xx.outcome === 'found' &&
          reconciledAfter5xx.payment &&
          (reconciledAfter5xx.payment.pix_copy_paste || reconciledAfter5xx.mpStatus === 'approved')
        ) {
          return {
            ok: true,
            statusCode: 200,
            code: 'MP_PIX_RECOVERED_AFTER_5XX',
            reconciled: true,
            recoveredFromExisting: true,
            shouldReleaseStock: false,
            persistenceOk: reconciledAfter5xx.persistenceOk,
            payment: reconciledAfter5xx.payment,
          };
        }

        if (reconciledAfter5xx.outcome === 'not_found') {
          return {
            ok: false,
            statusCode: 502,
            code: 'MP_PIX_CREATION_FAILED',
            error:
              'Não foi possível gerar a cobrança Pix oficial junto ao Mercado Pago. Confirmamos que nenhuma cobrança foi criada e o estoque reservado foi liberado.',
            shouldReleaseStock: true,
            inconclusive: false,
          };
        }

        return {
          ok: false,
          statusCode: 503,
          code: 'MP_PIX_RECONCILIATION_PENDING',
          error:
            'O Mercado Pago apresentou instabilidade temporária durante a emissão do Pix e o status da cobrança está em reconciliação. Seu pedido e estoque foram mantidos em segurança — tente novamente em instantes.',
          shouldReleaseStock: false,
          inconclusive: true,
        };
      }

      // Para respostas 4xx determinísticas, verificar na API se por algum motivo já existia cobrança vinculada
      const reconciledAfter4xx = await reconcileMercadoPagoPixPaymentByOrder({
        order,
        mpAccessToken,
        supabaseClient,
        fetchImpl: fetchFn,
        timeoutMs,
      });

      if (
        reconciledAfter4xx.outcome === 'found' &&
        reconciledAfter4xx.payment &&
        (reconciledAfter4xx.payment.pix_copy_paste || reconciledAfter4xx.mpStatus === 'approved')
      ) {
        return {
          ok: true,
          statusCode: 200,
          code: 'MP_PIX_RECOVERED_AFTER_4XX',
          reconciled: true,
          recoveredFromExisting: true,
          shouldReleaseStock: false,
          persistenceOk: reconciledAfter4xx.persistenceOk,
          payment: reconciledAfter4xx.payment,
        };
      }

      return {
        ok: false,
        statusCode: 502,
        code: 'MP_PIX_CREATION_FAILED',
        error:
          'Não foi possível gerar a cobrança Pix oficial junto ao Mercado Pago. O estoque reservado foi liberado e nenhuma cobrança foi efetuada.',
        shouldReleaseStock: true,
        inconclusive: false,
      };
    }
  } catch (networkErr: any) {
    console.error(
      `[PX CUSTON Mercado Pago] Erro de comunicação/timeout ao criar cobrança Pix para o pedido ${order.id}:`,
      networkErr?.message || networkErr
    );

    // Antes de cancelar ou liberar estoque, reconciliar ativamente no Mercado Pago!
    const reconciledAfterTimeout = await reconcileMercadoPagoPixPaymentByOrder({
      order,
      mpAccessToken,
      supabaseClient,
      fetchImpl: fetchFn,
      timeoutMs,
    });

    if (
      reconciledAfterTimeout.outcome === 'found' &&
      reconciledAfterTimeout.payment &&
      (reconciledAfterTimeout.payment.pix_copy_paste || reconciledAfterTimeout.mpStatus === 'approved')
    ) {
      return {
        ok: true,
        statusCode: 200,
        code: 'MP_PIX_RECOVERED_AFTER_TIMEOUT',
        reconciled: true,
        recoveredFromExisting: true,
        shouldReleaseStock: false,
        persistenceOk: reconciledAfterTimeout.persistenceOk,
        payment: reconciledAfterTimeout.payment,
      };
    }

    if (reconciledAfterTimeout.outcome === 'not_found') {
      return {
        ok: false,
        statusCode: 502,
        code: 'MP_PIX_NETWORK_ERROR',
        error:
          'Erro de comunicação com a API oficial do Mercado Pago. Confirmamos que nenhuma cobrança foi gerada e o estoque reservado foi liberado.',
        shouldReleaseStock: true,
        inconclusive: false,
      };
    }

    return {
      ok: false,
      statusCode: 503,
      code: 'MP_PIX_RECONCILIATION_PENDING',
      error:
        'A comunicação com o Mercado Pago oscilou durante a criação do Pix e o status da cobrança permanece em reconciliação. Seu pedido e estoque foram mantidos em segurança — tente novamente em instantes.',
      shouldReleaseStock: false,
      inconclusive: true,
    };
  }

  // 3. Validar resposta oficial do Mercado Pago (id, qr_code, external_reference, valor e moeda)
  const mpPaymentId = mpData.id ? String(mpData.id) : '';
  const txData = mpData.point_of_interaction?.transaction_data;
  const qrCodeCopyPaste =
    typeof txData?.qr_code === 'string' ? txData.qr_code.trim() : '';
  const qrCodeBase64 =
    typeof txData?.qr_code_base64 === 'string' && txData.qr_code_base64.trim()
      ? txData.qr_code_base64.trim()
      : null;
  const ticketUrl =
    typeof txData?.ticket_url === 'string' && txData.ticket_url.trim()
      ? txData.ticket_url.trim()
      : null;

  if (!mpPaymentId || !qrCodeCopyPaste) {
    console.error(
      `[PX CUSTON Mercado Pago] Resposta incompleta da API /v1/payments para o pedido ${order.id}: id ou qr_code ausente.`
    );
    return {
      ok: false,
      statusCode: 502,
      code: 'MP_PIX_INVALID_RESPONSE',
      error:
        'O Mercado Pago não retornou um QR Code Pix válido para este pedido. O pedido foi mantido para verificação.',
      shouldReleaseStock: !mpPaymentId,
      inconclusive: Boolean(mpPaymentId),
    };
  }

  if (mpData.external_reference && String(mpData.external_reference) !== order.id) {
    console.error(
      `[PX CUSTON Mercado Pago] Divergência crítica de external_reference: esperado ${order.id}, recebido ${mpData.external_reference}.`
    );
    return {
      ok: false,
      statusCode: 502,
      code: 'MP_EXTERNAL_REFERENCE_MISMATCH',
      error:
        'Falha de integridade na vinculação da cobrança Pix ao pedido.',
      shouldReleaseStock: false,
      inconclusive: true,
    };
  }

  if (mpData.currency_id && mpData.currency_id !== 'BRL') {
    console.error(
      `[PX CUSTON Mercado Pago] Moeda inválida na criação do Pix: ${mpData.currency_id}.`
    );
    return {
      ok: false,
      statusCode: 502,
      code: 'MP_CURRENCY_MISMATCH',
      error: 'Moeda retornada pelo gateway inválida (esperado BRL).',
      shouldReleaseStock: false,
      inconclusive: true,
    };
  }

  const returnedAmount = Number(mpData.transaction_amount ?? expectedAmount);
  if (Math.abs(returnedAmount - expectedAmount) > 0.05) {
    console.error(
      `[PX CUSTON Mercado Pago] Divergência de valor na criação do Pix: esperado R$ ${expectedAmount}, retornado R$ ${returnedAmount}.`
    );
    return {
      ok: false,
      statusCode: 502,
      code: 'MP_AMOUNT_MISMATCH',
      error:
        'Divergência de valor detectada na geração da cobrança Pix.',
      shouldReleaseStock: false,
      inconclusive: true,
    };
  }

  const effectiveExpiresAt =
    typeof mpData.date_of_expiration === 'string' && mpData.date_of_expiration
      ? mpData.date_of_expiration
      : expirationDateIso;

  const internalStatus = mapMercadoPagoStatusToInternal(mpData.status);

  // 4. Persistir vínculo do pagamento em public.orders e public.payments verificando { error } explicitamente
  const persistRes = await persistMercadoPagoPixChargeLink({
    supabaseClient,
    order: { id: order.id, user_id: order.user_id },
    mpPaymentId,
    amount: expectedAmount,
    status: internalStatus,
    qrCode: qrCodeCopyPaste,
    qrCodeBase64,
    ticketUrl,
    expiresAt: effectiveExpiresAt,
    liveMode: Boolean(mpData.live_mode),
    currencyId: String(mpData.currency_id || 'BRL').toUpperCase(),
  });

  if (supabaseClient && !persistRes.ok) {
    return {
      ok: false,
      statusCode: 503,
      code: 'MP_PIX_PERSISTENCE_FAILED',
      error:
        'A cobrança Pix foi gerada no Mercado Pago, mas houve uma falha ao persistir o vínculo no banco de dados. Seu pedido e estoque foram mantidos em segurança — tente novamente para recuperar o QR Code sem duplicar a cobrança.',
      shouldReleaseStock: false,
      inconclusive: true,
      persistenceOk: false,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    code: 'MP_PIX_CREATED',
    shouldReleaseStock: false,
    persistenceOk: persistRes.ok,
    payment: {
      id: mpPaymentId,
      status: internalStatus,
      method: 'pix',
      external_reference: order.id,
      gateway_ready: true,
      expires_at: effectiveExpiresAt,
      expires_in_seconds: 900,
      pix_copy_paste: qrCodeCopyPaste,
      pix_qr_code_base64: qrCodeBase64,
      ticket_url: ticketUrl,
      message:
        'Cobrança Pix gerada oficialmente pelo Mercado Pago. Aguardando confirmação do pagamento (Expira em 15 minutos).',
    },
  };
}

