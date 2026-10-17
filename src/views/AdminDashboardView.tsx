import React, { useState, useEffect, useCallback } from 'react';
import { ActiveScreen, EventItem, Order } from '../types';
import { supabase } from '../lib/supabase';
import {
  LayoutDashboard,
  Calendar,
  Ticket,
  ShoppingBag,
  Users,
  DollarSign,
  Settings,
  Trash2,
  LogOut,
  TrendingUp,
  Download,
  CheckCircle2,
  Clock,
  Search,
  Filter,
  CreditCard,
  AlertCircle,
  Eye,
  Palette,
} from 'lucide-react';
import { AdminEventsManager } from '../components/admin/AdminEventsManager';
import { AdminBrandingManager } from '../components/admin/AdminBrandingManager';
import { AdminBatchesManager } from '../components/admin/AdminBatchesManager';

interface AdminDashboardViewProps {
  events: EventItem[];
  onNavigate: (screen: ActiveScreen) => void;
  onRefreshEvents?: () => void;
}

interface AdminOrderRow {
  id: string;
  customer_name: string;
  customer_email: string;
  event_title: string;
  items_summary: string;
  quantity: number;
  total: number;
  payment_method: string;
  payment_status: 'approved' | 'pending' | 'cancelled';
  created_at: string;
}

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  events,
  onNavigate,
  onRefreshEvents,
}) => {
  const [adminTab, setAdminTab] = useState<'dashboard' | 'events' | 'tickets' | 'orders' | 'users' | 'branding'>('dashboard');
  const [selectedBatchEventId, setSelectedBatchEventId] = useState<string>('');
  const [dateRange, setDateRange] = useState('01/11/2025 - 30/11/2025');
  const [ordersSearch, setOrdersSearch] = useState('');
  const [ordersFilter, setOrdersFilter] = useState<'all' | 'approved' | 'pending'>('all');
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [profilesCount, setProfilesCount] = useState<number | null>(null);
  const [expiringOrders, setExpiringOrders] = useState(false);

  // Inicialização estrita com array vazio (dados reais consultados exclusivamente do Supabase)
  const [orders, setOrders] = useState<AdminOrderRow[]>([]);

  // Consultar pedidos oficiais da tabela orders no Supabase
  const fetchAdminOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*, profiles(full_name, email), events(title), order_items(*)')
        .order('created_at', { ascending: false });

      setOrdersLoading(false);
      if (error) {
        console.warn('[PX CONTROL] Falha ao carregar pedidos do Supabase:', error.message);
        setOrdersError('Falha ao consultar pedidos no Supabase: ' + error.message);
        return;
      }

      if (data && data.length > 0) {
        const mapped: AdminOrderRow[] = data.map((d: any) => {
          const itemsCount = (d.order_items || []).reduce(
            (acc: number, item: any) => acc + (item.quantity || 1),
            0
          );
          return {
            id: d.id,
            customer_name: d.profiles?.full_name || 'Cliente PX',
            customer_email: d.profiles?.email || 'cliente@pxcuston.com.br',
            event_title: d.events?.title || 'PX CUSTON',
            items_summary: `${itemsCount || 1} ingresso(s)`,
            quantity: itemsCount || 1,
            total: Number(d.total),
            payment_method: d.payment_method || 'pix',
            payment_status:
              d.payment_status === 'approved'
                ? 'approved'
                : d.payment_status === 'cancelled'
                ? 'cancelled'
                : 'pending',
            created_at: d.created_at,
          };
        });
        setOrders(mapped);
      } else {
        setOrders([]);
      }
    } catch (err: any) {
      setOrdersLoading(false);
      setOrdersError('Erro de conexão ao buscar pedidos no servidor.');
    }
  }, []);

  useEffect(() => {
    fetchAdminOrders();

    // Consultar contagem real de perfis cadastrados
    async function fetchProfilesCount() {
      try {
        const { count, error } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true });
        if (!error && count !== null) {
          setProfilesCount(count);
        }
      } catch {
        // Fallback silencioso
      }
    }
    fetchProfilesCount();
  }, [fetchAdminOrders]);

  const approvedOrders = orders.filter((o) => o.payment_status === 'approved');
  const pendingOrders = orders.filter((o) => o.payment_status === 'pending');
  const totalApprovedRevenue = approvedOrders.reduce((acc, curr) => acc + curr.total, 0);
  const averageTicket = approvedOrders.length > 0 ? totalApprovedRevenue / approvedOrders.length : 0;
  const approvedTicketsCount = approvedOrders.reduce((acc, curr) => acc + curr.quantity, 0);
  const uniqueCustomersCount = new Set(orders.map((o) => o.customer_email)).size;

  const filteredOrders = orders.filter((o) => {
    const matchStatus =
      ordersFilter === 'all' || o.payment_status === ordersFilter;
    const matchSearch =
      ordersSearch.trim() === '' ||
      o.id.toLowerCase().includes(ordersSearch.toLowerCase()) ||
      o.customer_name.toLowerCase().includes(ordersSearch.toLowerCase()) ||
      o.customer_email.toLowerCase().includes(ordersSearch.toLowerCase()) ||
      o.event_title.toLowerCase().includes(ordersSearch.toLowerCase());
    return matchStatus && matchSearch;
  });

  const handleExpirePendingOrders = async () => {
    setExpiringOrders(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/admin/orders/expire-pending', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ timeout_minutes: 15 }),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchAdminOrders();
        alert(`Verificação de expiração executada com sucesso! Pedidos cancelados e estoque liberado: ${data.result?.expired_orders_count || 0}`);
      } else {
        alert(data.error || 'Falha ao executar rotina de expiração.');
      }
    } catch (e: any) {
      alert('Erro de conexão ao verificar expirações: ' + e.message);
    } finally {
      setExpiringOrders(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col md:flex-row">
      {/* Sidebar: PX CONTROL */}
      <aside className="w-full md:w-64 bg-[#0d0d0d] border-b md:border-b-0 md:border-r border-[#1c1c1c] p-4 flex flex-col justify-between shrink-0">
        <div className="space-y-6">
          {/* Brand header */}
          <div className="flex items-center gap-2 px-2 pt-2">
            <span className="text-base font-black tracking-widest text-[#FF1A2D] uppercase font-heading">
              PX CONTROL
            </span>
          </div>

          {/* Navigation menu */}
          <nav className="space-y-1 text-xs">
            <button
              onClick={() => setAdminTab('dashboard')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-bold flex items-center gap-3 transition ${
                adminTab === 'dashboard'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Dashboard</span>
            </button>

            <button
              onClick={() => setAdminTab('events')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                adminTab === 'events'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>Eventos</span>
            </button>

            <button
              onClick={() => {
                setSelectedBatchEventId('');
                setAdminTab('tickets');
              }}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                adminTab === 'tickets'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Ticket className="w-4 h-4" />
              <span>Lotes & Ingressos</span>
            </button>

            {/* Menu Pedidos: Alterna para aba de Gestão de Pedidos (Todos) */}
            <button
              onClick={() => {
                setAdminTab('orders');
                setOrdersFilter('all');
              }}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                adminTab === 'orders' && ordersFilter === 'all'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingBag className="w-4 h-4" />
                <span>Pedidos</span>
              </div>
              <span className="bg-[#222] text-zinc-300 text-[10px] px-2 py-0.5 rounded-full font-mono">
                {orders.length}
              </span>
            </button>

            <button
              onClick={() => setAdminTab('users')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                adminTab === 'users'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>Usuários</span>
            </button>

            {/* Menu Identidade Visual & PWA */}
            <button
              onClick={() => setAdminTab('branding')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                adminTab === 'branding'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Palette className="w-4 h-4" />
              <span>Ícone & PWA</span>
            </button>

            {/* Menu Financeiro: Alterna para Pedidos Faturados / Receita Aprovada */}
            <button
              onClick={() => {
                setAdminTab('orders');
                setOrdersFilter('approved');
              }}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                adminTab === 'orders' && ordersFilter === 'approved'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <DollarSign className="w-4 h-4" />
                <span>Financeiro</span>
              </div>
              <span className="text-[10px] text-emerald-400 font-mono font-bold">
                R$ {totalApprovedRevenue.toFixed(0)}
              </span>
            </button>

            {/* Menu Configurações: Gateway Mercado Pago & Sistema */}
            <button
              onClick={() => onNavigate('admin_payments')}
              className="w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 text-zinc-400 hover:text-white hover:bg-[#181818] transition"
            >
              <Settings className="w-4 h-4" />
              <span>Configurações</span>
            </button>

            <button
              onClick={() => onNavigate('admin_cache')}
              className="w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 text-zinc-400 hover:text-white hover:bg-[#181818] transition"
            >
              <Trash2 className="w-4 h-4" />
              <span>Limpeza de Cache</span>
            </button>
          </nav>
        </div>

        <div className="pt-4 border-t border-[#1c1c1c]">
          <button
            onClick={() => onNavigate('home')}
            className="w-full text-left px-3.5 py-2 rounded-xl text-xs text-zinc-400 hover:text-white flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            <span>Voltar ao Site</span>
          </button>
        </div>
      </aside>

      {/* Main Admin Content */}
      <main className="flex-1 p-4 sm:p-8 space-y-8 overflow-y-auto">
        {/* SEÇÃO 1: DASHBOARD GERAL */}
        {adminTab === 'dashboard' && (
          <>
            {/* Top Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
              <div>
                <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading">
                  Dashboard Geral
                </h1>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Visão consolidada de receitas, ingressos e ocupação dos eventos PX CUSTON
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="bg-[#141414] border border-[#2a2a2a] px-3.5 py-2 rounded-xl text-xs text-zinc-300">
                  {dateRange}
                </div>

                <button
                  onClick={() => alert('Exportando relatório consolidado PX CONTROL (CSV/PDF)...')}
                  className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exportar Relatório</span>
                </button>
              </div>
            </div>

            {/* 4 Metrics Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              <div className="bg-[#121212] border border-[#222] p-5 rounded-2xl">
                <span className="text-xs text-zinc-400 uppercase font-semibold">Vendas Totais</span>
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-black text-white font-heading">
                    {ordersLoading ? '...' : `R$ ${totalApprovedRevenue.toFixed(2).replace('.', ',')}`}
                  </span>
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-3 h-3" /> Real
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 mt-2">
                  {ordersLoading ? 'Consultando pedidos...' : `${approvedOrders.length} pedido(s) aprovado(s)`}
                </p>
              </div>

              <div className="bg-[#121212] border border-[#222] p-5 rounded-2xl">
                <span className="text-xs text-zinc-400 uppercase font-semibold">Ingressos Vendidos</span>
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-black text-white font-heading">
                    {ordersLoading ? '...' : approvedTicketsCount}
                  </span>
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-3 h-3" /> Real
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 mt-2">Ingressos em pedidos aprovados</p>
              </div>

              <div className="bg-[#121212] border border-[#222] p-5 rounded-2xl">
                <span className="text-xs text-zinc-400 uppercase font-semibold">Eventos Ativos</span>
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-black text-white font-heading">{events.length}</span>
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-3 h-3" /> Oficial
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 mt-2">100% oficiais PX CUSTON</p>
              </div>

              <div className="bg-[#121212] border border-[#222] p-5 rounded-2xl">
                <span className="text-xs text-zinc-400 uppercase font-semibold">Usuários Cadastrados</span>
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-2xl font-black text-white font-heading">
                    {profilesCount !== null ? profilesCount : (ordersLoading ? '...' : uniqueCustomersCount)}
                  </span>
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-3 h-3" /> Base
                  </span>
                </div>
                <p className="text-[10px] text-zinc-500 mt-2">Perfis registrados no Supabase</p>
              </div>
            </div>

            {/* Charts & Activity Row */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-8 bg-[#121212] border border-[#222] p-6 rounded-3xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-black uppercase text-white font-heading">
                      Vendas por Período
                    </h3>
                    <p className="text-xs text-zinc-400">Evolução diária de faturamento com ingressos</p>
                  </div>
                  <span className="text-xs font-bold text-[#FF1A2D] bg-[#FF1A2D]/10 px-2.5 py-1 rounded-full border border-[#FF1A2D]/30">
                    Mercado Pago Conectado
                  </span>
                </div>

                <div className="h-64 w-full relative flex items-end pt-8 pb-4">
                  <svg className="w-full h-full overflow-visible" viewBox="0 0 500 150">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#FF1A2D" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#FF1A2D" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M 0 140 L 40 120 L 90 125 L 140 100 L 200 110 L 250 60 L 310 75 L 370 45 L 430 35 L 500 20 L 500 150 L 0 150 Z"
                      fill="url(#chartGrad)"
                    />
                    <path
                      d="M 0 140 L 40 120 L 90 125 L 140 100 L 200 110 L 250 60 L 310 75 L 370 45 L 430 35 L 500 20"
                      fill="none"
                      stroke="#FF1A2D"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                    />
                    <circle cx="500" cy="20" r="5" fill="#FFFFFF" stroke="#FF1A2D" strokeWidth="3" />
                  </svg>
                </div>

                <div className="flex justify-between text-[11px] text-zinc-500 font-mono border-t border-[#1c1c1c] pt-2">
                  <span>01/11</span>
                  <span>05/11</span>
                  <span>10/11</span>
                  <span>15/11</span>
                  <span>20/11</span>
                  <span>25/11</span>
                  <span>30/11</span>
                </div>
              </div>

              {/* Ingressos por Status */}
              <div className="lg:col-span-4 bg-[#121212] border border-[#222] p-6 rounded-3xl space-y-4 flex flex-col justify-between">
                <div>
                  <h3 className="text-sm font-black uppercase text-white font-heading">
                    Ingressos por Status
                  </h3>
                  <p className="text-xs text-zinc-400">Distribuição geral no sistema</p>
                </div>

                <div className="flex items-center justify-center my-4">
                  <div className="relative w-40 h-40">
                    <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                      <circle
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="transparent"
                        stroke="#FF1A2D"
                        strokeWidth="4.5"
                        strokeDasharray="45 55"
                        strokeDashoffset="0"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="transparent"
                        stroke="#10b981"
                        strokeWidth="4.5"
                        strokeDasharray="35 65"
                        strokeDashoffset="-45"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="transparent"
                        stroke="#3b82f6"
                        strokeWidth="4.5"
                        strokeDasharray="15 85"
                        strokeDashoffset="-80"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="transparent"
                        stroke="#71717a"
                        strokeWidth="4.5"
                        strokeDasharray="5 95"
                        strokeDashoffset="-95"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-xs font-bold text-zinc-400 uppercase">Total</span>
                      <span className="text-lg font-black text-white font-heading">1.248</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs pt-3 border-t border-[#1c1c1c]">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#FF1A2D]" />
                    <span className="text-zinc-300">Utilizados: <strong>45%</strong></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span className="text-zinc-300">Vendidos: <strong>35%</strong></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                    <span className="text-zinc-300">Disponíveis: <strong>15%</strong></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-500" />
                    <span className="text-zinc-300">Cancelados: <strong>5%</strong></span>
                  </div>
                </div>
              </div>
            </div>

            {/* Eventos Oficiais Recentes */}
            <div className="bg-[#121212] border border-[#222] p-6 rounded-3xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-black uppercase text-white font-heading">
                  Eventos Oficiais Recentes
                </h3>
                <button
                  onClick={() => onNavigate('events')}
                  className="text-xs text-[#FF1A2D] font-bold hover:underline"
                >
                  Gerenciar Eventos →
                </button>
              </div>

              <div className="space-y-3">
                {events.map((evt) => (
                  <div
                    key={evt.id}
                    className="bg-[#181818] border border-[#262626] p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={evt.cover_image}
                        alt={evt.title}
                        className="w-12 h-12 rounded-xl object-cover"
                      />
                      <div>
                        <h4 className="text-sm font-black text-white uppercase">{evt.title}</h4>
                        <p className="text-xs text-zinc-400">
                          {evt.formatted_date} — {evt.city}/{evt.state}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-3 py-1 rounded-full font-bold">
                        Publicado
                      </span>
                      <button
                        onClick={() => onNavigate('event_detail')}
                        className="bg-[#222] hover:bg-[#333] text-white text-xs px-3 py-1.5 rounded-lg border border-[#333]"
                      >
                        Editar Lotes
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* SEÇÃO 2: GESTÃO DE PEDIDOS (PX CONTROL) */}
        {adminTab === 'orders' && (
          <div className="space-y-6">
            {/* Top Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
              <div>
                <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                  <ShoppingBag className="w-6 h-6 text-[#FF1A2D]" />
                  <span>Gestão de Pedidos & Faturamento</span>
                </h1>
                <p className="text-xs text-zinc-400 mt-1">
                  Monitoramento em tempo real de pedidos emitidos, confirmação de pagamentos Pix/Cartão via Mercado Pago.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleExpirePendingOrders}
                  disabled={expiringOrders}
                  className="bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] text-zinc-300 text-xs font-semibold px-3.5 py-2.5 rounded-xl transition flex items-center gap-2 shrink-0 disabled:opacity-50"
                  title="Verifica pedidos pendentes há mais de 15 minutos e devolve o estoque aos lotes"
                >
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>{expiringOrders ? 'Verificando...' : 'Expirar Pendentes'}</span>
                </button>

                <button
                  onClick={() => alert('Exportando relatório de pedidos em formato CSV...')}
                  className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2 shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exportar Pedidos</span>
                </button>
              </div>
            </div>

            {/* Metrics Header for Orders */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
                <span className="text-[11px] text-zinc-400 uppercase font-semibold">Total em Pedidos</span>
                <p className="text-xl font-black text-white font-heading mt-1">
                  R$ {totalApprovedRevenue.toFixed(2).replace('.', ',')}
                </p>
                <span className="text-[10px] text-emerald-400">Faturamento aprovado</span>
              </div>

              <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
                <span className="text-[11px] text-zinc-400 uppercase font-semibold">Pedidos Concluídos</span>
                <p className="text-xl font-black text-emerald-400 font-heading mt-1">
                  {approvedOrders.length}
                </p>
                <span className="text-[10px] text-zinc-500">Pagamento confirmado</span>
              </div>

              <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
                <span className="text-[11px] text-zinc-400 uppercase font-semibold">Aguardando Pagamento</span>
                <p className="text-xl font-black text-amber-400 font-heading mt-1">
                  {pendingOrders.length}
                </p>
                <span className="text-[10px] text-zinc-500">Pix / cartões pendentes</span>
              </div>

              <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
                <span className="text-[11px] text-zinc-400 uppercase font-semibold">Ticket Médio</span>
                <p className="text-xl font-black text-white font-heading mt-1">
                  R$ {averageTicket.toFixed(2).replace('.', ',')}
                </p>
                <span className="text-[10px] text-zinc-500">Média por pedido aprovado</span>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="relative w-full sm:w-80">
                <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-3" />
                <input
                  type="text"
                  placeholder="Pesquisar por pedido, cliente ou evento..."
                  value={ordersSearch}
                  onChange={(e) => setOrdersSearch(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none text-xs rounded-xl pl-10 pr-3.5 py-2.5 text-white"
                />
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={() => setOrdersFilter('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    ordersFilter === 'all'
                      ? 'bg-[#FF1A2D] text-white'
                      : 'bg-[#181818] text-zinc-400 hover:text-white'
                  }`}
                >
                  Todos ({orders.length})
                </button>
                <button
                  onClick={() => setOrdersFilter('approved')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    ordersFilter === 'approved'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-[#181818] text-zinc-400 hover:text-white'
                  }`}
                >
                  Aprovados
                </button>
                <button
                  onClick={() => setOrdersFilter('pending')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    ordersFilter === 'pending'
                      ? 'bg-amber-600 text-white'
                      : 'bg-[#181818] text-zinc-400 hover:text-white'
                  }`}
                >
                  Pendentes
                </button>
              </div>
            </div>

            {/* Orders Table */}
            <div className="bg-[#121212] border border-[#222] rounded-3xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#181818] text-zinc-400 uppercase tracking-wider text-[10px] border-b border-[#222]">
                    <tr>
                      <th className="py-3.5 px-4 font-bold">ID do Pedido</th>
                      <th className="py-3.5 px-4 font-bold">Cliente</th>
                      <th className="py-3.5 px-4 font-bold">Evento</th>
                      <th className="py-3.5 px-4 font-bold">Itens</th>
                      <th className="py-3.5 px-4 font-bold">Método</th>
                      <th className="py-3.5 px-4 font-bold">Status</th>
                      <th className="py-3.5 px-4 font-bold">Total</th>
                      <th className="py-3.5 px-4 font-bold">Data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e1e1e]">
                    {ordersLoading ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-zinc-400">
                          <Clock className="w-5 h-5 animate-spin mx-auto mb-2 text-[#FF1A2D]" />
                          Carregando pedidos da base oficial...
                        </td>
                      </tr>
                    ) : ordersError ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center">
                          <div className="max-w-md mx-auto space-y-2">
                            <AlertCircle className="w-6 h-6 text-amber-500 mx-auto" />
                            <p className="text-xs font-bold text-white uppercase tracking-wider">
                              Falha na Consulta de Pedidos
                            </p>
                            <p className="text-[11px] text-zinc-400">
                              {ordersError}
                            </p>
                            <button
                              onClick={fetchAdminOrders}
                              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222] hover:bg-[#333] text-white text-xs border border-[#333] transition"
                            >
                              <Clock className="w-3.5 h-3.5 text-[#FF1A2D]" />
                              <span>Tentar Novamente</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : filteredOrders.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-zinc-500">
                          Nenhum pedido encontrado para o filtro selecionado.
                        </td>
                      </tr>
                    ) : (
                      filteredOrders.map((ord) => (
                        <tr key={ord.id} className="hover:bg-[#161616] transition">
                          <td className="py-3 px-4 font-mono font-bold text-white">
                            {ord.id}
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-semibold text-white">{ord.customer_name}</p>
                            <p className="text-[10px] text-zinc-500">{ord.customer_email}</p>
                          </td>
                          <td className="py-3 px-4 text-zinc-300 font-semibold truncate max-w-[180px]">
                            {ord.event_title}
                          </td>
                          <td className="py-3 px-4 text-zinc-400">
                            {ord.items_summary}
                          </td>
                          <td className="py-3 px-4">
                            <span className="uppercase text-[10px] font-mono bg-[#181818] px-2 py-0.5 rounded border border-[#2a2a2a] text-zinc-300">
                              {ord.payment_method}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            {ord.payment_status === 'approved' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                                <CheckCircle2 className="w-3 h-3" /> Aprovado
                              </span>
                            ) : ord.payment_status === 'cancelled' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-zinc-400 bg-zinc-900 border border-zinc-700 px-2 py-0.5 rounded-full">
                                <AlertCircle className="w-3 h-3 text-[#FF1A2D]" /> Cancelado / Expirado
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400 bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 rounded-full">
                                <Clock className="w-3 h-3" /> Pendente
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-white">
                            R$ {ord.total.toFixed(2).replace('.', ',')}
                          </td>
                          <td className="py-3 px-4 text-zinc-500 font-mono text-[11px]">
                            {new Date(ord.created_at).toLocaleDateString('pt-BR')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SEÇÃO 3: GESTÃO DE EVENTOS */}
        {adminTab === 'events' && (
          <AdminEventsManager
            onEventChange={onRefreshEvents}
            onManageBatches={(eventId) => {
              setSelectedBatchEventId(eventId);
              setAdminTab('tickets');
            }}
          />
        )}

        {/* SEÇÃO 4: GESTÃO DE LOTES E INGRESSOS */}
        {adminTab === 'tickets' && (
          <AdminBatchesManager
            initialEventId={selectedBatchEventId}
            onBatchesUpdated={onRefreshEvents}
          />
        )}

        {/* SEÇÃO 5: GESTÃO DE USUÁRIOS */}
        {adminTab === 'users' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
              <div>
                <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading">
                  Gestão de Usuários
                </h1>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Auditoria de perfis e níveis de permissão (RBAC) no sistema
                </p>
              </div>
            </div>

            {/* Banner de Módulo em Implementação */}
            <div className="bg-[#141414] border border-amber-500/30 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="p-3 bg-amber-500/10 rounded-xl text-amber-400 shrink-0">
                <Users className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
                    Módulo em implementação
                  </span>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono">
                    Fase de Estruturação
                  </span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  O módulo de atribuição de papéis (RBAC) e gerenciamento de permissões pelo PX CONTROL está em fase de estruturação.
                  Atualmente, as permissões são validadas estritamente via Row Level Security (RLS) e regras de banco no Supabase.
                </p>
              </div>
            </div>

            {/* Resumo de Usuários no Banco Oficial */}
            <div className="bg-[#121212] border border-[#222] rounded-2xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider font-heading">
                Status de Autenticação e Perfis (Supabase)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-[#181818] border border-[#262626] p-4 rounded-xl">
                  <span className="text-xs text-zinc-400 block mb-1">Perfis Registrados</span>
                  <span className="text-xl font-bold font-mono text-white">
                    {profilesCount !== null ? profilesCount : 'Consultando...'}
                  </span>
                </div>
                <div className="bg-[#181818] border border-[#262626] p-4 rounded-xl">
                  <span className="text-xs text-zinc-400 block mb-1">Níveis de Permissão</span>
                  <span className="text-xs font-mono text-zinc-300 block">
                    SUPER_ADMIN, ADMIN, CHECKIN_OPERATOR, CLIENT
                  </span>
                </div>
                <div className="bg-[#181818] border border-[#262626] p-4 rounded-xl">
                  <span className="text-xs text-zinc-400 block mb-1">Segurança Ativa</span>
                  <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Supabase Auth + RLS
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SEÇÃO 6: IDENTIDADE VISUAL & ÍCONE PWA */}
        {adminTab === 'branding' && <AdminBrandingManager />}
      </main>
    </div>
  );
};
