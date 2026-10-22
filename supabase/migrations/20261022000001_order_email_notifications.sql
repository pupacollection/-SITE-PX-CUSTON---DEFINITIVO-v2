-- ==============================================================================
-- PX CUSTON — MIGRATION: CONTROLE PERSISTENTE E IDEMPOTENTE DE NOTIFICAÇÕES POR E-MAIL
-- ==============================================================================
-- Garante que cada confirmação de pedido (order_confirmation) seja enviada uma única vez
-- após confirmação efetiva do pagamento e emissão dos ingressos, permitindo retentativas
-- seguras em caso de falha transitória de SMTP sem duplicar envios nem afetar pedidos/ingressos.

-- 1. TABELA DE CONTROLE DE NOTIFICAÇÕES DE PEDIDOS
CREATE TABLE IF NOT EXISTS public.order_email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL DEFAULT 'order_confirmation',
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  message_id TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_order_email_notification UNIQUE (order_id, notification_type)
);

-- Índices para busca rápida por pedido e status de envio
CREATE INDEX IF NOT EXISTS idx_order_email_notifications_order ON public.order_email_notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_order_email_notifications_status ON public.order_email_notifications(status);

-- 2. HABILITAÇÃO OBRIGATÓRIA DE ROW LEVEL SECURITY (RLS)
ALTER TABLE public.order_email_notifications ENABLE ROW LEVEL SECURITY;

-- Leitura permitida apenas para Administradores (ADMIN / SUPER_ADMIN) no PX CONTROL
DROP POLICY IF EXISTS "order_email_notifications_select_admin" ON public.order_email_notifications;
CREATE POLICY "order_email_notifications_select_admin" ON public.order_email_notifications
  FOR SELECT
  USING (public.is_admin_or_super());

-- Escrita e atualização restritas exclusivamente ao backend (service_role)
DROP POLICY IF EXISTS "order_email_notifications_service_all" ON public.order_email_notifications;
CREATE POLICY "order_email_notifications_service_all" ON public.order_email_notifications
  FOR ALL
  USING (current_setting('role', true) IS NOT DISTINCT FROM 'service_role')
  WITH CHECK (current_setting('role', true) IS NOT DISTINCT FROM 'service_role');

-- 3. FUNÇÃO ATÔMICA DE RESERVA DE ENVIO (CLAIM IDEMPOTENTE COM ROW LOCKING)
-- Evita condições de corrida caso dois webhooks aprovados cheguem simultaneamente.
CREATE OR REPLACE FUNCTION public.claim_order_confirmation_email(
  p_order_id UUID,
  p_recipient_email TEXT,
  p_notification_type TEXT DEFAULT 'order_confirmation'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record RECORD;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_order_id IS NULL OR p_recipient_email IS NULL OR btrim(p_recipient_email) = '' THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'invalid_parameters'
    );
  END IF;

  -- Garantir que a linha exista na tabela de notificações
  INSERT INTO public.order_email_notifications (
    order_id,
    notification_type,
    recipient_email,
    status,
    attempts,
    created_at,
    updated_at
  ) VALUES (
    p_order_id,
    COALESCE(p_notification_type, 'order_confirmation'),
    lower(btrim(p_recipient_email)),
    'pending',
    0,
    v_now,
    v_now
  )
  ON CONFLICT (order_id, notification_type) DO NOTHING;

  -- Bloquear a linha exclusivamente para esta transação
  SELECT * INTO v_record
  FROM public.order_email_notifications
  WHERE order_id = p_order_id
    AND notification_type = COALESCE(p_notification_type, 'order_confirmation')
  FOR UPDATE;

  -- Se já foi enviado com sucesso, bloquear novo envio (Idempotência estrita)
  IF v_record.status = 'sent' THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'already_sent', true,
      'status', v_record.status,
      'sent_at', v_record.sent_at,
      'attempts', v_record.attempts,
      'message_id', v_record.message_id
    );
  END IF;

  -- Se estiver em 'sending' há menos de 2 minutos (outro worker ativo), evitar disparo concorrente
  IF v_record.status = 'sending' AND v_record.updated_at > (v_now - INTERVAL '2 minutes') THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'already_sent', false,
      'in_progress', true,
      'status', v_record.status,
      'attempts', v_record.attempts
    );
  END IF;

  -- Reservar envio (transição para 'sending' e incremento de tentativa)
  UPDATE public.order_email_notifications
  SET
    status = 'sending',
    recipient_email = lower(btrim(p_recipient_email)),
    attempts = v_record.attempts + 1,
    updated_at = v_now
  WHERE id = v_record.id
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'claimed', true,
    'already_sent', false,
    'notification_id', v_record.id,
    'status', v_record.status,
    'attempts', v_record.attempts
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_confirmation_email(UUID, TEXT, TEXT) TO service_role;
