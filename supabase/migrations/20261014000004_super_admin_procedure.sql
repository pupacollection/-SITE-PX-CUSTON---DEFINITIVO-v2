-- ==============================================================================
-- PX CUSTON — Migração 04: Funções de Segurança, Check-in Atômico e Gestão de Papéis (Auditado - Revisão 2)
-- ==============================================================================

-- 1. FUNÇÃO ATÔMICA DE VALIDAÇÃO E CHECK-IN (ANTI-CONCORRÊNCIA COM ROW-LEVEL LOCKING)
CREATE OR REPLACE FUNCTION public.validate_and_checkin_ticket(
  p_code TEXT,
  p_operator_id UUID DEFAULT NULL,
  p_device_id TEXT DEFAULT 'web-scanner'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

-- 2. PROCEDIMENTO SEGURO PARA O PRIMEIRO SUPER_ADMIN
CREATE OR REPLACE FUNCTION public.promote_first_super_admin(
  target_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

-- Privilégios explícitos: Apenas service_role pode executar promote_first_super_admin
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_first_super_admin(TEXT) TO service_role;

-- 3. FUNÇÃO ADMINISTRATIVA PARA CONCESSÃO DE PAPÉIS (COM HIERARQUIA ESTRITA)
CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  target_user_id UUID,
  new_role user_role
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
