import React, { useState, useEffect, useCallback } from 'react';
import { UserProfile, UserRole } from '../../types';
import {
  AdminRoleAuditLog,
  AdminUserRow,
  AdminUsersSummary,
  getAdminUsers,
  updateAdminUserRole,
} from '../../services/usersService';
import {
  getRoleManagementPermissions,
  isValidUserRole,
  VALID_USER_ROLES,
} from '../../lib/userRoleValidator';
import { supabase } from '../../lib/supabase';
import {
  Users,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Lock,
  UserCheck,
  QrCode,
  FileText,
  ChevronLeft,
  ChevronRight,
  X,
  ArrowRight,
  Clock,
} from 'lucide-react';

interface AdminUsersManagerProps {
  currentUser?: UserProfile | null;
  onUserCountChange?: (count: number) => void;
}

const ROLE_METADATA: Record<
  UserRole,
  {
    label: string;
    shortLabel: string;
    description: string;
    badgeClass: string;
  }
> = {
  SUPER_ADMIN: {
    label: 'SUPER_ADMIN — Diretoria / Controle Total',
    shortLabel: 'SUPER_ADMIN',
    description:
      'Acesso total ao PX CONTROL, eventos, lotes, pedidos, configurações financeiras e gestão de administradores.',
    badgeClass: 'bg-[#FF1A2D]/15 text-[#FF1A2D] border-[#FF1A2D]/40',
  },
  ADMIN: {
    label: 'ADMIN — Administrador Operacional',
    shortLabel: 'ADMIN',
    description:
      'Acesso ao PX CONTROL para gestão de eventos, lotes, pedidos, check-in e atribuição de operadores de portaria.',
    badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  },
  CHECKIN_OPERATOR: {
    label: 'CHECKIN_OPERATOR — Operador de Portaria',
    shortLabel: 'CHECKIN_OPERATOR',
    description:
      'Acesso autorizado ao scanner QR Code de portaria (PX CHECK-IN) para conferência e validação de ingressos.',
    badgeClass: 'bg-sky-500/15 text-sky-400 border-sky-500/40',
  },
  USER: {
    label: 'USER — Participante / Cliente',
    shortLabel: 'USER',
    description:
      'Acesso padrão de cliente para compra de ingressos, carteira digital QR Code e gestão de perfil/veículos.',
    badgeClass: 'bg-zinc-800/80 text-zinc-300 border-zinc-700',
  },
};

export const AdminUsersManager: React.FC<AdminUsersManagerProps> = ({
  currentUser,
  onUserCountChange,
}) => {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [summary, setSummary] = useState<AdminUsersSummary>({
    total: 0,
    super_admins: 0,
    admins: 0,
    operators: 0,
    users: 0,
  });
  const [auditLogs, setAuditLogs] = useState<AdminRoleAuditLog[]>([]);
  const [callerId, setCallerId] = useState<string>(currentUser?.id || '');
  const [callerRole, setCallerRole] = useState<UserRole>(
    currentUser?.role && isValidUserRole(currentUser.role) ? currentUser.role : 'ADMIN'
  );

  // Estados de busca, filtro e paginação
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>('ALL');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalFiltered, setTotalFiltered] = useState(0);

  // Estados de carregamento e feedback
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Estado de seleção pendente por linha e modal de confirmação
  const [draftRoles, setDraftRoles] = useState<Record<string, UserRole>>({});
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    targetUser: AdminUserRow | null;
    newRole: UserRole | null;
  }>({
    open: false,
    targetUser: null,
    newRole: null,
  });
  const [submittingRole, setSubmittingRole] = useState(false);

  // Sincronizar dados do administrador logado
  useEffect(() => {
    if (currentUser?.id) {
      setCallerId(currentUser.id);
    }
    if (currentUser?.role && isValidUserRole(currentUser.role)) {
      setCallerRole(currentUser.role);
    }
  }, [currentUser]);

  // Debounce de 250ms na pesquisa textual
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Limpar aviso de ação após 6 segundos
  useEffect(() => {
    if (!actionNotice) return;
    const timer = setTimeout(() => setActionNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [actionNotice]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);

    const res = await getAdminUsers({
      search: debouncedSearch,
      role: roleFilter,
      page,
      limit: 20,
    });

    if (res.error) {
      setError(res.error);
      setUsers([]);
    } else {
      setUsers(res.users);
      setSummary(res.summary);
      setAuditLogs(res.audit_logs);
      setTotalPages(res.pagination.totalPages);
      setTotalFiltered(res.pagination.total);
      if (onUserCountChange) {
        onUserCountChange(res.summary.total);
      }
      if (res.caller?.id) {
        setCallerId(res.caller.id);
      }
      if (res.caller?.role && isValidUserRole(res.caller.role)) {
        setCallerRole(res.caller.role);
      } else if (!currentUser?.id) {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.user?.id) {
          setCallerId(session.user.id);
        }
      }
    }

    setLoading(false);
  }, [debouncedSearch, roleFilter, page, onUserCountChange, currentUser?.id]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSelectDraftRole = (userId: string, selectedRole: UserRole) => {
    setDraftRoles((prev) => ({
      ...prev,
      [userId]: selectedRole,
    }));
  };

  const handleOpenConfirmModal = (targetUser: AdminUserRow) => {
    const targetNewRole = draftRoles[targetUser.id] || targetUser.role;
    if (targetNewRole === targetUser.role) return;

    setConfirmModal({
      open: true,
      targetUser,
      newRole: targetNewRole,
    });
  };

  const handleCloseConfirmModal = () => {
    if (submittingRole) return;
    setConfirmModal({
      open: false,
      targetUser: null,
      newRole: null,
    });
  };

  const handleConfirmRoleChange = async () => {
    if (!confirmModal.targetUser || !confirmModal.newRole) return;

    setSubmittingRole(true);
    setActionNotice(null);

    const target = confirmModal.targetUser;
    const desiredRole = confirmModal.newRole;

    const result = await updateAdminUserRole(target.id, desiredRole);
    setSubmittingRole(false);

    if (!result.success) {
      setActionNotice({
        type: 'error',
        message: result.error || 'Não foi possível atualizar o papel do usuário.',
      });
      setConfirmModal({ open: false, targetUser: null, newRole: null });
      return;
    }

    // Limpar rascunho da linha alterada e recarregar dados reais do banco
    setDraftRoles((prev) => {
      const next = { ...prev };
      delete next[target.id];
      return next;
    });

    setConfirmModal({ open: false, targetUser: null, newRole: null });
    setActionNotice({
      type: 'success',
      message:
        result.message ||
        `Papel de ${target.full_name || target.email} atualizado de ${target.role} para ${desiredRole}.`,
    });

    await loadUsers();
  };

  const formatCpf = (cpf?: string) => {
    if (!cpf) return 'Não informado';
    const digits = cpf.replace(/\D/g, '');
    if (digits.length === 11) {
      return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    }
    return cpf;
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho da Seção */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-white font-heading">
              Gestão de Usuários & RBAC
            </h1>
            <span className="px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-500/30">
              Supabase Ativo
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Controle oficial de perfis, operadores de portaria e administradores sincronizado com{' '}
            <code className="text-zinc-300 font-mono">public.profiles</code>,{' '}
            <code className="text-zinc-300 font-mono">Supabase Auth</code> e{' '}
            <code className="text-zinc-300 font-mono">audit_logs</code>.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="px-3 py-2 rounded-xl bg-[#141414] border border-[#242424] text-xs flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#FF1A2D] shrink-0" />
            <span className="text-zinc-400">Seu papel:</span>
            <span className="font-mono font-bold text-white">{callerRole}</span>
          </div>

          <button
            type="button"
            onClick={loadUsers}
            disabled={loading}
            className="px-3.5 py-2 bg-[#161616] hover:bg-[#202020] border border-[#2a2a2a] rounded-xl text-xs font-bold text-zinc-200 flex items-center gap-2 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[#FF1A2D]' : ''}`} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {/* Aviso de Hierarquia para o Administrador Logado */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-[#FF1A2D]/10 text-[#FF1A2D] shrink-0 mt-0.5">
            <Shield className="w-4 h-4" />
          </div>
          <div className="space-y-0.5 text-xs">
            <p className="font-bold text-white uppercase tracking-wider">
              Política de Hierarquia e Segurança Ativa
            </p>
            <p className="text-zinc-400 leading-relaxed">
              {callerRole === 'SUPER_ADMIN'
                ? 'Como SUPER_ADMIN, você pode gerenciar todos os papéis (USER, CHECKIN_OPERATOR, ADMIN e SUPER_ADMIN). Por segurança, nenhum administrador pode alterar o próprio papel nem remover o último SUPER_ADMIN.'
                : 'Como ADMIN, você pode conceder ou revogar o papel CHECKIN_OPERATOR para usuários comuns (USER). A promoção ou alteração de contas ADMIN e SUPER_ADMIN é exclusiva de um SUPER_ADMIN.'}
            </p>
          </div>
        </div>
      </div>

      {/* Feedback de Ação (Sucesso ou Erro) */}
      {actionNotice && (
        <div
          role="status"
          className={`p-4 rounded-xl border flex items-start justify-between gap-3 ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
              : 'bg-red-950/30 border-[#FF1A2D]/40 text-red-300'
          }`}
        >
          <div className="flex items-start gap-2.5 text-xs">
            {actionNotice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 text-[#FF1A2D] shrink-0 mt-0.5" />
            )}
            <span className="font-medium leading-relaxed">{actionNotice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-zinc-400 hover:text-white p-1"
            aria-label="Fechar aviso"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Cards de Resumo de Papéis Oficiais */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-[#121212] border border-[#222222] p-4 rounded-xl">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-1">
            <span>Total de Perfis</span>
            <Users className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <div className="text-2xl font-black font-mono text-white">{summary.total}</div>
          <span className="text-[10px] text-zinc-500 font-mono">public.profiles</span>
        </div>

        <div className="bg-[#121212] border border-[#222222] p-4 rounded-xl">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-1">
            <span>SUPER_ADMIN</span>
            <ShieldAlert className="w-3.5 h-3.5 text-[#FF1A2D]" />
          </div>
          <div className="text-2xl font-black font-mono text-[#FF1A2D]">{summary.super_admins}</div>
          <span className="text-[10px] text-zinc-500">Controle total</span>
        </div>

        <div className="bg-[#121212] border border-[#222222] p-4 rounded-xl">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-1">
            <span>ADMIN</span>
            <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-2xl font-black font-mono text-amber-400">{summary.admins}</div>
          <span className="text-[10px] text-zinc-500">Gestão operacional</span>
        </div>

        <div className="bg-[#121212] border border-[#222222] p-4 rounded-xl">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-1">
            <span>CHECKIN_OPERATOR</span>
            <QrCode className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div className="text-2xl font-black font-mono text-sky-400">{summary.operators}</div>
          <span className="text-[10px] text-zinc-500">Portaria / Scanner</span>
        </div>

        <div className="bg-[#121212] border border-[#222222] p-4 rounded-xl col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-1">
            <span>USER</span>
            <UserCheck className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div className="text-2xl font-black font-mono text-zinc-200">{summary.users}</div>
          <span className="text-[10px] text-zinc-500">Participantes / Clientes</span>
        </div>
      </div>

      {/* Barra de Busca e Filtro por Papel */}
      <div className="bg-[#121212] border border-[#222222] rounded-2xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Input de Busca */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar por nome, e-mail, CPF ou UUID..."
              className="w-full bg-[#181818] border border-[#2a2a2a] rounded-xl pl-10 pr-9 py-2.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#FF1A2D]"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                aria-label="Limpar busca"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filtros de Papel Oficial */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0">
            {(['ALL', ...VALID_USER_ROLES] as const).map((roleOption) => {
              const active = roleFilter === roleOption;
              return (
                <button
                  key={roleOption}
                  type="button"
                  onClick={() => {
                    setRoleFilter(roleOption);
                    setPage(1);
                  }}
                  className={`px-3 py-2 rounded-xl text-[11px] font-mono font-bold whitespace-nowrap transition border ${
                    active
                      ? 'bg-[#FF1A2D] text-white border-[#FF1A2D] shadow-[0_0_12px_rgba(255,26,45,0.3)]'
                      : 'bg-[#181818] text-zinc-400 border-[#262626] hover:text-white hover:border-zinc-700'
                  }`}
                >
                  {roleOption === 'ALL' ? 'TODOS' : roleOption}
                </button>
              );
            })}
          </div>
        </div>

        {/* Estado de Erro */}
        {error && (
          <div className="bg-red-950/20 border border-[#FF1A2D]/40 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-[#FF1A2D] shrink-0 mt-0.5" />
              <div>
                <h4 className="text-xs font-bold uppercase text-white">
                  Falha ao carregar perfis do Supabase
                </h4>
                <p className="text-xs text-zinc-300 mt-1">{error}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={loadUsers}
              className="px-4 py-2 bg-[#FF1A2D] hover:bg-[#e01426] text-white rounded-xl text-xs font-bold uppercase tracking-wider shrink-0 transition"
            >
              Tentar Novamente
            </button>
          </div>
        )}

        {/* Estado de Carregamento */}
        {loading && !error && (
          <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
            <RefreshCw className="w-6 h-6 text-[#FF1A2D] animate-spin" />
            <p className="text-xs text-zinc-400 font-mono">
              Consultando perfis reais em public.profiles...
            </p>
          </div>
        )}

        {/* Estado Vazio */}
        {!loading && !error && users.length === 0 && (
          <div className="py-12 flex flex-col items-center justify-center text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-[#181818] border border-[#262626] flex items-center justify-center text-zinc-500 mb-3">
              <Users className="w-5 h-5" />
            </div>
            <p className="text-sm font-bold text-white">Nenhum usuário encontrado</p>
            <p className="text-xs text-zinc-400 max-w-md mt-1">
              {debouncedSearch || roleFilter !== 'ALL'
                ? 'Nenhum perfil corresponde aos filtros selecionados. Limpe a busca para visualizar todos os registros.'
                : 'Ainda não há perfis cadastrados na tabela public.profiles deste ambiente.'}
            </p>
          </div>
        )}

        {/* Lista Mobile (Cards para smartphones < md) */}
        {!loading && !error && users.length > 0 && (
          <div className="md:hidden space-y-3">
            {users.map((u) => {
              const perms = getRoleManagementPermissions({
                callerId,
                callerRole,
                targetId: u.id,
                targetRole: u.role,
                superAdminCount: summary.super_admins,
              });
              const currentDraft = draftRoles[u.id] || u.role;
              const hasChanged = currentDraft !== u.role;
              const isSelf = Boolean(callerId && u.id.toLowerCase() === callerId.toLowerCase());
              const meta = ROLE_METADATA[u.role] || ROLE_METADATA.USER;

              return (
                <div
                  key={u.id}
                  className="bg-[#161616] border border-[#262626] rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-white truncate">
                          {u.full_name || 'Usuário PX'}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-[#FF1A2D]/20 text-[#FF1A2D] border border-[#FF1A2D]/30">
                            Você
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-400 break-all mt-0.5">{u.email}</p>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border shrink-0 ${meta.badgeClass}`}
                    >
                      {u.role}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#222222] text-[11px]">
                    <div>
                      <span className="text-zinc-500 block">Telefone / CPF</span>
                      <span className="text-zinc-300 font-mono">
                        {u.phone || formatCpf(u.cpf)}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">Cadastro</span>
                      <span className="text-zinc-300 font-mono">
                        {u.created_at
                          ? new Date(u.created_at).toLocaleDateString('pt-BR')
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Controle de Papel no Card Mobile */}
                  <div className="pt-2 border-t border-[#222222]">
                    {!perms.canEdit ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 bg-[#121212] border border-[#222222] px-3 py-2 rounded-lg">
                        <Lock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span>{perms.lockReason}</span>
                      </div>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <select
                          aria-label={`Alterar papel de ${u.full_name || u.email}`}
                          value={currentDraft}
                          onChange={(e) =>
                            handleSelectDraftRole(u.id, e.target.value as UserRole)
                          }
                          className="flex-1 bg-[#111111] border border-[#2e2e2e] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#FF1A2D]"
                        >
                          {perms.allowedRoles.map((roleOpt) => (
                            <option key={roleOpt} value={roleOpt}>
                              {roleOpt}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!hasChanged}
                          onClick={() => handleOpenConfirmModal(u)}
                          className={`px-3.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition ${
                            hasChanged
                              ? 'bg-[#FF1A2D] hover:bg-[#e01426] text-white shadow-[0_0_12px_rgba(255,26,45,0.3)]'
                              : 'bg-[#1c1c1c] text-zinc-500 cursor-not-allowed'
                          }`}
                        >
                          Aplicar Papel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Tabela Desktop (>= md) */}
        {!loading && !error && users.length > 0 && (
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#222222] text-zinc-400 uppercase font-mono text-[10px]">
                  <th className="py-3 px-4">Usuário / Identificação</th>
                  <th className="py-3 px-4">E-mail & Contato</th>
                  <th className="py-3 px-4">Papel Atual (RBAC)</th>
                  <th className="py-3 px-4">Data de Cadastro</th>
                  <th className="py-3 px-4 text-right">Gerenciar Permissão</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1c1c1c]">
                {users.map((u) => {
                  const perms = getRoleManagementPermissions({
                    callerId,
                    callerRole,
                    targetId: u.id,
                    targetRole: u.role,
                    superAdminCount: summary.super_admins,
                  });
                  const currentDraft = draftRoles[u.id] || u.role;
                  const hasChanged = currentDraft !== u.role;
                  const isSelf = Boolean(callerId && u.id.toLowerCase() === callerId.toLowerCase());
                  const meta = ROLE_METADATA[u.role] || ROLE_METADATA.USER;

                  return (
                    <tr key={u.id} className="hover:bg-[#161616] transition">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">
                            {u.full_name || 'Usuário PX'}
                          </span>
                          {isSelf && (
                            <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-[#FF1A2D]/20 text-[#FF1A2D] border border-[#FF1A2D]/30">
                              Sua Conta
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] font-mono text-zinc-500 block mt-0.5">
                          ID: {u.id.slice(0, 8)}...{u.id.slice(-4)}
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        <span className="text-zinc-200 block">{u.email}</span>
                        <span className="text-[11px] font-mono text-zinc-500 block mt-0.5">
                          {u.phone ? `${u.phone} • ` : ''}CPF: {formatCpf(u.cpf)}
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border ${meta.badgeClass}`}
                        >
                          {u.role}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 font-mono text-zinc-400 text-[11px]">
                        {u.created_at
                          ? new Date(u.created_at).toLocaleDateString('pt-BR', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric',
                            })
                          : '—'}
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        {!perms.canEdit ? (
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 bg-[#181818] border border-[#262626] px-3 py-1.5 rounded-lg">
                            <Lock className="w-3.5 h-3.5 text-zinc-500" />
                            <span>{perms.lockReason}</span>
                          </span>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-2">
                            <select
                              aria-label={`Selecionar papel para ${u.full_name || u.email}`}
                              value={currentDraft}
                              onChange={(e) =>
                                handleSelectDraftRole(u.id, e.target.value as UserRole)
                              }
                              className="bg-[#181818] border border-[#2e2e2e] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-[#FF1A2D]"
                            >
                              {perms.allowedRoles.map((roleOpt) => (
                                <option key={roleOpt} value={roleOpt}>
                                  {roleOpt}
                                </option>
                              ))}
                            </select>

                            <button
                              type="button"
                              disabled={!hasChanged}
                              onClick={() => handleOpenConfirmModal(u)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition ${
                                hasChanged
                                  ? 'bg-[#FF1A2D] hover:bg-[#e01426] text-white shadow-[0_0_12px_rgba(255,26,45,0.3)]'
                                  : 'bg-[#1a1a1a] text-zinc-500 border border-[#262626] cursor-not-allowed'
                              }`}
                            >
                              Aplicar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginação */}
        {!loading && !error && totalPages > 1 && (
          <div className="flex items-center justify-between pt-3 border-t border-[#222222] text-xs text-zinc-400">
            <span>
              Exibindo página <strong className="text-white">{page}</strong> de{' '}
              <strong className="text-white">{totalPages}</strong> ({totalFiltered} registros)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="p-2 rounded-lg bg-[#181818] border border-[#2a2a2a] text-zinc-300 hover:text-white disabled:opacity-40"
                aria-label="Página anterior"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-2 rounded-lg bg-[#181818] border border-[#2a2a2a] text-zinc-300 hover:text-white disabled:opacity-40"
                aria-label="Próxima página"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Trilha Recente de Auditoria de Permissões (public.audit_logs) */}
      <div className="bg-[#121212] border border-[#222222] rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-[#FF1A2D]" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-heading">
              Registro de Auditoria RBAC (public.audit_logs)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-zinc-500">
            Últimas {auditLogs.length} alterações
          </span>
        </div>

        {auditLogs.length === 0 ? (
          <p className="text-xs text-zinc-500 font-mono py-2">
            Nenhuma alteração de papel registrada recentemente em public.audit_logs.
          </p>
        ) : (
          <div className="space-y-2">
            {auditLogs.map((log) => {
              const oldRole = log.details?.old_role || 'USER';
              const newRole = log.details?.new_role || log.details?.role || '—';
              const targetLabel =
                log.details?.target_email ||
                log.details?.email ||
                log.entity_id ||
                'Perfil';
              return (
                <div
                  key={log.id}
                  className="bg-[#161616] border border-[#242424] rounded-xl px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] uppercase px-2 py-0.5 rounded bg-[#222222] text-zinc-300 border border-[#333333]">
                      {log.action}
                    </span>
                    <span className="text-white font-semibold">{targetLabel}</span>
                    <span className="text-zinc-500 font-mono text-[11px]">
                      ({oldRole} → {newRole})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500">
                    <Clock className="w-3 h-3" />
                    <span>
                      {log.created_at
                        ? new Date(log.created_at).toLocaleString('pt-BR')
                        : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de Confirmação de Alteração de Papel */}
      {confirmModal.open && confirmModal.targetUser && confirmModal.newRole && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-role-modal-title"
        >
          <div className="w-full max-w-md bg-[#121212] border border-[#2a2a2a] rounded-2xl p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-xl bg-[#FF1A2D]/15 text-[#FF1A2D]">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3
                    id="confirm-role-modal-title"
                    className="text-base font-black uppercase text-white font-heading"
                  >
                    Confirmar Alteração de Papel
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    Operação auditada em tempo real no Supabase
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseConfirmModal}
                disabled={submittingRole}
                className="text-zinc-400 hover:text-white p-1"
                aria-label="Fechar modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-[#181818] border border-[#262626] rounded-xl p-4 space-y-3 text-xs">
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase font-mono">
                  Usuário Alvo
                </span>
                <span className="text-white font-bold text-sm block mt-0.5">
                  {confirmModal.targetUser.full_name || 'Usuário PX'}
                </span>
                <span className="text-zinc-400 font-mono text-[11px]">
                  {confirmModal.targetUser.email}
                </span>
              </div>

              <div className="pt-3 border-t border-[#242424] flex items-center justify-between gap-2">
                <div>
                  <span className="text-zinc-500 block text-[10px] uppercase font-mono">
                    Papel Atual
                  </span>
                  <span className="font-mono font-bold text-zinc-300 mt-0.5 block">
                    {confirmModal.targetUser.role}
                  </span>
                </div>
                <ArrowRight className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                <div className="text-right">
                  <span className="text-zinc-500 block text-[10px] uppercase font-mono">
                    Novo Papel
                  </span>
                  <span className="font-mono font-bold text-[#FF1A2D] mt-0.5 block">
                    {confirmModal.newRole}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-[#161616] border border-[#242424] rounded-xl p-3.5 text-xs text-zinc-300 leading-relaxed">
              <strong className="text-white block mb-1">
                {ROLE_METADATA[confirmModal.newRole].label}
              </strong>
              {ROLE_METADATA[confirmModal.newRole].description}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={handleCloseConfirmModal}
                disabled={submittingRole}
                className="px-4 py-2.5 rounded-xl bg-[#1a1a1a] hover:bg-[#242424] border border-[#2e2e2e] text-xs font-bold text-zinc-300 transition disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmRoleChange}
                disabled={submittingRole}
                className="px-5 py-2.5 rounded-xl bg-[#FF1A2D] hover:bg-[#e01426] text-white text-xs font-bold uppercase tracking-wider transition shadow-[0_0_15px_rgba(255,26,45,0.4)] disabled:opacity-50 flex items-center gap-2"
              >
                {submittingRole ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Aplicando...</span>
                  </>
                ) : (
                  <span>Confirmar Permissão</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
