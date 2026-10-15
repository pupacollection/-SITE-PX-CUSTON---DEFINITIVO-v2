-- ==============================================================================
-- PX CUSTON — Migração 05: Seed dos Eventos Demonstrativos Iniciais (Auditado - Revisão 2)
-- Todos os registros iniciais são demarcados com is_demo = true e is_official = false
-- ==============================================================================

DO $$
DECLARE
  v_evt_mega UUID;
  v_evt_racha UUID;
  v_evt_antigos UUID;
BEGIN
  -- 1. MEGA ENCONTRO PX CUSTON (DEMO)
  -- is_demo = true e is_official = false: claramente demarcado para testes e homologação
  INSERT INTO public.events (
    title,
    slug,
    subtitle,
    date,
    formatted_date,
    location,
    city,
    state,
    min_price,
    cover_image,
    gallery_images,
    description,
    tags,
    classification,
    rules,
    is_official,
    is_demo,
    status
  ) VALUES (
    'MEGA ENCONTRO PX CUSTON [DEMO]',
    'mega-encontro-px-custon',
    'Evento modelo para testes de homologação e validação de ingressos',
    '2025-11-15 14:00:00+00',
    '15 NOV 2025',
    'Parque de Exposições',
    'Manhuaçu',
    'MG',
    40.00,
    'https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80',
    ARRAY[
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&w=800&q=80'
    ],
    'Demonstração de layout e homologação técnica de lotes de ingressos e check-in da PX CUSTON.',
    ARRAY['Carros Rebaixados', 'Som Automotivo', 'Exposição', 'Praça de Alimentação'],
    'Classificação 16 anos',
    ARRAY['Classificação 16 anos', 'Proibida entrada de bebidas', 'Estacionamento no local'],
    false,
    true, -- Identificado explicitamente como DEMO
    'published'
  )
  ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false
  RETURNING id INTO v_evt_mega;

  -- Lotes do Mega Encontro
  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_mega, 'Pista', 'Entrada geral demonstrativa para homologação de ingressos.', 40.00, 1000, 1000, true),
    (v_evt_mega, 'Camarote', 'Área coberta demonstrativa.', 70.00, 300, 300, true),
    (v_evt_mega, 'VIP', 'Acesso total demonstrativo.', 100.00, 150, 150, true)
  ON CONFLICT (event_id, name) DO NOTHING;

  -- 2. RACHA DE SOM (DEMO)
  INSERT INTO public.events (
    title,
    slug,
    subtitle,
    date,
    formatted_date,
    location,
    city,
    state,
    min_price,
    cover_image,
    gallery_images,
    description,
    tags,
    classification,
    rules,
    is_official,
    is_demo,
    status
  ) VALUES (
    'RACHA DE SOM [DEMO]',
    'racha-de-som',
    'Competição modelo para medição sonora e homologação',
    '2025-12-06 18:00:00+00',
    '06 DEZ 2025',
    'Arena Automotiva',
    'Manhuaçu',
    'MG',
    30.00,
    'https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=1200&q=80',
    ARRAY['https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=800&q=80'],
    'Demonstração de medição de som automotivo e competição da PX CUSTON.',
    ARRAY['Som Automotivo', 'Medição RDL', 'Paredões', 'Troféus'],
    'Classificação 18 anos',
    ARRAY['Classificação 18 anos', 'Proibido som de terceiros fora da arena'],
    false,
    true,
    'published'
  )
  ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false
  RETURNING id INTO v_evt_racha;

  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_racha, 'Pista Geral', 'Acesso demonstrativo aos setores de medição.', 30.00, 800, 800, true),
    (v_evt_racha, 'Box Competidor + Carro', 'Acesso demonstrativo de veículo.', 90.00, 60, 60, true)
  ON CONFLICT (event_id, name) DO NOTHING;

  -- 3. CARROS ANTIGOS & CUSTOM (DEMO)
  INSERT INTO public.events (
    title,
    slug,
    subtitle,
    date,
    formatted_date,
    location,
    city,
    state,
    min_price,
    cover_image,
    gallery_images,
    description,
    tags,
    classification,
    rules,
    is_official,
    is_demo,
    status
  ) VALUES (
    'CARROS ANTIGOS & CUSTOM [DEMO]',
    'carros-antigos',
    'Exposição modelo de veículos clássicos para homologação',
    '2025-12-20 10:00:00+00',
    '20 DEZ 2025',
    'Praça Central de Eventos',
    'Manhuaçu',
    'MG',
    50.00,
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=1200&q=80',
    ARRAY['https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=800&q=80'],
    'Demonstração da estrutura de clássicos e colecionadores.',
    ARRAY['Carros Antigos', 'Hot Rods', 'Colecionadores', 'Música ao Vivo'],
    'Classificação Livre',
    ARRAY['Classificação Livre (família)'],
    false,
    true,
    'published'
  )
  ON CONFLICT (slug) DO UPDATE SET is_demo = true, is_official = false
  RETURNING id INTO v_evt_antigos;

  INSERT INTO public.ticket_batches (event_id, name, description, price, total_quantity, available_quantity, is_active)
  VALUES
    (v_evt_antigos, 'Ingresso Visitante', 'Acesso demonstrativo à exposição.', 50.00, 600, 600, true)
  ON CONFLICT (event_id, name) DO NOTHING;

END $$;
