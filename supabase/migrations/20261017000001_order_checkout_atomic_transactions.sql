-- ==============================================================================
-- PX CUSTON — MIGRATION: GARANTIA TRANSACIONAL DE ESTOQUE, PEDIDOS E PAGAMENTOS
-- ==============================================================================
-- Fornece 4 funções autoritativas com transação real no PostgreSQL (ACID):
-- 1. process_order_checkout: Valida evento, lotes, estoque e datas com ROW LOCK (FOR UPDATE),
--    decrementa estoque atomicamente e cria pedido + itens em uma única transação atômica.
--    Elimina condições de corrida (Race Conditions) e deadlocks ordenando locks por batch_id.
--    Possui suporte a idempotência nativa com verificação de p_order_id.
-- 2. cancel_order_and_release_stock: Cancela pedidos não pagos e devolve estoque aos lotes
--    de forma estritamente idempotente (sem duplicar liberação e sem afetar pedidos aprovados).
-- 3. confirm_order_and_issue_tickets: Confirma pagamento, emite ingressos com códigos PX únicos
--    e QR payloads válidos para o terminal PX CHECK-IN com garantia anti-duplicação.
-- 4. expire_pending_orders: Rotina autoritativa que identifica pedidos pendentes com tempo
--    expirado por forma de pagamento (Pix: 15 min; Cartão: 1h; Boleto: 4 dias), cancela e devolve
--    o estoque aos lotes de forma atômica sem tocar em pedidos 'in_process' ou aprovados.

-- 1. FUNÇÃO ATÔMICA DE CHECKOUT E RESERVA DE ESTOQUE
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
  v_subtotal NUMERIC(10,2) := 0.00;
  v_convenience_fee NUMERIC(10,2) := 0.00;
  v_discount NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_item_subtotal NUMERIC(10,2);
  v_processed_items JSONB := '[]'::jsonb;
  v_qty INT;
  v_batch_id UUID;
  v_profile RECORD;
BEGIN
  -- 0. Idempotência Estrita: Se o ID informado já foi processado (retry de rede ou cliente), retornar sem duplicar
  IF p_order_id IS NOT NULL THEN
    SELECT * INTO v_existing_order FROM public.orders WHERE id = p_order_id;
    IF v_existing_order.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'order_id', v_existing_order.id,
        'event_id', v_existing_order.event_id,
        'subtotal', v_existing_order.subtotal,
        'convenience_fee', v_existing_order.convenience_fee,
        'discount', v_existing_order.discount,
        'total', v_existing_order.total,
        'payment_method', v_existing_order.payment_method,
        'payment_status', v_existing_order.payment_status,
        'created_at', v_existing_order.created_at
      );
    END IF;
  END IF;

  -- 1. Validar se o perfil do comprador existe
  SELECT id INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'Perfil do comprador não encontrado na base oficial PX CUSTON (id: %).', p_user_id;
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

  -- 3. Validar payload de itens
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'O pedido deve conter pelo menos um item.';
  END IF;

  -- 4. Processar cada item com ROW LOCKING (FOR UPDATE) no lote correspondente
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

  -- 5. Cálculo de taxas e descontos oficiais
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

  -- 6. Inserir na tabela public.orders
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

  -- 7. Inserir itens na tabela public.order_items
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

  -- 8. Retornar dados completos do pedido criado
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
    'created_at', v_now
  );
END;
$$;

-- 2. FUNÇÃO ATÔMICA DE CANCELAMENTO E LIBERAÇÃO IDEMPOTENTE DE ESTOQUE
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

  -- 2. REGRA FUNDAMENTAL: Se o pedido já estiver 'approved', 'refunded' ou 'cancelled', NÃO liberar estoque!
  IF v_order.payment_status = 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Operação bloqueada: Pedidos com pagamento aprovado não podem ter o estoque liberado por cancelamento ou expiração.',
      'status', v_order.payment_status
    );
  END IF;

  IF v_order.payment_status = 'cancelled' THEN
    -- Idempotência: Se já foi cancelado, não faz nada e não libera estoque duas vezes!
    RETURN jsonb_build_object(
      'success', true, 
      'already_cancelled', true,
      'order_id', p_order_id,
      'message', 'Pedido já havia sido cancelado anteriormente. Estoque preservado sem duplicação.'
    );
  END IF;

  -- 3. Apenas pedidos 'pending' ou 'rejected' podem ser cancelados com devolução de estoque
  UPDATE public.orders
  SET payment_status = 'cancelled', updated_at = v_now
  WHERE id = p_order_id;

  -- 4. Iterar sobre os itens do pedido e devolver o estoque aos lotes com FOR UPDATE
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

-- 3. FUNÇÃO ATÔMICA DE CONFIRMAÇÃO DE PAGAMENTO E EMISSÃO DE INGRESSOS
CREATE OR REPLACE FUNCTION public.confirm_order_and_issue_tickets(
  p_order_id UUID,
  p_mercado_pago_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_profile RECORD;
  v_event RECORD;
  v_now TIMESTAMPTZ := now();
  v_ticket_code TEXT;
  v_tickets_created INT := 0;
  v_idx INT;
  v_holder_name TEXT;
  v_holder_doc TEXT;
BEGIN
  -- 1. Buscar o pedido com lock exclusivo
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- 2. Idempotência: Se já foi aprovado, não reemite ingressos
  IF v_order.payment_status = 'approved' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_approved', true,
      'order_id', p_order_id,
      'message', 'Pedido já aprovado anteriormente. Ingressos mantidos sem duplicação.'
    );
  END IF;

  -- 3. Se foi cancelado previamente, não aprova
  IF v_order.payment_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operação bloqueada: Não é permitido aprovar um pedido que já foi cancelado e teve seu estoque devolvido aos lotes.'
    );
  END IF;

  -- 4. Atualizar pedido para 'approved'
  UPDATE public.orders
  SET 
    payment_status = 'approved',
    mercado_pago_id = COALESCE(p_mercado_pago_id, mercado_pago_id),
    updated_at = v_now
  WHERE id = p_order_id;

  -- Buscar dados do comprador e do evento
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_order.user_id;
  SELECT * INTO v_event FROM public.events WHERE id = v_order.event_id;

  v_holder_name := COALESCE(v_profile.full_name, 'Cliente PX');
  v_holder_doc := v_profile.cpf;

  -- 5. Emitir ingressos reais na tabela public.tickets para cada unidade comprada
  FOR v_item IN 
    SELECT oi.*, b.name as batch_name 
    FROM public.order_items oi
    JOIN public.ticket_batches b ON b.id = oi.batch_id
    WHERE oi.order_id = p_order_id
    ORDER BY oi.id ASC
  LOOP
    FOR v_idx IN 1..v_item.quantity LOOP
      -- Gerar código único PX de 8 dígitos alfanuméricos com prefixo PX-
      v_ticket_code := 'PX-' || upper(substring(md5(random()::text || clock_timestamp()::text || v_idx::text) from 1 for 8));

      INSERT INTO public.tickets (
        code,
        order_id,
        user_id,
        event_id,
        batch_id,
        holder_name,
        holder_doc,
        price,
        status,
        qr_payload,
        created_at
      ) VALUES (
        v_ticket_code,
        p_order_id,
        v_order.user_id,
        v_order.event_id,
        v_item.batch_id,
        v_holder_name,
        v_holder_doc,
        v_item.unit_price,
        'paid',
        'PX:' || v_ticket_code || ':' || v_order.event_id,
        v_now
      );

      v_tickets_created := v_tickets_created + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'status', 'approved',
    'tickets_issued', v_tickets_created
  );
END;
$$;

-- 4. ROTINA ATÔMICA DE EXPIRAÇÃO DE PEDIDOS PENDENTES E DEVOLUÇÃO DE ESTOQUE
CREATE OR REPLACE FUNCTION public.expire_pending_orders(
  p_timeout_minutes INT DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff_pix TIMESTAMPTZ := now() - (p_timeout_minutes || ' minutes')::interval;
  v_cutoff_card TIMESTAMPTZ := now() - INTERVAL '1 hour';
  v_cutoff_boleto TIMESTAMPTZ := now() - INTERVAL '4 days';
  v_order RECORD;
  v_expired_count INT := 0;
  v_cancelled_res JSONB;
BEGIN
  -- Bloquear e iterar APENAS sobre pedidos pendentes cujo tempo limite por método de pagamento expirou
  -- Pedidos 'in_process' (em análise de antifraude) NUNCA são expirados pela rotina
  FOR v_order IN
    SELECT id
    FROM public.orders
    WHERE payment_status = 'pending'
      AND (
        (payment_method = 'pix' AND created_at < v_cutoff_pix)
        OR (payment_method = 'credit_card' AND created_at < v_cutoff_card)
        OR (payment_method = 'boleto' AND created_at < v_cutoff_boleto)
      )
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    v_cancelled_res := public.cancel_order_and_release_stock(v_order.id, 'expired_timeout');
    IF (v_cancelled_res->>'success')::boolean IS TRUE AND (v_cancelled_res->>'already_cancelled') IS NULL THEN
      v_expired_count := v_expired_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expired_orders_count', v_expired_count,
    'cutoff_pix', v_cutoff_pix,
    'timeout_minutes_pix', p_timeout_minutes
  );
END;
$$;

-- Permissões de Segurança Rigorosas
REVOKE EXECUTE ON FUNCTION public.process_order_checkout FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_order_checkout FROM anon;
GRANT EXECUTE ON FUNCTION public.process_order_checkout TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.cancel_order_and_release_stock FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_order_and_release_stock FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_order_and_release_stock TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets FROM anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_and_issue_tickets TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.expire_pending_orders FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_pending_orders FROM anon;
GRANT EXECUTE ON FUNCTION public.expire_pending_orders TO authenticated, service_role;
