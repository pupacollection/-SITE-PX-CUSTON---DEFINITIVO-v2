-- ==============================================================================
-- PX CUSTON — Migração 03: Triggers de Autenticação, Proteção de Papéis e Integridade
-- Garante integridade referencial, bloqueia auto-promoção e protege eventos demo
-- ==============================================================================

-- 1. TRIGGER PARA CRIAÇÃO AUTOMÁTICA DE PERFIL AO CADASTRAR NO SUPABASE AUTH
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    phone,
    role,
    is_verified
  ) VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    'USER', -- Força sempre o papel básico 'USER', ignorando metadados enviados pelo cliente
    COALESCE((NEW.email_confirmed_at IS NOT NULL), false)
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;

-- 2. TRIGGER DE BLOQUEIO DE AUTO-PROMOÇÃO DE PAPEL (ROLE) COM NEGAÇÃO EXPLÍCITA DE NULL
CREATE OR REPLACE FUNCTION public.prevent_self_role_elevation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Em inserções (INSERT):
  -- Apenas service_role pode definir papel privilegiado na criação direta
  -- Proteção contra NULL: IS DISTINCT FROM 'service_role' nega explicitamente NULL
  IF TG_OP = 'INSERT' THEN
    IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
      NEW.role := 'USER';
    END IF;
    RETURN NEW;
  END IF;

  -- Em atualizações (UPDATE):
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role IS DISTINCT FROM NEW.role THEN
      -- 1. Permitir se for explicitamente a service_role (backend autorizado)
      IF current_setting('role', true) IS NOT DISTINCT FROM 'service_role' THEN
        RETURN NEW;
      END IF;

      -- 2. Permitir se for uma chamada administrativa autorizada (flag transacional)
      IF COALESCE(current_setting('px.allow_role_change', true), '') = 'true' THEN
        RETURN NEW;
      END IF;

      -- 3. Qualquer outra alteração direta de papel é estritamente bloqueada
      RAISE EXCEPTION 'Acesso negado: Alterações de privilégio de acesso (role) só podem ser efetuadas via funções administrativas autorizadas.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_protect_role_elevation ON public.profiles;
CREATE TRIGGER trigger_protect_role_elevation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_role_elevation();

REVOKE EXECUTE ON FUNCTION public.prevent_self_role_elevation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_self_role_elevation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_self_role_elevation() FROM authenticated;

-- 3. TRIGGER DE BLOQUEIO DE PEDIDOS EM EVENTOS DEMONSTRATIVOS (INSERT E UPDATE)
CREATE OR REPLACE FUNCTION public.check_order_not_demo_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_demo BOOLEAN;
BEGIN
  IF NEW.event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Identificador do evento (event_id) é obrigatório.';
  END IF;

  SELECT is_demo INTO v_is_demo FROM public.events WHERE id = NEW.event_id;
  IF v_is_demo IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Evento associado ao pedido não encontrado.';
  END IF;

  IF v_is_demo IS TRUE THEN
    RAISE EXCEPTION 'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) não aceitam pedidos ou vendas comerciais reais.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_prevent_demo_event_orders ON public.orders;
CREATE TRIGGER trigger_prevent_demo_event_orders
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.check_order_not_demo_event();

REVOKE EXECUTE ON FUNCTION public.check_order_not_demo_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_order_not_demo_event() FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_order_not_demo_event() FROM authenticated;

-- 4. TRIGGER DE CONSISTÊNCIA ENTRE EVENTO DO PEDIDO E LOTES DE INGRESSOS
CREATE OR REPLACE FUNCTION public.validate_order_item_batch_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_event_id UUID;
  v_batch_event_id UUID;
  v_batch_is_active BOOLEAN;
BEGIN
  IF NEW.order_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Identificador do pedido (order_id) é obrigatório.';
  END IF;
  IF NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Identificador do lote (batch_id) é obrigatório.';
  END IF;

  SELECT event_id INTO v_order_event_id FROM public.orders WHERE id = NEW.order_id;
  IF v_order_event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Pedido associado não encontrado.';
  END IF;

  SELECT event_id, is_active INTO v_batch_event_id, v_batch_is_active FROM public.ticket_batches WHERE id = NEW.batch_id;
  IF v_batch_event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Lote de ingressos associado não encontrado.';
  END IF;

  IF v_order_event_id IS DISTINCT FROM v_batch_event_id THEN
    RAISE EXCEPTION 'Inconsistência de integridade: O lote de ingressos (%) não pertence ao evento do pedido (%).', NEW.batch_id, v_order_event_id;
  END IF;

  IF TG_OP = 'INSERT' AND v_batch_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Operação bloqueada: O lote de ingressos selecionado não está ativo para novas compras.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_validate_order_item_batch ON public.order_items;
CREATE TRIGGER trigger_validate_order_item_batch
  BEFORE INSERT OR UPDATE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_order_item_batch_consistency();

REVOKE EXECUTE ON FUNCTION public.validate_order_item_batch_consistency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_order_item_batch_consistency() FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_order_item_batch_consistency() FROM authenticated;

-- 5. TRIGGER DE CONSISTÊNCIA NO INGRESSO ENTRE LOTE E EVENTO
CREATE OR REPLACE FUNCTION public.validate_ticket_batch_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_event_id UUID;
BEGIN
  IF NEW.event_id IS NULL OR NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: event_id e batch_id são obrigatórios para a emissão de ingressos.';
  END IF;

  SELECT event_id INTO v_batch_event_id FROM public.ticket_batches WHERE id = NEW.batch_id;
  IF v_batch_event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Lote de ingressos associado não encontrado.';
  END IF;

  IF NEW.event_id IS DISTINCT FROM v_batch_event_id THEN
    RAISE EXCEPTION 'Inconsistência de integridade: O lote associado ao ingresso não pertence ao evento informado.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_validate_ticket_batch ON public.tickets;
CREATE TRIGGER trigger_validate_ticket_batch
  BEFORE INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.validate_ticket_batch_consistency();

REVOKE EXECUTE ON FUNCTION public.validate_ticket_batch_consistency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_ticket_batch_consistency() FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_ticket_batch_consistency() FROM authenticated;

-- 6. TRIGGER DE IMUTABILIDADE DA TABELA AUDIT_LOGS
CREATE OR REPLACE FUNCTION public.protect_audit_logs_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Operação bloqueada: Registros de auditoria são imutáveis e não podem ser alterados ou excluídos.';
END;
$$;

DROP TRIGGER IF EXISTS trigger_audit_logs_immutable ON public.audit_logs;
CREATE TRIGGER trigger_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.protect_audit_logs_immutability();

REVOKE EXECUTE ON FUNCTION public.protect_audit_logs_immutability() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_audit_logs_immutability() FROM anon;
REVOKE EXECUTE ON FUNCTION public.protect_audit_logs_immutability() FROM authenticated;
