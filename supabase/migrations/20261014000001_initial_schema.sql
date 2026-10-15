-- ==============================================================================
-- PX CUSTON — Migração 01: Esquema Inicial de Banco de Dados (Auditado)
-- Tabelas principais: perfis, veículos, eventos, lotes, pedidos, pagamentos, ingressos, check-ins e logs
-- ==============================================================================

-- 1. TIPOS ENUMERADOS
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

-- 2. TABELA DE PERFIS PÚBLICOS (Vinculada ao auth.users)
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

-- 3. VEÍCULOS DOS USUÁRIOS (Projetos automotivos cadastrados)
CREATE TABLE IF NOT EXISTS public.vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  year INT,
  license_plate TEXT NOT NULL,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. EVENTOS OFICIAIS PX CUSTON
-- is_demo: diferencia dados de teste/demonstração de eventos reais contratados
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

-- 5. LOTES DE INGRESSOS (Ticket Batches)
CREATE TABLE IF NOT EXISTS public.ticket_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  total_quantity INT NOT NULL,
  available_quantity INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_positive_quantity CHECK (available_quantity >= 0 AND available_quantity <= total_quantity),
  CONSTRAINT uq_event_batch_name UNIQUE (event_id, name)
);

-- 6. PEDIDOS (Orders)
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

-- 7. ITENS DO PEDIDO (Order Items)
CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES public.ticket_batches(id) ON DELETE RESTRICT,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL
);

-- 8. PAGAMENTOS (Payments)
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

-- 9. INGRESSOS EMITIDOS (Tickets com QR Code)
CREATE TABLE IF NOT EXISTS public.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL, -- Ex: PX-7AI89C10
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

-- 10. REGISTRO DE CHECK-INS (Checkin Log)
CREATE TABLE IF NOT EXISTS public.checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  operator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. DISPOSITIVOS DE OPERADORES DE CHECK-IN
CREATE TABLE IF NOT EXISTS public.checkin_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name TEXT NOT NULL,
  operator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- 12. LOGS DE AUDITORIA ADMINISTRATIVA
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

-- ÍNDICES DE PERFORMANCE
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
