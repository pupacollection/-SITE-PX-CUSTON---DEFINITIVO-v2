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
