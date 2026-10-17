import { supabase } from '../lib/supabase';
import { TicketBatch, CreateTicketBatchInput, UpdateTicketBatchInput } from '../types';

/**
 * Validação estrita de integridade para criação e edição de lotes de ingressos
 */
export function validateBatchInput(
  input: Partial<CreateTicketBatchInput>,
  isEdit = false
): { valid: boolean; error: string | null } {
  if (!isEdit && !input.event_id) {
    return { valid: false, error: 'O identificador do evento (event_id) é obrigatório.' };
  }

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length < 2) {
      return { valid: false, error: 'O nome do lote deve conter pelo menos 2 caracteres.' };
    }
    if (trimmed.length > 80) {
      return { valid: false, error: 'O nome do lote não pode exceder 80 caracteres.' };
    }
  } else if (!isEdit) {
    return { valid: false, error: 'O nome do lote é obrigatório.' };
  }

  if (input.price !== undefined) {
    const priceNum = Number(input.price);
    if (isNaN(priceNum) || priceNum < 0) {
      return { valid: false, error: 'O preço unitário deve ser um número maior ou igual a zero.' };
    }
  } else if (!isEdit) {
    return { valid: false, error: 'O preço unitário é obrigatório.' };
  }

  if (input.total_quantity !== undefined) {
    const totalQty = parseInt(String(input.total_quantity), 10);
    if (isNaN(totalQty) || totalQty <= 0) {
      return { valid: false, error: 'A quantidade total de ingressos deve ser um número inteiro positivo maior que zero.' };
    }
  } else if (!isEdit) {
    return { valid: false, error: 'A quantidade total é obrigatória.' };
  }

  if (input.available_quantity !== undefined) {
    const availQty = parseInt(String(input.available_quantity), 10);
    if (isNaN(availQty) || availQty < 0) {
      return { valid: false, error: 'A quantidade disponível não pode ser negativa.' };
    }
    if (input.total_quantity !== undefined) {
      const totalQty = parseInt(String(input.total_quantity), 10);
      if (availQty > totalQty) {
        return {
          valid: false,
          error: `A quantidade disponível (${availQty}) não pode ser maior que a quantidade total (${totalQty}).`,
        };
      }
    }
  }

  // Validação de coerência do período de vendas
  if (input.start_date && input.end_date) {
    const start = new Date(input.start_date);
    const end = new Date(input.end_date);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { valid: false, error: 'Formato de data inválido para o período de vendas.' };
    }
    if (start.getTime() >= end.getTime()) {
      return { valid: false, error: 'A data/hora de início das vendas deve ser anterior à data/hora de encerramento.' };
    }
  }

  return { valid: true, error: null };
}

/**
 * Consulta todos os lotes de um evento no Supabase
 */
export async function getEventBatches(
  eventId: string
): Promise<{ data: TicketBatch[] | null; error: string | null }> {
  try {
    if (!eventId) {
      return { data: null, error: 'ID do evento não informado.' };
    }

    const { data, error } = await supabase
      .from('ticket_batches')
      .select('*')
      .eq('event_id', eventId)
      .order('price', { ascending: true });

    if (error) {
      return { data: null, error: error.message };
    }

    const mapped: TicketBatch[] = (data || []).map((row: any) => ({
      id: row.id,
      event_id: row.event_id,
      name: row.name,
      description: row.description || '',
      price: typeof row.price === 'number' ? row.price : parseFloat(row.price || '0'),
      total_quantity: row.total_quantity,
      available_quantity: row.available_quantity,
      is_active: Boolean(row.is_active),
      start_date: row.start_date || null,
      end_date: row.end_date || null,
      created_at: row.created_at,
    }));

    return { data: mapped, error: null };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Falha de conexão ao carregar lotes de ingressos.' };
  }
}

/**
 * Cria um novo lote de ingressos para um evento no Supabase
 */
export async function createTicketBatch(
  input: CreateTicketBatchInput
): Promise<{ data: TicketBatch | null; error: string | null }> {
  const validation = validateBatchInput(input);
  if (!validation.valid) {
    return { data: null, error: validation.error };
  }

  const totalQty = parseInt(String(input.total_quantity), 10);
  const availQty = input.available_quantity !== undefined
    ? parseInt(String(input.available_quantity), 10)
    : totalQty;

  const payload: Record<string, any> = {
    event_id: input.event_id,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    price: Math.max(0, Number(input.price)),
    total_quantity: totalQty,
    available_quantity: Math.min(totalQty, Math.max(0, availQty)),
    is_active: input.is_active !== undefined ? Boolean(input.is_active) : true,
  };

  if (input.start_date) {
    payload.start_date = new Date(input.start_date).toISOString();
  }
  if (input.end_date) {
    payload.end_date = new Date(input.end_date).toISOString();
  }

  try {
    let { data, error } = await supabase
      .from('ticket_batches')
      .insert(payload)
      .select('*')
      .single();

    // Fallback defensivo: se a tabela em produção ainda não possuir as colunas start_date / end_date
    if (error && (error.code === '42703' || error.message.includes('start_date') || error.message.includes('end_date'))) {
      const fallbackPayload = { ...payload };
      delete fallbackPayload.start_date;
      delete fallbackPayload.end_date;

      const fallbackResult = await supabase
        .from('ticket_batches')
        .insert(fallbackPayload)
        .select('*')
        .single();

      data = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error) {
      if (error.code === '23505' || error.message.includes('uq_event_batch_name') || error.message.includes('unique')) {
        return { data: null, error: `Já existe um lote com o nome "${input.name}" cadastrado neste evento.` };
      }
      return { data: null, error: error.message };
    }

    return {
      data: {
        id: data.id,
        event_id: data.event_id,
        name: data.name,
        description: data.description || '',
        price: typeof data.price === 'number' ? data.price : parseFloat(data.price || '0'),
        total_quantity: data.total_quantity,
        available_quantity: data.available_quantity,
        is_active: Boolean(data.is_active),
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        created_at: data.created_at,
      },
      error: null,
    };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Erro inesperado ao cadastrar lote no Supabase.' };
  }
}

/**
 * Atualiza os dados de um lote existente
 */
export async function updateTicketBatch(
  batchId: string,
  input: UpdateTicketBatchInput
): Promise<{ data: TicketBatch | null; error: string | null }> {
  if (!batchId) {
    return { data: null, error: 'Identificador do lote é obrigatório.' };
  }

  const validation = validateBatchInput(input, true);
  if (!validation.valid) {
    return { data: null, error: validation.error };
  }

  const payload: Record<string, any> = {};

  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.description !== undefined) payload.description = input.description ? input.description.trim() : null;
  if (input.price !== undefined) payload.price = Math.max(0, Number(input.price));
  if (input.total_quantity !== undefined) payload.total_quantity = parseInt(String(input.total_quantity), 10);
  if (input.available_quantity !== undefined) payload.available_quantity = parseInt(String(input.available_quantity), 10);
  if (input.is_active !== undefined) payload.is_active = Boolean(input.is_active);
  if (input.start_date !== undefined) {
    payload.start_date = input.start_date ? new Date(input.start_date).toISOString() : null;
  }
  if (input.end_date !== undefined) {
    payload.end_date = input.end_date ? new Date(input.end_date).toISOString() : null;
  }

  try {
    let { data, error } = await supabase
      .from('ticket_batches')
      .update(payload)
      .eq('id', batchId)
      .select('*')
      .single();

    // Fallback defensivo caso colunas start_date / end_date ainda não existam no banco
    if (error && (error.code === '42703' || error.message.includes('start_date') || error.message.includes('end_date'))) {
      const fallbackPayload = { ...payload };
      delete fallbackPayload.start_date;
      delete fallbackPayload.end_date;

      const fallbackResult = await supabase
        .from('ticket_batches')
        .update(fallbackPayload)
        .eq('id', batchId)
        .select('*')
        .single();

      data = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error) {
      if (error.code === '23505' || error.message.includes('uq_event_batch_name') || error.message.includes('unique')) {
        return { data: null, error: `Já existe outro lote cadastrado com este nome no mesmo evento.` };
      }
      return { data: null, error: error.message };
    }

    return {
      data: {
        id: data.id,
        event_id: data.event_id,
        name: data.name,
        description: data.description || '',
        price: typeof data.price === 'number' ? data.price : parseFloat(data.price || '0'),
        total_quantity: data.total_quantity,
        available_quantity: data.available_quantity,
        is_active: Boolean(data.is_active),
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        created_at: data.created_at,
      },
      error: null,
    };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Erro inesperado ao atualizar lote no Supabase.' };
  }
}

/**
 * Ativa ou desativa um lote de ingressos
 */
export async function toggleBatchStatus(
  batchId: string,
  isActive: boolean
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('ticket_batches')
      .update({ is_active: isActive })
      .eq('id', batchId);

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (err: any) {
    return { error: err?.message || 'Erro inesperado ao alterar status do lote.' };
  }
}

/**
 * Encerra as vendas de um lote (desativa e zera disponibilidade com segurança)
 */
export async function closeTicketBatch(
  batchId: string
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('ticket_batches')
      .update({
        is_active: false,
        available_quantity: 0,
      })
      .eq('id', batchId);

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  } catch (err: any) {
    return { error: err?.message || 'Erro ao encerrar vendas do lote.' };
  }
}

/**
 * Exclusão segura de lote com verificação de integridade referencial prévia
 * Não permite excluir lotes que possuam vendas, pedidos ou ingressos emitidos.
 */
export async function deleteTicketBatch(
  batchId: string
): Promise<{ error: string | null }> {
  try {
    // 1. Verificar se há itens de pedido associados ao lote
    const { data: orderItems, error: orderItemsErr } = await supabase
      .from('order_items')
      .select('id')
      .eq('batch_id', batchId)
      .limit(1);

    if (orderItemsErr) {
      console.warn('[BatchesService] Falha ao verificar order_items:', orderItemsErr.message);
    } else if (orderItems && orderItems.length > 0) {
      return {
        error: 'Este lote possui compras e pedidos registrados no sistema. Para preservar a auditoria contábil e a segurança fiscal, o lote não pode ser excluído. Recomendamos desativar ou encerrar o lote.',
      };
    }

    // 2. Verificar se há ingressos gerados para o lote
    const { data: tickets, error: ticketsErr } = await supabase
      .from('tickets')
      .select('id')
      .eq('batch_id', batchId)
      .limit(1);

    if (ticketsErr) {
      console.warn('[BatchesService] Falha ao verificar tickets:', ticketsErr.message);
    } else if (tickets && tickets.length > 0) {
      return {
        error: 'Existem ingressos emitidos vinculados a este lote. A exclusão física violaria a integridade da portaria (PX CHECK-IN). Desative ou encerre o lote.',
      };
    }

    // 3. Seguro para exclusão física
    const { error: deleteErr } = await supabase
      .from('ticket_batches')
      .delete()
      .eq('id', batchId);

    if (deleteErr) {
      if (deleteErr.code === '23503' || deleteErr.message.includes('violates foreign key')) {
        return {
          error: 'Operação bloqueada pelo banco de dados: Este lote possui registros financeiros vinculados. Desative o lote em vez de excluí-lo.',
        };
      }
      return { error: deleteErr.message };
    }

    return { error: null };
  } catch (err: any) {
    return { error: err?.message || 'Erro inesperado ao excluir lote de ingressos.' };
  }
}
