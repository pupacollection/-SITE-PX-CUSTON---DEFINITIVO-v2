-- ==============================================================================
-- PX CUSTON — MIGRATION: ENDURECIMENTO DE AUTORIZAÇÃO DAS RPCS E IDEMPOTÊNCIA DE CHECKOUT
-- ==============================================================================
-- Objetivo:
-- 1. Revogar permissões excessivas de execução (PUBLIC, anon, authenticated) e
--    conceder EXECUTE exclusivamente a service_role nas funções transacionais de
--    backend, utilizando as assinaturas exatas das migrations originais:
--    - public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID)
--    - public.cancel_order_and_release_stock(UUID, TEXT)
--    - public.confirm_order_and_issue_tickets(UUID, TEXT)
--    - public.expire_pending_orders(INT)
--    - public.claim_order_confirmation_email(UUID, TEXT, TEXT)
--    Nota arquitetural: A restrição de execução é aplicada via catálogo de permissões
--    do PostgreSQL (REVOKE/GRANT) sem depender de current_setting('role', true) = 'service_role'
--    dentro de funções SECURITY DEFINER (evitando incompatibilidades de contexto GUC
--    quando executadas pelo owner ou conexões diretas). Efeito real em PostgREST deve
--    ser homologado em banco de staging antes da aplicação em produção.
-- 2. Atualizar public.process_order_checkout para:
--    - Validar estritamente a compatibilidade de comprador (p_user_id), evento (p_event_id),
--      método de pagamento (p_payment_method) e itens consolidados (batch_id + quantity)
--      quando p_order_id já existir, bloqueando colisão/reuso indevido de ID com itens
--      ou compradores distintos e preservando retries legítimos com payload completo.
--    - Preservar e utilizar p_buyer_info para complementar nome/CPF ausentes no perfil
--      do comprador e retornar buyer_info no payload.
-- 3. Atualizar public.cancel_order_and_release_stock para recusar explicitamente o
--    cancelamento de pedidos nos estados 'approved', 'refunded' e 'in_process',
--    retornando contagem explícita de itens liberados (released_items_count).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. Verificação Explícita de Pré-requisitos (Falha Rápida e Segura)
-- Não ignora silenciosamente funções ou colunas ausentes: exige que as migrations
-- anteriores (20261014000001, 20261016000001, 20261017000001 e 20261022000001)
-- já estejam aplicadas no banco alvo antes de prosseguir.
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ticket_batches'
      AND column_name = 'start_date'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ticket_batches'
      AND column_name = 'end_date'
  ) THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Colunas start_date/end_date não encontradas em public.ticket_batches. Aplique a migration 20261016000001_ticket_batches_periods.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;

  IF to_regprocedure('public.process_order_checkout(uuid,uuid,jsonb,payment_method,jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Função public.process_order_checkout(uuid,uuid,jsonb,payment_method,jsonb,uuid) não encontrada. Aplique a migration 20261017000001_atomic_checkout_and_stock.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;

  IF to_regprocedure('public.cancel_order_and_release_stock(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Função public.cancel_order_and_release_stock(uuid,text) não encontrada. Aplique a migration 20261017000001_atomic_checkout_and_stock.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;

  IF to_regprocedure('public.confirm_order_and_issue_tickets(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Função public.confirm_order_and_issue_tickets(uuid,text) não encontrada. Aplique a migration 20261017000001_atomic_checkout_and_stock.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;

  IF to_regprocedure('public.expire_pending_orders(integer)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Função public.expire_pending_orders(integer) não encontrada. Aplique a migration 20261017000001_atomic_checkout_and_stock.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;

  IF to_regprocedure('public.claim_order_confirmation_email(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: Função public.claim_order_confirmation_email(uuid,text,text) não encontrada. Aplique a migration 20261022000001_order_email_notifications.sql antes de 20261022000002_rpc_authorization_hardening.sql.';
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 1. Atualização de public.process_order_checkout (Idempotência Estrita + p_buyer_info)
-- Assinatura original preservada: (UUID, UUID, JSONB, payment_method, JSONB, UUID)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_order_checkout(
  p_event_id UUID,
  p_user_id UUID,
  p_items JSONB,
  p_payment_method payment_method,
  p_buyer_info JSONB DEFAULT '{}'::jsonb,
  p_order_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event RECORD;
  v_item RECORD;
  v_batch RECORD;
  v_now TIMESTAMPTZ := now();
  v_order_id UUID := COALESCE(p_order_id, gen_random_uuid());
  v_existing_order RECORD;
  v_requested_items_norm JSONB;
  v_existing_items_norm JSONB;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_convenience_fee NUMERIC(10,2) := 0.00;
  v_discount NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_item_subtotal NUMERIC(10,2);
  v_processed_items JSONB := '[]'::jsonb;
  v_qty INT;
  v_batch_id UUID;
  v_profile RECORD;
  v_buyer_name TEXT;
  v_buyer_cpf TEXT;
BEGIN
  -- Validar payload de itens antes da verificação de idempotência
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'O pedido deve conter pelo menos um item.';
  END IF;

  -- 0. Idempotência Estrita com Verificação de Compatibilidade Integral
  IF p_order_id IS NOT NULL THEN
    SELECT * INTO v_existing_order
    FROM public.orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_existing_order.id IS NOT NULL THEN
      -- Normalizar itens solicitados (ordenados por batch_id ASC e quantidades somadas)
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object('batch_id', batch_id, 'quantity', quantity)
          ORDER BY batch_id ASC
        ),
        '[]'::jsonb
      )
      INTO v_requested_items_norm
      FROM (
        SELECT batch_id, SUM(quantity)::INT AS quantity
        FROM jsonb_to_recordset(p_items) AS (batch_id UUID, quantity INT)
        GROUP BY batch_id
      ) req;

      -- Normalizar itens persistidos no pedido existente
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object('batch_id', batch_id, 'quantity', quantity)
          ORDER BY batch_id ASC
        ),
        '[]'::jsonb
      )
      INTO v_existing_items_norm
      FROM (
        SELECT batch_id, SUM(quantity)::INT AS quantity
        FROM public.order_items
        WHERE order_id = v_existing_order.id
        GROUP BY batch_id
      ) cur;

      -- Rejeitar qualquer divergência de comprador, evento, forma de pagamento ou itens
      IF v_existing_order.user_id IS DISTINCT FROM p_user_id
         OR v_existing_order.event_id IS DISTINCT FROM p_event_id
         OR v_existing_order.payment_method IS DISTINCT FROM p_payment_method
         OR v_requested_items_norm IS DISTINCT FROM v_existing_items_norm
      THEN
        RAISE EXCEPTION 'Conflito de idempotência: O identificador de pedido (%) já está vinculado a outro comprador, evento, método de pagamento ou conjunto de itens.', p_order_id;
      END IF;

      -- Carregar título do evento e itens detalhados para preservar contrato de retorno em retries legítimos
      SELECT id, title INTO v_event FROM public.events WHERE id = v_existing_order.event_id;

      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'batch_id', oi.batch_id,
            'batch_name', COALESCE(b.name, 'Ingresso PX'),
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'subtotal', oi.subtotal
          )
          ORDER BY oi.batch_id ASC
        ),
        '[]'::jsonb
      )
      INTO v_processed_items
      FROM public.order_items oi
      LEFT JOIN public.ticket_batches b ON b.id = oi.batch_id
      WHERE oi.order_id = v_existing_order.id;

      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'order_id', v_existing_order.id,
        'event_id', v_existing_order.event_id,
        'event_title', v_event.title,
        'items', v_processed_items,
        'subtotal', v_existing_order.subtotal,
        'convenience_fee', v_existing_order.convenience_fee,
        'discount', v_existing_order.discount,
        'total', v_existing_order.total,
        'payment_method', v_existing_order.payment_method,
        'payment_status', v_existing_order.payment_status,
        'buyer_info', COALESCE(p_buyer_info, '{}'::jsonb),
        'created_at', v_existing_order.created_at
      );
    END IF;
  END IF;

  -- 1. Validar se o perfil do comprador existe e complementar dados via p_buyer_info quando ausentes
  SELECT id, full_name, cpf INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'Perfil do comprador não encontrado na base oficial PX CUSTON (id: %).', p_user_id;
  END IF;

  IF p_buyer_info IS NOT NULL AND jsonb_typeof(p_buyer_info) = 'object' THEN
    v_buyer_name := NULLIF(btrim(COALESCE(p_buyer_info->>'name', p_buyer_info->>'full_name', '')), '');
    v_buyer_cpf := NULLIF(regexp_replace(COALESCE(p_buyer_info->>'cpf', ''), '\D', '', 'g'), '');

    IF (v_profile.full_name IS NULL OR btrim(v_profile.full_name) = '' OR v_profile.full_name = 'Cliente PX') AND v_buyer_name IS NOT NULL THEN
      UPDATE public.profiles
      SET full_name = v_buyer_name, updated_at = v_now
      WHERE id = p_user_id;
    END IF;

    IF (v_profile.cpf IS NULL OR btrim(v_profile.cpf) = '') AND v_buyer_cpf IS NOT NULL AND length(v_buyer_cpf) IN (11, 14) THEN
      UPDATE public.profiles
      SET cpf = v_buyer_cpf, updated_at = v_now
      WHERE id = p_user_id;
    END IF;
  END IF;

  -- 2. Validar se o evento existe e NÃO é demo para pedidos comerciais
  SELECT id, title, is_demo, status INTO v_event FROM public.events WHERE id = p_event_id;
  IF v_event.id IS NULL THEN
    RAISE EXCEPTION 'Evento não encontrado (id: %).', p_event_id;
  END IF;

  IF v_event.is_demo IS TRUE THEN
    RAISE EXCEPTION 'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) não aceitam pedidos ou pagamentos comerciais reais.';
  END IF;

  IF v_event.status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'Operação bloqueada: O evento selecionado não está publicado para vendas.';
  END IF;

  -- 3. Processar cada item com ROW LOCKING (FOR UPDATE) no lote correspondente
  -- Consolidar itens duplicados por batch_id e ordenar ascendentemente para eliminar Deadlocks
  FOR v_item IN 
    SELECT batch_id, SUM(quantity)::INT AS quantity
    FROM jsonb_to_recordset(p_items) AS (batch_id UUID, quantity INT)
    GROUP BY batch_id
    ORDER BY batch_id ASC
  LOOP
    v_batch_id := v_item.batch_id;
    v_qty := v_item.quantity;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantidade inválida para o lote %: %.', v_batch_id, v_qty;
    END IF;

    -- Bloqueio pessimista de linha atômico
    SELECT * INTO v_batch 
    FROM public.ticket_batches 
    WHERE id = v_batch_id 
    FOR UPDATE;

    IF v_batch.id IS NULL THEN
      RAISE EXCEPTION 'Lote de ingressos não encontrado (id: %).', v_batch_id;
    END IF;

    -- Validar se o lote de fato pertence ao evento do pedido
    IF v_batch.event_id IS DISTINCT FROM p_event_id THEN
      RAISE EXCEPTION 'Inconsistência de integridade: O lote "%" (%) não pertence ao evento do pedido.', v_batch.name, v_batch_id;
    END IF;

    -- Validar se o lote está ativo
    IF v_batch.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'O lote "%" está inativo ou com vendas suspensas.', v_batch.name;
    END IF;

    -- Validar datas de vigência (se configuradas)
    IF v_batch.start_date IS NOT NULL AND v_batch.start_date > v_now THEN
      RAISE EXCEPTION 'As vendas para o lote "%" ainda não foram iniciadas.', v_batch.name;
    END IF;

    IF v_batch.end_date IS NOT NULL AND v_batch.end_date < v_now THEN
      RAISE EXCEPTION 'O período de vendas para o lote "%" já está encerrado.', v_batch.name;
    END IF;

    -- Validar quantidade disponível e descontar atomicamente
    IF v_batch.available_quantity < v_qty THEN
      RAISE EXCEPTION 'Estoque insuficiente: O lote "%" possui apenas % ingressos disponíveis (solicitado: %).', v_batch.name, v_batch.available_quantity, v_qty;
    END IF;

    -- Deduzir estoque diretamente no banco
    UPDATE public.ticket_batches
    SET available_quantity = available_quantity - v_qty
    WHERE id = v_batch_id;

    -- Calcular subtotal
    v_item_subtotal := round(v_batch.price * v_qty, 2);
    v_subtotal := v_subtotal + v_item_subtotal;

    v_processed_items := v_processed_items || jsonb_build_array(jsonb_build_object(
      'batch_id', v_batch.id,
      'batch_name', v_batch.name,
      'quantity', v_qty,
      'unit_price', v_batch.price,
      'subtotal', v_item_subtotal
    ));
  END LOOP;

  -- 4. Cálculo de taxas e descontos oficiais
  IF v_subtotal > 0 THEN
    v_convenience_fee := 4.00;
  END IF;

  IF p_payment_method = 'pix' THEN
    v_discount := round(v_subtotal * 0.05, 2);
  END IF;

  v_total := round(v_subtotal + v_convenience_fee - v_discount, 2);
  IF v_total < 0 THEN
    v_total := 0.00;
  END IF;

  -- 5. Inserir na tabela public.orders
  INSERT INTO public.orders (
    id,
    user_id,
    event_id,
    subtotal,
    convenience_fee,
    discount,
    total,
    payment_method,
    payment_status,
    created_at,
    updated_at
  ) VALUES (
    v_order_id,
    p_user_id,
    p_event_id,
    v_subtotal,
    v_convenience_fee,
    v_discount,
    v_total,
    p_payment_method,
    'pending',
    v_now,
    v_now
  );

  -- 6. Inserir itens na tabela public.order_items
  FOR v_item IN SELECT * FROM jsonb_to_recordset(v_processed_items) AS (batch_id UUID, quantity INT, unit_price NUMERIC(10,2), subtotal NUMERIC(10,2))
  LOOP
    INSERT INTO public.order_items (
      order_id,
      batch_id,
      quantity,
      unit_price,
      subtotal
    ) VALUES (
      v_order_id,
      v_item.batch_id,
      v_item.quantity,
      v_item.unit_price,
      v_item.subtotal
    );
  END LOOP;

  -- 7. Retornar dados completos do pedido criado
  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'event_id', p_event_id,
    'event_title', v_event.title,
    'items', v_processed_items,
    'subtotal', v_subtotal,
    'convenience_fee', v_convenience_fee,
    'discount', v_discount,
    'total', v_total,
    'payment_method', p_payment_method,
    'payment_status', 'pending',
    'buyer_info', COALESCE(p_buyer_info, '{}'::jsonb),
    'created_at', v_now
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 2. Atualização de public.cancel_order_and_release_stock
-- Assinatura original preservada: (UUID, TEXT)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order_and_release_stock(
  p_order_id UUID,
  p_reason TEXT DEFAULT 'expired'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_now TIMESTAMPTZ := now();
  v_released_items INT := 0;
BEGIN
  -- 1. Buscar o pedido com lock exclusivo de linha (FOR UPDATE)
  SELECT id, payment_status, event_id INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- 2. REGRA FUNDAMENTAL: Se o pedido já estiver 'approved', NÃO liberar estoque!
  IF v_order.payment_status = 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Operação bloqueada: Pedidos com pagamento aprovado não podem ter o estoque liberado por cancelamento ou expiração.',
      'status', v_order.payment_status
    );
  END IF;

  -- 2.1. Se o pedido estiver 'refunded' ou 'in_process', bloquear cancelamento automático
  IF v_order.payment_status IN ('refunded', 'in_process') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Operação bloqueada: Pedidos com status "%s" não podem ser cancelados por esta rotina.', v_order.payment_status),
      'status', v_order.payment_status
    );
  END IF;

  IF v_order.payment_status = 'cancelled' THEN
    -- Idempotência: Se já foi cancelado, não faz nada e não libera estoque duas vezes!
    RETURN jsonb_build_object(
      'success', true, 
      'already_cancelled', true,
      'order_id', p_order_id,
      'status', 'cancelled',
      'released_items_count', 0,
      'message', 'Pedido já havia sido cancelado anteriormente. Estoque preservado sem duplicação.'
    );
  END IF;

  -- 3. Apenas pedidos 'pending' ou 'rejected' podem ser cancelados com devolução de estoque
  UPDATE public.orders
  SET payment_status = 'cancelled', updated_at = v_now
  WHERE id = p_order_id;

  -- 4. Iterar sobre os itens do pedido e devolver o estoque aos lotes
  FOR v_item IN 
    SELECT batch_id, quantity 
    FROM public.order_items 
    WHERE order_id = p_order_id
    ORDER BY batch_id ASC
  LOOP
    UPDATE public.ticket_batches
    SET available_quantity = LEAST(total_quantity, available_quantity + v_item.quantity)
    WHERE id = v_item.batch_id;

    v_released_items := v_released_items + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'status', 'cancelled',
    'released_items_count', v_released_items,
    'reason', p_reason
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Revogação de Permissões Excessivas e Concessão Estrita a service_role
-- Assinaturas exatas confirmadas nas migrations 20261017000001 e 20261022000001
-- ------------------------------------------------------------------------------

-- 3.1. process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID)
REVOKE EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) TO service_role;

-- 3.2. cancel_order_and_release_stock(UUID, TEXT)
REVOKE EXECUTE ON FUNCTION public.cancel_order_and_release_stock(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_order_and_release_stock(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_order_and_release_stock(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order_and_release_stock(UUID, TEXT) TO service_role;

-- 3.3. confirm_order_and_issue_tickets(UUID, TEXT) (Sem recriar a função)
REVOKE EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets(UUID, TEXT) TO service_role;

-- 3.4. expire_pending_orders(INT) (Sem recriar a função)
REVOKE EXECUTE ON FUNCTION public.expire_pending_orders(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_pending_orders(INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.expire_pending_orders(INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_orders(INT) TO service_role;

-- 3.5. claim_order_confirmation_email(UUID, TEXT, TEXT) (Sem recriar a função)
REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) TO service_role;

COMMIT;
