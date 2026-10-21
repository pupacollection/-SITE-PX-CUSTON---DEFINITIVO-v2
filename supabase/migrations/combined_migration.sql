-- ==============================================================================
-- PX CUSTON — Migração Consolidada Oficial (Fase 2 - Revisão 2 de Segurança)
-- Execute no SQL Editor do Supabase: https://supabase.com/dashboard/project/jivviwvpjxzhbpbmqmxm/sql
-- Integridade Transacional Completa (BEGIN ... COMMIT)
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. TIPOS ENUMERADOS
-- ------------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('USER', 'CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('pending', 'paid', 'cancelled', 'refunded', 'used', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('pix', 'credit_card', 'boleto');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'in_process', 'rejected', 'refunded', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE event_status AS ENUM ('draft', 'published', 'finished');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ------------------------------------------------------------------------------
-- 2. TABELAS PRINCIPAIS (11 TABELAS OFICIAIS DO SCHEMA)
-- ------------------------------------------------------------------------------

-- Tabela 1: Profiles (Perfis de Usuários)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  cpf TEXT,
  avatar_url TEXT,
  role user_role NOT NULL DEFAULT 'USER',
  is_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 2: Vehicles (Veículos de Usuários)
CREATE TABLE IF NOT EXISTS public.vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  year INT,
  license_plate TEXT NOT NULL,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 3: Events (Eventos Automotivos)
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  subtitle TEXT,
  date TIMESTAMPTZ NOT NULL,
  formatted_date TEXT NOT NULL,
  location TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  min_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  cover_image TEXT NOT NULL,
  gallery_images TEXT[] DEFAULT ARRAY[]::TEXT[],
  description TEXT NOT NULL,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  classification TEXT NOT NULL DEFAULT 'Classificação 16 anos',
  rules TEXT[] DEFAULT ARRAY[]::TEXT[],
  is_official BOOLEAN NOT NULL DEFAULT true,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  status event_status NOT NULL DEFAULT 'published',
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_demo_event_distinction CHECK (NOT (is_demo IS TRUE AND is_official IS TRUE))
);

-- Tabela 4: Ticket Batches (Lotes de Ingressos)
CREATE TABLE IF NOT EXISTS public.ticket_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  total_quantity INT NOT NULL,
  available_quantity INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_positive_quantity CHECK (available_quantity >= 0 AND available_quantity <= total_quantity),
  CONSTRAINT uq_event_batch_name UNIQUE (event_id, name)
);

-- Tabela 5: Orders (Pedidos de Compra)
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  subtotal NUMERIC(10,2) NOT NULL,
  convenience_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  discount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  total NUMERIC(10,2) NOT NULL,
  payment_method payment_method NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  mercado_pago_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 6: Order Items (Itens do Pedido)
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES public.ticket_batches(id) ON DELETE RESTRICT,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL
);

-- Tabela 7: Payments (Transações de Pagamento)
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  external_reference TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 8: Tickets (Ingressos Emitidos e Validados)
CREATE TABLE IF NOT EXISTS public.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES public.ticket_batches(id) ON DELETE RESTRICT,
  holder_name TEXT NOT NULL,
  holder_doc TEXT,
  price NUMERIC(10,2) NOT NULL,
  status ticket_status NOT NULL DEFAULT 'paid',
  qr_payload TEXT NOT NULL,
  checkin_at TIMESTAMPTZ,
  checkin_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 9: Checkins (Registro Auditável de Entrada no Evento)
CREATE TABLE IF NOT EXISTS public.checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  operator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela 10: Checkin Devices (Dispositivos Autorizados de Check-in)
CREATE TABLE IF NOT EXISTS public.checkin_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name TEXT NOT NULL,
  operator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- Tabela 11: Audit Logs (Trilha de Auditoria Administrativa Imutável)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 3. ÍNDICES DE PERFORMANCE E INTEGRIDADE
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_events_slug ON public.events(slug);
CREATE INDEX IF NOT EXISTS idx_events_date ON public.events(date);
CREATE INDEX IF NOT EXISTS idx_events_is_demo ON public.events(is_demo);
CREATE INDEX IF NOT EXISTS idx_events_is_official ON public.events(is_official);
CREATE INDEX IF NOT EXISTS idx_ticket_batches_event ON public.ticket_batches(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON public.tickets(code);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON public.tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON public.tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON public.tickets(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_batch ON public.order_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_checkins_ticket ON public.checkins(ticket_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);

-- ------------------------------------------------------------------------------
-- 4. HABILITAÇÃO OBRIGATÓRIA DE RLS EM TODAS AS 11 TABELAS
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- 5. FUNÇÕES DE SUPORTE À SEGURANÇA E POLÍTICAS RLS (SECURITY DEFINER)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_auth_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT role = 'SUPER_ADMIN' FROM public.profiles WHERE id = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_super()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT role IN ('ADMIN', 'SUPER_ADMIN') FROM public.profiles WHERE id = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.is_operator_or_above()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT role IN ('CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN') FROM public.profiles WHERE id = auth.uid()), false);
$$;

-- Restrições explícitas de privilégios de execução para funções auxiliares
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

-- ------------------------------------------------------------------------------
-- 6. POLÍTICAS RLS IDEMPOTENTES (DROP IF EXISTS + CREATE)
-- ------------------------------------------------------------------------------

-- 6.1. PROFILES
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles FOR SELECT
  USING (auth.uid() = id OR public.is_operator_or_above());

DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
CREATE POLICY "profiles_update_policy" ON public.profiles FOR UPDATE
  USING (auth.uid() = id OR public.is_super_admin())
  WITH CHECK (auth.uid() = id OR public.is_super_admin());

DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy" ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id OR public.is_super_admin());

-- 6.2. VEHICLES
DROP POLICY IF EXISTS "vehicles_select_own" ON public.vehicles;
CREATE POLICY "vehicles_select_own" ON public.vehicles FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

DROP POLICY IF EXISTS "vehicles_insert_own" ON public.vehicles;
CREATE POLICY "vehicles_insert_own" ON public.vehicles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "vehicles_update_own" ON public.vehicles;
CREATE POLICY "vehicles_update_own" ON public.vehicles FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "vehicles_delete_own" ON public.vehicles;
CREATE POLICY "vehicles_delete_own" ON public.vehicles FOR DELETE
  USING (auth.uid() = user_id OR public.is_admin_or_super());

-- 6.3. EVENTS
DROP POLICY IF EXISTS "events_select_policy" ON public.events;
CREATE POLICY "events_select_policy" ON public.events FOR SELECT
  USING (status = 'published' OR public.is_admin_or_super());

DROP POLICY IF EXISTS "events_admin_all" ON public.events;
CREATE POLICY "events_admin_all" ON public.events FOR ALL
  USING (public.is_admin_or_super()) WITH CHECK (public.is_admin_or_super());

-- 6.4. TICKET BATCHES
DROP POLICY IF EXISTS "batches_select_public" ON public.ticket_batches;
CREATE POLICY "batches_select_public" ON public.ticket_batches FOR SELECT
  USING (
    (is_active = true AND EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.status = 'published'))
    OR public.is_admin_or_super()
    OR public.is_operator_or_above()
  );

DROP POLICY IF EXISTS "batches_admin_all" ON public.ticket_batches;
CREATE POLICY "batches_admin_all" ON public.ticket_batches FOR ALL
  USING (public.is_admin_or_super()) WITH CHECK (public.is_admin_or_super());

-- 6.5. ORDERS
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
CREATE POLICY "orders_select_own" ON public.orders FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 6.6. ORDER ITEMS
DROP POLICY IF EXISTS "order_items_select_own" ON public.order_items;
CREATE POLICY "order_items_select_own" ON public.order_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND (o.user_id = auth.uid() OR public.is_admin_or_super())));

DROP POLICY IF EXISTS "order_items_insert_own" ON public.order_items;
CREATE POLICY "order_items_insert_own" ON public.order_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

-- 6.7. PAYMENTS
DROP POLICY IF EXISTS "payments_select_policy" ON public.payments;
CREATE POLICY "payments_select_policy" ON public.payments FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin_or_super());

DROP POLICY IF EXISTS "payments_insert_policy" ON public.payments;
CREATE POLICY "payments_insert_policy" ON public.payments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 6.8. TICKETS
DROP POLICY IF EXISTS "tickets_select_policy" ON public.tickets;
CREATE POLICY "tickets_select_policy" ON public.tickets FOR SELECT
  USING (auth.uid() = user_id OR public.is_operator_or_above());

DROP POLICY IF EXISTS "tickets_update_operator" ON public.tickets;
CREATE POLICY "tickets_update_operator" ON public.tickets FOR UPDATE
  USING (public.is_operator_or_above()) WITH CHECK (public.is_operator_or_above());

-- 6.9. CHECKINS
DROP POLICY IF EXISTS "checkins_select_operator" ON public.checkins;
CREATE POLICY "checkins_select_operator" ON public.checkins FOR SELECT
  USING (public.is_operator_or_above());

DROP POLICY IF EXISTS "checkins_insert_operator" ON public.checkins;
CREATE POLICY "checkins_insert_operator" ON public.checkins FOR INSERT
  WITH CHECK (public.is_operator_or_above());

-- 6.10. CHECKIN DEVICES
DROP POLICY IF EXISTS "checkin_devices_operator_all" ON public.checkin_devices;
CREATE POLICY "checkin_devices_operator_all" ON public.checkin_devices FOR ALL
  USING (public.is_operator_or_above())
  WITH CHECK (public.is_operator_or_above());

-- 6.11. AUDIT LOGS (Proteção reforçada contra forjamento de registros)
DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
CREATE POLICY "audit_logs_select_admin" ON public.audit_logs FOR SELECT
  USING (public.is_admin_or_super());

DROP POLICY IF EXISTS "audit_logs_insert_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_admin" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_admin" ON public.audit_logs FOR INSERT
  WITH CHECK (
    (public.is_admin_or_super() AND (actor_id = auth.uid() OR actor_id IS NULL))
    OR current_setting('role', true) IS NOT DISTINCT FROM 'service_role'
  );

-- ------------------------------------------------------------------------------
-- 7. REGRAS DE NEGÓCIO E TRIGGERS DE SEGURANÇA
-- ------------------------------------------------------------------------------

-- 7.1. Bloqueio rigoroso de pedidos (INSERT e UPDATE) para eventos demonstrativos (is_demo = true)
CREATE OR REPLACE FUNCTION public.check_order_not_demo_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- 7.2. Validação estrita de consistência entre o evento do pedido e os lotes de ingressos
CREATE OR REPLACE FUNCTION public.validate_order_item_batch_consistency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- Obter o evento do pedido
  SELECT event_id INTO v_order_event_id FROM public.orders WHERE id = NEW.order_id;
  IF v_order_event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Pedido associado não encontrado.';
  END IF;

  -- Obter o evento e status do lote de ingressos
  SELECT event_id, is_active INTO v_batch_event_id, v_batch_is_active FROM public.ticket_batches WHERE id = NEW.batch_id;
  IF v_batch_event_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: Lote de ingressos associado não encontrado.';
  END IF;

  -- Validar se o lote de fato pertence ao evento do pedido
  IF v_order_event_id IS DISTINCT FROM v_batch_event_id THEN
    RAISE EXCEPTION 'Inconsistência de integridade: O lote de ingressos (%) não pertence ao evento do pedido (%).', NEW.batch_id, v_order_event_id;
  END IF;

  -- Validar se o lote está ativo para novos pedidos
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

-- 7.3. Validação estrita de consistência no ingresso (tickets) entre lote e evento
CREATE OR REPLACE FUNCTION public.validate_ticket_batch_consistency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- 7.4. Imutabilidade absoluta da tabela de trilha de auditoria (audit_logs)
CREATE OR REPLACE FUNCTION public.protect_audit_logs_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
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

-- 7.5. Criação automática de perfil ao cadastrar usuário no Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone, role, is_verified)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    'USER',
    COALESCE((NEW.email_confirmed_at IS NOT NULL), false)
  )
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
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

-- 7.6. Bloqueio rigoroso de auto-promoção de papel (role) e proteção contra NULL
CREATE OR REPLACE FUNCTION public.prevent_self_role_elevation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

      -- 2. Permitir se for uma chamada administrativa autorizada (flag transacional de admin_set_user_role)
      IF COALESCE(current_setting('px.allow_role_change', true), '') = 'true' THEN
        RETURN NEW;
      END IF;

      -- 3. Qualquer outra alteração de papel originada de clientes é estritamente bloqueada
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

-- ------------------------------------------------------------------------------
-- 8. FUNÇÃO ATÔMICA DE CHECK-IN COM BLOQUEIO DE LINHA (ANTI-CONCORRÊNCIA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_and_checkin_ticket(
  p_code TEXT,
  p_operator_id UUID DEFAULT NULL,
  p_device_id TEXT DEFAULT 'web-scanner'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role user_role;
  v_effective_operator UUID;
  v_ticket RECORD;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- 1. Validação de nulidade do código de ingresso
  IF p_code IS NULL OR trim(p_code) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_code',
      'message', 'Código do ingresso não fornecido ou inválido.'
    );
  END IF;

  -- 2. Verificação de autorização do chamador com negação explícita de NULL
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    -- Exigir usuário autenticado
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: Operador não autenticado.';
    END IF;

    -- Consultar perfil do operador na tabela public.profiles
    SELECT role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();

    -- Negar explicitamente operador sem perfil registrado
    IF v_caller_role IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: Perfil do operador não encontrado no sistema.';
    END IF;

    -- Negar chamadas sem o papel necessário
    IF v_caller_role NOT IN ('CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Acesso negado: Usuário com papel "%" não tem permissão para realizar check-in.', v_caller_role;
    END IF;

    -- Forçar que o operador registrado no check-in seja o próprio operador autenticado
    v_effective_operator := auth.uid();
  ELSE
    -- Chamada via backend oficial com credencial de serviço
    v_effective_operator := p_operator_id;
  END IF;

  -- 3. Consulta atômica com ROW LOCKING exclusivo (FOR UPDATE OF t)
  -- Bloqueia a linha do ingresso exclusivamente até o COMMIT, eliminando condição de corrida (Race Condition)
  SELECT
    t.id,
    t.code,
    t.event_id,
    t.batch_id,
    t.holder_name,
    t.status,
    t.checkin_at,
    e.title AS event_title,
    e.is_demo AS event_is_demo,
    b.name AS batch_name
  INTO v_ticket
  FROM public.tickets t
  JOIN public.events e ON e.id = t.event_id
  JOIN public.ticket_batches b ON b.id = t.batch_id
  WHERE upper(trim(t.code)) = upper(trim(p_code))
  FOR UPDATE OF t;

  -- Se o ingresso não foi localizado
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'message', format('Ingresso "%s" não encontrado na base de dados oficial PX CUSTON.', trim(p_code))
    );
  END IF;

  -- Se o ingresso já foi utilizado anteriormente
  IF v_ticket.status = 'used' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_used',
      'message', format('ALERTA DE SEGURANÇA: Ingresso %s já foi utilizado anteriormente!', v_ticket.code),
      'holder', v_ticket.holder_name,
      'checkin_at', v_ticket.checkin_at,
      'is_demo', v_ticket.event_is_demo
    );
  END IF;

  -- Se o status não for 'paid' (pendente, cancelado, estornado, etc.)
  IF v_ticket.status <> 'paid' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_status',
      'message', format('Ingresso não autorizado para entrada. Situação atual: "%s".', v_ticket.status),
      'holder', v_ticket.holder_name,
      'is_demo', v_ticket.event_is_demo
    );
  END IF;

  -- 4. Atualização transacional imediata do ingresso
  UPDATE public.tickets
  SET
    status = 'used',
    checkin_at = v_now,
    checkin_device_id = COALESCE(p_device_id, 'scanner')
  WHERE id = v_ticket.id;

  -- 5. Gravação do histórico auditável de check-in
  INSERT INTO public.checkins (
    ticket_id,
    event_id,
    operator_id,
    device_id,
    status,
    created_at
  ) VALUES (
    v_ticket.id,
    v_ticket.event_id,
    v_effective_operator,
    COALESCE(p_device_id, 'scanner'),
    'success',
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'status', 'success',
    'code', v_ticket.code,
    'event', v_ticket.event_title,
    'holder', v_ticket.holder_name,
    'batch', v_ticket.batch_name,
    'is_demo', v_ticket.event_is_demo,
    'timestamp', v_now
  );
END;
$$;

-- Privilégios explícitos para validação de check-in
REVOKE EXECUTE ON FUNCTION public.validate_and_checkin_ticket(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_and_checkin_ticket(TEXT, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_and_checkin_ticket(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_checkin_ticket(TEXT, UUID, TEXT) TO service_role;

-- ------------------------------------------------------------------------------
-- 9. GESTÃO DE PAPÉIS ADMINISTRATIVOS E BOOTSTRAP DO PRIMEIRO SUPER_ADMIN
-- ------------------------------------------------------------------------------

-- 9.1. Inicialização segura do primeiro SUPER_ADMIN (Apenas backend com service_role)
CREATE OR REPLACE FUNCTION public.promote_first_super_admin(target_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin_count INT;
  v_user_id UUID;
  v_existing_role user_role;
BEGIN
  -- 1. Restrição absoluta ao backend autenticado (service_role) com negação explícita de NULL
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Acesso negado: A inicialização do primeiro SUPER_ADMIN é de uso estrito do backend autorizado (service_role).';
  END IF;

  -- 2. Validação de nulidade do e-mail
  IF target_email IS NULL OR trim(target_email) = '' THEN
    RAISE EXCEPTION 'Parâmetro inválido: O e-mail do usuário não pode ser nulo ou vazio.';
  END IF;

  -- 2.1. Bloqueio consultivo transacional para garantir exclusividade entre instâncias concorrentes
  -- Chave estável de 64 bits para bootstrap de Super Admin (hash estável de 'px_custom_first_super_admin_bootstrap_lock')
  PERFORM pg_advisory_xact_lock(hashtext('px_custom_first_super_admin_bootstrap_lock'));

  -- 3. Garantia de unicidade da promoção inicial
  SELECT COUNT(*) INTO v_admin_count FROM public.profiles WHERE role = 'SUPER_ADMIN';
  IF v_admin_count > 0 THEN
    RAISE EXCEPTION 'Ação bloqueada: Já existe um SUPER_ADMIN registrado no sistema. Novas permissões devem ser geridas pelo painel PX CONTROL.';
  END IF;

  -- 4. Localização do perfil do usuário alvo
  SELECT id, role INTO v_user_id, v_existing_role
  FROM public.profiles
  WHERE lower(email) = lower(trim(target_email));

  -- Negar explicitamente usuário sem perfil cadastrado
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado: O e-mail "%" não possui perfil cadastrado na plataforma.', target_email;
  END IF;

  -- 5. Ativar flag transacional para autorizar alteração no trigger e executar atualização
  PERFORM set_config('px.allow_role_change', 'true', true);

  UPDATE public.profiles
  SET role = 'SUPER_ADMIN', updated_at = now()
  WHERE id = v_user_id;

  -- 6. Registro de auditoria permanente
  INSERT INTO public.audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    v_user_id,
    'FIRST_SUPER_ADMIN_PROMOTED',
    'profiles',
    v_user_id::TEXT,
    jsonb_build_object(
      'email', lower(trim(target_email)),
      'role', 'SUPER_ADMIN',
      'initialized_by', 'service_role_backend'
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Primeiro SUPER_ADMIN oficial da PX CUSTON inicializado com sucesso!',
    'email', lower(trim(target_email)),
    'role', 'SUPER_ADMIN'
  );
END;
$$;

-- Privilégios explícitos: REVOGADO TOTALMENTE de PUBLIC, anon e authenticated.
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) TO service_role;

-- 9.2. Alteração de Papel de Usuário por Administrador Autenticado
CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  target_user_id UUID,
  new_role user_role
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role user_role;
  v_target_current_role user_role;
  v_super_count INT;
  v_actor UUID;
BEGIN
  -- 1. Validação explícita de valores nulos nos parâmetros
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'Parâmetro inválido: O identificador do usuário alvo (target_user_id) não pode ser nulo.';
  END IF;

  IF new_role IS NULL THEN
    RAISE EXCEPTION 'Parâmetro inválido: O novo papel de acesso (new_role) não pode ser nulo.';
  END IF;

  -- 2. Verificação de permissões do chamador com negação explícita de NULL
  v_actor := COALESCE(auth.uid(), NULLIF(current_setting('px.actor_id', true), '')::UUID);

  IF current_setting('role', true) IS DISTINCT FROM 'service_role' OR v_actor IS NOT NULL THEN
    -- Exigir usuário autenticado
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: Usuário solicitante não autenticado.';
    END IF;

    -- Consultar perfil do solicitante
    SELECT role INTO v_caller_role FROM public.profiles WHERE id = v_actor;

    -- Negar explicitamente usuários sem perfil
    IF v_caller_role IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: Perfil do solicitante não encontrado no sistema.';
    END IF;

    -- Negar usuários sem privilégio administrativo
    IF v_caller_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Acesso negado: Privilégios insuficientes. Apenas administradores podem gerenciar papéis de acesso.';
    END IF;

    -- Impedir que qualquer administrador altere o seu próprio papel
    IF target_user_id = v_actor THEN
      RAISE EXCEPTION 'Acesso negado: Usuários administrativos não podem alterar os seus próprios privilégios de acesso.';
    END IF;
  END IF;

  -- 3. Localização e validação do usuário alvo
  SELECT role INTO v_target_current_role FROM public.profiles WHERE id = target_user_id;

  IF v_target_current_role IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado: O usuário alvo não possui perfil registrado na plataforma.';
  END IF;

  -- 4. Regras estritas de hierarquia para papel ADMIN (não SUPER_ADMIN)
  IF v_caller_role = 'ADMIN' THEN
    -- Administrador comum NÃO pode conceder ADMIN ou SUPER_ADMIN
    IF new_role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Acesso negado: Apenas um SUPER_ADMIN pode conceder os papéis ADMIN ou SUPER_ADMIN.';
    END IF;

    -- Administrador comum NÃO pode modificar outro ADMIN ou SUPER_ADMIN
    IF v_target_current_role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Acesso negado: Apenas um SUPER_ADMIN pode alterar papéis de outros administradores.';
    END IF;
  END IF;

  -- 5. Proteção contra remoção do último SUPER_ADMIN do sistema
  IF v_target_current_role = 'SUPER_ADMIN' AND new_role <> 'SUPER_ADMIN' THEN
    SELECT COUNT(*) INTO v_super_count FROM public.profiles WHERE role = 'SUPER_ADMIN' AND id <> target_user_id;
    IF v_super_count = 0 THEN
      RAISE EXCEPTION 'Ação bloqueada: Não é permitido remover ou rebaixar o único SUPER_ADMIN ativo do sistema.';
    END IF;
  END IF;

  -- 6. Habilitar autorização transacional para o trigger prevent_self_role_elevation
  PERFORM set_config('px.allow_role_change', 'true', true);

  -- 7. Execução da atualização
  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = target_user_id;

  -- 8. Registro no log de auditoria
  INSERT INTO public.audit_logs (actor_id, action, entity, entity_id, details)
  VALUES (
    v_actor,
    'ROLE_CHANGED',
    'profiles',
    target_user_id::TEXT,
    jsonb_build_object(
      'old_role', v_target_current_role,
      'new_role', new_role,
      'target_user_id', target_user_id,
      'executed_by', COALESCE(v_actor::TEXT, 'service_role')
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'target_id', target_user_id,
    'old_role', v_target_current_role,
    'new_role', new_role
  );
END;
$$;

-- Privilégios explícitos: Revogado de PUBLIC e anônimos; concedido a autenticados e service_role
REVOKE EXECUTE ON FUNCTION public.admin_set_user_role(UUID, user_role) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_set_user_role(UUID, user_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(UUID, user_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(UUID, user_role) TO service_role;

-- ------------------------------------------------------------------------------
-- 10. SEED DE EVENTOS DEMONSTRATIVOS (IS_DEMO = TRUE, IS_OFFICIAL = FALSE)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_evt_mega UUID;
  v_evt_racha UUID;
  v_evt_antigos UUID;
BEGIN
  -- Evento Demo 1: MEGA ENCONTRO PX CUSTON
  -- is_demo = true e is_official = false: claramente demarcado para testes e homologação
  INSERT INTO public.events (
    title, slug, subtitle, date, formatted_date, location, city, state, min_price, cover_image, description, tags, is_official, is_demo, status
  ) VALUES (
    'MEGA ENCONTRO PX CUSTON [DEMO]', 'mega-encontro-px-custon', 'Modelo para testes de homologação',
    '2025-11-15 14:00:00+00', '15 NOV 2025', 'Parque de Exposições', 'Manhuaçu', 'MG', 40.00,
    'https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80',
    'Demonstração de homologação técnica de lotes de ingressos e check-in da PX CUSTON.',
    ARRAY['Carros Rebaixados', 'Som Automotivo', 'Exposição', 'Praça de Alimentação'], false, true, 'published'
  ) ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false RETURNING id INTO v_evt_mega;

  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_mega, 'Pista', 'Entrada geral demonstrativa.', 40.00, 1000, 1000, true),
    (v_evt_mega, 'Camarote', 'Área coberta demonstrativa.', 70.00, 300, 300, true),
    (v_evt_mega, 'VIP', 'Acesso total demonstrativo.', 100.00, 150, 150, true)
  ON CONFLICT (event_id, name) DO NOTHING;

  -- Evento Demo 2: RACHA DE SOM
  INSERT INTO public.events (
    title, slug, subtitle, date, formatted_date, location, city, state, min_price, cover_image, description, tags, is_official, is_demo, status
  ) VALUES (
    'RACHA DE SOM [DEMO]', 'racha-de-som', 'Modelo para medição sonora',
    '2025-12-06 18:00:00+00', '06 DEZ 2025', 'Arena Automotiva', 'Manhuaçu', 'MG', 30.00,
    'https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=1200&q=80',
    'Demonstração de medição de som automotivo da PX CUSTON.',
    ARRAY['Som Automotivo', 'Medição RDL', 'Paredões', 'Troféus'], false, true, 'published'
  ) ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false RETURNING id INTO v_evt_racha;

  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_racha, 'Pista Geral', 'Acesso demonstrativo aos setores de medição.', 30.00, 800, 800, true),
    (v_evt_racha, 'Box Competidor + Carro', 'Acesso demonstrativo de veículo.', 90.00, 60, 60, true)
  ON CONFLICT (event_id, name) DO NOTHING;

  -- Evento Demo 3: CARROS ANTIGOS & CUSTOM
  INSERT INTO public.events (
    title, slug, subtitle, date, formatted_date, location, city, state, min_price, cover_image, description, tags, is_official, is_demo, status
  ) VALUES (
    'CARROS ANTIGOS & CUSTOM [DEMO]', 'carros-antigos', 'Modelo de clássicos para homologação',
    '2025-12-20 10:00:00+00', '20 DEZ 2025', 'Praça Central de Eventos', 'Manhuaçu', 'MG', 50.00,
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=1200&q=80',
    'Demonstração de clássicos e colecionadores da PX CUSTON.',
    ARRAY['Carros Antigos', 'Hot Rods', 'Colecionadores', 'Música ao Vivo'], false, true, 'published'
  ) ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false RETURNING id INTO v_evt_antigos;

  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_antigos, 'Ingresso Visitante', 'Acesso demonstrativo.', 50.00, 600, 600, true)
  ON CONFLICT (event_id, name) DO NOTHING;
END $$;

-- ------------------------------------------------------------------------------
-- 11. FUNÇÕES ATÔMICAS: CHECKOUT, CANCELAMENTO, EMISSÃO E EXPIRAÇÃO DE PEDIDOS
-- ------------------------------------------------------------------------------

-- 11.1. process_order_checkout: Valida evento, lotes, estoque e datas com ROW LOCK (FOR UPDATE),
-- decrementa estoque atomicamente e cria pedido + itens em transação atômica única.
-- Suporte a idempotência estrita via p_order_id e eliminação de Deadlocks por ordenação de batch_id.
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

-- 11.2. cancel_order_and_release_stock: Cancela pedido não pago e devolve estoque aos lotes
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

-- 11.3. confirm_order_and_issue_tickets: Confirma pagamento e emite ingressos reais com lock anti-duplicação
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

-- 11.4. expire_pending_orders: Rotina autoritativa de expiração periódica
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

COMMIT;

