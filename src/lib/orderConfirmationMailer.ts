/**
 * PX CUSTON — Serviço Transacional e Idempotente de E-mail de Confirmação de Compra
 *
 * Responsabilidades:
 * 1. Enviar e-mail de confirmação SOMENTE após confirmação efetiva do pagamento ('approved')
 *    e emissão bem-sucedida dos ingressos ('paid'/'used').
 * 2. Garantir idempotência estrita (persistente em public.order_email_notifications / public.audit_logs
 *    + lock concorrente em memória) para impedir duplicidade em webhooks repetidos.
 * 3. Permitir retentativa automática caso uma tentativa anterior tenha falhado (status = 'failed')
 *    e um novo webhook aprovado seja recebido.
 * 4. Isolar falhas de SMTP: erros de conexão, autenticação ou envio NUNCA desfazem pagamentos
 *    aprovados nem invalidam ingressos emitidos.
 * 5. Sanitizar logs e registros de erro para nunca expor SMTP_PASS, tokens ou segredos.
 */

import nodemailer from 'nodemailer';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SmtpEnvConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  configured: boolean;
  reason?: string;
}

export interface IssuedTicketSummary {
  id?: string;
  code: string;
  batch_name: string;
  holder_name: string;
  price: number;
  status: string;
  qr_payload: string;
}

export interface OrderConfirmationEmailInput {
  orderId: string;
  paymentId?: string;
  supabaseAdmin: SupabaseClient | any;
  fallbackOrder?: {
    id: string;
    user_id?: string;
    event_id: string;
    event_title?: string;
    total: number;
    payment_method: string;
    payment_status: string;
    buyer?: { id?: string; name: string; email: string; cpf?: string };
  } | null;
  mpPayerEmail?: string | null;
  /** Permite injeção controlada de transporte em testes automatizados */
  customTransport?: {
    sendMail: (mailOptions: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }) => Promise<{ messageId?: string }>;
  };
  /** Permite sobrescrever variáveis de ambiente em testes automatizados */
  envOverride?: Partial<Record<'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM', string>>;
}

export interface OrderConfirmationEmailResult {
  order_id: string;
  sent: boolean;
  already_sent: boolean;
  status: 'sent' | 'already_sent' | 'failed' | 'skipped_not_ready' | 'skipped_unconfigured' | 'in_progress';
  recipient_email?: string;
  tickets_count?: number;
  attempts?: number;
  message_id?: string;
  error?: string;
}

interface InMemoryNotificationRecord {
  order_id: string;
  recipient_email: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  message_id?: string;
  last_error?: string;
  sent_at?: string;
  updated_at: string;
}

// Estado em memória para concorrência no mesmo processo e contingência caso a migration 20261022000001 ainda não tenha sido aplicada
const inFlightOrderLocks = new Set<string>();
const memoryNotificationStore = new Map<string, InMemoryNotificationRecord>();

/**
 * Limpa estado em memória (utilizado exclusivamente por suítes de testes automatizados)
 */
export function resetOrderEmailMemoryStateForTests(orderId?: string): void {
  if (orderId) {
    inFlightOrderLocks.delete(orderId);
    memoryNotificationStore.delete(orderId);
  } else {
    inFlightOrderLocks.clear();
    memoryNotificationStore.clear();
  }
}

/**
 * Lê e valida a configuração privada de SMTP a partir das variáveis de ambiente do servidor.
 */
export function resolveSmtpConfig(
  envOverride?: Partial<Record<'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM', string>>
): SmtpEnvConfig {
  const env = {
    SMTP_HOST: envOverride?.SMTP_HOST ?? process.env.SMTP_HOST ?? '',
    SMTP_PORT: envOverride?.SMTP_PORT ?? process.env.SMTP_PORT ?? '',
    SMTP_SECURE: envOverride?.SMTP_SECURE ?? process.env.SMTP_SECURE ?? '',
    SMTP_USER: envOverride?.SMTP_USER ?? process.env.SMTP_USER ?? '',
    SMTP_PASS: envOverride?.SMTP_PASS ?? process.env.SMTP_PASS ?? '',
    SMTP_FROM: envOverride?.SMTP_FROM ?? process.env.SMTP_FROM ?? '',
  };

  const host = env.SMTP_HOST.trim();
  const portNum = parseInt(env.SMTP_PORT.trim() || '465', 10);
  const port = Number.isNaN(portNum) || portNum <= 0 ? 465 : portNum;
  const secureRaw = env.SMTP_SECURE.trim().toLowerCase();
  const secure = secureRaw === '' ? port === 465 : secureRaw === 'true' || secureRaw === '1';
  const user = env.SMTP_USER.trim();
  const pass = env.SMTP_PASS;
  const from = (env.SMTP_FROM.trim() || (user ? `PX CUSTON <${user}>` : '')).trim();

  const isPlaceholder = (val: string) => {
    const lower = val.toLowerCase();
    return (
      !val ||
      lower.includes('placeholder') ||
      lower.includes('your-provider.example') ||
      lower.includes('your-domain.example') ||
      lower.includes('your-smtp-secret') ||
      lower.includes('sua_senha')
    );
  };

  if (isPlaceholder(host) || isPlaceholder(user) || isPlaceholder(pass) || !from) {
    return {
      host,
      port,
      secure,
      user,
      pass: '',
      from,
      configured: false,
      reason: 'Variáveis SMTP_HOST, SMTP_USER, SMTP_PASS ou SMTP_FROM ausentes ou com valores de placeholder.',
    };
  }

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    configured: true,
  };
}

/**
 * Sanitiza mensagens de erro ou logs para garantir que senhas SMTP, tokens ou credenciais
 * nunca sejam gravados em banco ou exibidos nos logs do servidor.
 */
export function sanitizeSmtpError(rawError: unknown, extraSecrets: string[] = []): string {
  const errObj = rawError as Record<string, unknown> | null;
  const parts: string[] = [];

  if (rawError instanceof Error) {
    parts.push(rawError.message);
  } else if (typeof rawError === 'string') {
    parts.push(rawError);
  } else if (rawError) {
    parts.push(JSON.stringify(rawError));
  }

  if (errObj && typeof errObj === 'object') {
    if (typeof errObj.response === 'string' && !parts.includes(errObj.response)) {
      parts.push(errObj.response);
    }
    if (typeof errObj.code === 'string' && !parts.join(' ').includes(errObj.code)) {
      parts.unshift(`[${errObj.code}]`);
    }
  }

  const rawMessage = parts.filter(Boolean).join(' | ') || 'Erro desconhecido no envio SMTP';

  let sanitized = rawMessage
    // Ocultar credenciais em URIs (ex: smtp://user:pass@host ou smtps://user:pass@host)
    .replace(/:\/\/([^:\s]+):([^@\s]+)@/gi, '://***:***@')
    // Ocultar comandos SMTP AUTH PLAIN / AUTH LOGIN com payload Base64
    .replace(/\bAUTH\s+(?:PLAIN|LOGIN)\s+[^\s'"]+/gi, 'AUTH [REDACTED]')
    // Ocultar padrões de senha, token ou credencial em mensagens de autenticação
    .replace(
      /(password|pass|passwd|secret|token|auth|credentials|authorization)\s*[:=]\s*(['"]?)[^\s,'";]+(\2)/gi,
      '$1=[REDACTED]'
    );

  const baseSecrets = [
    process.env.SMTP_PASS,
    process.env.MP_ACCESS_TOKEN,
    process.env.MP_CLIENT_SECRET,
    process.env.SUPABASE_SECRET_KEY,
    ...extraSecrets,
  ].filter((s): s is string => Boolean(s && s.trim().length >= 3));

  const secretsToScrub = new Set<string>();
  for (const sec of baseSecrets) {
    secretsToScrub.add(sec);
    secretsToScrub.add(sec.trim());
    try {
      secretsToScrub.add(encodeURIComponent(sec));
      secretsToScrub.add(Buffer.from(sec).toString('base64'));
    } catch {
      // Ignorar falha de encoding auxiliar
    }
  }

  for (const secret of secretsToScrub) {
    if (!secret || secret.length < 3) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }

  return sanitized.slice(0, 500);
}

/**
 * Escapa caracteres HTML para evitar injeção no template de e-mail
 */
function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPaymentMethodLabel(method: string): string {
  switch ((method || '').toLowerCase()) {
    case 'pix':
      return 'PIX Instantâneo';
    case 'credit_card':
      return 'Cartão de Crédito';
    case 'boleto':
      return 'Boleto Bancário';
    default:
      return method || 'Mercado Pago';
  }
}

/**
 * Constrói o conteúdo HTML e Texto Puro do e-mail oficial de confirmação da PX CUSTON
 */
export function buildOrderConfirmationEmailContent(params: {
  orderId: string;
  buyerName: string;
  eventTitle: string;
  eventDateFormatted: string;
  eventLocation: string;
  totalAmount: number;
  paymentMethod: string;
  tickets: IssuedTicketSummary[];
}): { subject: string; text: string; html: string } {
  const {
    orderId,
    buyerName,
    eventTitle,
    eventDateFormatted,
    eventLocation,
    totalAmount,
    paymentMethod,
    tickets,
  } = params;

  const shortOrder = orderId.slice(0, 8).toUpperCase();
  const formattedTotal = `R$ ${Number(totalAmount || 0).toFixed(2).replace('.', ',')}`;
  const paymentLabel = formatPaymentMethodLabel(paymentMethod);
  const subject = `Pagamento Confirmado! Seus ingressos para ${eventTitle} — Pedido #${shortOrder}`;

  const ticketsTextList = tickets
    .map(
      (t, idx) =>
        `  ${idx + 1}. Código: ${t.code} | Lote: ${t.batch_name} | Titular: ${t.holder_name} | QR Check-in: ${t.qr_payload}`
    )
    .join('\n');

  const text = [
    `OLÁ, ${buyerName.toUpperCase()}!`,
    '',
    `Seu pagamento foi aprovado e seus ingressos oficiais para ${eventTitle} já foram emitidos.`,
    '',
    '=== RESUMO DO PEDIDO ===',
    `Pedido: #${shortOrder} (${orderId})`,
    `Evento: ${eventTitle}`,
    `Data: ${eventDateFormatted}`,
    `Local: ${eventLocation}`,
    `Forma de Pagamento: ${paymentLabel}`,
    `Total Pago: ${formattedTotal}`,
    '',
    `=== SEUS INGRESSOS EMITIDOS (${tickets.length}) ===`,
    ticketsTextList,
    '',
    'Apresente o QR Code ou o código PX-XXXXXXXX na portaria oficial (PX CHECK-IN) no dia do evento.',
    'Você também pode acessar seus ingressos a qualquer momento na aba "Meus Ingressos" da plataforma PX CUSTON.',
    '',
    'PX CUSTON — Eventos, Carros e Experiências.',
  ].join('\n');

  const ticketsHtmlRows = tickets
    .map(
      (t) => `
      <tr>
        <td style="padding: 14px 16px; border-bottom: 1px solid #262626; color: #ffffff; font-family: monospace; font-size: 15px; font-weight: 700; letter-spacing: 0.06em;">
          ${escapeHtml(t.code)}
        </td>
        <td style="padding: 14px 16px; border-bottom: 1px solid #262626; color: #e5e5e5; font-size: 14px;">
          ${escapeHtml(t.batch_name)}
        </td>
        <td style="padding: 14px 16px; border-bottom: 1px solid #262626; color: #a3a3a3; font-size: 13px;">
          ${escapeHtml(t.holder_name)}
        </td>
        <td style="padding: 14px 16px; border-bottom: 1px solid #262626; text-align: right;">
          <span style="display: inline-block; padding: 4px 10px; background-color: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">
            LIBERADO
          </span>
        </td>
      </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0a0a0a; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 620px; background-color: #121212; border: 1px solid #262626;">
          <!-- Header -->
          <tr>
            <td style="padding: 28px 32px; background-color: #0d0d0d; border-bottom: 3px solid #E11D48;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.2em; color: #E11D48; margin-bottom: 6px;">
                PX CUSTON // CREDENCIAMENTO OFICIAL
              </div>
              <div style="font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: #ffffff;">
                PAGAMENTO CONFIRMADO
              </div>
            </td>
          </tr>

          <!-- Saudação -->
          <tr>
            <td style="padding: 28px 32px 16px 32px;">
              <p style="margin: 0 0 12px 0; font-size: 16px; color: #ffffff;">
                Olá, <strong>${escapeHtml(buyerName)}</strong>!
              </p>
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #a3a3a3;">
                Seu pagamento via <strong>${escapeHtml(paymentLabel)}</strong> foi aprovado e seus ingressos oficiais para o evento <strong style="color: #ffffff;">${escapeHtml(eventTitle)}</strong> já estão disponíveis e prontos para o check-in.
              </p>
            </td>
          </tr>

          <!-- Resumo do Pedido -->
          <tr>
            <td style="padding: 12px 32px 20px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #171717; border: 1px solid #262626; padding: 18px;">
                <tr>
                  <td style="padding-bottom: 10px; font-size: 12px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em;">Evento</td>
                  <td style="padding-bottom: 10px; font-size: 14px; color: #ffffff; font-weight: 700; text-align: right;">${escapeHtml(eventTitle)}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 12px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em;">Data / Local</td>
                  <td style="padding-bottom: 10px; font-size: 13px; color: #d4d4d4; text-align: right;">${escapeHtml(eventDateFormatted)} — ${escapeHtml(eventLocation)}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 12px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em;">Pedido</td>
                  <td style="padding-bottom: 10px; font-size: 13px; color: #d4d4d4; font-family: monospace; text-align: right;">#${escapeHtml(shortOrder)}</td>
                </tr>
                <tr>
                  <td style="font-size: 12px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em;">Total Confirmado</td>
                  <td style="font-size: 16px; color: #34d399; font-weight: 800; text-align: right;">${escapeHtml(formattedTotal)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Lista de Ingressos -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #E11D48; margin-bottom: 10px;">
                Ingressos Emitidos (${tickets.length})
              </div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #171717; border: 1px solid #262626;">
                <thead>
                  <tr style="background-color: #1f1f1f;">
                    <th align="left" style="padding: 10px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a3a3a3;">Código</th>
                    <th align="left" style="padding: 10px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a3a3a3;">Lote</th>
                    <th align="left" style="padding: 10px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a3a3a3;">Titular</th>
                    <th align="right" style="padding: 10px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a3a3a3;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${ticketsHtmlRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Instruções de Check-in -->
          <tr>
            <td style="padding: 0 32px 28px 32px;">
              <div style="padding: 16px; background-color: #18181b; border-left: 3px solid #E11D48; font-size: 13px; line-height: 1.5; color: #a3a3a3;">
                <strong style="color: #ffffff;">Check-in na Portaria:</strong> Acesse a área <strong>Meus Ingressos</strong> na plataforma PX CUSTON pelo seu celular para apresentar o QR Code oficial na entrada do evento.
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; background-color: #0d0d0d; border-top: 1px solid #262626; font-size: 12px; color: #525252; text-align: center;">
              PX CUSTON — Plataforma Oficial de Eventos Automotivos &amp; Check-in Online.<br />
              Este é um e-mail automático referente ao pedido ${escapeHtml(orderId)}.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Analisa registros de public.audit_logs para determinar estado persistente de envio/claim
 * quando a migração 20261022000001_order_email_notifications.sql ainda não foi aplicada.
 */
function evaluateAuditLogsEmailState(
  rows: Array<{ id?: string; action?: string; created_at?: string; details?: any }>,
  nowMs: number
): {
  alreadySent: boolean;
  sentRow?: { id?: string; created_at?: string; details?: any };
  failedCount: number;
  activeClaims: Array<{ claimId: string; createdAtMs: number; rowId: string }>;
} {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sentRow = safeRows.find((r) => r?.action === 'ORDER_CONFIRMATION_EMAIL_SENT');

  const failedClaimIds = new Set<string>();
  let latestFailMs = 0;
  let failedCount = 0;

  for (const r of safeRows) {
    if (r?.action === 'ORDER_CONFIRMATION_EMAIL_FAILED') {
      failedCount++;
      const cid = r?.details?.claim_id;
      if (typeof cid === 'string' && cid) {
        failedClaimIds.add(cid);
      }
      const ts = r?.created_at ? new Date(r.created_at).getTime() : 0;
      if (!Number.isNaN(ts) && ts > latestFailMs) {
        latestFailMs = ts;
      }
    }
  }

  const activeClaims: Array<{ claimId: string; createdAtMs: number; rowId: string }> = [];
  for (const r of safeRows) {
    if (r?.action === 'ORDER_CONFIRMATION_EMAIL_CLAIM') {
      const claimId = String(r?.details?.claim_id || r?.id || '');
      const createdAtMs = r?.created_at ? new Date(r.created_at).getTime() : 0;
      const isRecent = !Number.isNaN(createdAtMs) && createdAtMs > 0 && nowMs - createdAtMs < 120_000;
      const isFailedById = claimId ? failedClaimIds.has(claimId) : false;
      const isSupersededByFail = !claimId && latestFailMs >= createdAtMs;

      if (isRecent && !isFailedById && !isSupersededByFail) {
        activeClaims.push({
          claimId,
          createdAtMs,
          rowId: String(r?.id || ''),
        });
      }
    }
  }

  activeClaims.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    if (a.rowId !== b.rowId) return a.rowId.localeCompare(b.rowId);
    return a.claimId.localeCompare(b.claimId);
  });

  return {
    alreadySent: Boolean(sentRow),
    sentRow,
    failedCount,
    activeClaims,
  };
}

/**
 * Verifica e reserva de forma idempotente o envio de confirmação do pedido.
 * Prioriza:
 * 1. Função RPC atômica `claim_order_confirmation_email` (com FOR UPDATE em `order_email_notifications`)
 * 2. Acesso direto à tabela `public.order_email_notifications`
 * 3. Reserva persistente e determinística em `public.audit_logs` (segura entre múltiplos processos e reinicializações)
 * Se nenhuma camada persistente do banco estiver acessível, falha de forma fechada (fail-closed) para nunca duplicar e-mails.
 */
async function claimOrderEmailSend(
  supabaseAdmin: any,
  orderId: string,
  recipientEmail: string
): Promise<{
  claimed: boolean;
  alreadySent: boolean;
  inProgress?: boolean;
  attempts: number;
  usedTable: boolean;
  claimId?: string;
  persistenceError?: string;
}> {
  const mem = memoryNotificationStore.get(orderId);
  if (mem?.status === 'sent') {
    return {
      claimed: false,
      alreadySent: true,
      attempts: mem.attempts,
      usedTable: false,
    };
  }

  // 1. Tentar RPC atômica no PostgreSQL (public.claim_order_confirmation_email)
  try {
    const { data: claimData, error: claimErr } = await supabaseAdmin.rpc('claim_order_confirmation_email', {
      p_order_id: orderId,
      p_recipient_email: recipientEmail,
      p_notification_type: 'order_confirmation',
    });

    if (!claimErr && claimData) {
      if (claimData.already_sent === true || claimData.status === 'sent') {
        memoryNotificationStore.set(orderId, {
          order_id: orderId,
          recipient_email: recipientEmail,
          status: 'sent',
          attempts: Number(claimData.attempts || 1),
          message_id: claimData.message_id,
          sent_at: claimData.sent_at,
          updated_at: new Date().toISOString(),
        });
        return {
          claimed: false,
          alreadySent: true,
          attempts: Number(claimData.attempts || 1),
          usedTable: true,
        };
      }

      if (claimData.in_progress === true) {
        return {
          claimed: false,
          alreadySent: false,
          inProgress: true,
          attempts: Number(claimData.attempts || 1),
          usedTable: true,
        };
      }

      if (claimData.claimed === true) {
        const attempts = Number(claimData.attempts || 1);
        memoryNotificationStore.set(orderId, {
          order_id: orderId,
          recipient_email: recipientEmail,
          status: 'sending',
          attempts,
          updated_at: new Date().toISOString(),
        });
        return {
          claimed: true,
          alreadySent: false,
          attempts,
          usedTable: true,
        };
      }
    }
  } catch {
    // Continua para verificação direta na tabela ou audit_logs
  }

  // 2. Fallback: Verificar tabela public.order_email_notifications diretamente
  try {
    const { data: existingRow, error: selErr } = await supabaseAdmin
      .from('order_email_notifications')
      .select('id, status, attempts, message_id, sent_at, updated_at')
      .eq('order_id', orderId)
      .eq('notification_type', 'order_confirmation')
      .maybeSingle();

    if (!selErr) {
      if (existingRow?.status === 'sent') {
        memoryNotificationStore.set(orderId, {
          order_id: orderId,
          recipient_email: recipientEmail,
          status: 'sent',
          attempts: Number(existingRow.attempts || 1),
          message_id: existingRow.message_id,
          sent_at: existingRow.sent_at,
          updated_at: new Date().toISOString(),
        });
        return {
          claimed: false,
          alreadySent: true,
          attempts: Number(existingRow.attempts || 1),
          usedTable: true,
        };
      }

      if (existingRow?.status === 'sending' && existingRow.updated_at) {
        const updatedMs = new Date(existingRow.updated_at).getTime();
        if (!Number.isNaN(updatedMs) && Date.now() - updatedMs < 120_000) {
          return {
            claimed: false,
            alreadySent: false,
            inProgress: true,
            attempts: Number(existingRow.attempts || 1),
            usedTable: true,
          };
        }
      }

      const nextAttempts = Number(existingRow?.attempts || 0) + 1;
      const { error: upsertErr } = await supabaseAdmin.from('order_email_notifications').upsert(
        {
          order_id: orderId,
          notification_type: 'order_confirmation',
          recipient_email: recipientEmail,
          status: 'sending',
          attempts: nextAttempts,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'order_id,notification_type' }
      );

      if (!upsertErr) {
        memoryNotificationStore.set(orderId, {
          order_id: orderId,
          recipient_email: recipientEmail,
          status: 'sending',
          attempts: nextAttempts,
          updated_at: new Date().toISOString(),
        });

        return {
          claimed: true,
          alreadySent: false,
          attempts: nextAttempts,
          usedTable: true,
        };
      }
    }
  } catch {
    // Tabela order_email_notifications ainda não aplicada no banco remoto; usar audit_logs persistente
  }

  // 3. Fallback persistente em public.audit_logs (seguro entre processos e reinicializações)
  try {
    const readAuditRows = async (): Promise<{
      rows: Array<{ id?: string; action?: string; created_at?: string; details?: any }>;
      error: any;
    }> => {
      const query = supabaseAdmin
        .from('audit_logs')
        .select('id, action, created_at, details')
        .eq('entity', 'order_email_confirmation')
        .eq('entity_id', orderId);

      const res = typeof query.order === 'function'
        ? await query.order('created_at', { ascending: true })
        : await query;

      if (res?.error) {
        return { rows: [], error: res.error };
      }
      if (Array.isArray(res?.data)) {
        return { rows: res.data, error: null };
      }
      return { rows: [], error: null };
    };

    const initialAudit = await readAuditRows();
    if (initialAudit.error) {
      return {
        claimed: false,
        alreadySent: false,
        inProgress: false,
        attempts: 0,
        usedTable: false,
        persistenceError: `Não foi possível consultar public.audit_logs para idempotência: ${initialAudit.error.message || 'erro desconhecido'}`,
      };
    }

    const nowMs = Date.now();
    const initialState = evaluateAuditLogsEmailState(initialAudit.rows, nowMs);

    if (initialState.alreadySent) {
      const attempts = Number(initialState.sentRow?.details?.attempts || initialState.failedCount + 1);
      memoryNotificationStore.set(orderId, {
        order_id: orderId,
        recipient_email: recipientEmail,
        status: 'sent',
        attempts,
        message_id: initialState.sentRow?.details?.message_id,
        sent_at: initialState.sentRow?.created_at,
        updated_at: new Date().toISOString(),
      });
      return {
        claimed: false,
        alreadySent: true,
        attempts,
        usedTable: false,
      };
    }

    if (initialState.activeClaims.length > 0) {
      return {
        claimed: false,
        alreadySent: false,
        inProgress: true,
        attempts: initialState.failedCount + 1,
        usedTable: false,
      };
    }

    // Inserir claim persistente em public.audit_logs ANTES do disparo SMTP
    // Nota: actor_id é definido como NULL para evitar violação de FK caso user_id não exista em public.profiles
    const claimId = `claim-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
    const nextAttempts = initialState.failedCount + 1;
    const claimTimestampIso = new Date(nowMs).toISOString();

    const { error: insertClaimErr } = await supabaseAdmin.from('audit_logs').insert({
      actor_id: null,
      action: 'ORDER_CONFIRMATION_EMAIL_CLAIM',
      entity: 'order_email_confirmation',
      entity_id: orderId,
      details: {
        claim_id: claimId,
        order_id: orderId,
        recipient_email: recipientEmail,
        attempts: nextAttempts,
        timestamp: claimTimestampIso,
      },
    });

    if (insertClaimErr) {
      return {
        claimed: false,
        alreadySent: false,
        inProgress: false,
        attempts: nextAttempts,
        usedTable: false,
        persistenceError: `Não foi possível registrar reserva de envio em public.audit_logs: ${insertClaimErr.message || 'erro desconhecido'}`,
      };
    }

    // Revalidar após inserção para resolver condições de corrida entre processos distintos
    const postClaimAudit = await readAuditRows();
    if (!postClaimAudit.error && postClaimAudit.rows.length > 0) {
      const postState = evaluateAuditLogsEmailState(postClaimAudit.rows, Date.now());
      if (postState.alreadySent) {
        return {
          claimed: false,
          alreadySent: true,
          attempts: nextAttempts,
          usedTable: false,
        };
      }

      if (postState.activeClaims.length > 0 && postState.activeClaims[0].claimId !== claimId) {
        return {
          claimed: false,
          alreadySent: false,
          inProgress: true,
          attempts: nextAttempts,
          usedTable: false,
        };
      }
    }

    memoryNotificationStore.set(orderId, {
      order_id: orderId,
      recipient_email: recipientEmail,
      status: 'sending',
      attempts: nextAttempts,
      updated_at: claimTimestampIso,
    });

    return {
      claimed: true,
      alreadySent: false,
      attempts: nextAttempts,
      usedTable: false,
      claimId,
    };
  } catch (err: unknown) {
    return {
      claimed: false,
      alreadySent: false,
      inProgress: false,
      attempts: 0,
      usedTable: false,
      persistenceError: sanitizeSmtpError(err),
    };
  }
}

/**
 * Registra o resultado final (sucesso ou falha) de forma persistente e segura (sem expor segredos).
 */
async function persistOrderEmailOutcome(params: {
  supabaseAdmin: any;
  orderId: string;
  verifiedActorId?: string | null;
  recipientEmail: string;
  status: 'sent' | 'failed';
  attempts: number;
  claimId?: string;
  messageId?: string;
  sanitizedError?: string;
  ticketsCount: number;
  paymentId?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    orderId,
    verifiedActorId,
    recipientEmail,
    status,
    attempts,
    claimId,
    messageId,
    sanitizedError,
    ticketsCount,
    paymentId,
  } = params;

  const nowIso = new Date().toISOString();

  memoryNotificationStore.set(orderId, {
    order_id: orderId,
    recipient_email: recipientEmail,
    status,
    attempts,
    message_id: messageId,
    last_error: sanitizedError,
    sent_at: status === 'sent' ? nowIso : undefined,
    updated_at: nowIso,
  });

  // 1. Atualizar tabela dedicada public.order_email_notifications (se existir)
  try {
    if (status === 'sent') {
      await supabaseAdmin.from('order_email_notifications').upsert(
        {
          order_id: orderId,
          notification_type: 'order_confirmation',
          recipient_email: recipientEmail,
          status: 'sent',
          attempts,
          message_id: messageId || null,
          last_error: null,
          sent_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'order_id,notification_type' }
      );
    } else {
      // Quando 'failed', nunca sobrescrever um registro que já esteja 'sent'
      const { data: currentRow } = await supabaseAdmin
        .from('order_email_notifications')
        .select('status')
        .eq('order_id', orderId)
        .eq('notification_type', 'order_confirmation')
        .maybeSingle();

      if (currentRow?.status !== 'sent') {
        await supabaseAdmin.from('order_email_notifications').upsert(
          {
            order_id: orderId,
            notification_type: 'order_confirmation',
            recipient_email: recipientEmail,
            status: 'failed',
            attempts,
            message_id: null,
            last_error: sanitizedError || 'Falha no envio SMTP',
            sent_at: null,
            updated_at: nowIso,
          },
          { onConflict: 'order_id,notification_type' }
        );
      }
    }
  } catch {
    // Silencioso caso a tabela ainda não exista
  }

  // 2. Registrar trilha de auditoria em public.audit_logs (presente desde a migração 01)
  try {
    const auditPayload = {
      actor_id: verifiedActorId || null,
      action: status === 'sent' ? 'ORDER_CONFIRMATION_EMAIL_SENT' : 'ORDER_CONFIRMATION_EMAIL_FAILED',
      entity: 'order_email_confirmation',
      entity_id: orderId,
      details: {
        claim_id: claimId || null,
        order_id: orderId,
        recipient_email: recipientEmail,
        status,
        attempts,
        tickets_count: ticketsCount,
        payment_id: paymentId || null,
        message_id: messageId || null,
        error: status === 'failed' ? sanitizedError : null,
        timestamp: nowIso,
      },
    };

    const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert(auditPayload);
    if (auditErr && auditPayload.actor_id !== null) {
      // Retentar com actor_id: null caso haja restrição de FK em public.profiles
      await supabaseAdmin.from('audit_logs').insert({
        ...auditPayload,
        actor_id: null,
      });
    }
  } catch {
    // Nunca propagar erro de log para o fluxo de pagamento
  }
}

/**
 * Envia o e-mail de confirmação de compra de forma idempotente e tolerante a falhas.
 * Nunca lança exceções para o chamador (garantindo que falhas de SMTP jamais revertam pagamentos ou ingressos).
 */
export async function sendOrderConfirmationEmailIfNeeded(
  input: OrderConfirmationEmailInput
): Promise<OrderConfirmationEmailResult> {
  const { orderId, paymentId, supabaseAdmin, fallbackOrder, mpPayerEmail, customTransport, envOverride } = input;

  if (!orderId) {
    return {
      order_id: '',
      sent: false,
      already_sent: false,
      status: 'skipped_not_ready',
      error: 'Identificador do pedido ausente.',
    };
  }

  // Proteção contra execução simultânea no mesmo processo (race condition de webhooks paralelos)
  if (inFlightOrderLocks.has(orderId)) {
    return {
      order_id: orderId,
      sent: false,
      already_sent: false,
      status: 'in_progress',
    };
  }

  inFlightOrderLocks.add(orderId);

  try {
    // 1. Consultar pedido oficial no banco para confirmar que o pagamento está 'approved'
    let orderRecord: any = null;
    try {
      const { data } = await supabaseAdmin
        .from('orders')
        .select('id, user_id, event_id, total, payment_method, payment_status, created_at')
        .eq('id', orderId)
        .maybeSingle();
      orderRecord = data;
    } catch {
      orderRecord = null;
    }

    if (!orderRecord && fallbackOrder) {
      orderRecord = fallbackOrder;
    }

    if (!orderRecord || orderRecord.payment_status !== 'approved') {
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'skipped_not_ready',
        error: 'O pedido ainda não consta com pagamento aprovado.',
      };
    }

    // 2. Consultar ingressos emitidos para o pedido (obrigatório ter ingressos emitidos antes de enviar confirmação)
    let rawTickets: any[] = [];
    try {
      const { data: ticketRows } = await supabaseAdmin
        .from('tickets')
        .select('id, code, batch_id, holder_name, price, status, qr_payload')
        .eq('order_id', orderId)
        .in('status', ['paid', 'used']);
      if (Array.isArray(ticketRows)) {
        rawTickets = ticketRows;
      }
    } catch {
      rawTickets = [];
    }

    if (rawTickets.length === 0) {
      console.warn(
        `[PX CUSTON Mailer] Envio adiado para o pedido ${orderId}: nenhum ingresso ativo encontrado em public.tickets.`
      );
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'skipped_not_ready',
        error: 'Ingressos ainda não localizados para o pedido aprovado.',
      };
    }

    // Buscar nomes dos lotes (ticket_batches) para compor o resumo dos ingressos
    const batchNamesMap = new Map<string, string>();
    const batchIds = Array.from(new Set(rawTickets.map((t) => t.batch_id).filter(Boolean)));
    if (batchIds.length > 0) {
      try {
        const { data: batches } = await supabaseAdmin
          .from('ticket_batches')
          .select('id, name')
          .in('id', batchIds);
        if (Array.isArray(batches)) {
          for (const b of batches) {
            if (b?.id && b?.name) batchNamesMap.set(b.id, b.name);
          }
        }
      } catch {
        // Fallback para nome padrão caso a consulta de lotes falhe
      }
    }

    const issuedTickets: IssuedTicketSummary[] = rawTickets.map((t) => ({
      id: t.id,
      code: t.code,
      batch_name: t.batch_name || batchNamesMap.get(t.batch_id) || 'Ingresso Oficial PX CUSTON',
      holder_name: t.holder_name || fallbackOrder?.buyer?.name || 'Cliente PX',
      price: Number(t.price || 0),
      status: t.status || 'paid',
      qr_payload: t.qr_payload || `PX:${t.code}:${orderRecord.event_id}`,
    }));

    // 3. Identificar comprador (public.profiles -> fallbackOrder -> mpPayerEmail)
    let buyerProfile: { id?: string; email?: string; full_name?: string } | null = null;
    if (orderRecord.user_id) {
      try {
        const { data: prof } = await supabaseAdmin
          .from('profiles')
          .select('id, email, full_name')
          .eq('id', orderRecord.user_id)
          .maybeSingle();
        buyerProfile = prof;
      } catch {
        buyerProfile = null;
      }
    }

    const recipientEmail = (
      buyerProfile?.email ||
      fallbackOrder?.buyer?.email ||
      mpPayerEmail ||
      ''
    )
      .trim()
      .toLowerCase();

    const buyerName =
      buyerProfile?.full_name ||
      fallbackOrder?.buyer?.name ||
      issuedTickets[0]?.holder_name ||
      'Cliente PX';

    if (!recipientEmail || !recipientEmail.includes('@')) {
      console.warn(`[PX CUSTON Mailer] Pedido ${orderId} aprovado, porém sem e-mail de destinatário válido.`);
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'skipped_not_ready',
        error: 'E-mail do comprador não encontrado.',
      };
    }

    // 4. Consultar detalhes do evento
    let eventDetails: { title?: string; formatted_date?: string; location?: string; city?: string; state?: string } | null = null;
    if (orderRecord.event_id) {
      try {
        const { data: evt } = await supabaseAdmin
          .from('events')
          .select('title, formatted_date, location, city, state')
          .eq('id', orderRecord.event_id)
          .maybeSingle();
        eventDetails = evt;
      } catch {
        eventDetails = null;
      }
    }

    const eventTitle = eventDetails?.title || fallbackOrder?.event_title || 'Evento Oficial PX CUSTON';
    const eventDateFormatted = eventDetails?.formatted_date || 'Data oficial confirmada';
    const eventLocation = eventDetails?.location
      ? `${eventDetails.location}${eventDetails.city ? ` - ${eventDetails.city}/${eventDetails.state || ''}` : ''}`
      : 'Local oficial PX CUSTON';

    // 5. Verificar configuração SMTP antes de reservar tentativa (exceto quando há customTransport de teste)
    const smtpConfig = resolveSmtpConfig(envOverride);
    if (!customTransport && !smtpConfig.configured) {
      console.warn(
        `[PX CUSTON Mailer] Envio de e-mail para pedido ${orderId} pendente de configuração SMTP (${smtpConfig.reason}). Pagamento e ingressos permanecem válidos.`
      );
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'skipped_unconfigured',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        error: smtpConfig.reason,
      };
    }

    // 6. Verificação e reserva idempotente (evita duplicação em webhooks repetidos)
    const claim = await claimOrderEmailSend(supabaseAdmin, orderId, recipientEmail);
    if (claim.alreadySent) {
      console.log(
        `[PX CUSTON Mailer] Idempotência: E-mail de confirmação do pedido ${orderId} já foi enviado anteriormente. Ignorando duplicata.`
      );
      return {
        order_id: orderId,
        sent: false,
        already_sent: true,
        status: 'already_sent',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        attempts: claim.attempts,
      };
    }

    if (claim.persistenceError) {
      const sanitizedPersistErr = sanitizeSmtpError(claim.persistenceError, [smtpConfig.pass]);
      console.error(
        `[PX CUSTON Mailer] ⚠️ Envio abortado de forma segura (fail-closed) para o pedido ${orderId}: não foi possível garantir lock persistente no banco (${sanitizedPersistErr}).`
      );
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'failed',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        attempts: claim.attempts,
        error: sanitizedPersistErr,
      };
    }

    if (claim.inProgress || !claim.claimed) {
      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'in_progress',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        attempts: claim.attempts,
      };
    }

    // 7. Montar conteúdo e enviar via transporte SMTP
    const emailContent = buildOrderConfirmationEmailContent({
      orderId,
      buyerName,
      eventTitle,
      eventDateFormatted,
      eventLocation,
      totalAmount: Number(orderRecord.total || 0),
      paymentMethod: String(orderRecord.payment_method || 'pix'),
      tickets: issuedTickets,
    });

    const transporter =
      customTransport ||
      nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: {
          user: smtpConfig.user,
          pass: smtpConfig.pass,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });

    const fromAddress = smtpConfig.from || 'PX CUSTON <no-reply@pxcuston.com.br>';

    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to: recipientEmail,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      const messageId = info?.messageId || `px-mail-${Date.now()}`;

      await persistOrderEmailOutcome({
        supabaseAdmin,
        orderId,
        verifiedActorId: buyerProfile?.id || null,
        recipientEmail,
        status: 'sent',
        attempts: claim.attempts,
        claimId: claim.claimId,
        messageId,
        ticketsCount: issuedTickets.length,
        paymentId,
      });

      console.log(
        `[PX CUSTON Mailer] ✅ E-mail de confirmação enviado com sucesso para o pedido ${orderId} (${issuedTickets.length} ingresso(s), tentativa #${claim.attempts}).`
      );

      return {
        order_id: orderId,
        sent: true,
        already_sent: false,
        status: 'sent',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        attempts: claim.attempts,
        message_id: messageId,
      };
    } catch (sendErr: unknown) {
      const sanitizedError = sanitizeSmtpError(sendErr, [smtpConfig.pass]);

      await persistOrderEmailOutcome({
        supabaseAdmin,
        orderId,
        verifiedActorId: buyerProfile?.id || null,
        recipientEmail,
        status: 'failed',
        attempts: claim.attempts,
        claimId: claim.claimId,
        sanitizedError,
        ticketsCount: issuedTickets.length,
        paymentId,
      });

      console.error(
        `[PX CUSTON Mailer] ⚠️ Falha ao enviar e-mail de confirmação para o pedido ${orderId} (tentativa #${claim.attempts}). O pagamento aprovado e os ingressos emitidos foram preservados. Causa: ${sanitizedError}`
      );

      return {
        order_id: orderId,
        sent: false,
        already_sent: false,
        status: 'failed',
        recipient_email: recipientEmail,
        tickets_count: issuedTickets.length,
        attempts: claim.attempts,
        error: sanitizedError,
      };
    }
  } catch (unexpectedErr: unknown) {
    const sanitizedError = sanitizeSmtpError(unexpectedErr, [envOverride?.SMTP_PASS || '']);
    console.error(
      `[PX CUSTON Mailer] ⚠️ Exceção isolada no fluxo de e-mail do pedido ${orderId} (pagamento e ingressos preservados): ${sanitizedError}`
    );
    return {
      order_id: orderId,
      sent: false,
      already_sent: false,
      status: 'failed',
      error: sanitizedError,
    };
  } finally {
    inFlightOrderLocks.delete(orderId);
  }
}
