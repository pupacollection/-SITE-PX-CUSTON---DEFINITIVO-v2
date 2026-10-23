/**
 * PX CUSTON — Módulo de Validação e Integridade de Check-in
 * 
 * Processa a resposta oficial da Stored Procedure validate_and_checkin_ticket.
 * Garante que:
 * 1. Respostas nulas, erros operacionais ou de rede resultem em HTTP 503 (sem fallback).
 * 2. Arrays, valores primitivos ou objetos malformados resultem em HTTP 503.
 * 3. Respostas success=true sem os campos obrigatórios retornados pelo banco
 *    (code, event, holder, batch, timestamp e status='success') resultem em HTTP 503.
 * 4. Status mapeados da procedure (success, already_used, invalid_status, not_found)
 *    tenham seus códigos HTTP correspondentes (200, 409, 400, 404).
 * 5. Em produção, nenhum código demo receba bypass do banco oficial (estrito HTTP 404).
 */

export interface TicketValidationOutcome {
  statusCode: number;
  payload: {
    valid: boolean;
    code?: string;
    event?: string;
    holder?: string;
    batch?: string;
    status: string;
    message?: string;
    timestamp?: string;
  };
}

export interface ValidateCheckinParams {
  rpcResult: any;
  rpcError: any;
  cleanCode: string;
  isProduction: boolean;
  demoUsedMap: Map<string, { checkin_at: string; operator: string; device: string }>;
  operatorId?: string;
  deviceId?: string;
}

/**
 * Avalia estritamente a saída da procedure validate_and_checkin_ticket.
 * Não realiza mutações no banco de dados nem contingências inseguras desacopladas.
 */
export function evaluateTicketValidationOutcome(params: ValidateCheckinParams): TicketValidationOutcome {
  const { rpcResult, rpcError, cleanCode, isProduction, demoUsedMap, operatorId, deviceId } = params;

  // 1. Falha operacional na RPC (erro de rede/banco) ou resultado ausente (null/undefined)
  if (rpcError || !rpcResult) {
    return {
      statusCode: 503,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'service_unavailable',
        message: 'Serviço de validação temporariamente indisponível. Operação abortada por segurança.',
      },
    };
  }

  // 2. Rejeição estrita de arrays, tipos primitivos ou estruturas não-objeto
  if (typeof rpcResult !== 'object' || Array.isArray(rpcResult)) {
    return {
      statusCode: 503,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'service_unavailable',
        message: 'Resposta inválida ou malformada do procedimento de validação. Operação abortada por segurança.',
      },
    };
  }

  // 3. Sucesso: Ingresso válido, pago, atualizado e auditado atomicamente na procedure
  if (rpcResult.success === true) {
    // Validar rigorosamente o contrato de sucesso retornado pela procedure SQL:
    // Deve conter status === 'success', code, event, holder, batch e timestamp
    if (
      rpcResult.status !== 'success' ||
      !rpcResult.code ||
      typeof rpcResult.code !== 'string' ||
      !rpcResult.event ||
      typeof rpcResult.event !== 'string' ||
      !rpcResult.holder ||
      typeof rpcResult.holder !== 'string' ||
      !rpcResult.batch ||
      typeof rpcResult.batch !== 'string' ||
      !rpcResult.timestamp
    ) {
      return {
        statusCode: 503,
        payload: {
          valid: false,
          code: cleanCode,
          status: 'service_unavailable',
          message: 'Procedimento retornou payload de sucesso incompleto ou malformado. Operação abortada por segurança.',
        },
      };
    }

    return {
      statusCode: 200,
      payload: {
        valid: true,
        code: rpcResult.code,
        event: rpcResult.event,
        holder: rpcResult.holder,
        batch: rpcResult.batch,
        status: 'success',
        timestamp: rpcResult.timestamp,
      },
    };
  }

  // 4. Ingresso já utilizado anteriormente (bloqueio anti-fraude)
  if (rpcResult.status === 'already_used') {
    return {
      statusCode: 409,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'already_used',
        message: rpcResult.message || `ALERTA DE SEGURANÇA: Ingresso ${cleanCode} já foi utilizado anteriormente!`,
        holder: rpcResult.holder,
      },
    };
  }

  // 5. Ingresso com status inválido (pendente, cancelado, estornado)
  if (rpcResult.status === 'invalid_status') {
    return {
      statusCode: 400,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'invalid_status',
        message: rpcResult.message || `Ingresso não autorizado para entrada. Situação atual: "${rpcResult.status}".`,
        holder: rpcResult.holder,
      },
    };
  }

  // 6. Ingresso não encontrado na base de dados oficial
  if (rpcResult.status === 'not_found') {
    // Em desenvolvimento / homologação, permitir contingência para códigos de demonstração conhecidos
    if (!isProduction && (cleanCode === 'PX-7AI89C10' || cleanCode === 'PX-4M29L8X1')) {
      const alreadyUsed = demoUsedMap.get(cleanCode);
      if (alreadyUsed) {
        return {
          statusCode: 409,
          payload: {
            valid: false,
            code: cleanCode,
            status: 'already_used',
            message: `ALERTA: Ingresso ${cleanCode} já foi utilizado anteriormente nesta sessão!`,
            holder: 'Deivid J. Silva',
          },
        };
      }

      const checkinTime = new Date().toISOString();
      demoUsedMap.set(cleanCode, {
        checkin_at: checkinTime,
        operator: operatorId || 'Operador',
        device: deviceId || 'web-scanner',
      });

      const isMega = cleanCode === 'PX-7AI89C10';
      return {
        statusCode: 200,
        payload: {
          valid: true,
          code: cleanCode,
          event: isMega ? 'MEGA ENCONTRO PX CUSTON [DEMO]' : 'RACHA DE SOM [DEMO]',
          holder: 'Deivid J. Silva',
          batch: isMega ? 'Pista (Entrada Geral)' : 'Pista Geral',
          status: 'success',
          timestamp: checkinTime,
        },
      };
    }

    // Em produção (ou qualquer outro código não registrado), retornar 404 estrito
    return {
      statusCode: 404,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'not_found',
        message: rpcResult.message || `Ingresso "${cleanCode}" não encontrado na base de dados oficial PX CUSTON.`,
      },
    };
  }

  // 7. Qualquer outro status não reconhecido retornado pela RPC: falha operacional segura
  return {
    statusCode: 503,
    payload: {
      valid: false,
      code: cleanCode,
      status: 'service_unavailable',
      message: 'Status desconhecido retornado pelo procedimento de validação. Operação abortada.',
    },
  };
}

export const ALLOWED_CHECKIN_ROLES = ['CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;

export interface AuthenticatedTicketValidationRequest {
  authHeader?: string;
  code?: any;
  clientOperatorId?: any;
  deviceId?: string;
  supabaseClient: any;
  isProduction: boolean;
  demoUsedMap: Map<string, { checkin_at: string; operator: string; device: string }>;
}

export interface AuthenticatedTicketValidationResult {
  statusCode: number;
  verifiedOperatorId?: string;
  verifiedRole?: string;
  payload: {
    valid: boolean;
    code?: string;
    event?: string;
    holder?: string;
    batch?: string;
    status: string;
    error?: string;
    message?: string;
    timestamp?: string;
    requiredRoles?: string[];
  };
}

/**
 * Executa a validação de ingresso exigindo autenticação válida no Supabase Auth
 * e autorização explícita de papel (CHECKIN_OPERATOR, ADMIN ou SUPER_ADMIN) na tabela public.profiles.
 * Nunca confia em operator_id enviado pelo cliente.
 */
export async function executeAuthenticatedTicketValidation(
  reqParams: AuthenticatedTicketValidationRequest
): Promise<AuthenticatedTicketValidationResult> {
  const { authHeader, code, deviceId, supabaseClient, isProduction, demoUsedMap } = reqParams;

  // 1. Exigir cabeçalho Authorization Bearer
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      payload: {
        valid: false,
        status: 'unauthorized',
        error: 'Token de autenticação não fornecido ou inválido.',
        message: 'Acesso negado: Operador não autenticado.',
      },
    };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return {
      statusCode: 401,
      payload: {
        valid: false,
        status: 'unauthorized',
        error: 'Token de autenticação vazio.',
        message: 'Acesso negado: Operador não autenticado.',
      },
    };
  }

  // 2. Validar sessão no Supabase Auth
  let verifiedUser: any = null;
  try {
    const { data, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !data?.user || !data.user.id) {
      return {
        statusCode: 401,
        payload: {
          valid: false,
          status: 'unauthorized',
          error: 'Sessão inválida ou expirada no Supabase Auth.',
          message: 'Acesso negado: Sessão inválida ou expirada.',
        },
      };
    }
    verifiedUser = data.user;
  } catch {
    return {
      statusCode: 503,
      payload: {
        valid: false,
        status: 'service_unavailable',
        error: 'Falha na verificação de identidade no servidor.',
        message: 'Serviço de autenticação temporariamente indisponível.',
      },
    };
  }

  // 3. Consultar papel real do operador na tabela public.profiles (nunca confiar em user_metadata nem em body.operator_id)
  let verifiedRole: string | null = null;
  try {
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('id, role')
      .eq('id', verifiedUser.id)
      .maybeSingle();

    if (profileError || !profile || !profile.role) {
      return {
        statusCode: 403,
        payload: {
          valid: false,
          status: 'forbidden',
          error: 'Acesso negado: Perfil do operador não encontrado no sistema.',
          message: 'Acesso negado: Perfil do operador não localizado.',
        },
      };
    }
    verifiedRole = String(profile.role);
  } catch {
    return {
      statusCode: 503,
      payload: {
        valid: false,
        status: 'service_unavailable',
        error: 'Falha ao consultar permissões do operador no banco de dados.',
        message: 'Serviço de autorização temporariamente indisponível.',
      },
    };
  }

  // 4. Autorização explícita para CHECKIN_OPERATOR, ADMIN ou SUPER_ADMIN
  if (!ALLOWED_CHECKIN_ROLES.includes(verifiedRole as any)) {
    return {
      statusCode: 403,
      payload: {
        valid: false,
        status: 'forbidden',
        error: `Acesso negado: Seu papel (${verifiedRole}) não possui permissão para validar ingressos.`,
        message: 'Acesso negado: Permissão insuficiente para realizar check-in.',
        requiredRoles: [...ALLOWED_CHECKIN_ROLES],
      },
    };
  }

  // 5. Validar código do ingresso somente após autenticação e autorização confirmadas
  if (!code || String(code).trim() === '') {
    return {
      statusCode: 400,
      payload: {
        valid: false,
        status: 'invalid_code',
        message: 'Código do ingresso não fornecido.',
      },
    };
  }

  let cleanCode = String(code).trim().toUpperCase();
  if (cleanCode.startsWith('PX:') && cleanCode.split(':').length >= 2) {
    const parts = cleanCode.split(':');
    cleanCode = parts[1].trim();
  }

  // Identidade do operador derivada estritamente da sessão autenticada no servidor
  const verifiedOperatorId = String(verifiedUser.id);
  const safeDeviceId = deviceId && String(deviceId).trim() ? String(deviceId).trim() : 'web-scanner';

  try {
    const { data: rpcResult, error: rpcError } = await supabaseClient.rpc('validate_and_checkin_ticket', {
      p_code: cleanCode,
      p_operator_id: verifiedOperatorId,
      p_device_id: safeDeviceId,
    });

    const outcome = evaluateTicketValidationOutcome({
      rpcResult,
      rpcError,
      cleanCode,
      isProduction,
      demoUsedMap,
      operatorId: verifiedOperatorId,
      deviceId: safeDeviceId,
    });

    return {
      statusCode: outcome.statusCode,
      verifiedOperatorId,
      verifiedRole,
      payload: outcome.payload,
    };
  } catch {
    return {
      statusCode: 503,
      verifiedOperatorId,
      verifiedRole,
      payload: {
        valid: false,
        code: cleanCode,
        status: 'service_unavailable',
        message: 'Serviço de validação temporariamente indisponível devido a falha operacional no banco de dados. Tente novamente.',
      },
    };
  }
}

export interface EvaluateOrderCancellationParams {
  rpcResult: any;
  rpcError: any;
  orderId: string;
  currentStatus?: string;
  total?: number;
  updatedAt?: string;
}

export interface OrderCancellationEvaluation {
  statusCode: number;
  outcome: 'cancelled' | 'already_cancelled' | 'already_approved' | 'operation_refused' | 'rpc_error';
  cancelled: boolean;
  stockReleased: boolean;
  releasedItemsCount: number;
  payload: {
    id: string;
    status: string;
    total?: number;
    updated_at?: string;
    expired: boolean;
    already_cancelled?: boolean;
    already_approved?: boolean;
    stock_released: boolean;
    released_items_count?: number;
    message?: string;
    error?: string;
  };
}

/**
 * Avalia estritamente o resultado da RPC cancel_order_and_release_stock.
 * - NUNCA marca um pedido como cancelled quando a RPC falha.
 * - Trata separadamente: erro da RPC (503), pedido já aprovado (200 status='approved') e recusa da operação (409).
 * - Só informa que o estoque foi liberado quando comprovado por released_items_count > 0 na resposta da RPC.
 */
export function evaluateOrderCancellationOutcome(
  params: EvaluateOrderCancellationParams
): OrderCancellationEvaluation {
  const { rpcResult, rpcError, orderId, currentStatus = 'pending', total, updatedAt } = params;

  // 1. Erro operacional da RPC ou resposta nula/malformada -> 503 (sem alterar status para cancelled)
  if (rpcError || !rpcResult || typeof rpcResult !== 'object' || Array.isArray(rpcResult)) {
    return {
      statusCode: 503,
      outcome: 'rpc_error',
      cancelled: false,
      stockReleased: false,
      releasedItemsCount: 0,
      payload: {
        id: orderId,
        status: currentStatus,
        total,
        updated_at: updatedAt,
        expired: false,
        stock_released: false,
        error: 'Falha ao processar cancelamento transacional no banco de dados. O status do pedido foi mantido e o estoque não foi liberado.',
      },
    };
  }

  // 2. Pedido já aprovado concorrentemente -> proteger contra cancelamento retroativo
  if (rpcResult.success === false && rpcResult.status === 'approved') {
    return {
      statusCode: 200,
      outcome: 'already_approved',
      cancelled: false,
      stockReleased: false,
      releasedItemsCount: 0,
      payload: {
        id: orderId,
        status: 'approved',
        total,
        updated_at: updatedAt || new Date().toISOString(),
        expired: false,
        already_approved: true,
        stock_released: false,
        message: rpcResult.error || 'Pedido já se encontra com pagamento aprovado. Cancelamento recusado para preservar os ingressos emitidos.',
      },
    };
  }

  // 3. Recusa explícita da operação pela RPC (ex: refunded, in_process, pedido não encontrado)
  if (rpcResult.success !== true) {
    return {
      statusCode: 409,
      outcome: 'operation_refused',
      cancelled: false,
      stockReleased: false,
      releasedItemsCount: 0,
      payload: {
        id: orderId,
        status: rpcResult.status || currentStatus,
        total,
        updated_at: updatedAt,
        expired: false,
        stock_released: false,
        error: rpcResult.error || 'Operação de cancelamento recusada pela regra transacional do banco.',
      },
    };
  }

  // 4. Sucesso confirmado pela RPC: validar contrato da resposta antes de informar liberação de estoque
  const alreadyCancelled = rpcResult.already_cancelled === true;
  const hasValidReleasedCount = typeof rpcResult.released_items_count === 'number' && rpcResult.released_items_count >= 0;
  const hasExplicitCancelledStatus = rpcResult.status === 'cancelled' || alreadyCancelled;

  if (!hasExplicitCancelledStatus || (!alreadyCancelled && !hasValidReleasedCount)) {
    return {
      statusCode: 503,
      outcome: 'rpc_error',
      cancelled: false,
      stockReleased: false,
      releasedItemsCount: 0,
      payload: {
        id: orderId,
        status: currentStatus,
        total,
        updated_at: updatedAt,
        expired: false,
        stock_released: false,
        error: 'Resposta da RPC de cancelamento não comprovou o cancelamento transacional ou a liberação do estoque. Operação abortada por segurança.',
      },
    };
  }

  const releasedItemsCount = hasValidReleasedCount ? rpcResult.released_items_count : 0;
  const stockReleased = !alreadyCancelled && releasedItemsCount > 0;

  return {
    statusCode: 200,
    outcome: alreadyCancelled ? 'already_cancelled' : 'cancelled',
    cancelled: true,
    stockReleased,
    releasedItemsCount,
    payload: {
      id: orderId,
      status: 'cancelled',
      total,
      updated_at: new Date().toISOString(),
      expired: true,
      already_cancelled: alreadyCancelled,
      stock_released: stockReleased,
      released_items_count: releasedItemsCount,
      message: alreadyCancelled
        ? rpcResult.message || 'Pedido já havia sido cancelado anteriormente. Estoque preservado sem duplicação.'
        : stockReleased
          ? 'O tempo limite para pagamento deste pedido expirou (15 minutos). O estoque reservado foi liberado automaticamente.'
          : 'O pedido foi cancelado com confirmação transacional no banco de dados.',
    },
  };
}

export interface OrderIdempotencyItem {
  batch_id: string;
  quantity: number;
}

export interface VerifyOrderIdempotencyParams {
  existingOrder: {
    id: string;
    user_id: string;
    event_id: string;
    payment_method: string;
    items?: OrderIdempotencyItem[];
  };
  requestedUserId: string;
  requestedEventId: string;
  requestedPaymentMethod: string;
  requestedItems: OrderIdempotencyItem[];
}

export interface OrderIdempotencyVerificationResult {
  compatible: boolean;
  conflictReason?: 'user_mismatch' | 'event_mismatch' | 'payment_method_mismatch' | 'items_mismatch';
  errorMessage?: string;
}

/**
 * Normaliza e consolida itens por batch_id (ordenados ascendentemente),
 * espelhando exatamente a lógica SQL de process_order_checkout.
 */
export function normalizeOrderItemsForIdempotency(items: OrderIdempotencyItem[]): OrderIdempotencyItem[] {
  const map = new Map<string, number>();
  for (const item of items || []) {
    const batchId = String(item?.batch_id || '').trim().toLowerCase();
    const qty = Number(item?.quantity || 0);
    if (!batchId || !Number.isFinite(qty) || qty <= 0) continue;
    map.set(batchId, (map.get(batchId) || 0) + Math.floor(qty));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([batch_id, quantity]) => ({ batch_id, quantity }));
}

/**
 * Verifica se um pedido existente com o mesmo order_id é compatível com os dados
 * da tentativa atual (mesmo comprador, mesmo evento, mesmo método de pagamento e mesmos itens).
 * Impede que um order_id reutilizado retorne ou misture pedidos diferentes.
 */
export function verifyOrderIdempotencyMatch(
  params: VerifyOrderIdempotencyParams
): OrderIdempotencyVerificationResult {
  const {
    existingOrder,
    requestedUserId,
    requestedEventId,
    requestedPaymentMethod,
    requestedItems,
  } = params;

  if (String(existingOrder.user_id || '').trim() !== String(requestedUserId || '').trim()) {
    return {
      compatible: false,
      conflictReason: 'user_mismatch',
      errorMessage: 'Conflito de idempotência: O identificador de pedido informado já pertence a outro comprador.',
    };
  }

  if (String(existingOrder.event_id || '').trim() !== String(requestedEventId || '').trim()) {
    return {
      compatible: false,
      conflictReason: 'event_mismatch',
      errorMessage: 'Conflito de idempotência: O identificador de pedido informado já está vinculado a outro evento.',
    };
  }

  if (String(existingOrder.payment_method || '').trim() !== String(requestedPaymentMethod || '').trim()) {
    return {
      compatible: false,
      conflictReason: 'payment_method_mismatch',
      errorMessage: 'Conflito de idempotência: O identificador de pedido informado já foi registrado com outro método de pagamento.',
    };
  }

  const normExisting = normalizeOrderItemsForIdempotency(existingOrder.items || []);
  const normRequested = normalizeOrderItemsForIdempotency(requestedItems || []);

  if (normExisting.length !== normRequested.length) {
    return {
      compatible: false,
      conflictReason: 'items_mismatch',
      errorMessage: 'Conflito de idempotência: O identificador de pedido informado já foi utilizado com itens ou quantidades diferentes.',
    };
  }

  for (let i = 0; i < normExisting.length; i++) {
    if (
      normExisting[i].batch_id !== normRequested[i].batch_id ||
      normExisting[i].quantity !== normRequested[i].quantity
    ) {
      return {
        compatible: false,
        conflictReason: 'items_mismatch',
        errorMessage: 'Conflito de idempotência: O identificador de pedido informado já foi utilizado com itens ou quantidades diferentes.',
      };
    }
  }

  return { compatible: true };
}

