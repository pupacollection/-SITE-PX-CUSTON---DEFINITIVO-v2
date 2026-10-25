-- ==============================================================================
-- PX CUSTON — MIGRATION: UNICIDADE DE PAGAMENTOS, IDEMPOTÊNCIA FIM A FIM E
-- PROTEÇÃO DE RECONCILIAÇÃO PIX NA EXPIRAÇÃO DE PEDIDOS
-- ==============================================================================
-- NOTA DE HOMOLOGAÇÃO:
-- Este arquivo de migração é fornecido para revisão técnica antes da aplicação
-- controlada em ambiente de homologação/produção.
--
-- Objetivos:
-- 1. Garantir unicidade de vínculo em public.payments por order_id e por
--    external_reference (payment_id do Mercado Pago), prevenindo duplicidade de
--    registros financeiros para o mesmo pedido.
-- 2. Endurecer public.process_order_checkout para:
--    - Retornar mercado_pago_id em chamadas idempotentes (already_processed = true);
--    - Bloquear reutilização de p_order_id cujo pedido já esteja encerrado
--      (cancelled, rejected ou refunded), exigindo um novo UUID de tentativa.
-- 3. Endurecer public.expire_pending_orders para:
--    - Aplicar janela mínima de segurança de 18 minutos para Pix (15 min do QR Code
--      + 3 min de margem de compensação/reconciliação);
--    - Nunca cancelar pedido que já possua pagamento 'approved' ou 'in_process'
--      registrado em public.payments.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Validação prévia e saneamento com preservação integral de histórico financeiro
--    antes da criação dos índices únicos em public.payments
-- ------------------------------------------------------------------------------
-- CONSULTAS SOMENTE LEITURA RECOMENDADAS ANTES DE APLICAR ESTA MIGRATION:
--   a) Duplicidades por order_id:
--      SELECT order_id, COUNT(*), array_agg(id), array_agg(status), array_agg(external_reference)
--      FROM public.payments GROUP BY order_id HAVING COUNT(*) > 1;
--   b) Duplicidades por external_reference:
--      SELECT external_reference, COUNT(*), array_agg(id), array_agg(order_id), array_agg(status)
--      FROM public.payments
--      WHERE external_reference IS NOT NULL AND btrim(external_reference) <> ''
--      GROUP BY external_reference HAVING COUNT(*) > 1;
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payments_dedup_archive (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL,
  user_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  method payment_method NOT NULL,
  status payment_status NOT NULL,
  external_reference TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_reason TEXT NOT NULL
);

DO $$
DECLARE
  v_conflicting_financial_orders INT := 0;
  v_conflicting_ext_refs INT := 0;
BEGIN
  -- 1.1 Bloquear automaticamente se um mesmo pedido possuir mais de um pagamento efetivo (approved, in_process ou refunded)
  SELECT COUNT(*) INTO v_conflicting_financial_orders
  FROM (
    SELECT order_id
    FROM public.payments
    WHERE status IN ('approved', 'in_process', 'refunded')
    GROUP BY order_id
    HAVING COUNT(*) > 1
  ) c;

  IF v_conflicting_financial_orders > 0 THEN
    RAISE EXCEPTION 'Auditoria financeira obrigatória: Existem % pedido(s) com múltiplos pagamentos nos status approved/in_process/refunded em public.payments. Concilie manualmente antes de criar o índice único.', v_conflicting_financial_orders;
  END IF;

  -- 1.2 Bloquear automaticamente se um mesmo external_reference (payment_id do Mercado Pago) estiver vinculado a mais de um order_id distinto
  SELECT COUNT(*) INTO v_conflicting_ext_refs
  FROM (
    SELECT external_reference
    FROM public.payments
    WHERE external_reference IS NOT NULL AND btrim(external_reference) <> ''
    GROUP BY external_reference
    HAVING COUNT(DISTINCT order_id) > 1
  ) e;

  IF v_conflicting_ext_refs > 0 THEN
    RAISE EXCEPTION 'Auditoria financeira obrigatória: Existem % external_reference(s) vinculados a múltiplos pedidos distintos em public.payments. Concilie manualmente antes de criar o índice único.', v_conflicting_ext_refs;
  END IF;
END $$;

-- 1.3 Arquivar tentativas obsoletas duplicadas por order_id sem perda de histórico financeiro
-- Prioridade explícita contemplando todos os 6 valores do enum payment_status:
-- 1: approved | 2: in_process | 3: refunded | 4: pending | 5: rejected | 6: cancelled
WITH ranked_by_order AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY order_id
           ORDER BY
             CASE status
               WHEN 'approved' THEN 1
               WHEN 'in_process' THEN 2
               WHEN 'refunded' THEN 3
               WHEN 'pending' THEN 4
               WHEN 'rejected' THEN 5
               WHEN 'cancelled' THEN 6
               ELSE 7
             END ASC,
             updated_at DESC NULLS LAST,
             created_at DESC NULLS LAST
         ) AS rn
  FROM public.payments
  WHERE order_id IS NOT NULL
),
moved_order_dups AS (
  DELETE FROM public.payments p
  USING ranked_by_order r
  WHERE p.id = r.id
    AND r.rn > 1
    AND p.status IN ('pending', 'rejected', 'cancelled')
  RETURNING p.*
)
INSERT INTO public.payments_dedup_archive (
  id, order_id, user_id, amount, method, status, external_reference, metadata, created_at, updated_at, archived_at, archive_reason
)
SELECT
  id, order_id, user_id, amount, method, status, external_reference, metadata, created_at, updated_at, now(), 'duplicate_order_id_superseded'
FROM moved_order_dups
ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_id_unique
  ON public.payments (order_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_reference_unique
  ON public.payments (external_reference)
  WHERE external_reference IS NOT NULL AND btrim(external_reference) <> '';


-- ------------------------------------------------------------------------------
-- 2. Atualização de public.process_order_checkout
--    Retorna mercado_pago_id em retries e bloqueia reuso de pedido encerrado
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
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'O pedido deve conter pelo menos um item.';
  END IF;

  -- 0. Idempotência Estrita com Verificação de Compatibilidade e Estado Financeiro
  IF p_order_id IS NOT NULL THEN
    SELECT * INTO v_existing_order
    FROM public.orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF v_existing_order.id IS NOT NULL THEN
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

      IF v_existing_order.user_id IS DISTINCT FROM p_user_id
         OR v_existing_order.event_id IS DISTINCT FROM p_event_id
         OR v_existing_order.payment_method IS DISTINCT FROM p_payment_method
         OR v_requested_items_norm IS DISTINCT FROM v_existing_items_norm
      THEN
        RAISE EXCEPTION 'Conflito de idempotência: O identificador de pedido (%) já está vinculado a outro comprador, evento, método de pagamento ou conjunto de itens.', p_order_id;
      END IF;

      -- Bloquear reutilização de pedido já cancelado, rejeitado ou estornado
      IF v_existing_order.payment_status IN ('cancelled', 'rejected', 'refunded') THEN
        RAISE EXCEPTION 'Operação bloqueada: O pedido (%) já foi encerrado com status "%" e seu estoque foi liberado. Gere um novo identificador de tentativa.', p_order_id, v_existing_order.payment_status;
      END IF;

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
        'mercado_pago_id', v_existing_order.mercado_pago_id,
        'buyer_info', COALESCE(p_buyer_info, '{}'::jsonb),
        'created_at', v_existing_order.created_at
      );
    END IF;
  END IF;

  -- 1. Validar se o perfil do comprador existe
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

    IF (v_profile.cpf IS NULL OR btrim(v_profile.cpf) = '') AND v_buyer_cpf IS NOT NULL AND length(v_buyer_cpf) = 11 THEN
      UPDATE public.profiles
      SET cpf = v_buyer_cpf, updated_at = v_now
      WHERE id = p_user_id;
    END IF;
  END IF;

  -- 2. Validar evento oficial
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

  -- 3. Reserva de estoque atômica com ROW LOCKING (FOR UPDATE)
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

    SELECT * INTO v_batch
    FROM public.ticket_batches
    WHERE id = v_batch_id
    FOR UPDATE;

    IF v_batch.id IS NULL THEN
      RAISE EXCEPTION 'Lote de ingressos não encontrado (id: %).', v_batch_id;
    END IF;

    IF v_batch.event_id IS DISTINCT FROM p_event_id THEN
      RAISE EXCEPTION 'Inconsistência de integridade: O lote "%" (%) não pertence ao evento do pedido.', v_batch.name, v_batch_id;
    END IF;

    IF v_batch.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'O lote "%" está inativo ou com vendas suspensas.', v_batch.name;
    END IF;

    IF v_batch.start_date IS NOT NULL AND v_batch.start_date > v_now THEN
      RAISE EXCEPTION 'As vendas para o lote "%" ainda não foram iniciadas.', v_batch.name;
    END IF;

    IF v_batch.end_date IS NOT NULL AND v_batch.end_date < v_now THEN
      RAISE EXCEPTION 'O período de vendas para o lote "%" já está encerrado.', v_batch.name;
    END IF;

    IF v_batch.available_quantity < v_qty THEN
      RAISE EXCEPTION 'Estoque insuficiente: O lote "%" possui apenas % ingressos disponíveis (solicitado: %).', v_batch.name, v_batch.available_quantity, v_qty;
    END IF;

    UPDATE public.ticket_batches
    SET available_quantity = available_quantity - v_qty
    WHERE id = v_batch_id;

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
    'mercado_pago_id', NULL,
    'buyer_info', COALESCE(p_buyer_info, '{}'::jsonb),
    'created_at', v_now
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Atualização de public.expire_pending_orders com janela mínima de segurança (18 min)
--    e proteção contra cancelamento de pedidos com pagamento aprovado/em análise
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_pending_orders(
  p_timeout_minutes INT DEFAULT 18
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_effective_minutes INT := GREATEST(COALESCE(p_timeout_minutes, 18), 18);
  v_cutoff_pix TIMESTAMPTZ := now() - (v_effective_minutes || ' minutes')::interval;
  v_cutoff_card TIMESTAMPTZ := now() - INTERVAL '1 hour';
  v_cutoff_boleto TIMESTAMPTZ := now() - INTERVAL '4 days';
  v_order RECORD;
  v_expired_count INT := 0;
  v_cancelled_res JSONB;
BEGIN
  FOR v_order IN
    SELECT o.id
    FROM public.orders o
    WHERE o.payment_status = 'pending'
      AND (
        (o.payment_method = 'pix' AND o.created_at < v_cutoff_pix)
        OR (o.payment_method = 'credit_card' AND o.created_at < v_cutoff_card)
        OR (o.payment_method = 'boleto' AND o.created_at < v_cutoff_boleto)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payments p
        WHERE p.order_id = o.id
          AND p.status IN ('approved', 'in_process', 'refunded')
      )
    ORDER BY o.created_at ASC
    FOR UPDATE OF o SKIP LOCKED
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
    'timeout_minutes_pix', v_effective_minutes
  );
END;
$$;

-- Proteger tabela de arquivo de auditoria financeira com RLS restrito a service_role
ALTER TABLE public.payments_dedup_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payments_dedup_archive FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.payments_dedup_archive TO service_role;

-- Preservar permissões estritas (exclusivamente service_role)
REVOKE EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_order_checkout(UUID, UUID, JSONB, payment_method, JSONB, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.expire_pending_orders(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_orders(INT) TO service_role;

COMMIT;
