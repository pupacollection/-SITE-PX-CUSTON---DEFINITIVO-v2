import { supabase } from '../lib/supabase';
import { UserProfile, UserRole } from '../types';
import { isValidUserRole, isValidUuid, VALID_USER_ROLES } from '../lib/userRoleValidator';

export interface AdminUserRow extends UserProfile {
  updated_at?: string;
}

export interface AdminUsersSummary {
  total: number;
  super_admins: number;
  admins: number;
  operators: number;
  users: number;
}

export interface AdminRoleAuditLog {
  id: string;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: {
    old_role?: string;
    new_role?: string;
    target_user_id?: string;
    target_email?: string;
    target_name?: string;
    email?: string;
    role?: string;
    executed_by?: string;
    executed_by_email?: string;
    executed_by_role?: string;
  } | null;
  created_at: string;
}

export interface GetAdminUsersParams {
  search?: string;
  role?: 'ALL' | UserRole;
  page?: number;
  limit?: number;
}

export interface GetAdminUsersResult {
  users: AdminUserRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  summary: AdminUsersSummary;
  audit_logs: AdminRoleAuditLog[];
  caller?: {
    id: string;
    email?: string;
    role: UserRole;
  };
  error?: string;
}

export interface UpdateUserRoleResult {
  success: boolean;
  unchanged?: boolean;
  target_user_id?: string;
  old_role?: UserRole;
  new_role?: UserRole;
  user?: AdminUserRow;
  message?: string;
  error?: string;
}

/**
 * Consulta real de usuários e perfis registrados na plataforma PX CUSTON.
 * Prioriza a rota administrativa oficial do backend (/api/admin/users) com fallback
 * estrito para consulta direta autenticada ao PostgreSQL (public.profiles via RLS).
 * Nunca retorna dados fictícios ou mockados.
 */
export async function getAdminUsers(params: GetAdminUsersParams = {}): Promise<GetAdminUsersResult> {
  const search = (params.search || '').trim();
  const roleFilter = params.role || 'ALL';
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 25));

  const emptyResult = (errorMsg: string): GetAdminUsersResult => ({
    users: [],
    pagination: { page: 1, limit, total: 0, totalPages: 1 },
    summary: { total: 0, super_admins: 0, admins: 0, operators: 0, users: 0 },
    audit_logs: [],
    error: errorMsg,
  });

  if (roleFilter !== 'ALL' && !isValidUserRole(roleFilter)) {
    return emptyResult(`Filtro de papel inválido (${roleFilter}).`);
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return emptyResult('Sessão administrativa não autenticada. Faça login novamente.');
    }

    // 1. Consultar endpoint administrativo autoritativo no backend Express
    try {
      const query = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        role: roleFilter,
      });
      if (search) {
        query.set('search', search);
      }

      const response = await fetch(`/api/admin/users?${query.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const payload = await response.json();
        if (response.ok && Array.isArray(payload.users)) {
          return {
            users: payload.users,
            pagination: payload.pagination || {
              page,
              limit,
              total: payload.users.length,
              totalPages: 1,
            },
            summary: payload.summary || {
              total: payload.users.length,
              super_admins: payload.users.filter((u: AdminUserRow) => u.role === 'SUPER_ADMIN').length,
              admins: payload.users.filter((u: AdminUserRow) => u.role === 'ADMIN').length,
              operators: payload.users.filter((u: AdminUserRow) => u.role === 'CHECKIN_OPERATOR').length,
              users: payload.users.filter((u: AdminUserRow) => u.role === 'USER').length,
            },
            audit_logs: Array.isArray(payload.audit_logs) ? payload.audit_logs : [],
            caller: payload.caller,
          };
        }

        if (response.status === 401 || response.status === 403 || response.status === 400) {
          return emptyResult(payload.error || 'Acesso negado ao consultar usuários.');
        }
      }
    } catch {
      // Caso a chamada HTTP falhe, prosseguir para consulta autenticada direta no Supabase sob RLS
    }

    // 2. Consulta direta autenticada ao Supabase PostgreSQL respeitando RLS (profiles_select_policy)
    const { data: allProfiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, cpf, avatar_url, role, is_verified, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (profilesError) {
      return emptyResult(`Erro ao consultar perfis no Supabase: ${profilesError.message}`);
    }

    const list: AdminUserRow[] = (allProfiles || []).map((row: any) => ({
      id: row.id,
      email: row.email || '',
      full_name: row.full_name || 'Usuário PX',
      phone: row.phone || '',
      cpf: row.cpf || '',
      avatar_url: row.avatar_url || undefined,
      role: isValidUserRole(row.role) ? row.role : 'USER',
      is_verified: Boolean(row.is_verified),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const summary: AdminUsersSummary = {
      total: list.length,
      super_admins: list.filter((u) => u.role === 'SUPER_ADMIN').length,
      admins: list.filter((u) => u.role === 'ADMIN').length,
      operators: list.filter((u) => u.role === 'CHECKIN_OPERATOR').length,
      users: list.filter((u) => u.role === 'USER').length,
    };

    const searchLower = search.toLowerCase();
    const filtered = list.filter((u) => {
      if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
      if (searchLower.length > 0) {
        return (
          u.full_name.toLowerCase().includes(searchLower) ||
          u.email.toLowerCase().includes(searchLower) ||
          (u.cpf || '').toLowerCase().includes(searchLower) ||
          u.id.toLowerCase().includes(searchLower)
        );
      }
      return true;
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    let auditLogs: AdminRoleAuditLog[] = [];
    try {
      const { data: logs } = await supabase
        .from('audit_logs')
        .select('id, actor_id, action, entity, entity_id, details, created_at')
        .eq('entity', 'profiles')
        .in('action', ['ROLE_CHANGED', 'ROLE_PROMOTED', 'FIRST_SUPER_ADMIN_PROMOTED'])
        .order('created_at', { ascending: false })
        .limit(15);
      if (Array.isArray(logs)) {
        auditLogs = logs as AdminRoleAuditLog[];
      }
    } catch {
      // Tolerante
    }

    return {
      users: paginated,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
      summary,
      audit_logs: auditLogs,
    };
  } catch (err: any) {
    return emptyResult(err?.message || 'Erro inesperado ao carregar usuários.');
  }
}

/**
 * Altera o papel (role) de um usuário através da rota administrativa autoritativa do backend,
 * garantindo validação de hierarquia, proteção contra auto-alteração, proteção do último SUPER_ADMIN,
 * sincronização de user_metadata no Supabase Auth e registro em public.audit_logs.
 */
export async function updateAdminUserRole(
  targetUserId: string,
  newRole: UserRole
): Promise<UpdateUserRoleResult> {
  if (!isValidUuid(targetUserId)) {
    return {
      success: false,
      error: 'Identificador do usuário alvo inválido (deve ser um UUID válido).',
    };
  }

  if (!isValidUserRole(newRole)) {
    return {
      success: false,
      error: `Papel inválido (${String(newRole)}). Papéis permitidos: ${VALID_USER_ROLES.join(', ')}.`,
    };
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return {
        success: false,
        error: 'Sua sessão expirou. Faça login novamente para gerenciar permissões.',
      };
    }

    const response = await fetch(`/api/admin/users/${encodeURIComponent(targetUserId)}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        target_user_id: targetUserId,
        new_role: newRole,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        success: false,
        error: data?.error || `Falha ao alterar permissão (HTTP ${response.status}).`,
      };
    }

    return {
      success: true,
      unchanged: Boolean(data?.unchanged),
      target_user_id: data?.target_user_id || targetUserId,
      old_role: data?.old_role,
      new_role: data?.new_role || newRole,
      user: data?.user,
      message: data?.message || `Papel atualizado com sucesso para ${newRole}.`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Erro de comunicação com o servidor ao atualizar permissão.',
    };
  }
}
