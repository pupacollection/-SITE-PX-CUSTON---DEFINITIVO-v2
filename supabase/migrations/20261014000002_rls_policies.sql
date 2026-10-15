-- ==============================================================================
-- PX CUSTON — Migração 02: Row Level Security (RLS) e Políticas de Acesso
-- Princípio do Menor Privilégio: Visitante < Usuário < Operador < Admin < SUPER_ADMIN
-- ==============================================================================

-- 1. HABILITAÇÃO OBRIGATÓRIA DE RLS EM TODAS AS TABELAS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkin_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 2. FUNÇÕES AUXILIARES DE SEGURANÇA
CREATE OR REPLACE FUNCTION public.get_auth_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = 'SUPER_ADMIN' FROM public.profiles WHERE id = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_super()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role IN ('ADMIN', 'SUPER_ADMIN') FROM public.profiles WHERE id = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.is_operator_or_above()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role IN ('CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN') FROM public.profiles WHERE id = auth.uid()), false);
-- Restrições explícitas de privilégios de execução
REVOKE EXECUTE ON FUNCTION public.get_auth_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_auth_role() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_auth_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_auth_role() TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_admin_or_super() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin_or_super() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super() TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_operator_or_above() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_operator_or_above() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_operator_or_above() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_operator_or_above() TO service_role;

-- 3. POLÍTICAS PARA PROFILES
-- Leitura: Usuário lê seu próprio perfil; Operadores e Admins lêem qualquer perfil
CREATE POLICY "profiles_select_policy" ON public.profiles
  FOR SELECT
  USING (
    auth.uid() = id
    OR public.is_operator_or_above()
  );

-- Atualização: Usuário atualiza dados pessoais próprios
CREATE POLICY "profiles_update_policy" ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id OR public.is_super_admin())
  WITH CHECK (auth.uid() = id OR public.is_super_admin());

-- Inserção: Feita automaticamente pelo trigger on_auth_user_created
CREATE POLICY "profiles_insert_policy" ON public.profiles
  FOR INSERT
  WITH CHECK (auth.uid() = id OR public.is_super_admin());

-- 4. POLÍTICAS PARA VEHICLES
CREATE POLICY "vehicles_select_own" ON public.vehicles
  FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

CREATE POLICY "vehicles_insert_own" ON public.vehicles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "vehicles_update_own" ON public.vehicles
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "vehicles_delete_own" ON public.vehicles
  FOR DELETE
  USING (auth.uid() = user_id OR public.is_admin_or_super());

-- 5. POLÍTICAS PARA EVENTS
-- Leitura: Qualquer visitante ou autenticado pode ver eventos publicados; Admins vêem rascunhos
CREATE POLICY "events_select_policy" ON public.events
  FOR SELECT
  USING (status = 'published' OR public.is_admin_or_super());

-- Escrita/Edição/Exclusão: Apenas ADMIN e SUPER_ADMIN
CREATE POLICY "events_admin_insert" ON public.events
  FOR INSERT
  WITH CHECK (public.is_admin_or_super());

CREATE POLICY "events_admin_update" ON public.events
  FOR UPDATE
  USING (public.is_admin_or_super())
  WITH CHECK (public.is_admin_or_super());

CREATE POLICY "events_admin_delete" ON public.events
  FOR DELETE
  USING (public.is_admin_or_super());

-- 6. POLÍTICAS PARA TICKET_BATCHES
CREATE POLICY "batches_select_public" ON public.ticket_batches
  FOR SELECT
  USING (
    (is_active = true AND EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.status = 'published'))
    OR public.is_admin_or_super()
    OR public.is_operator_or_above()
  );

CREATE POLICY "batches_admin_all" ON public.ticket_batches
  FOR ALL
  USING (public.is_admin_or_super())
  WITH CHECK (public.is_admin_or_super());

-- 7. POLÍTICAS PARA ORDERS E ORDER_ITEMS
CREATE POLICY "orders_select_own" ON public.orders
  FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "order_items_select_own" ON public.order_items
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND (o.user_id = auth.uid() OR public.is_admin_or_super()))
  );

CREATE POLICY "order_items_insert_own" ON public.order_items
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid())
  );

-- 8. POLÍTICAS PARA PAYMENTS
-- Leitura de pagamento: Dono do pedido ou Administrador
CREATE POLICY "payments_select_policy" ON public.payments
  FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

-- Inserção de pagamento: Dono do pedido
CREATE POLICY "payments_insert_policy" ON public.payments
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Atualização: Apenas backend / service role pode mudar status para aprovado/rejeitado

-- 9. POLÍTICAS PARA TICKETS
-- Leitura: Usuário vê seus ingressos; Operador de check-in e Admin visualizam ingressos para conferência
CREATE POLICY "tickets_select_policy" ON public.tickets
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_operator_or_above()
  );

-- Atualização de status de ingresso (ex: marcação de check-in): apenas operadores e admins
CREATE POLICY "tickets_update_operator" ON public.tickets
  FOR UPDATE
  USING (public.is_operator_or_above())
  WITH CHECK (public.is_operator_or_above());

-- 10. POLÍTICAS PARA CHECKINS
CREATE POLICY "checkins_select_operator" ON public.checkins
  FOR SELECT
  USING (public.is_operator_or_above());

CREATE POLICY "checkins_insert_operator" ON public.checkins
  FOR INSERT
  WITH CHECK (public.is_operator_or_above());

-- 11. POLÍTICAS PARA AUDIT_LOGS (Imutável e protegido contra forjamento)
CREATE POLICY "audit_logs_select_admin" ON public.audit_logs
  FOR SELECT
  USING (public.is_admin_or_super());

CREATE POLICY "audit_logs_insert_admin" ON public.audit_logs
  FOR INSERT
  WITH CHECK (
    (public.is_admin_or_super() AND (actor_id = auth.uid() OR actor_id IS NULL))
    OR current_setting('role', true) IS NOT DISTINCT FROM 'service_role'
  );

-- 12. POLÍTICAS PARA CHECKIN_DEVICES
CREATE POLICY "checkin_devices_operator_all" ON public.checkin_devices
  FOR ALL
  USING (public.is_operator_or_above())
  WITH CHECK (public.is_operator_or_above());
