import { UserRole } from '../types';

export const VALID_USER_ROLES: readonly UserRole[] = [
  'USER',
  'CHECKIN_OPERATOR',
  'ADMIN',
  'SUPER_ADMIN',
] as const;

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function isValidUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (VALID_USER_ROLES as readonly string[]).includes(value);
}

export interface RoleChangePolicyInput {
  actorUserId: string;
  actorRole: string;
  targetUserId: string;
  targetCurrentRole: string | null | undefined;
  newRole: unknown;
  otherSuperAdminsCount?: number;
}

export interface RoleChangePolicyOutcome {
  allowed: boolean;
  statusCode: number;
  error?: string;
  code?: string;
}

/**
 * Avalia estritamente todas as regras de segurança e hierarquia RBAC para alteração de papel:
 * 1. Validação de UUID do ator e do alvo (400)
 * 2. Validação do novo papel contra o enum oficial USER | CHECKIN_OPERATOR | ADMIN | SUPER_ADMIN (400)
 * 3. Permissão do solicitante: apenas ADMIN e SUPER_ADMIN podem gerenciar papéis (403)
 * 4. Existência do perfil alvo (404)
 * 5. Proibição absoluta de auto-alteração de papel (403)
 * 6. Hierarquia estrita para ADMIN: só pode gerenciar e atribuir USER e CHECKIN_OPERATOR (403)
 * 7. Proteção do último SUPER_ADMIN ativo do sistema (403)
 */
export function evaluateUserRoleChangePolicy(input: RoleChangePolicyInput): RoleChangePolicyOutcome {
  const {
    actorUserId,
    actorRole,
    targetUserId,
    targetCurrentRole,
    newRole,
    otherSuperAdminsCount = 0,
  } = input;

  if (!isValidUuid(actorUserId)) {
    return {
      allowed: false,
      statusCode: 401,
      code: 'INVALID_ACTOR_ID',
      error: 'Identificador do administrador autenticado inválido.',
    };
  }

  if (!isValidUuid(targetUserId)) {
    return {
      allowed: false,
      statusCode: 400,
      code: 'INVALID_TARGET_ID',
      error: 'Parâmetro inválido: target_user_id deve ser um UUID válido.',
    };
  }

  if (!isValidUserRole(newRole)) {
    return {
      allowed: false,
      statusCode: 400,
      code: 'INVALID_ROLE',
      error: `Papel inválido (${String(newRole)}). Os únicos papéis oficiais permitidos são: USER, CHECKIN_OPERATOR, ADMIN, SUPER_ADMIN.`,
    };
  }

  if (actorRole !== 'ADMIN' && actorRole !== 'SUPER_ADMIN') {
    return {
      allowed: false,
      statusCode: 403,
      code: 'INSUFFICIENT_PRIVILEGES',
      error: 'Acesso negado: Apenas administradores (ADMIN ou SUPER_ADMIN) podem gerenciar níveis de permissão.',
    };
  }

  if (actorUserId.trim().toLowerCase() === targetUserId.trim().toLowerCase()) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'SELF_ROLE_CHANGE_FORBIDDEN',
      error: 'Acesso negado: Administradores não podem alterar o próprio nível de permissão.',
    };
  }

  if (!targetCurrentRole || !isValidUserRole(targetCurrentRole)) {
    return {
      allowed: false,
      statusCode: 404,
      code: 'TARGET_PROFILE_NOT_FOUND',
      error: 'Usuário alvo não encontrado ou sem perfil válido registrado em public.profiles.',
    };
  }

  // Regras estritas de hierarquia para ADMIN (não SUPER_ADMIN)
  if (actorRole === 'ADMIN') {
    if (targetCurrentRole === 'ADMIN' || targetCurrentRole === 'SUPER_ADMIN') {
      return {
        allowed: false,
        statusCode: 403,
        code: 'ADMIN_CANNOT_MODIFY_ADMINS',
        error: 'Acesso negado: Apenas um SUPER_ADMIN pode alterar o papel de outros administradores.',
      };
    }

    if (newRole === 'ADMIN' || newRole === 'SUPER_ADMIN') {
      return {
        allowed: false,
        statusCode: 403,
        code: 'ADMIN_CANNOT_GRANT_ADMIN_ROLES',
        error: 'Acesso negado: Apenas um SUPER_ADMIN pode conceder os papéis ADMIN ou SUPER_ADMIN.',
      };
    }
  }

  // Proteção contra remoção ou rebaixamento do último SUPER_ADMIN do sistema
  if (targetCurrentRole === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN') {
    if (otherSuperAdminsCount < 1) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'LAST_SUPER_ADMIN_PROTECTED',
        error: 'Ação bloqueada: Não é permitido remover ou rebaixar o único SUPER_ADMIN ativo do sistema.',
      };
    }
  }

  return {
    allowed: true,
    statusCode: 200,
  };
}

/**
 * Mescla com segurança o novo papel nos metadados do Supabase Auth sem apagar campos existentes
 * (como full_name, phone, cpf, avatar_url).
 */
export function mergeAuthUserMetadata(
  existingMetadata: Record<string, unknown> | null | undefined,
  newRole: UserRole
): Record<string, unknown> {
  const safeBase =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? { ...existingMetadata }
      : {};
  return {
    ...safeBase,
    role: newRole,
  };
}

/**
 * Retorna os papéis que o administrador logado tem permissão de atribuir para um determinado usuário alvo,
 * bem como se a linha está bloqueada para edição.
 */
export function getRoleManagementPermissions(params: {
  callerId: string;
  callerRole: UserRole;
  targetId: string;
  targetRole: UserRole;
  superAdminCount: number;
}): {
  canEdit: boolean;
  lockReason?: string;
  allowedRoles: UserRole[];
} {
  const { callerId, callerRole, targetId, targetRole, superAdminCount } = params;

  if (callerRole !== 'ADMIN' && callerRole !== 'SUPER_ADMIN') {
    return {
      canEdit: false,
      lockReason: 'Sem permissão administrativa',
      allowedRoles: [],
    };
  }

  if (callerId && targetId && callerId.toLowerCase() === targetId.toLowerCase()) {
    return {
      canEdit: false,
      lockReason: 'Sua própria conta (auto-alteração bloqueada)',
      allowedRoles: [targetRole],
    };
  }

  if (callerRole === 'ADMIN') {
    if (targetRole === 'ADMIN' || targetRole === 'SUPER_ADMIN') {
      return {
        canEdit: false,
        lockReason: 'Protegido (requer SUPER_ADMIN)',
        allowedRoles: [targetRole],
      };
    }
    return {
      canEdit: true,
      allowedRoles: ['USER', 'CHECKIN_OPERATOR'],
    };
  }

  // callerRole === 'SUPER_ADMIN'
  if (targetRole === 'SUPER_ADMIN' && superAdminCount <= 1) {
    return {
      canEdit: false,
      lockReason: 'Último SUPER_ADMIN ativo (protegido)',
      allowedRoles: ['SUPER_ADMIN'],
    };
  }

  return {
    canEdit: true,
    allowedRoles: ['USER', 'CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'],
  };
}
